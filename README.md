# What I Am Working On — Live Work Log & Priority Queue

A simple, zero-dependency mini web app built for an **Individual Contributor (IC) serving multiple bosses/managers at the same time**. Hosted directly on **GitHub Pages**.

## Why This Design Works for 3 Bosses

When you report to 3 bosses who don't talk to each other, each boss naturally assumes you have 100% bandwidth for their requests. You don't need complex project management software—you only need **4 clear answers** on a single page:

1. **Workload Split Bar (Top Banner)**: Shows at a glance how your active tasks are divided across Boss A, Boss B, and Boss C. Each boss immediately sees they share your time with 2 other stakeholders.
2. **🔥 Doing Right Now**: What your hands are on today (keep this to 1–2 items so bosses see focus).
3. **🚧 Blocked / Waiting on Input**: Tasks paused because you are waiting on someone else (credentials, decisions, reviews).
4. **📋 Up Next (In Order `#1, #2, #3`)**: A numbered queue. If Boss C asks *"Can you do my task today?"*, you can show them the board and ask: *"Sure—it's currently #3 behind Boss A's #1 and Boss B's #2. Should we check with them to swap?"*
5. **✅ Recently Completed**: Proof of everything you have shipped recently.

---

## How to Host on GitHub Pages (Takes 2 Minutes)

1. **Create a new repository on GitHub** (for example: `show-what-i-am-doing`) and push these files:
   - `index.html` — live board
   - `manual.html` — how you use it + how bosses review it
   - `style.css`
   - `app.js`
   - `data.json`

Open `manual.html` (or `/manual.html` on GitHub Pages) for the operating guide. Send bosses `manual.html#for-bosses` the first time — that section is a **~37s walkthrough video** with clickable steps (not a wall of text).

Video files live in `assets/boss-review-demo.webm` + `.mp4`. Regenerate with:

```bash
python3 -m venv .venv-video && .venv-video/bin/pip install pillow
.venv-video/bin/python scripts/generate_boss_review_video.py
```
2. Go to your repository on GitHub → click **Settings** → click **Pages** (on the left sidebar).
3. Under **Build and deployment** → **Branch**, select `main` (and `/ (root)` folder), then click **Save**.
4. Wait ~60 seconds. Your site is now live at:
   `https://<your-github-username>.github.io/<repo-name>/`

---

## How to Record & Update Your Tasks

Open your GitHub Pages URL and click **✏️ Manage / Record Work** in the top-right corner:
- **Customize Bosses**: Click **⚙️ Boss Names & Status** to set your 3 bosses' real names/teams and your current bandwidth status.
- **Record Tasks**: Add tasks, move them between *Doing / Up Next / Blocked / Done*, or reorder the queue with `↑` and `↓`.

### 3 Ways to Share Updates with Your Bosses

Because GitHub Pages hosts static files, your edits save in your browser first. To let your bosses see your updates on their computers, pick whichever method you like best:

1. **🚀 Method 1: 1-Click "Publish to GitHub" (Fastest)**
   - In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
   - Generate a token with **Contents: Read and write** permission for only this repository.
   - Click **🚀 Publish to GitHub** on your board, paste your repo name (`username/repo`) and token once. From then on, clicking **Publish** updates `data.json` on GitHub Pages directly from the browser!
2. **📥 Method 2: Download `data.json` & Commit**
   - Click **📥 Download data.json** and replace `data.json` in your GitHub repo.
3. **🔗 Method 3: Copy Snapshot Link (No GitHub commit needed)**
   - Click **🔗 Copy Snapshot Link** and paste it into Slack/Teams/Email. The link encodes your current board directly in the URL.
