#!/usr/bin/env python3
"""Generate a polished boss-review walkthrough video (WebM + MP4) for manual.html."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FRAME_DIR = ROOT / "assets" / "video-frames"
OUT_WEBM = ROOT / "assets" / "boss-review-demo.webm"
OUT_MP4 = ROOT / "assets" / "boss-review-demo.mp4"
OUT_CHAPTERS = ROOT / "assets" / "boss-review-chapters.json"

W, H = 1280, 720
FPS = 30

BG = (248, 250, 252)
SURFACE = (255, 255, 255)
BORDER = (226, 232, 240)
TEXT = (15, 23, 42)
TEXT2 = (71, 85, 105)
MUTED = (100, 116, 139)
BLUE = (37, 99, 235)
PURPLE = (124, 58, 237)
GREEN = (5, 150, 105)
RED = (220, 38, 38)
AMBER = (217, 119, 6)
SPOT = (16, 185, 129)
NAVY = (15, 23, 42)


def get_font(size: int, bold: bool = False):
    paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in paths:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


F12 = get_font(12)
F12B = get_font(12, True)
F13 = get_font(13)
F13B = get_font(13, True)
F14 = get_font(14)
F14B = get_font(14, True)
F15B = get_font(15, True)
F18B = get_font(18, True)
F28B = get_font(28, True)
F10B = get_font(10, True)
F11 = get_font(11)
F11B = get_font(11, True)


def tw(draw, text, fnt):
    b = draw.textbbox((0, 0), text, font=fnt)
    return b[2] - b[0]


def soft_boss_bg(color):
    return tuple(int(min(255, c + (255 - c) * 0.88)) for c in color)


def draw_board(highlight: str | None, pulse: float) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Full board stays visible. Captions live outside the video, not on top of it.
    d.rounded_rectangle((28, 56, 1252, 708), radius=16, fill=SURFACE, outline=BORDER, width=2)

    d.text((48, 68), "LIVE WORKLOAD & PRIORITY BOARD", font=F10B, fill=MUTED)
    d.text((48, 86), "My Work Log & Queue", font=get_font(22, True), fill=TEXT)

    # Summary row: bandwidth + split, kept short so lower sections fit
    d.rounded_rectangle((44, 122, 620, 196), radius=10, fill=SURFACE, outline=BORDER)
    d.rounded_rectangle((58, 136, 292, 164), radius=12, fill=(254, 243, 199))
    d.text((72, 142), "Focused / At Capacity", font=F12B, fill=(180, 83, 9))
    d.text((58, 172), "New requests go to Up Next", font=F11, fill=TEXT2)

    d.rounded_rectangle((636, 122, 1236, 196), radius=10, fill=SURFACE, outline=BORDER)
    d.text((652, 132), "ACTIVE WORKLOAD SPLIT", font=F10B, fill=MUTED)
    d.rounded_rectangle((652, 152, 1220, 168), radius=8, fill=(241, 245, 249))
    seg = (1220 - 652) // 3
    d.rectangle((652, 152, 652 + seg - 2, 168), fill=BLUE)
    d.rectangle((652 + seg, 152, 652 + 2 * seg - 2, 168), fill=PURPLE)
    d.rectangle((652 + 2 * seg, 152, 1220, 168), fill=GREEN)
    d.text((652, 174), "Boss A 33%     Boss B 33%     Boss C 33%", font=F11, fill=TEXT2)

    tabs = [("All Bosses", True), ("Boss A", False), ("Boss B", False), ("Boss C", False)]
    x = 44
    for label, active in tabs:
        w = tw(d, label, F12B) + 24
        if active:
            d.rounded_rectangle((x, 208, x + w, 234), radius=14, fill=NAVY)
            d.text((x + 12, 213), label, font=F12B, fill=(255, 255, 255))
        else:
            d.rounded_rectangle((x, 208, x + w, 234), radius=14, fill=SURFACE, outline=BORDER)
            d.text((x + 12, 213), label, font=F12B, fill=TEXT2)
        x += w + 8

    def section_header(title, color, count, y):
        d.ellipse((52, y + 3, 64, y + 15), fill=color)
        d.text((72, y), title, font=F13B, fill=TEXT)
        cx = 72 + tw(d, title, F13B) + 8
        d.rounded_rectangle((cx, y, cx + 24, y + 18), radius=9, fill=(241, 245, 249))
        d.text((cx + 7, y + 1), str(count), font=F11B, fill=TEXT2)
        return y + 22

    def task_card(y, rank, boss, boss_color, priority, title, eta):
        d.rounded_rectangle((44, y, 1236, y + 34), radius=7, fill=(255, 255, 255), outline=BORDER)
        badge_bg = boss_color if rank in ("NOW", "!") else (241, 245, 249)
        badge_fg = (255, 255, 255) if rank in ("NOW", "!") else TEXT2
        d.rounded_rectangle((54, y + 6, 92, y + 28), radius=5, fill=badge_bg)
        d.text((60 if len(rank) > 2 else 64, y + 9), rank, font=F11B, fill=badge_fg)
        bw = tw(d, boss, F11B) + 14
        d.rounded_rectangle((102, y + 6, 102 + bw, y + 28), radius=4, fill=soft_boss_bg(boss_color), outline=boss_color)
        d.text((109, y + 8), boss, font=F11B, fill=boss_color)
        d.text((112 + bw, y + 8), priority, font=F11B, fill=TEXT2)
        d.text((220 + bw, y + 8), title, font=F13B, fill=TEXT)
        d.text((1100, y + 8), eta, font=F12B, fill=TEXT2)
        return y + 40

    y = 248
    doing_top = y
    y = section_header("Doing Right Now", BLUE, 2, y)
    y = task_card(y, "NOW", "Boss B", PURPLE, "Urgent", "Fix checkout payment timeout", "Today 5pm")
    card_box = (44, y - 40, 1236, y - 6)
    y = task_card(y, "NOW", "Boss A", BLUE, "High", "Prepare Q4 usage data export", "Tomorrow")
    doing_box = (40, doing_top, 1240, y)

    blocked_top = y + 4
    y = section_header("Blocked / Waiting", RED, 1, blocked_top)
    y = task_card(y, "!", "Boss C", GREEN, "High", "Inventory sync — waiting on IT credentials", "Paused")
    blocked_box = (40, blocked_top, 1240, y)

    queue_top = y + 4
    y = section_header("Up Next  ·  #1 is next", AMBER, 2, queue_top)
    y = task_card(y, "#1", "Boss A", BLUE, "Normal", "Add export-to-PDF on monthly report", "~1 day")
    y = task_card(y, "#2", "Boss B", PURPLE, "Normal", "Upgrade staging Node.js runtime", "~0.5 day")
    queue_box = (40, queue_top, 1240, y)

    vault_top = y + 4
    y = section_header("Future & Long-Term Vault", PURPLE, 1, vault_top)
    y = task_card(y, "2yr", "Boss B", PURPLE, "High", "Renew SSL certificate  ·  calendar alarm set", "Oct 2028")
    vault_box = (40, vault_top, 1240, y)

    done_top = y + 4
    y = section_header("Recently Completed", GREEN, 1, done_top)
    y = task_card(y, "OK", "Boss B", PURPLE, "Urgent", "Resolved mobile Safari login redirect", "Done")
    done_box = (40, done_top, 1240, y)
    later_box = (40, vault_top, 1240, y)

    regions = {
        "bandwidth": (44, 122, 620, 196),
        "split": (636, 122, 1236, 196),
        "filters": (40, 202, 520, 242),
        "doing": doing_box,
        "card": card_box,
        "blocked": blocked_box,
        "queue": queue_box,
        "vault": vault_box,
        "done": done_box,
        "later": later_box,
    }

    if highlight and highlight in regions:
        x0, y0, x1, y1 = regions[highlight]
        pad = 8
        # Dim layer with clear hole via mask
        dim = Image.new("RGBA", (W, H), (15, 23, 42, 150))
        mask = Image.new("L", (W, H), 255)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle((x0 - pad, y0 - pad, x1 + pad, y1 + pad), radius=14, fill=0)
        base = img.convert("RGBA")
        base = Image.composite(base, Image.alpha_composite(base, dim), Image.eval(mask, lambda p: 255 - p))
        gd = ImageDraw.Draw(base)
        width = 3 + int(2 * abs(math.sin(pulse * math.pi * 2)))
        gd.rounded_rectangle(
            (x0 - pad, y0 - pad, x1 + pad, y1 + pad),
            radius=14,
            outline=(*SPOT, 255),
            width=width,
        )
        # Step pointer chip
        chip = "LOOK HERE"
        cw = tw(gd, chip, F11B) + 20
        cy = max(48, y0 - 28)
        gd.rounded_rectangle((x0, cy, x0 + cw, cy + 22), radius=6, fill=SPOT)
        gd.text((x0 + 10, cy + 3), chip, font=F11B, fill=(255, 255, 255))
        return base.convert("RGB")

    return img


def draw_chrome(img: Image.Image, step_no: int, total: int, title: str, subtitle: str) -> Image.Image:
    out = img.copy()
    d = ImageDraw.Draw(out)
    d.rectangle((0, 0, W, 44), fill=NAVY)
    d.text((24, 12), f"Step {step_no} of {total}", font=F14B, fill=(255, 255, 255))
    # Title stays in the top bar so the board itself is never covered.
    d.text((150, 12), title, font=F14B, fill=(167, 243, 208))
    for i in range(total):
        x = 980 + i * 28
        fill = SPOT if i < step_no else (51, 65, 85)
        d.ellipse((x, 14, x + 14, 28), fill=fill)
    return out


STEPS = [
    {
        "id": "intro",
        "highlight": None,
        "title": "Open the live board — just read, no editing",
        "subtitle": "Do not click Manage / Record Work. Scan top → bottom in about 2 minutes.",
        "seconds": 3.2,
    },
    {
        "id": "bandwidth",
        "highlight": "bandwidth",
        "title": "1 · Current Bandwidth",
        "subtitle": "Available, Focused, or Fire drill — know capacity before asking for more work.",
        "seconds": 4.0,
    },
    {
        "id": "split",
        "highlight": "split",
        "title": "2 · Workload Split Bar",
        "subtitle": "See how active work is split across Boss A / B / C. You share this bandwidth.",
        "seconds": 4.5,
    },
    {
        "id": "filters",
        "highlight": "filters",
        "title": "3 · Filter by your name",
        "subtitle": "Optional: click your boss tab to hide other teams and see only your requests.",
        "seconds": 3.5,
    },
    {
        "id": "doing",
        "highlight": "doing",
        "title": "4 · Doing Right Now",
        "subtitle": "Active focus today — kept to 1–2 items so delivery finishes faster.",
        "seconds": 4.0,
    },
    {
        "id": "card",
        "highlight": "card",
        "title": "5 · Read one work card",
        "subtitle": "Boss tag · Priority · Mini progress · Title · ETA. One glance = full status.",
        "seconds": 4.5,
    },
    {
        "id": "blocked",
        "highlight": "blocked",
        "title": "6 · Blocked / Waiting",
        "subtitle": "Paused for access, decision, or reply. If it is you — answer to unblock.",
        "seconds": 4.0,
    },
    {
        "id": "queue",
        "highlight": "queue",
        "title": "7 · Up Next (#1 is next)",
        "subtitle": "Need yours sooner? Ask to swap with #1 — not “are you free?”",
        "seconds": 5.0,
    },
    {
        "id": "outro",
        "highlight": "later",
        "title": "8 · Future Vault, then Recently Completed",
        "subtitle": "Long-term work has a date and alarm. The Done row is proof it was delivered.",
        "seconds": 4.0,
    },
]


def main():
    if FRAME_DIR.exists():
        shutil.rmtree(FRAME_DIR)
    FRAME_DIR.mkdir(parents=True)
    OUT_WEBM.parent.mkdir(parents=True, exist_ok=True)

    frame_i = 0
    t = 0.0
    chapters = []

    for si, step in enumerate(STEPS, start=1):
        chapters.append({"id": step["id"], "start": round(t, 2), "title": step["title"], "subtitle": step["subtitle"]})
        n = max(1, int(step["seconds"] * FPS))
        for fi in range(n):
            pulse = fi / max(1, n - 1)
            frame = draw_board(step["highlight"], pulse)
            frame = draw_chrome(frame, si, len(STEPS), step["title"], step["subtitle"])
            frame.save(FRAME_DIR / f"frame_{frame_i:05d}.png")
            frame_i += 1
        t += step["seconds"]

    OUT_CHAPTERS.write_text(json.dumps({"fps": FPS, "duration": round(t, 2), "chapters": chapters}, indent=2))
    print(f"Rendered {frame_i} frames (~{t:.1f}s)")

    pattern = str(FRAME_DIR / "frame_%05d.png")
    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS), "-i", pattern,
            "-c:v", "libvpx-vp9", "-b:v", "2.5M", "-row-mt", "1", "-pix_fmt", "yuv420p",
            str(OUT_WEBM),
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS), "-i", pattern,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
            str(OUT_MP4),
        ],
        check=True,
    )
    print("Wrote", OUT_WEBM.name, "and", OUT_MP4.name)

    shutil.rmtree(FRAME_DIR)
    print("Cleaned temp frames")


if __name__ == "__main__":
    main()
