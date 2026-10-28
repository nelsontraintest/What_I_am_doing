const STORAGE_KEY = "work_board_state_v1";
const GH_CONFIG_KEY = "work_board_gh_config_v1";

let state = null;
let isEditMode = false;
let editingCardId = null;
let activeBossFilter = "all";
let searchQuery = "";

const UNDO_LIMIT = 50;
const CLICK_EXPAND_DELAY_MS = 250;
let undoStack = [];
let redoStack = [];
let historyBaseline = null;
const expandedCardIds = new Set();

const DEFAULT_FALLBACK = {
  profile: {
    name: "My Work Log & Queue",
    subtitle: "Live view of what I am working on, what is next in line, and long-term scheduled reminders.",
    capacityStatus: "busy",
    capacityNote: "Focused on current active deliverables. New requests will be queued in 'Up Next'.",
    lastUpdated: new Date().toISOString()
  },
  bosses: [
    { id: "boss-a", name: "Boss A (Product)", color: "#2563eb", bg: "#eff6ff" },
    { id: "boss-b", name: "Boss B (Engineering)", color: "#7c3aed", bg: "#f5f3ff" },
    { id: "boss-c", name: "Boss C (Operations)", color: "#059669", bg: "#ecfdf5" }
  ],
  tasks: []
};

// Utility: Generate light tint background from hex color
function hexToSoftBg(hex) {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#f1f5f9";
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.12)`;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2800);
}

function formatRelativeTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  return "Last updated: " + date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Calculate human-readable countdown & status for a YYYY-MM-DD dueDate
function getDueDateInfo(dueDateStr) {
  if (!dueDateStr) return null;
  const parts = dueDateStr.split("-").map(Number);
  if (parts.length !== 3) return null;
  const target = new Date(parts[0], parts[1] - 1, parts[2], 9, 0, 0);
  if (isNaN(target.getTime())) return null;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const diffDays = Math.round((targetStart - todayStart) / (1000 * 60 * 60 * 24));

  const formattedDate = target.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });

  let countdownText = "";
  let urgencyClass = "";

  if (diffDays < 0) {
    countdownText = `Overdue by ${Math.abs(diffDays)}d`;
    urgencyClass = "overdue";
  } else if (diffDays === 0) {
    countdownText = "Due Today!";
    urgencyClass = "overdue";
  } else if (diffDays <= 30) {
    countdownText = `Due in ${diffDays}d (Wake-up window!)`;
    urgencyClass = "due-soon";
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    const remDays = diffDays % 30;
    countdownText = `In ~${months}mo ${remDays > 0 ? `${remDays}d` : ""} (${diffDays}d)`;
  } else {
    const years = (diffDays / 365).toFixed(1);
    countdownText = `In ${years} yrs (${diffDays} days left)`;
  }

  return {
    diffDays,
    formattedDate,
    countdownText,
    urgencyClass,
    target
  };
}

// Open an all-day event draft in Outlook on the web, with the runbook in the body.
function buildOutlookCalendarUrl(task, boss) {
  let targetDate = new Date();
  if (task.dueDate) {
    const [y, m, d] = task.dueDate.split("-").map(Number);
    targetDate = new Date(y, m - 1, d);
  } else {
    targetDate.setFullYear(targetDate.getFullYear() + 1);
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = (date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const startStr = `${dateStr(targetDate)}T00:00:00`;
  const endStr = `${dateStr(targetDate)}T23:59:00`;

  const details = [
    `Requester / Boss: ${boss.name}`,
    `Priority: ${task.priority || "Normal"}`,
    task.triggerPlan ? `Reminder Plan: ${task.triggerPlan}` : "",
    task.runbook ? `\n--- HOW TO DO IT (RUNBOOK FOR FUTURE ME) ---\n${task.runbook}` : "",
    task.note ? `\nNote: ${task.note}` : "",
    `\nBoard Link: ${window.location.origin}${window.location.pathname}`
  ]
    .filter(Boolean)
    .join("\n");

  const params = new URLSearchParams({
    subject: `[Work Queue] ${task.title} (${boss.name})`,
    body: details,
    startdt: startStr,
    enddt: endStr,
    allday: "true",
    location: `${window.location.origin}${window.location.pathname}`
  });

  return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
}

// Generate and download an .ics file with built-in 30-day and 7-day advance VALARM triggers
function downloadTaskIcs(task, boss) {
  let targetDate = new Date();
  if (task.dueDate) {
    const [y, m, d] = task.dueDate.split("-").map(Number);
    targetDate = new Date(y, m - 1, d);
  } else {
    targetDate.setFullYear(targetDate.getFullYear() + 1);
  }

  const pad = (n) => String(n).padStart(2, "0");
  const startStr = `${targetDate.getFullYear()}${pad(targetDate.getMonth() + 1)}${pad(targetDate.getDate())}`;
  const nextDay = new Date(targetDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const endStr = `${nextDay.getFullYear()}${pad(nextDay.getMonth() + 1)}${pad(nextDay.getDate())}`;

  const escapeIcs = (str) =>
    String(str || "")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");

  const desc = [
    `Requester: ${boss.name}`,
    `Priority: ${task.priority || "Normal"}`,
    task.runbook ? `HOW TO DO IT (RUNBOOK): ${task.runbook}` : "",
    task.note ? `Note: ${task.note}` : "",
    `Board URL: ${window.location.origin}${window.location.pathname}`
  ]
    .filter(Boolean)
    .join("\n");

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ShowWhatIAmDoing//WorkBoard//EN",
    "BEGIN:VEVENT",
    `UID:${task.id}@show-what-i-am-doing`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    `DTSTART;VALUE=DATE:${startStr}`,
    `DTEND;VALUE=DATE:${endStr}`,
    `SUMMARY:${escapeIcs(`[Scheduled Task] ${task.title} (${boss.name})`)}`,
    `DESCRIPTION:${escapeIcs(desc)}`,
    "BEGIN:VALARM",
    "TRIGGER:-P30D",
    "ACTION:DISPLAY",
    "DESCRIPTION:30-Day Advance Reminder: Long-term scheduled task coming up!",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-P7D",
    "ACTION:DISPLAY",
    "DESCRIPTION:7-Day Advance Reminder: Scheduled task due in 1 week!",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-PT9H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Task is due today!",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ];

  const blob = new Blob([icsLines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reminder-${task.id}.ics`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Downloaded .ics Calendar Alarm (with 30d & 7d alerts)!");
}

// Load state: Priority 1 = URL snapshot (?data=...), Priority 2 = localStorage + data.json comparison
async function loadInitialState() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("data");
  if (encoded) {
    try {
      const jsonStr = decodeURIComponent(escape(atob(encoded)));
      state = JSON.parse(jsonStr);
      return;
    } catch (err) {
      console.warn("Failed to parse URL snapshot data:", err);
    }
  }

  let remoteData = null;
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      remoteData = await res.json();
    }
  } catch (err) {
    console.warn("Could not fetch data.json, falling back to local storage:", err);
  }

  const savedRaw = localStorage.getItem(STORAGE_KEY);
  let localData = null;
  if (savedRaw) {
    try {
      localData = JSON.parse(savedRaw);
    } catch (e) {
      localData = null;
    }
  }

  if (localData && remoteData) {
    const localTime = new Date(localData.profile?.lastUpdated || 0).getTime();
    const remoteTime = new Date(remoteData.profile?.lastUpdated || 0).getTime();
    state = localTime >= remoteTime ? localData : remoteData;
  } else {
    state = localData || remoteData || structuredClone(DEFAULT_FALLBACK);
  }
}

function snapshotState() {
  return JSON.parse(JSON.stringify(state));
}

function saveState() {
  if (historyBaseline) {
    undoStack.push(historyBaseline);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  redoStack = [];
  state.profile.lastUpdated = new Date().toISOString();
  historyBaseline = snapshotState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
}

function applyHistoryState(next) {
  state = next;
  historyBaseline = snapshotState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (editingCardId && !(state.tasks || []).some((t) => t.id === editingCardId)) {
    editingCardId = null;
    document.body.classList.remove("is-card-edit");
  }
  renderAll();
  const editingId = document.getElementById("editingTaskId").value;
  if (!editingId) return;
  const task = (state.tasks || []).find((t) => t.id === editingId);
  if (task) populateTaskFormForEdit(task, { preventScroll: true });
  else resetTaskForm();
}

function undoChange() {
  if (!undoStack.length) {
    showToast("Nothing to undo");
    return;
  }
  redoStack.push(snapshotState());
  if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  applyHistoryState(undoStack.pop());
  showToast("Undone");
}

function redoChange() {
  if (!redoStack.length) {
    showToast("Nothing to redo");
    return;
  }
  if (historyBaseline) {
    undoStack.push(historyBaseline);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  applyHistoryState(redoStack.pop());
  showToast("Redone");
}

function isTextEditingTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  const field = target.closest("input, textarea, [contenteditable='true']");
  if (!field) return false;
  if (field.tagName === "INPUT") {
    const type = (field.getAttribute("type") || "text").toLowerCase();
    const textTypes = ["text", "search", "email", "url", "password", "number", "tel"];
    if (!textTypes.includes(type)) return false;
  }
  return true;
}

function getBossById(bossId) {
  return (
    state.bosses.find((b) => b.id === bossId) || {
      id: bossId,
      name: "Unassigned",
      color: "#475569",
      bg: "#f1f5f9"
    }
  );
}

function renderHeaderAndSummary() {
  document.getElementById("boardTitle").textContent = state.profile.name;
  document.getElementById("boardSubtitle").textContent = state.profile.subtitle;
  document.getElementById("lastUpdatedText").textContent = formatRelativeTime(
    state.profile.lastUpdated
  );

  const badge = document.getElementById("capacityBadge");
  badge.className = `capacity-badge ${state.profile.capacityStatus || "busy"}`;
  const labels = {
    available: "🟢 Available for Requests",
    busy: "🟡 Focused / At Capacity",
    overloaded: "🔴 Deep Work / Urgent Delivery"
  };
  badge.textContent = labels[state.profile.capacityStatus] || labels.busy;
  document.getElementById("capacityNote").textContent =
    state.profile.capacityNote || "";

  // Count tasks by status
  const doingCount = state.tasks.filter((t) => t.status === "doing").length;
  const blockedCount = state.tasks.filter((t) => t.status === "blocked").length;
  const nextCount = state.tasks.filter((t) => t.status === "next").length;
  const scheduledCount = state.tasks.filter((t) => t.status === "scheduled").length;
  const doneCount = state.tasks.filter((t) => t.status === "done").length;

  document.getElementById("quickStats").innerHTML = `
    <span class="stat-pill">🔥 ${doingCount} Doing</span>
    <span class="stat-pill">📋 ${nextCount} Queued</span>
    ${blockedCount > 0 ? `<span class="stat-pill" style="background:#fee2e2;color:#b91c1c;">🚧 ${blockedCount} Blocked</span>` : ""}
    <span class="stat-pill" style="background:#f5f3ff;color:#5b21b6;">🕰️ ${scheduledCount} Future Vault</span>
    <span class="stat-pill">✅ ${doneCount} Done</span>
  `;

  // Check if any scheduled tasks are due within 30 days
  const dueSoonTasks = state.tasks.filter((t) => {
    if (t.status !== "scheduled" || !t.dueDate) return false;
    const info = getDueDateInfo(t.dueDate);
    return info && info.diffDays <= 30;
  });

  const dueBanner = document.getElementById("dueSoonBanner");
  if (dueSoonTasks.length > 0) {
    dueBanner.classList.remove("hidden");
    dueBanner.innerHTML = `
      <div>
        🔔 <strong>Long-Term Reminder Triggered:</strong> ${dueSoonTasks.length} scheduled future task(s) are due within 30 days (e.g., <em>${escapeHtml(dueSoonTasks[0].title)}</em>).
      </div>
      <span style="font-weight:700;">Ready to move to "Up Next"!</span>
    `;
  } else {
    dueBanner.classList.add("hidden");
  }

  // Active workload split by boss (doing + next + blocked)
  const activeTasks = state.tasks.filter(
    (t) => t.status === "doing" || t.status === "next" || t.status === "blocked"
  );
  const totalActive = activeTasks.length;
  document.getElementById("totalActiveCount").textContent =
    `${totalActive} active item${totalActive === 1 ? "" : "s"}`;

  const barEl = document.getElementById("workloadBar");
  const legendEl = document.getElementById("workloadLegend");
  barEl.innerHTML = "";
  legendEl.innerHTML = "";

  state.bosses.forEach((boss) => {
    const bossActive = activeTasks.filter((t) => t.bossId === boss.id).length;
    const bossDoing = state.tasks.filter(
      (t) => t.bossId === boss.id && t.status === "doing"
    ).length;
    const bossScheduled = state.tasks.filter(
      (t) => t.bossId === boss.id && t.status === "scheduled"
    ).length;
    const pct = totalActive > 0 ? Math.round((bossActive / totalActive) * 100) : 0;

    if (bossActive > 0) {
      const seg = document.createElement("div");
      seg.className = "workload-segment";
      seg.style.width = `${(bossActive / totalActive) * 100}%`;
      seg.style.backgroundColor = boss.color;
      seg.title = `${boss.name}: ${bossActive} active (${pct}%)`;
      barEl.appendChild(seg);
    }

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${boss.color}"></span>
      <span>${escapeHtml(boss.name)}:</span>
      <span class="legend-count">${bossActive} active (${pct}%)</span>
      ${bossDoing > 0 ? `<span style="font-size:11px;color:#2563eb;font-weight:600;">• ${bossDoing} in progress</span>` : ""}
      ${bossScheduled > 0 ? `<span style="font-size:11px;color:#7c3aed;font-weight:600;">• ${bossScheduled} long-term</span>` : ""}
    `;
    legendEl.appendChild(item);
  });
}

function renderBossFiltersAndSelect() {
  const filterWrap = document.getElementById("bossFilters");
  filterWrap.innerHTML = "";

  const allCount = state.tasks.filter((t) => t.status !== "done").length;
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `filter-tab ${activeBossFilter === "all" ? "active" : ""}`;
  allBtn.innerHTML = `All Bosses <span class="filter-count">${allCount}</span>`;
  allBtn.addEventListener("click", () => {
    activeBossFilter = "all";
    renderAll();
  });
  filterWrap.appendChild(allBtn);

  state.bosses.forEach((boss) => {
    const count = state.tasks.filter(
      (t) => t.bossId === boss.id && t.status !== "done"
    ).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `filter-tab ${activeBossFilter === boss.id ? "active" : ""}`;
    btn.innerHTML = `
      <span class="legend-swatch" style="background:${boss.color}"></span>
      ${escapeHtml(boss.name)}
      <span class="filter-count">${count}</span>
    `;
    btn.addEventListener("click", () => {
      activeBossFilter = boss.id;
      renderAll();
    });
    filterWrap.appendChild(btn);
  });

  // Populate task form select
  const select = document.getElementById("taskBoss");
  const currentVal = select.value;
  select.innerHTML = "";
  state.bosses.forEach((boss) => {
    const opt = document.createElement("option");
    opt.value = boss.id;
    opt.textContent = boss.name;
    select.appendChild(opt);
  });
  if (currentVal && state.bosses.some((b) => b.id === currentVal)) {
    select.value = currentVal;
  }
}

function matchesFilter(task) {
  if (activeBossFilter !== "all" && task.bossId !== activeBossFilter) {
    return false;
  }
  if (searchQuery.trim() !== "") {
    const q = searchQuery.toLowerCase();
    const boss = getBossById(task.bossId);
    const miniText = (task.miniTasks || [])
      .map((m) => `${m.text || ""} ${m.resultNote || ""} ${m.result || ""}`)
      .join(" ");
    const hay = `${task.title} ${task.note || ""} ${task.eta || ""} ${task.runbook || ""} ${task.triggerPlan || ""} ${miniText} ${boss.name}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const MINI_STAGES = {
  todo: "To do",
  doing: "Doing",
  done: "Done"
};

const MINI_RESULTS = {
  "": "No result yet",
  positive: "Positive",
  negative: "Negative",
  unclear: "Unclear"
};

function normalizeMini(mini) {
  if (!mini.stage) mini.stage = mini.done ? "done" : "todo";
  if (!MINI_STAGES[mini.stage]) mini.stage = "todo";
  mini.done = mini.stage === "done";
  if (!MINI_RESULTS.hasOwnProperty(mini.result)) mini.result = "";
  if (typeof mini.resultNote !== "string") mini.resultNote = "";
  return mini;
}

function ensureMiniTasks(task) {
  if (!Array.isArray(task.miniTasks)) {
    task.miniTasks = [];
  }
  task.miniTasks.forEach(normalizeMini);
  return task.miniTasks;
}

function getMiniProgress(task) {
  const list = task.miniTasks || [];
  if (list.length === 0) return null;
  const done = list.filter((m) => m.stage === "done" || m.done).length;
  const doing = list.filter((m) => m.stage === "doing").length;
  return { done, doing, total: list.length, allDone: done === list.length };
}

function miniStageOptions(selected) {
  return Object.entries(MINI_STAGES)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function miniResultOptions(selected) {
  return Object.entries(MINI_RESULTS)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function renderMiniResultRead(mini) {
  if (!mini.result && !mini.resultNote) return "";
  const label = MINI_RESULTS[mini.result] || "Result";
  const kind = mini.result || "note";
  return `
    <div class="mini-result-read result-${kind}">
      <span class="mini-result-label">Result · ${escapeHtml(label)}</span>
      ${mini.resultNote ? `<span class="mini-result-note">${escapeHtml(mini.resultNote)}</span>` : ""}
    </div>
  `;
}

function cardIsEditable(task) {
  return isEditMode || task.id === editingCardId;
}

function renderMiniTasksHtml(task, status) {
  // Show mini checklist on active work; hide on done unless there are leftovers
  const list = task.miniTasks || [];
  const editable = cardIsEditable(task);
  const showForBoss = list.length > 0;
  const showForEdit = editable && status !== "done" && status !== "scheduled";

  if (!showForBoss && !showForEdit) return "";

  const progress = getMiniProgress(task);
  const itemsHtml =
    list.length === 0
      ? `<div class="mini-empty">No mini-tasks yet — add today's small asks here (not as new board cards).</div>`
      : `<ul class="mini-list">${list
          .map((m) => {
            normalizeMini(m);
            const stageClass = `stage-${m.stage}`;
            return `
        <li class="mini-item ${m.stage === "done" ? "done" : ""} ${stageClass}" data-mini-id="${escapeHtml(m.id)}">
          <div class="mini-main">
            ${
              editable
                ? `<select class="mini-stage js-mini-stage" title="What I am doing with this mini-task">${miniStageOptions(m.stage)}</select>`
                : `<span class="mini-stage-pill ${stageClass}">${MINI_STAGES[m.stage]}</span>`
            }
            <span class="mini-text" ${editable ? 'title="Click the pencil to edit"' : ""}>${escapeHtml(m.text)}</span>
            ${
              editable
                ? `<button type="button" class="mini-edit js-mini-edit" title="Edit mini-task">✏️</button>
                   <button type="button" class="mini-delete js-mini-delete" title="Remove mini-task">✕</button>`
                : ""
            }
          </div>
          ${
            editable
              ? `<div class="mini-result-row">
                   <select class="mini-result js-mini-result" title="Result">${miniResultOptions(m.result)}</select>
                   <input type="text" class="js-mini-result-note" value="${escapeHtml(m.resultNote || "")}" placeholder="Result comment, e.g. Copilot API works. Need admin to enable it." />
                 </div>`
              : renderMiniResultRead(m)
          }
        </li>`;
          })
          .join("")}</ul>`;

  const addRow = editable
    ? `<div class="mini-add-row">
        <input type="text" class="js-mini-input" placeholder="Add a mini-task for today... e.g. Check webhook logs" />
        <button type="button" class="btn btn-sm btn-secondary js-mini-add">+ Add</button>
      </div>`
    : "";

  return `
    <div class="mini-box">
      <div class="mini-box-header">
        <span>Daily Mini-Tasks (inside this project)</span>
        ${
          progress
            ? `<span class="mini-progress ${progress.allDone ? "all-done" : ""}">${progress.done}/${progress.total} done${progress.doing ? ` · ${progress.doing} doing` : ""}</span>`
            : ""
        }
      </div>
      ${itemsHtml}
      ${addRow}
    </div>
  `;
}

function beginMiniEdit(row, mini) {
  if (row.querySelector(".js-mini-edit-input")) return;
  const textEl = row.querySelector(".mini-text");
  if (!textEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "js-mini-edit-input";
  input.value = mini.text;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  let closed = false;
  const close = (save) => {
    if (closed) return;
    closed = true;
    if (!save) {
      renderAll();
      return;
    }
    const next = input.value.trim();
    if (!next) {
      closed = false;
      input.focus();
      showToast("Mini-task needs some text");
      return;
    }
    if (next === mini.text) {
      renderAll();
      return;
    }
    mini.text = next;
    saveState();
    showToast("Mini-task updated");
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  });
  input.addEventListener("blur", () => close(true));
}

function bindMiniTaskControls(cardEl, task) {
  ensureMiniTasks(task);

  const applyMiniRow = (row) => {
    const mini = task.miniTasks.find((m) => m.id === row.dataset.miniId);
    if (!mini) return null;
    const stage = row.querySelector(".js-mini-stage");
    const result = row.querySelector(".js-mini-result");
    const note = row.querySelector(".js-mini-result-note");
    if (stage) mini.stage = stage.value;
    if (result) mini.result = result.value;
    if (note) mini.resultNote = note.value.trim();
    mini.done = mini.stage === "done";
    return mini;
  };

  cardEl.querySelectorAll(".js-mini-stage, .js-mini-result").forEach((select) => {
    select.addEventListener("change", (e) => {
      const row = e.target.closest(".mini-item");
      if (!applyMiniRow(row)) return;
      saveState();
    });
  });

  cardEl.querySelectorAll(".js-mini-result-note").forEach((input) => {
    input.addEventListener("change", (e) => {
      const row = e.target.closest(".mini-item");
      if (!applyMiniRow(row)) return;
      saveState();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
    });
  });

  cardEl.querySelectorAll(".js-mini-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".mini-item");
      const mini = task.miniTasks.find((m) => m.id === row.dataset.miniId);
      if (!mini) return;
      beginMiniEdit(row, mini);
    });
  });

  cardEl.querySelectorAll(".js-mini-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".mini-item");
      task.miniTasks = task.miniTasks.filter((m) => m.id !== row.dataset.miniId);
      saveState();
      showToast("Mini-task removed");
    });
  });

  const addBtn = cardEl.querySelector(".js-mini-add");
  const input = cardEl.querySelector(".js-mini-input");
  if (addBtn && input) {
    const addMini = () => {
      const text = input.value.trim();
      if (!text) return;
      ensureMiniTasks(task);
      task.miniTasks.push({
        id: "m-" + Date.now(),
        text,
        stage: "todo",
        done: false,
        result: "",
        resultNote: "",
        createdAt: new Date().toISOString()
      });
      input.value = "";
      saveState();
      showToast("Mini-task added");
    };
    addBtn.addEventListener("click", addMini);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addMini();
      }
    });
  }
}

function renderTaskSections() {
  const sections = [
    { status: "doing", listId: "listDoing", countId: "countDoing", emptyText: "Nothing marked as 'Doing Right Now'." },
    { status: "blocked", listId: "listBlocked", countId: "countBlocked", emptyText: "No blocked tasks right now." },
    { status: "next", listId: "listNext", countId: "countNext", emptyText: "Queue is clear!" },
    { status: "scheduled", listId: "listScheduled", countId: "countScheduled", emptyText: "No future long-term tasks scheduled." },
    { status: "done", listId: "listDone", countId: "countDone", emptyText: "No completed tasks recorded yet." }
  ];

  sections.forEach(({ status, listId, countId, emptyText }) => {
    let allInStatus = state.tasks.filter((t) => t.status === status);
    // Sort scheduled tasks by nearest target date first
    if (status === "scheduled") {
      allInStatus = [...allInStatus].sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    }

    const filtered = allInStatus.filter(matchesFilter);

    document.getElementById(countId).textContent = filtered.length;
    const listEl = document.getElementById(listId);
    listEl.innerHTML = "";
    listEl.dataset.status = status;
    bindListDrop(listEl);

    // Hide blocked section in read-only mode if 0 blocked items
    if (status === "blocked") {
      const wrap = document.getElementById("sectionBlockedWrap");
      if (allInStatus.length === 0 && !isEditMode) {
        wrap.classList.add("hidden");
      } else {
        wrap.classList.remove("hidden");
      }
    }

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = emptyText;
      listEl.appendChild(empty);
      return;
    }

    filtered.forEach((task) => {
      const trueIndex = allInStatus.findIndex((t) => t.id === task.id);
      const boss = getBossById(task.bossId);
      const card = document.createElement("div");
      card.className = "task-card";
      card.dataset.taskId = task.id;

      let rankBadge = "";
      if (status === "next") {
        rankBadge = `<span class="queue-rank" title="Queue position #${trueIndex + 1}">#${trueIndex + 1}</span>`;
      } else if (status === "doing") {
        rankBadge = `<span class="queue-rank" title="In Progress">NOW</span>`;
      } else if (status === "blocked") {
        rankBadge = `<span class="queue-rank" title="Blocked">!</span>`;
      } else if (status === "scheduled") {
        rankBadge = `<span class="queue-rank" title="Scheduled Future Task">🕰️</span>`;
      } else {
        rankBadge = `<span class="queue-rank" title="Done">✓</span>`;
      }

      const bossBg = boss.bg || hexToSoftBg(boss.color);
      const dueInfo = task.dueDate ? getDueDateInfo(task.dueDate) : null;
      const miniProgress = getMiniProgress(task);

      let countdownHtml = "";
      if (dueInfo) {
        countdownHtml = `<span class="countdown-badge ${dueInfo.urgencyClass}" title="Target Date: ${dueInfo.formattedDate}">⏳ ${escapeHtml(dueInfo.countdownText)} • ${escapeHtml(dueInfo.formattedDate)}</span>`;
      }

      let miniProgressBadge = "";
      if (miniProgress) {
        miniProgressBadge = `<span class="mini-progress ${miniProgress.allDone ? "all-done" : ""}" title="Daily mini-tasks progress">${miniProgress.done}/${miniProgress.total} mini</span>`;
      }

      let futureDetailsHtml = "";
      if (status === "scheduled" || task.runbook || task.triggerPlan) {
        const outlookUrl = status === "scheduled" ? buildOutlookCalendarUrl(task, boss) : "";
        futureDetailsHtml = `
          <div class="future-meta-box">
            ${
              task.triggerPlan
                ? `<div class="future-meta-row"><span class="future-meta-label">🔔 How I'll Remember:</span> <span>${escapeHtml(task.triggerPlan)}</span></div>`
                : ""
            }
            ${
              task.runbook
                ? `<div class="future-meta-row"><span class="future-meta-label">📖 How to Do It (Runbook):</span> <span>${escapeHtml(task.runbook)}</span></div>`
                : ""
            }
            <div class="reminder-actions">
              <button type="button" class="reminder-btn js-download-ics">📅 Download Calendar Alarm (.ics w/ 30d &amp; 7d alerts)</button>
              ${
                outlookUrl
                  ? `<a href="${escapeHtml(outlookUrl)}" target="_blank" rel="noopener" class="reminder-btn">📤 Send to Outlook</a>`
                  : ""
              }
              ${
                dueInfo && dueInfo.diffDays <= 30
                  ? `<button type="button" class="reminder-btn js-promote-next" style="background:#fef3c7;border-color:#f59e0b;color:#92400e;">⚡ Move to 'Up Next' Queue Now</button>`
                  : ""
              }
            </div>
          </div>
        `;
      }

      const miniHtml = renderMiniTasksHtml(task, status);

      const editable = cardIsEditable(task);
      if (expandedCardIds.has(task.id)) card.classList.add("is-expanded");
      if (task.id === editingCardId) card.classList.add("is-editing");

      card.innerHTML = `
        <div class="task-left">
          <span class="drag-handle" draggable="true" role="button" aria-label="Drag to reorder" title="Drag to reorder">
            <span class="drag-grip" aria-hidden="true"></span>
          </span>
          ${rankBadge}
          <div class="task-content">
            <div class="task-top-row">
              <span class="boss-tag" style="background:${bossBg}; color:${boss.color}; border: 1px solid ${boss.color}33;">
                <span class="legend-swatch" style="background:${boss.color};width:7px;height:7px;"></span>
                ${escapeHtml(boss.name)}
              </span>
              <span class="priority-badge priority-${task.priority || "Normal"}">${escapeHtml(task.priority || "Normal")}</span>
              ${miniProgressBadge}
              ${countdownHtml}
              <span class="task-title">${escapeHtml(task.title)}</span>
            </div>
            ${task.note ? `<div class="task-note">${status === "blocked" ? "⚠️ Blocker: " : ""}${escapeHtml(task.note)}</div>` : ""}
            ${futureDetailsHtml}
            ${miniHtml}
            <span class="card-expand-hint">Click to expand</span>
          </div>
        </div>
        <div class="task-right">
          ${task.eta ? `<span class="eta-badge">⏱ ${escapeHtml(task.eta)}</span>` : ""}
          ${editable ? renderEditControls(task, trueIndex, allInStatus.length) : ""}
        </div>
      `;

      // Bind calendar export buttons (available in both Boss & Edit views!)
      const icsBtn = card.querySelector(".js-download-ics");
      if (icsBtn) {
        icsBtn.addEventListener("click", () => downloadTaskIcs(task, boss));
      }
      const promoteBtn = card.querySelector(".js-promote-next");
      if (promoteBtn) {
        promoteBtn.addEventListener("click", () => {
          task.status = "next";
          saveState();
          showToast("Moved scheduled task to 'Up Next' queue!");
        });
      }

      bindMiniTaskControls(card, task);
      if (editable) bindCardControls(card, task);
      bindCardGestures(card, task);
      bindCardDrag(card, task);

      listEl.appendChild(card);
      markCardClamp(card);
      refreshCardGestureTitle(card);
    });
  });
}

function renderEditControls(task, indexInGroup, groupLen) {
  return `
    <div class="task-controls">
      <select class="ctrl-select js-status-select" title="Move stage">
        <option value="doing" ${task.status === "doing" ? "selected" : ""}>🔥 Doing</option>
        <option value="next" ${task.status === "next" ? "selected" : ""}>📋 Up Next</option>
        <option value="blocked" ${task.status === "blocked" ? "selected" : ""}>🚧 Blocked</option>
        <option value="scheduled" ${task.status === "scheduled" ? "selected" : ""}>🕰️ Future Vault</option>
        <option value="done" ${task.status === "done" ? "selected" : ""}>✅ Done</option>
      </select>
      <button type="button" class="ctrl-btn js-move-up" title="Move Up" ${indexInGroup === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="ctrl-btn js-move-down" title="Move Down" ${indexInGroup === groupLen - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="ctrl-btn js-edit-task" title="Edit task">✏️</button>
      <button type="button" class="ctrl-btn js-delete-task" title="Delete task">🗑️</button>
    </div>
  `;
}

function bindCardControls(cardEl, task) {
  const statusSelect = cardEl.querySelector(".js-status-select");
  statusSelect.addEventListener("change", (e) => {
    task.status = e.target.value;
    if (task.status === "done" && (!task.eta || !task.eta.toLowerCase().includes("completed"))) {
      const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
      task.eta = `Completed ${today}`;
    }
    saveState();
    showToast("Task stage updated");
  });

  cardEl.querySelector(".js-move-up").addEventListener("click", () => {
    moveTaskWithinStatus(task.id, -1);
  });

  cardEl.querySelector(".js-move-down").addEventListener("click", () => {
    moveTaskWithinStatus(task.id, 1);
  });

  cardEl.querySelector(".js-edit-task").addEventListener("click", () => {
    document.getElementById("editPanel").classList.remove("hidden");
    populateTaskFormForEdit(task);
  });

  cardEl.querySelector(".js-delete-task").addEventListener("click", () => {
    const removedId = task.id;
    state.tasks = state.tasks.filter((t) => t.id !== removedId);
    if (editingCardId === removedId) editingCardId = null;
    if (!isEditMode && !editingCardId) {
      document.body.classList.remove("is-card-edit");
      document.getElementById("editPanel").classList.add("hidden");
      resetTaskForm();
    }
    saveState();
    showToast("Task removed");
  });
}

let dragTaskId = null;

function clearDropMarkers() {
  document.querySelectorAll(".drop-before, .drop-after, .drop-target").forEach((el) => {
    el.classList.remove("drop-before", "drop-after", "drop-target");
  });
}

function dropMarker(listEl, clientY) {
  const cards = [...listEl.querySelectorAll(".task-card")].filter(
    (card) => card.dataset.taskId !== dragTaskId
  );
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return card.dataset.taskId;
  }
  return null;
}

function showDropMarker(listEl, beforeId) {
  clearDropMarkers();
  listEl.classList.add("drop-target");
  if (beforeId) {
    const card = listEl.querySelector(`.task-card[data-task-id="${CSS.escape(beforeId)}"]`);
    if (card) card.classList.add("drop-before");
    return;
  }
  const cards = [...listEl.querySelectorAll(".task-card")].filter(
    (card) => card.dataset.taskId !== dragTaskId
  );
  const last = cards[cards.length - 1];
  if (last) last.classList.add("drop-after");
}

function bindListDrop(listEl) {
  if (listEl.dataset.dropBound) return;
  listEl.dataset.dropBound = "1";
  listEl.addEventListener("dragover", (event) => {
    if (!dragTaskId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    showDropMarker(listEl, dropMarker(listEl, event.clientY));
  });
  listEl.addEventListener("dragleave", (event) => {
    if (listEl.contains(event.relatedTarget)) return;
    clearDropMarkers();
  });
  listEl.addEventListener("drop", (event) => {
    if (!dragTaskId) return;
    event.preventDefault();
    const taskId = dragTaskId;
    const beforeId = dropMarker(listEl, event.clientY);
    const targetStatus = listEl.dataset.status;
    clearDropMarkers();
    moveTaskTo(taskId, targetStatus, beforeId);
  });
}

function bindCardDrag(card, task) {
  const handle = card.querySelector(".drag-handle");
  if (!handle) return;
  handle.addEventListener("mousedown", (event) => event.stopPropagation());
  handle.addEventListener("click", (event) => event.stopPropagation());
  handle.addEventListener("dragstart", (event) => {
    dragTaskId = task.id;
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("is-dragging");
    event.dataTransfer.setDragImage(card, 24, 24);
  });
  handle.addEventListener("dragend", () => {
    dragTaskId = null;
    card.classList.remove("is-dragging");
    clearDropMarkers();
  });
}

function rewriteGroup(orderedIds) {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const block = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const blockSet = new Set(orderedIds);
  const rest = [];
  let insertAt = null;
  state.tasks.forEach((task) => {
    if (blockSet.has(task.id)) {
      if (insertAt === null) insertAt = rest.length;
      return;
    }
    rest.push(task);
  });
  if (insertAt === null) insertAt = rest.length;
  rest.splice(insertAt, 0, ...block);
  state.tasks = rest;
}

function moveTaskTo(taskId, targetStatus, beforeId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !targetStatus) return;
  const fromStatus = task.status;

  if (fromStatus === targetStatus) {
    if (targetStatus === "scheduled") return;
    const ids = state.tasks.filter((item) => item.status === targetStatus).map((item) => item.id);
    const from = ids.indexOf(taskId);
    const without = ids.filter((id) => id !== taskId);
    let insertAt = without.length;
    if (beforeId) {
      const idx = without.indexOf(beforeId);
      if (idx >= 0) insertAt = idx;
    }
    if (from < 0 || insertAt === from) return;
    without.splice(insertAt, 0, taskId);
    rewriteGroup(without);
    saveState();
    showToast("Order updated");
    return;
  }

  if (targetStatus === "done" && (!task.eta || !task.eta.toLowerCase().includes("completed"))) {
    const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    task.eta = `Completed ${today}`;
  }
  task.status = targetStatus;

  if (targetStatus === "scheduled") {
    saveState();
    showToast("Moved to Future vault");
    return;
  }

  const without = state.tasks
    .filter((item) => item.status === targetStatus && item.id !== taskId)
    .map((item) => item.id);
  let insertAt = without.length;
  if (beforeId) {
    const idx = without.indexOf(beforeId);
    if (idx >= 0) insertAt = idx;
  }
  without.splice(insertAt, 0, taskId);
  rewriteGroup(without);
  saveState();
  showToast("Task moved");
}

function moveTaskWithinStatus(taskId, direction) {
  const target = state.tasks.find((t) => t.id === taskId);
  if (!target) return;
  const sameStatusIndices = state.tasks
    .map((t, idx) => (t.status === target.status ? idx : -1))
    .filter((idx) => idx !== -1);

  const currentPosInStatus = sameStatusIndices.findIndex(
    (idx) => state.tasks[idx].id === taskId
  );
  const swapPosInStatus = currentPosInStatus + direction;
  if (swapPosInStatus < 0 || swapPosInStatus >= sameStatusIndices.length) return;

  const idxA = sameStatusIndices[currentPosInStatus];
  const idxB = sameStatusIndices[swapPosInStatus];
  const temp = state.tasks[idxA];
  state.tasks[idxA] = state.tasks[idxB];
  state.tasks[idxB] = temp;
  saveState();
}

function updateFutureFieldsVisibility() {
  const statusVal = document.getElementById("taskStatus").value;
  const wrap = document.getElementById("futureFieldsWrap");
  if (statusVal === "scheduled") {
    wrap.classList.remove("hidden");
  } else {
    wrap.classList.add("hidden");
  }
}

function populateTaskFormForEdit(task, options) {
  document.getElementById("editingTaskId").value = task.id;
  document.getElementById("taskTitle").value = task.title;
  document.getElementById("taskBoss").value = task.bossId;
  document.getElementById("taskStatus").value = task.status;
  document.getElementById("taskPriority").value = task.priority || "Normal";
  document.getElementById("taskEta").value = task.eta || "";
  document.getElementById("taskNote").value = task.note || "";
  document.getElementById("taskDueDate").value = task.dueDate || "";
  document.getElementById("taskTriggerPlan").value =
    task.triggerPlan || "GitHub Repo + Calendar Alarm (30d & 7d advance alert)";
  document.getElementById("taskRunbook").value = task.runbook || "";

  updateFutureFieldsVisibility();
  if (task.dueDate || task.runbook) {
    document.getElementById("futureFieldsWrap").classList.remove("hidden");
  }

  document.getElementById("saveTaskBtn").textContent = "Save Changes";
  document.getElementById("cancelEditTaskBtn").classList.remove("hidden");
  document.getElementById("taskTitle").focus({ preventScroll: Boolean(options && options.preventScroll) });
}

function resetTaskForm() {
  document.getElementById("editingTaskId").value = "";
  document.getElementById("taskTitle").value = "";
  document.getElementById("taskStatus").value = "next";
  document.getElementById("taskPriority").value = "Normal";
  document.getElementById("taskEta").value = "";
  document.getElementById("taskNote").value = "";
  document.getElementById("taskDueDate").value = "";
  document.getElementById("taskTriggerPlan").value =
    "GitHub Repo + Calendar Alarm (30d & 7d advance alert)";
  document.getElementById("taskRunbook").value = "";
  updateFutureFieldsVisibility();
  document.getElementById("saveTaskBtn").textContent = "+ Add Task";
  document.getElementById("cancelEditTaskBtn").classList.add("hidden");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAll() {
  renderHeaderAndSummary();
  renderBossFiltersAndSelect();
  renderTaskSections();
}

function collapsedMaxPx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--card-collapsed-max");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 172;
}

function markCardClamp(card) {
  const content = card.querySelector(".task-content");
  if (!content) return;
  content.classList.toggle("is-clamped", content.scrollHeight > collapsedMaxPx() + 1);
}

function refreshCardGestureTitle(card) {
  const content = card.querySelector(".task-content");
  const hint = card.querySelector(".card-expand-hint");
  const clamped = Boolean(content && content.classList.contains("is-clamped"));
  const open = card.classList.contains("is-expanded") || card.classList.contains("is-editing");
  if (hint) hint.textContent = open ? "Click to collapse" : "Click to expand";
  if (open && clamped) card.title = "Click the title to collapse. Double-click to edit.";
  else if (clamped) card.title = "Click to expand details. Double-click to edit.";
  else card.title = "Double-click to edit.";
}

function setCardExpanded(taskId, expanded) {
  if (expanded) expandedCardIds.add(taskId);
  else expandedCardIds.delete(taskId);
  const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`);
  if (!card) return;
  card.classList.toggle("is-expanded", expanded);
  refreshCardGestureTitle(card);
}

function cardGestureIgnored(event, card) {
  if (event.target.closest("button, a, input, select, textarea, label, .drag-handle")) return true;
  const open = card.classList.contains("is-expanded") || card.classList.contains("is-editing");
  if (open && event.target.closest(".mini-box, .future-meta-box, .task-note, .reminder-actions")) return true;
  return false;
}

function bindCardGestures(card, task) {
  let pending = null;
  card.addEventListener("mousedown", (event) => {
    if (event.detail > 1) event.preventDefault();
  });
  card.addEventListener("click", (event) => {
    if (cardGestureIgnored(event, card)) return;
    if (event.detail > 1) {
      clearTimeout(pending);
      pending = null;
      return;
    }
    const content = card.querySelector(".task-content");
    if (!content || !content.classList.contains("is-clamped")) return;
    if (editingCardId === task.id) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (editingCardId === task.id) return;
      setCardExpanded(task.id, !expandedCardIds.has(task.id));
    }, CLICK_EXPAND_DELAY_MS);
  });
  card.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, a, input, select, textarea, label, .drag-handle")) return;
    clearTimeout(pending);
    pending = null;
    event.preventDefault();
    const anchorTop = card.getBoundingClientRect().top;
    expandedCardIds.add(task.id);
    if (isEditMode) {
      if (editingCardId !== task.id) {
        editingCardId = task.id;
        document.body.classList.add("is-card-edit");
        renderAll();
        keepClickedCardInPlace({ taskId: task.id, top: anchorTop });
      }
      document.getElementById("editPanel").classList.remove("hidden");
      const fresh = state.tasks.find((t) => t.id === task.id) || task;
      populateTaskFormForEdit(fresh, { preventScroll: true });
      return;
    }
    if (editingCardId === task.id) return;
    openCardForEdit(task, anchorTop);
  });
}

function setEditMode(enabled, anchor) {
  if (isEditMode === enabled) return;
  if (!anchor && !enabled) anchor = firstVisibleTaskAnchor();
  isEditMode = enabled;
  editingCardId = null;
  document.body.classList.toggle("is-edit-mode", isEditMode);
  document.body.classList.remove("is-card-edit");
  const toggleEditBtn = document.getElementById("toggleEditBtn");
  const editPanel = document.getElementById("editPanel");
  editPanel.classList.toggle("hidden", !isEditMode);
  toggleEditBtn.classList.toggle("active", isEditMode);
  toggleEditBtn.textContent = isEditMode ? "👁️ View as Boss" : "✏️ Manage / Record Work";
  renderAll();
  if (anchor) keepClickedCardInPlace(anchor);
}

function openCardForEdit(task, anchorTop) {
  editingCardId = task.id;
  document.body.classList.add("is-card-edit");
  if (!isEditMode) {
    document.getElementById("editPanel").classList.add("hidden");
    resetTaskForm();
  }
  renderAll();
  keepClickedCardInPlace({ taskId: task.id, top: anchorTop });
}

function closeCardEdit() {
  if (!editingCardId) return;
  const anchor = firstVisibleTaskAnchor();
  editingCardId = null;
  document.body.classList.remove("is-card-edit");
  if (!isEditMode) {
    document.getElementById("editPanel").classList.add("hidden");
    resetTaskForm();
  }
  renderAll();
  if (anchor) keepClickedCardInPlace(anchor);
}

function firstVisibleTaskAnchor() {
  const card = [...document.querySelectorAll(".task-card")].find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < window.innerHeight;
  });
  if (!card) return null;
  return { taskId: card.dataset.taskId, top: card.getBoundingClientRect().top };
}

function keepClickedCardInPlace(anchor) {
  const place = () => {
    const card = document.querySelector(
      `.task-card[data-task-id="${CSS.escape(anchor.taskId)}"]`
    );
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    const delta = top - anchor.top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  };
  place();
  requestAnimationFrame(place);
  setTimeout(place, 0);
}

// Settings Modal Logic
function openSettingsModal() {
  document.getElementById("settingBoardTitle").value = state.profile.name || "";
  document.getElementById("settingBoardSubtitle").value = state.profile.subtitle || "";
  document.getElementById("settingCapacityStatus").value = state.profile.capacityStatus || "busy";
  document.getElementById("settingCapacityNote").value = state.profile.capacityNote || "";

  renderBossConfigRows(state.bosses);
  document.getElementById("settingsModal").classList.remove("hidden");
}

function renderBossConfigRows(bossesList) {
  const container = document.getElementById("bossConfigList");
  container.innerHTML = "";
  bossesList.forEach((boss) => {
    const row = document.createElement("div");
    row.className = "boss-config-row";
    row.dataset.id = boss.id;
    row.innerHTML = `
      <input type="color" class="js-boss-color" value="${boss.color || "#2563eb"}" />
      <input type="text" class="js-boss-name" value="${escapeHtml(boss.name)}" placeholder="Boss / Team Name" required />
      ${bossesList.length > 1 ? `<button type="button" class="ctrl-btn js-remove-boss" title="Remove">✕</button>` : ""}
    `;
    const removeBtn = row.querySelector(".js-remove-boss");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        row.remove();
      });
    }
    container.appendChild(row);
  });
}

// GitHub Direct Publish Logic
function openGithubModal() {
  const saved = JSON.parse(localStorage.getItem(GH_CONFIG_KEY) || "{}");
  let defaultRepo = saved.repo || "";
  if (!defaultRepo && window.location.hostname.endsWith(".github.io")) {
    const username = window.location.hostname.replace(".github.io", "");
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      defaultRepo = `${username}/${pathParts[0]}`;
    }
  }
  document.getElementById("ghRepo").value = defaultRepo;
  document.getElementById("ghBranch").value = saved.branch || "main";
  document.getElementById("ghToken").value = saved.token || "";
  document.getElementById("ghStatusMsg").classList.add("hidden");
  document.getElementById("githubModal").classList.remove("hidden");
}

async function publishToGitHub(e) {
  e.preventDefault();
  const repo = document.getElementById("ghRepo").value.trim();
  const branch = document.getElementById("ghBranch").value.trim() || "main";
  const token = document.getElementById("ghToken").value.trim();
  const statusEl = document.getElementById("ghStatusMsg");
  const btn = document.getElementById("confirmGithubPushBtn");

  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify({ repo, branch, token }));

  statusEl.className = "status-msg";
  statusEl.textContent = "Publishing data.json to GitHub...";
  statusEl.classList.remove("hidden");
  btn.disabled = true;

  try {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/data.json`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json"
    };

    let sha = undefined;
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    const jsonString = JSON.stringify(state, null, 2);
    const contentBase64 = btoa(unescape(encodeURIComponent(jsonString)));

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Update work board (${new Date().toLocaleDateString()})`,
        content: contentBase64,
        branch,
        ...(sha ? { sha } : {})
      })
    });

    if (!putRes.ok) {
      const errJson = await putRes.json().catch(() => ({}));
      throw new Error(errJson.message || `GitHub API returned ${putRes.status}`);
    }

    statusEl.className = "status-msg success";
    statusEl.textContent = "✅ Published! GitHub Pages will update within ~30–60 seconds.";
    showToast("Published to GitHub!");
  } catch (err) {
    statusEl.className = "status-msg error";
    statusEl.textContent = `❌ Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Event Listeners Setup
document.addEventListener("DOMContentLoaded", async () => {
  await loadInitialState();
  historyBaseline = snapshotState();
  renderAll();

  const toggleEditBtn = document.getElementById("toggleEditBtn");

  toggleEditBtn.addEventListener("click", () => {
    setEditMode(!isEditMode);
  });

  document.addEventListener("keydown", (event) => {
    const key = (event.key || "").toLowerCase();
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey && key === "z";
    if (shortcut && !isTextEditingTarget(event.target)) {
      event.preventDefault();
      if (event.shiftKey) redoChange();
      else undoChange();
      return;
    }
    if (event.key !== "Escape" || (!isEditMode && !editingCardId)) return;
    const modalOpen = ["settingsModal", "githubModal"].some(
      (id) => !document.getElementById(id).classList.contains("hidden")
    );
    if (modalOpen) return;
    event.preventDefault();
    if (isEditMode) setEditMode(false);
    else closeCardEdit();
  });

  // Show/hide Future fields when stage changes
  document.getElementById("taskStatus").addEventListener("change", updateFutureFieldsVisibility);

  // Quick date preset buttons (+6m, +1yr, +2yr)
  document.querySelectorAll(".js-date-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const months = parseInt(btn.dataset.months, 10) || 12;
      const d = new Date();
      d.setMonth(d.getMonth() + months);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      document.getElementById("taskDueDate").value = `${yyyy}-${mm}-${dd}`;
      const formatted = d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
      });
      document.getElementById("taskEta").value = `Due ${formatted}`;
    });
  });

  // Search filter
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderTaskSections();
  });

  // Add / Edit Task Submit
  document.getElementById("taskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const editingId = document.getElementById("editingTaskId").value;
    const status = document.getElementById("taskStatus").value;
    const dueDate = document.getElementById("taskDueDate").value;
    let eta = document.getElementById("taskEta").value.trim();

    if (status === "scheduled" && dueDate && !eta) {
      const info = getDueDateInfo(dueDate);
      if (info) eta = `Due ${info.formattedDate}`;
    }

    const payload = {
      title: document.getElementById("taskTitle").value.trim(),
      bossId: document.getElementById("taskBoss").value,
      status,
      priority: document.getElementById("taskPriority").value,
      eta,
      note: document.getElementById("taskNote").value.trim(),
      dueDate: dueDate || undefined,
      triggerPlan:
        status === "scheduled" || document.getElementById("taskRunbook").value.trim()
          ? document.getElementById("taskTriggerPlan").value.trim()
          : undefined,
      runbook: document.getElementById("taskRunbook").value.trim() || undefined
    };

    if (!payload.title) return;

    if (editingId) {
      const existing = state.tasks.find((t) => t.id === editingId);
      if (existing) {
        // Keep existing miniTasks when editing the parent card fields
        const keptMini = existing.miniTasks || [];
        Object.assign(existing, payload);
        existing.miniTasks = keptMini;
        showToast("Task updated");
      }
    } else {
      state.tasks.unshift({
        id: "t-" + Date.now(),
        ...payload,
        miniTasks: [],
        createdAt: new Date().toISOString()
      });
      showToast("Task added to board");
    }

    resetTaskForm();
    saveState();
  });

  document.getElementById("cancelEditTaskBtn").addEventListener("click", resetTaskForm);

  // Download data.json
  document.getElementById("downloadJsonBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "data.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Downloaded data.json");
  });

  // Copy Shareable Snapshot Link
  document.getElementById("shareUrlBtn").addEventListener("click", async () => {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    const shareUrl = `${window.location.origin}${window.location.pathname}?data=${encodeURIComponent(encoded)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Snapshot link copied to clipboard!");
    } catch {
      prompt("Copy this link to share:", shareUrl);
    }
  });

  // Settings Modal
  document.getElementById("openSettingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("closeSettingsBtn").addEventListener("click", () => {
    document.getElementById("settingsModal").classList.add("hidden");
  });
  document.getElementById("cancelSettingsBtn").addEventListener("click", () => {
    document.getElementById("settingsModal").classList.add("hidden");
  });

  document.getElementById("addBossBtn").addEventListener("click", () => {
    const container = document.getElementById("bossConfigList");
    const newId = "boss-" + Date.now();
    const row = document.createElement("div");
    row.className = "boss-config-row";
    row.dataset.id = newId;
    row.innerHTML = `
      <input type="color" class="js-boss-color" value="#ea580c" />
      <input type="text" class="js-boss-name" value="" placeholder="New Boss / Team Name" required />
      <button type="button" class="ctrl-btn js-remove-boss" title="Remove">✕</button>
    `;
    row.querySelector(".js-remove-boss").addEventListener("click", () => row.remove());
    container.appendChild(row);
  });

  document.getElementById("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.profile.name = document.getElementById("settingBoardTitle").value.trim();
    state.profile.subtitle = document.getElementById("settingBoardSubtitle").value.trim();
    state.profile.capacityStatus = document.getElementById("settingCapacityStatus").value;
    state.profile.capacityNote = document.getElementById("settingCapacityNote").value.trim();

    const rows = Array.from(document.querySelectorAll("#bossConfigList .boss-config-row"));
    const updatedBosses = rows
      .map((r) => {
        const color = r.querySelector(".js-boss-color").value;
        const name = r.querySelector(".js-boss-name").value.trim();
        return {
          id: r.dataset.id,
          name,
          color,
          bg: hexToSoftBg(color)
        };
      })
      .filter((b) => b.name);

    if (updatedBosses.length > 0) {
      state.bosses = updatedBosses;
    }

    document.getElementById("settingsModal").classList.add("hidden");
    saveState();
    showToast("Settings saved");
  });

  document.getElementById("resetDefaultBtn").addEventListener("click", async () => {
    if (!confirm("Reset board back to the default sample data.json?")) return;
    if (historyBaseline) {
      undoStack.push(historyBaseline);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    redoStack = [];
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", window.location.pathname);
    await loadInitialState();
    historyBaseline = snapshotState();
    editingCardId = null;
    document.body.classList.remove("is-card-edit");
    document.getElementById("settingsModal").classList.add("hidden");
    renderAll();
    showToast("Reset to default sample data");
  });

  // GitHub Modal
  document.getElementById("githubSyncBtn").addEventListener("click", openGithubModal);
  document.getElementById("closeGithubBtn").addEventListener("click", () => {
    document.getElementById("githubModal").classList.add("hidden");
  });
  document.getElementById("cancelGithubBtn").addEventListener("click", () => {
    document.getElementById("githubModal").classList.add("hidden");
  });
  document.getElementById("githubForm").addEventListener("submit", publishToGitHub);
});
