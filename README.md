# Personal Tracker

A lightweight, private personal tracker that runs as a **static site** — no frameworks, no build step, no backend, no CDNs. All data stays in your browser (`localStorage`). Works offline and loads instantly.

Tabs: **Home (dashboard) · Habits · Health · Finance · Goals & Tasks**

## Features

- **Dashboard:** today's habits, water/sleep, month spending, open tasks + 2 hand-drawn SVG charts (weekly habits, spending by category).
- **Habits:** daily checklist + 🔥 streak counter, add/edit/delete.
- **Health:** water, sleep, workout, weight + date/note, with Today/Week/Month/All filter.
- **Finance:** income/expense + amount (₱, auto-comma)/category/description/date + payment method (Cash, GCash, Maya, cards, bank) on expenses, monthly income/expense/balance, date filter. **Transfers** (e.g. Maya → GCash) move money between wallets without counting as spending — only the fee counts as an expense. **Wallet balances** on the dashboard show net per payment method, derived from your transactions.
- **Goals & Tasks:** tasks with due date, priority, done/undone, optional goal link; goal progress % = done ÷ linked tasks.
- **Data:** export JSON backup, import with Replace/Merge, reset all (double confirm). Corrupted storage is detected and backed up, never crashes.
- **Design:** mobile-first responsive, auto light/dark via `prefers-color-scheme` + manual toggle (Auto → Light → Dark), semantic HTML, labels, keyboard-friendly.

## Files

| File | What |
|---|---|
| `index.html` | Structure + all forms/views. Uses relative paths (`./style.css`, `./app.js`) so it works from `username.github.io/repo-name/`. |
| `style.css` | Theming, layout, responsive cards. |
| `app.js` | One `state` object, single `save()`/`load()`, schema `version` + `migrate()`. Small functions per feature. |

Total size is well under 100 KB.

## Deploy on GitHub Pages

1. **Create a repo** on GitHub (e.g. `personal-tracker`). Don't add anything yet, or clone it:
   ```bash
   git clone https://github.com/YOUR-USERNAME/personal-tracker.git
   cd personal-tracker
   ```
2. **Copy** `index.html`, `style.css`, `app.js` (and this `README.md`) into the repo root.
3. **Push:**
   ```bash
   git add index.html style.css app.js README.md
   git commit -m "Add personal tracker"
   git push -u origin main
   ```
4. **Enable Pages:** GitHub repo → **Settings → Pages** → under *Build and deployment*, Source: **Deploy from a branch**, Branch: **main** / **(root)** → Save.
5. Wait ~1 minute, then open `https://YOUR-USERNAME.github.io/personal-tracker/`.

Updates: edit files, commit, push — Pages redeploys automatically. No build step.

> Local preview: just double-click `index.html`, or run `python3 -m http.server` in the folder and open `http://localhost:8000`. No internet needed after first load (there are zero external requests).

## Import / Export

**Export (Download backup):** Home → *Your data* → **Download backup**, or the **Export** button in the header. You get one file like `personal-tracker-2026-10-04.json`:

```json
{
  "app": "personal-tracker",
  "version": 1,
  "exportDate": "2026-10-04T12:00:00.000Z",
  "data": { "habits": [], "health": [], "finance": [], "goals": [], "tasks": [] }
}
```

**Import:** Home → *Your data* → **Import JSON…** → pick a backup file.
- The file is parsed and **validated** (must be JSON with array fields for habits/health/finance/goals/tasks; a raw state object is also accepted).
- If invalid, you see a friendly error and nothing changes.
- If valid, choose **Replace existing** (overwrite everything) or **Merge with existing** (append; ID collisions get fresh IDs) or **Cancel**.

**Reset:** **Reset all data** asks twice before erasing `localStorage`.

## Privacy

Everything lives in `localStorage` under key `personal-tracker-v1` (theme under `personal-tracker-theme`). Nothing is sent anywhere — verify in DevTools → Network (zero requests) and Application → Local Storage.
