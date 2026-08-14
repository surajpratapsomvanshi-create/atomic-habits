/**
 * Atomic Habits Tracker — Google Sheets backend
 * ------------------------------------------------
 * Creates / uses a spreadsheet named "Atomic Habits DB" inside your
 * shared Drive folder. That sheet IS the database.
 *
 * SETUP (one time, ~3 minutes):
 *  1. Open https://script.google.com → New project.
 *  2. Name the project "Atomic Habits Backend".
 *  3. Delete the placeholder code and paste this ENTIRE file. Save (Ctrl+S).
 *  4. (Optional but recommended) Run the function createDatabase once from
 *     the toolbar dropdown → Run. Authorize when asked. This creates
 *     "Atomic Habits DB" in the Drive folder immediately.
 *  5. Deploy → New deployment → ⚙️ → Web app:
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Deploy, authorize, COPY the Web app URL (ends with /exec).
 *  6. Paste that URL into the app: Settings → Google Sheets sync.
 *
 * IMPORTANT: If you update this script after the first deploy, use
 * Deploy → Manage deployments → Edit (pencil) → Version: New version
 * so the live Web App picks up Log/Habits columns for counters.
 * The raw _backup JSON remains compatible either way.
 *
 * Drive folder used as DB home:
 *   https://drive.google.com/drive/folders/1QburNwA9oTicqU_6hlSOcwMNmhofqNoW
 *
 * Tabs created automatically:
 *  - Habits  : one row per habit (type, schedule, limit, totals)
 *  - Log     : one row per (date, habit) — check-ins and counter values
 *  - _backup : raw JSON snapshot used by "Restore from Sheet"
 */

const FOLDER_ID = "1QburNwA9oTicqU_6hlSOcwMNmhofqNoW";
const DB_NAME = "Atomic Habits DB";
const HABITS_SHEET = "Habits";
const LOG_SHEET = "Log";
const BACKUP_SHEET = "_backup";
const HISTORY_SHEET = "_history";
const MAX_HISTORY = 20;
/** Bump when redeploying; v37+ GET save; v39+ chunked GET save + form POST. */
const BACKEND_VERSION = 39;

/* ---------------- HTTP entry points ---------------- */

function getParams(e) {
  return (e && e.parameter) ? e.parameter : {};
}

/** Decode ?payload= base64(JSON) from GET save fallback (handles + → space in URLs). */
function decodePayloadParam(payload) {
  var raw = String(payload || "").replace(/ /g, "+");
  var pad = raw.length % 4;
  if (pad) raw += "====".slice(pad);
  var decoded = Utilities.newBlob(Utilities.base64Decode(raw)).getDataAsString();
  return JSON.parse(decoded);
}

/** Parse application/x-www-form-urlencoded body into a key/value map. */
function parseFormBody(text) {
  var out = {};
  String(text || "").split("&").forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf("=");
    var k = idx >= 0 ? pair.slice(0, idx) : pair;
    var v = idx >= 0 ? pair.slice(idx + 1) : "";
    try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (e1) { /* keep raw */ }
    try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e2) { /* keep raw */ }
    out[k] = v;
  });
  return out;
}

/** Parse POST body — text/plain JSON, form payload=, or ?payload= after a redirect. */
function parseRequestBody(e) {
  if (!e) return null;
  if (e.postData && e.postData.contents) {
    var text = String(e.postData.contents);
    var type = String((e.postData.type || "")).toLowerCase();
    if (type.indexOf("application/x-www-form-urlencoded") >= 0) {
      var form = parseFormBody(text);
      if (form.payload) return decodePayloadParam(form.payload);
      if (form.action) {
        return {
          action: form.action,
          data: form.data ? safeParse(form.data) : undefined,
          baseRevision: form.baseRevision != null && form.baseRevision !== ""
            ? Number(form.baseRevision) : undefined,
          deviceId: form.deviceId || null,
          force: form.force === "true" || form.force === true,
          revision: form.revision,
        };
      }
    }
    if (text) {
      // text/plain JSON (preferred CORS-simple POST from the PWA)
      try { return JSON.parse(text); } catch (errJson) {
        // Some clients post payload=… without a proper content-type.
        if (text.indexOf("payload=") === 0) {
          var form2 = parseFormBody(text);
          if (form2.payload) return decodePayloadParam(form2.payload);
        }
        throw errJson;
      }
    }
  }
  var p = getParams(e);
  if (p.payload) return decodePayloadParam(p.payload);
  if (p.action) {
    return {
      action: p.action,
      data: p.data ? safeParse(p.data) : undefined,
      baseRevision: p.baseRevision != null && p.baseRevision !== ""
        ? Number(p.baseRevision) : undefined,
      deviceId: p.deviceId || null,
      force: p.force === "true" || p.force === true,
      revision: p.revision,
    };
  }
  return null;
}

/**
 * Assemble chunked GET save uploads (mobile URL length limits).
 * Chunks are fragments of base64(JSON body); final chunk runs handleSave.
 */
function handleSaveChunk(p) {
  var uploadId = String(p.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  var i = Number(p.i);
  var n = Number(p.n);
  var chunk = String(p.chunk || "").replace(/ /g, "+");
  if (!uploadId || !(n > 0) || n > 200 || isNaN(i) || i < 0 || i >= n || !chunk) {
    return json({ ok: false, error: "Bad saveChunk params" });
  }
  var cache = CacheService.getScriptCache();
  var prefix = "ahc_" + uploadId + "_";
  cache.put(prefix + String(i), chunk, 600);
  cache.put(prefix + "n", String(n), 600);

  var parts = [];
  var missing = [];
  for (var k = 0; k < n; k++) {
    var part = cache.get(prefix + String(k));
    if (part == null) missing.push(k);
    else parts.push(part);
  }
  if (missing.length) {
    return json({
      ok: true,
      waiting: true,
      received: n - missing.length,
      total: n,
      missing: missing.length,
    });
  }

  // Clear chunk keys best-effort, then decode + save under lock.
  try {
    var keys = [];
    for (var c = 0; c < n; c++) keys.push(prefix + String(c));
    keys.push(prefix + "n");
    cache.removeAll(keys);
  } catch (eClear) { /* ignore */ }

  var body;
  try {
    body = decodePayloadParam(parts.join(""));
  } catch (errDec) {
    return json({ ok: false, error: "Bad chunked save payload: " + String(errDec) });
  }
  return withLock(function () {
    return dispatchAction(body);
  });
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return json({ ok: false, error: "Server busy — try again in a few seconds" });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function dispatchAction(body) {
  if (!body || !body.action) return json({ ok: false, error: "Missing action" });
  if (body.action === "save") return handleSave(body);
  if (body.action === "restoreRevision") return handleRestoreRevision(body);
  return json({ ok: false, error: "Unknown action: " + body.action });
}

function doPost(e) {
  return withLock(function () {
    try {
      var body = parseRequestBody(e);
      if (!body) return json({ ok: false, error: "Empty request body" });
      return dispatchAction(body);
    } catch (err) {
      return json({ ok: false, error: "Bad request: " + String(err) });
    }
  });
}

/**
 * Fail-safe save with optimistic-concurrency + blank-data guards.
 * - Rejects (conflict) if the cloud already has data and the caller's
 *   baseRevision does not match the current cloud revision.
 * - Rejects (conflict) if incoming data is blank/empty but cloud has data.
 * - force:true bypasses both guards (still archives the previous snapshot).
 */
function handleSave(body) {
  const ss = getSpreadsheet();
  ensureTabs(ss);
  const backup = ss.getSheetByName(BACKUP_SHEET);
  const cloudRaw = backup.getRange(1, 1).getValue();
  const cloudData = cloudRaw ? safeParse(cloudRaw) : null;
  const meta = readMeta(backup);
  const cloudHas = dataHasContent(cloudData);
  const incomingHas = dataHasContent(body.data);
  const force = body.force === true;
  const base = body.baseRevision;

  if (cloudHas && !force) {
    const baseMatches =
      base !== undefined && base !== null && String(base) === String(meta.revision);
    if (!baseMatches) {
      return json({
        ok: false, conflict: true, reason: "stale",
        revision: meta.revision, updatedAt: meta.updatedAt, deviceId: meta.deviceId,
        data: cloudData, spreadsheetUrl: ss.getUrl(),
      });
    }
    if (!incomingHas) {
      return json({
        ok: false, conflict: true, reason: "blank",
        revision: meta.revision, updatedAt: meta.updatedAt, deviceId: meta.deviceId,
        data: cloudData, spreadsheetUrl: ss.getUrl(),
      });
    }
  }

  // Archive the previous snapshot before overwriting (recovery after force).
  if (cloudRaw) appendHistory(ss, cloudRaw, meta);

  writeAll(body.data);
  const newMeta = {
    revision: (Number(meta.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
    deviceId: body.deviceId || null,
  };
  writeMeta(backup, newMeta);
  return json({
    ok: true, savedAt: newMeta.updatedAt, revision: newMeta.revision,
    updatedAt: newMeta.updatedAt, deviceId: newMeta.deviceId,
    spreadsheetUrl: ss.getUrl(),
  });
}

/** Restore a prior snapshot from _history and make it the current revision. */
function handleRestoreRevision(body) {
  const ss = getSpreadsheet();
  const h = ss.getSheetByName(HISTORY_SHEET);
  if (!h) return json({ ok: false, error: "No history yet" });
  const last = h.getLastRow();
  for (let r = 2; r <= last; r++) {
    const rev = h.getRange(r, 2).getValue();
    if (String(rev) === String(body.revision)) {
      const raw = h.getRange(r, 4).getValue();
      const parsed = safeParse(raw);
      if (!parsed) return json({ ok: false, error: "Snapshot unreadable" });
      const backup = ss.getSheetByName(BACKUP_SHEET);
      const meta = readMeta(backup);
      const cloudRaw = backup.getRange(1, 1).getValue();
      if (cloudRaw) appendHistory(ss, cloudRaw, meta);
      writeAll(parsed);
      const newMeta = {
        revision: (Number(meta.revision) || 0) + 1,
        updatedAt: new Date().toISOString(),
        deviceId: body.deviceId || null,
      };
      writeMeta(backup, newMeta);
      return json({ ok: true, data: parsed, revision: newMeta.revision, updatedAt: newMeta.updatedAt });
    }
  }
  return json({ ok: false, error: "Revision not found" });
}

function doGet(e) {
  try {
    var p = getParams(e);
    var action = p.action;

    /** GET fallback when POST upload fails (mobile GAS redirect → 404/411). */
    if (action === "save" && p.payload) {
      return withLock(function () {
        try {
          var body = decodePayloadParam(p.payload);
          return dispatchAction(body);
        } catch (err) {
          return json({ ok: false, error: "Bad save payload: " + String(err) });
        }
      });
    }

    /** Chunked GET save when a single ?payload= URL would be too long. */
    if (action === "saveChunk") {
      try {
        return handleSaveChunk(p);
      } catch (errChunk) {
        return json({ ok: false, error: "saveChunk failed: " + String(errChunk) });
      }
    }

    if (action === "load") {
      var ss = getSpreadsheet();
      ensureTabs(ss);
      var backup = ss.getSheetByName(BACKUP_SHEET);
      var raw = backup.getRange(1, 1).getValue();
      if (!raw) {
        return json({ ok: false, error: "No data saved yet", hasData: false, revision: 0 });
      }
      var parsed = safeParse(raw);
      if (!parsed) return json({ ok: false, error: "Snapshot unreadable", hasData: false });
      var meta = readMeta(backup);
      return json({
        ok: true, data: parsed,
        revision: meta.revision, updatedAt: meta.updatedAt, deviceId: meta.deviceId,
      });
    }

    if (action === "info") {
      var ssInfo = getSpreadsheet();
      ensureTabs(ssInfo);
      var backupInfo = ssInfo.getSheetByName(BACKUP_SHEET);
      var rawInfo = backupInfo.getRange(1, 1).getValue();
      var metaInfo = readMeta(backupInfo);
      return json({
        ok: true,
        name: ssInfo.getName(),
        spreadsheetUrl: ssInfo.getUrl(),
        folderId: FOLDER_ID,
        hasData: dataHasContent(safeParse(rawInfo)),
        revision: metaInfo.revision,
        updatedAt: metaInfo.updatedAt,
        deviceId: metaInfo.deviceId,
        backendVersion: BACKEND_VERSION,
        supportsGetSave: true,
        supportsChunkedSave: true,
        supportsFormSave: true,
      });
    }

    if (action === "history") {
      var ssHist = getSpreadsheet();
      var h = ssHist.getSheetByName(HISTORY_SHEET);
      var out = [];
      if (h) {
        var last = h.getLastRow();
        for (var r = 2; r <= last; r++) {
          out.push({
            timestamp: h.getRange(r, 1).getValue(),
            revision: h.getRange(r, 2).getValue(),
            deviceId: h.getRange(r, 3).getValue(),
          });
        }
      }
      return json({ ok: true, history: out });
    }

    // Visiting the URL in a browser also ensures the DB exists
    var ssDefault = getSpreadsheet();
    return json({
      ok: true,
      message: "Atomic Habits backend is running",
      backendVersion: BACKEND_VERSION,
      supportsGetSave: true,
      supportsChunkedSave: true,
      supportsFormSave: true,
      spreadsheetUrl: ssDefault.getUrl(),
    });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---------------- revision metadata + history ---------------- */

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function dataHasContent(d) {
  return !!(d && Array.isArray(d.habits) && d.habits.length > 0);
}

/** Metadata JSON lives in _backup cell A2 ({revision, updatedAt, deviceId}). */
function readMeta(backup) {
  try {
    const v = backup.getRange(2, 1).getValue();
    if (v) {
      const m = JSON.parse(v);
      if (m && m.revision !== undefined) {
        return {
          revision: Number(m.revision) || 0,
          updatedAt: m.updatedAt || null,
          deviceId: m.deviceId || null,
        };
      }
    }
  } catch (e) { /* legacy "Last sync: …" string → treat as revision 0 */ }
  return { revision: 0, updatedAt: null, deviceId: null };
}

function writeMeta(backup, meta) {
  backup.getRange(2, 1).setValue(JSON.stringify(meta));
}

/** Prepend the previous snapshot to _history, keeping the latest MAX_HISTORY. */
function appendHistory(ss, rawJson, meta) {
  let h = ss.getSheetByName(HISTORY_SHEET);
  if (!h) h = ss.insertSheet(HISTORY_SHEET);
  if (!h.getRange(1, 1).getValue()) {
    h.getRange(1, 1, 1, 4)
      .setValues([["Timestamp", "Revision", "DeviceId", "RawJSON"]])
      .setFontWeight("bold");
  }
  h.insertRowAfter(1);
  h.getRange(2, 1, 1, 4).setValues([[
    new Date().toISOString(),
    meta ? meta.revision : "",
    meta && meta.deviceId ? meta.deviceId : "",
    rawJson,
  ]]);
  const last = h.getLastRow();
  if (last > MAX_HISTORY + 1) {
    h.deleteRows(MAX_HISTORY + 2, last - (MAX_HISTORY + 1));
  }
}

/**
 * Run this once from the Apps Script editor to create the DB sheet
 * in the Drive folder right away (before the first sync).
 */
function createDatabase() {
  const ss = getSpreadsheet();
  ensureTabs(ss);
  Logger.log("Database ready: " + ss.getUrl());
  return ss.getUrl();
}

/* ---------------- spreadsheet / folder helpers ---------------- */

function getFolder() {
  try {
    return DriveApp.getFolderById(FOLDER_ID);
  } catch (err) {
    throw new Error(
      "Cannot open Drive folder " + FOLDER_ID +
      ". Make sure this Google account can edit that shared folder. " +
      String(err)
    );
  }
}

function getSpreadsheet() {
  const folder = getFolder();
  const files = folder.getFilesByName(DB_NAME);
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.openById(file.getId());
    }
  }
  // Not found → create it inside the shared folder
  const ss = SpreadsheetApp.create(DB_NAME);
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file); // keep only in the shared folder
  ensureTabs(ss);
  return ss;
}

function ensureTabs(ss) {
  // Rename the default first sheet to Habits if still blank/default
  const first = ss.getSheets()[0];
  if (first.getName() === "Sheet1") first.setName(HABITS_SHEET);

  [HABITS_SHEET, LOG_SHEET, BACKUP_SHEET].forEach(function (name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  // Seed headers if Habits is empty (writeAll refreshes full layout on sync)
  const habits = ss.getSheetByName(HABITS_SHEET);
  if (!habits.getRange(1, 1).getValue()) {
    habits.getRange(1, 1, 1, 8)
      .setValues([["ID", "Name", "Emoji", "Created", "Type", "Schedule", "Daily limit", "Total"]])
      .setFontWeight("bold");
  }
  const log = ss.getSheetByName(LOG_SHEET);
  if (!log.getRange(1, 1).getValue()) {
    log.getRange(1, 1, 1, 5)
      .setValues([["Date", "Habit", "Done", "Count", "Type"]])
      .setFontWeight("bold");
  }
}

function getSheet(name) {
  const ss = getSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/* ---------------- write ---------------- */

function scheduleLabel(h) {
  var s = h && h.schedule ? h.schedule : null;
  if (!s || s.kind === "daily") return "Every day";
  if (s.kind === "weekdays") {
    var labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var days = Array.isArray(s.weekdays) ? s.weekdays.slice() : [];
    return days.map(function (d) { return labels[d] || d; }).join(" ");
  }
  if (s.kind === "once") return "Once " + (s.date || "");
  return "Every day";
}

function writeAll(data) {
  const ss = getSpreadsheet();
  ensureTabs(ss);

  // 1. raw JSON snapshot (source of truth for restore) — keeps full payload
  //    including counts / type / schedule for backward-compatible restores.
  // A1 = raw JSON snapshot; A2 = revision metadata (written by writeMeta,
  // never overwritten here so concurrency/revision info survives a save).
  const backup = ss.getSheetByName(BACKUP_SHEET);
  backup.getRange(1, 1).setValue(JSON.stringify(data));

  const habits = data.habits || [];
  const checks = data.checks || {};
  const counts = data.counts || {};

  // Totals: check-ins for good habits, sum of counts for bad habits
  const checkTotals = {};
  Object.keys(checks).forEach(function (d) {
    (checks[d] || []).forEach(function (id) {
      checkTotals[id] = (checkTotals[id] || 0) + 1;
    });
  });
  const countTotals = {};
  Object.keys(counts).forEach(function (d) {
    var day = counts[d] || {};
    Object.keys(day).forEach(function (id) {
      countTotals[id] = (countTotals[id] || 0) + (Number(day[id]) || 0);
    });
  });

  // 2. human-readable Habits tab
  const habitsSheet = ss.getSheetByName(HABITS_SHEET);
  habitsSheet.clearContents();
  habitsSheet.getRange(1, 1, 1, 9)
    .setValues([["ID", "Name", "Emoji", "Created", "Type", "Schedule", "Daily limit", "Total", "List"]])
    .setFontWeight("bold");

  const listNameById = {};
  (data.lists || []).forEach(function (l) {
    if (l && l.id != null) listNameById[String(l.id)] = l.name || "";
  });

  if (habits.length) {
    habitsSheet.getRange(2, 1, habits.length, 9).setValues(
      habits.map(function (h) {
        var type = h.type === "bad" ? "bad" : "good";
        var total = type === "bad" ? (countTotals[h.id] || 0) : (checkTotals[h.id] || 0);
        var limit = (type === "bad" && h.dailyLimit != null && h.dailyLimit !== "")
          ? h.dailyLimit
          : "";
        var listLabel = h.listId != null ? (listNameById[String(h.listId)] || String(h.listId)) : "";
        return [
          h.id,
          h.name,
          h.emoji,
          h.createdAt || "",
          type,
          scheduleLabel(h),
          limit,
          total,
          listLabel,
        ];
      })
    );
  }

  // 3. flat Log tab — good check-ins + bad-habit daily counts
  const logSheet = ss.getSheetByName(LOG_SHEET);
  logSheet.clearContents();
  logSheet.getRange(1, 1, 1, 5)
    .setValues([["Date", "Habit", "Done", "Count", "Type"]])
    .setFontWeight("bold");

  const nameById = {};
  const typeById = {};
  habits.forEach(function (h) {
    nameById[h.id] = h.name;
    typeById[h.id] = h.type === "bad" ? "bad" : "good";
  });

  const rows = [];
  Object.keys(checks).sort().forEach(function (date) {
    (checks[date] || []).forEach(function (id) {
      rows.push([date, nameById[id] || id, 1, "", typeById[id] || "good"]);
    });
  });
  Object.keys(counts).sort().forEach(function (date) {
    var day = counts[date] || {};
    Object.keys(day).sort().forEach(function (id) {
      var n = Number(day[id]) || 0;
      if (n <= 0) return;
      rows.push([date, nameById[id] || id, "", n, typeById[id] || "bad"]);
    });
  });
  rows.sort(function (a, b) {
    if (a[0] === b[0]) return String(a[1]).localeCompare(String(b[1]));
    return a[0] < b[0] ? -1 : 1;
  });
  if (rows.length) {
    logSheet.getRange(2, 1, rows.length, 5).setValues(rows);
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
