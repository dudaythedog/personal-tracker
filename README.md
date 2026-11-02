# Finance Tracker

A lightweight, private finance tracker (₱) that runs as a **static site** — no frameworks, no build step, no backend, no CDNs. All data stays in your browser (`localStorage`). Works offline and loads instantly.

One page: balance, wallets and transactions. Budgets and spending by category open from the **Budgets & spending** card under Balance, which shows what is left this month and shows a red or amber tag when a budget is over or nearly used up.

## Features

- **Transactions:** income / expense / transfer with amount (₱, auto-comma), category (on-screen picker with presets plus your own), payment method (Cash, GCash, Maya, cards, bank), date and description. Grouped by day; tap a row to edit. Month / Week / Today / All filter and a month navigator.
- **Balance:** month income and expenses, plus a balance that carries over from earlier months.
- **Transfers** (e.g. Maya → GCash) move money between wallets without counting as spending; only the fee counts as an expense.
- **Wallets:** all-time balance per payment method, derived from your transactions plus an optional starting balance. **Set balances** lets you type what each wallet really holds now (minus for card debt); the difference is saved as that wallet's starting balance, so Wallets and Balance match your real accounts.
- **Budgets:** a monthly limit per expense category (and transfer fees), showing what is left for the viewed month (amber at 80%, red when over). Saving an expense in a budgeted category tells you what is left, e.g. "Dining Out: ₱110.00 left this month" (amber when nearly used up, red when over).
- **Repeats monthly:** turn on "Repeat every month" in a transaction (expense, income or transfer). On that day each month a "due" card asks you to **Add** or **Skip** it; day 31 falls on the last day of shorter months. The Repeats monthly card lists them and stops one with ×.
- **Spending by category** for the viewed month.
- **Data:** a reminder when you have not backed up in 14 days (or ever; "Later" snoozes 3 days), JSON backup download, import with Replace/Merge, reset all (double confirm). Deleting a transaction shows an **Undo** toast instead of a confirm popup. Corrupted storage is detected and backed up, never crashes.
- **Design:** mobile-first (tuned for ~384px phones like the Galaxy S23 Ultra), floating + button, bottom-sheet dialogs with sticky actions, auto light/dark via `prefers-color-scheme` + manual toggle (Auto → Light → Dark), semantic HTML, keyboard-friendly. Zero dependencies and no build step.

> This app used to also track habits, health and goals/tasks. Those sections were removed; any old data from them is kept untouched (as `legacy` in storage and backups), so nothing was lost. Import → Replace keeps it unless the file has its own copy, Merge never duplicates it, and Reset says how many old records it will delete.

## Files

| File | What |
|---|---|
| `index.html` | Structure + all forms/views. Uses relative paths (`./style.css`, `./app.js`) so it works from `username.github.io/repo-name/`. |
| `style.css` | Theming, layout, responsive cards. |
| `sw.js` / `manifest.webmanifest` / `icons/` | Offline cache + installable app (PWA). |
| `app.js` | One `state` object, single `save()`/`load()`, schema `version` + `migrate()`. Small functions per feature. |

Total size is well under 100 KB.

## Deploy on GitHub Pages

1. **Create a repo** on GitHub (e.g. `personal-tracker`). Don't add anything yet, or clone it:
   ```bash
   git clone https://github.com/YOUR-USERNAME/personal-tracker.git
   cd personal-tracker
   ```
2. **Copy** everything into the repo root: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, the `icons/` folder (and this `README.md`). `sw.js` + `manifest.webmanifest` + `icons/` are required for offline use and Add to Home Screen.
3. **Push:**
   ```bash
   git add .
   git commit -m "Add personal tracker"
   git push -u origin main
   ```
4. **Enable Pages:** GitHub repo → **Settings → Pages** → under *Build and deployment*, Source: **Deploy from a branch**, Branch: **main** / **(root)** → Save.
5. Wait ~1 minute, then open `https://YOUR-USERNAME.github.io/personal-tracker/`.

Updates: edit files, commit, push — Pages redeploys automatically. No build step. The service worker is network-first, so phones pick up the new version on the next load (the cached copy is only used offline). Bump `CACHE` in `sw.js` when you change files so old caches get cleaned up.

> Local preview: just double-click `index.html`, or run `python3 -m http.server` in the folder and open `http://localhost:8000`. No internet needed after first load (there are zero external requests).

## Import / Export

**Export (Download backup):** *Your data* (bottom of the page) → **Download backup**, or the **Export** button in the header. You get one file like `personal-tracker-2026-10-04.json`:

```json
{
  "app": "personal-tracker",
  "version": 1,
  "exportDate": "2026-10-04T12:00:00.000Z",
  "data": { "finance": [], "budgets": [], "openings": [], "recurring": [] }
}
```

**Import:** *Your data* (bottom of the page) → **Import JSON…** → pick a backup file.
- The file is parsed and **validated** (must be JSON with array fields such as finance and budgets; older backups that also hold habits/health/goals/tasks still import; a raw state object is also accepted).
- If invalid, you see a friendly error and nothing changes.
- If valid, choose **Replace existing** (overwrite everything) or **Merge with existing** (append; ID collisions get fresh IDs) or **Cancel**.

**Reset:** **Reset all data** asks twice before erasing `localStorage`.

## Privacy

Everything lives in `localStorage` under key `personal-tracker-v1` (theme under `personal-tracker-theme`). Nothing is sent anywhere — verify in DevTools → Network (zero requests) and Application → Local Storage.
