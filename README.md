# Suraj Pratap's Atomic Habits

**Permanent host (GitHub Pages):** https://surajpratapsomvanshi-create.github.io/atomic-habits/  
**Install APK:** `apk/AtomicHabits-github.apk` (see `apk/INSTALL.txt`)  
Repo: https://github.com/surajpratapsomvanshi-create/atomic-habits

Suraj Pratap's personal mobile habit-tracking app (brush teeth, drink water, read…) that works offline and
saves your data to **your own Google Sheet** — completely free, no server, no account
other than your Google login.

It is built as a **PWA (Progressive Web App)**: you can install it on your phone like
a normal app straight from the browser, and you can also package it into a real
**APK** (instructions at the bottom).

---

## Features

- One-tap daily check-off with streaks (🔥 current + best streak per habit)
- Habit **schedules**: every day, selected weekdays, or a one-off date (Today only lists what’s due)
- **Bad habit counters** (e.g. cigarettes): tap to add, undo to subtract, optional daily limit, average warnings
- 7-day date strip — tap a past day to back-fill missed check-ins
- Stats screen with a 30-day heat-map per habit (scheduled days + counter intensity)
- Works fully **offline** (data stored on the device), syncs when online
- **Google Sheets sync**: auto-sync after every change + manual "Sync now" / "Restore"
- JSON export/import backup
- No sign-ups, no tracking, no cost

---

## Part 1 — Create the DB in your Drive folder (one time, ~3 min)

The database lives in this shared Drive folder:

https://drive.google.com/drive/folders/1QburNwA9oTicqU_6hlSOcwMNmhofqNoW

The script automatically creates a spreadsheet named **Atomic Habits DB** inside it
(on first sync, or when you run `createDatabase`).

1. Open [script.google.com](https://script.google.com) → **New project**. Name it `Atomic Habits Backend`.
2. Delete the placeholder code and paste the whole contents of **`google-apps-script.gs`**. Save (**Ctrl+S**).
3. Optional but recommended: in the toolbar function dropdown pick **`createDatabase`** → **Run**, then authorize with the Google account that owns / can edit that Drive folder. This creates the sheet immediately.
4. Click **Deploy → New deployment**, click the ⚙️ gear → **Web app**, then set:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
5. Click **Deploy**, authorize (if warned: *Advanced → Go to … (unsafe)* — it's your own script), then **copy the Web app URL** (it ends in `/exec`).
6. Open the app → **Settings → Google Sheets sync** → paste the URL → **Sync now**.

Your Drive folder will then contain `Atomic Habits DB` with three tabs:

| Tab | Contents |
|---|---|
| `Habits` | one row per habit (type, schedule, limit, totals) |
| `Log` | one row per date + habit — check-ins and counter values |
| `_backup` | raw snapshot used by "Restore from Sheet" |

If you update `google-apps-script.gs` later, redeploy a **new version** of the Web App so the readable Habits/Log tabs pick up the new columns. The `_backup` JSON restore path stays compatible either way.

If you reinstall the app or switch phones, paste the same URL and tap
**Restore from Sheet ↓**.

---

## Part 2 — Get the app onto your phone

### Option A (easiest): install as a PWA

1. Open the permanent URL in **Chrome on your Android phone**:  
   https://surajpratapsomvanshi-create.github.io/atomic-habits/  
   (Already hosted on GitHub Pages from the `atomic-habits` repo / `_publish` folder.)
2. Menu (⋮) → **Add to Home screen → Install**.

It installs with its own icon, opens full-screen without the browser bar, and works
offline. For most purposes this *is* the app.

To try it on your PC first, run a local server in this folder:

```bash
cd habit-tracker
node dev-server.js
```

then open http://localhost:8123.

### Option B: a real APK file

A signed APK is already in **`apk/AtomicHabits.apk`** (see `apk/INSTALL.txt`).

For a long-lived APK (not tied to a temporary tunnel), host the app with HTTPS first
(step A-1), then regenerate:

1. Go to **[pwabuilder.com](https://www.pwabuilder.com)** (free, by Microsoft).
2. Paste your permanent hosted URL and click **Start**.
3. Choose **Android → Generate package**.
4. Download the `.apk`, copy it to your phone, and install it
   (allow "install from unknown sources" when prompted).

No Android Studio or SDK needed. Keep `apk/extracted/signing.keystore` and
`signing-key-info.txt` safe if you want Play Store updates later.

---

## Files

| File | Purpose |
|---|---|
| `index.html` / `styles.css` / `app.js` | the app itself |
| `manifest.webmanifest` + `icons/` | makes it installable |
| `sw.js` | service worker — offline support |
| `google-apps-script.gs` | paste into script.google.com (backend that creates the DB in your Drive folder) |

## Privacy

All data lives in your phone's local storage and (if you enable sync) in your own
Google Sheet inside the Drive folder above. Nothing is sent anywhere else.
