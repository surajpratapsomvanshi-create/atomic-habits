/* =====================================================================
   Atomic Habits Tracker — offline-first, syncs to Google Sheets
   Data model (localStorage "ah.data"):
   {
     lists: [{ id, name, sortIndex, createdAt }],
     activeListId: string,
     habits: [{
       id, name, emoji, color, createdAt, archived, listId,
       type: "good" | "bad",
       schedule: { kind: "daily" } |
                 { kind: "weekdays", weekdays: [0-6] } |
                 { kind: "once", date: "YYYY-MM-DD" },
       dailyLimit: number | null,  // bad habits only
       sortIndex: number           // display order within list
     }],
     checks: { "YYYY-MM-DD": ["habitId", ...] },   // good habits
     counts: { "YYYY-MM-DD": { habitId: number } }, // bad habits
     lastUsedAt: { habitId: ISO datetime },         // clock time of last + / check-on
     punches: [{ id, habitId, at: ISO, delta: number }] // transactional punch log
   }
   Legacy habits without type/schedule/listId migrate to daily good habits
   on a default "Atomic Habits" list.
   ===================================================================== */

const LS_DATA = "ah.data";
const LS_SETTINGS = "ah.settings";
const LS_APP_VERSION = "ah.appVersion";

/** Visible app build — bump with every Pages deploy / SW cache bust. */
const APP_VERSION = "39";

/** Default Google Apps Script Web App URL (Atomic Habits backend). */
const DEFAULT_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxxcZhrVNYDpg4ZUfFQNDGudJKUJENaQRRcoyMio8_YEdo5GoKscHAGyUhEd0iK9NkG/exec";

/** Default poll interval when auto-refresh is on. */
const DEFAULT_POLL_MS = 45000;
const POLL_EDIT_DEBOUNCE_MS = 2500;
const DEFAULT_LIST_ID = "list-default";
const DEFAULT_LIST_NAME = "Atomic Habits";

const EMOJIS = ["🦷","💧","🏃","📖","🧘","💪","😴","🥗","✍️","🚭","🧹","💊","🌞","🎸","💻","🙏"];
const COLORS = ["#8ab4f8","#81c995","#fdd663","#f28b82","#a78bfa","#f472b6","#22d3ee","#fb923c"];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_AVG_HISTORY_DAYS = 1;
const EDIT_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DRAG_HANDLE =
  `<button class="habit-drag" type="button" aria-label="Drag to reorder" title="Drag to reorder"><span aria-hidden="true">⋮⋮</span></button>`;

const _bootRaw = load(LS_DATA, { habits: [], checks: {}, counts: {} });
const _bootRawPunchSig = JSON.stringify((_bootRaw && _bootRaw.punches) || []);
let data = migrateData(_bootRaw);
// Persist migrate heals (orphan lastUsedAt → punch, count→timeline backfill) immediately.
saveData();
/** Set when migrate/heal invents punches so the next armed sync uploads them. */
let healPendingUpload = JSON.stringify(data.punches || []) !== _bootRawPunchSig;

/**
 * Re-run punch/count/lastUsed heals when mid-session drift appears
 * (cloud merge, legacy data, or stale clients). Returns true if data changed.
 */
function healDataDrift() {
  if (!data || typeof data !== "object") return false;
  if (!Array.isArray(data.punches)) data.punches = [];
  if (!data.lastUsedAt || typeof data.lastUsedAt !== "object") data.lastUsedAt = {};
  if (!data.counts || typeof data.counts !== "object") data.counts = {};
  const before = JSON.stringify({
    p: data.punches,
    c: data.counts,
    l: data.lastUsedAt,
  });
  // Drop legacy random-id synthetics, then rebuild with stable ids/times.
  data.punches = stripSyntheticPunches(data.punches);
  // Backfill first (uses lastUsedAt as newest slot); promote only adds a
  // newer orphan clock that counts did not already cover.
  backfillCountGapsIntoPunches(data.punches, data.counts, data.lastUsedAt);
  promoteOrphanLastUsedIntoPunches(data.punches, data.lastUsedAt);
  data.counts = reconcileCountsFromPunches(data.counts, data.punches);
  reconcileLastUsedAtFromPunches(data.lastUsedAt, data.punches);
  const after = JSON.stringify({
    p: data.punches,
    c: data.counts,
    l: data.lastUsedAt,
  });
  const changed = before !== after;
  if (changed) {
    localDirty = true;
    healPendingUpload = true;
  }
  return changed;
}

/** Queue an upload after heal invents punches (once sync is armed). */
function queueHealUpload() {
  if (!healPendingUpload && !localDirty) return;
  if (!settings.scriptUrl || !settings.autoSync) return;
  if (!autoSyncArmed) return;
  healPendingUpload = false;
  queueSync();
}

/** True when stored day count, punch times, or lastUsedAt disagree for habit/day. */
function dayViewDrift(habitId, day) {
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : "";
  const id = String(habitId || "");
  if (!dayKey || !id) return false;
  const stored = getCount(id, dayKey);
  const ats = getUnmatchedPlusPunches(id, dayKey, data.punches);
  if (stored !== ats.length && (stored > 0 || ats.length > 0)) return true;
  const lu = getLastUsedAt(id);
  if (!lu) return false;
  const t = Date.parse(lu);
  if (!Number.isFinite(t) || dateStr(new Date(t)) !== dayKey) return false;
  if (!ats.length) return true;
  const lastMs = Date.parse(ats[ats.length - 1].at);
  return !Number.isFinite(lastMs) || Math.abs(lastMs - t) >= 60000;
}
let settings = loadSettings();
let selectedDate = todayStr();
/** Rightmost day shown in the 7-day strip (selected date can be any day). */
let stripEndDate = todayStr();
let currentView = "today";
let editingHabitId = null;
let modalEmoji = EMOJIS[0];
let modalColor = COLORS[0];
let modalType = "good";
let modalScheduleKind = "daily";
let modalWeekdays = [1, 3, 5];
let modalOnceDate = todayStr();
let modalDailyLimit = "";
/** Target list for new/edited habit (Move to…). */
let modalListId = null;
/** Bad-habit Stats compare mode: full-day average vs pace-until-now. */
let counterPaceMode = "full"; // "full" | "until"
let syncTimer = null;
/** Auto-sync stays disarmed until cloud state is loaded or confirmed empty. */
let autoSyncArmed = false;
/** True once initSync has finished its first cloud check. */
let cloudChecked = false;
/** Local edits waiting to push (set by queueSync, cleared after successful upload/restore). */
let localDirty = !!healPendingUpload;
/** Timestamp of last user edit — used to debounce mid-tap cloud pulls. */
let lastUserEditAt = 0;
/** Periodic cloud refresh timer. */
let pollTimer = null;
/** When the next poll is due (ms epoch), for Settings status. */
let nextPollAt = null;
/** Last successful cloud pull timestamp. */
let lastPullAt = null;

/* ---------------- persistence ---------------- */
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}
/** Generate a short, stable device identifier for conflict attribution. */
function makeDeviceId() {
  return "dev-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
/** Merge saved settings with defaults; empty scriptUrl falls back to the wired URL. */
function loadSettings() {
  const defaults = {
    scriptUrl: DEFAULT_SCRIPT_URL,
    autoSync: true,
    autoRefresh: true,         // poll cloud while app is open
    pollIntervalMs: DEFAULT_POLL_MS,
    lastSync: null,
    // Fail-safe sync state:
    deviceId: null,            // stable per-device id
    lastSeenRevision: null,    // last cloud revision this device confirmed
    lastSeenUpdatedAt: null,   // timestamp of that revision
    lastSyncOkAt: null,        // last successful upload or pull
    lastPullOkAt: null,        // last successful cloud pull
    lastSyncError: null,       // { at, message } last cloud API failure
  };
  const saved = load(LS_SETTINGS, null);
  const merged = saved ? { ...defaults, ...saved } : { ...defaults };
  let dirty = !saved;
  if (!merged.scriptUrl || !String(merged.scriptUrl).trim()) {
    merged.scriptUrl = DEFAULT_SCRIPT_URL;
    dirty = true;
  }
  if (!merged.deviceId) {
    merged.deviceId = makeDeviceId();
    dirty = true;
  }
  if (dirty) localStorage.setItem(LS_SETTINGS, JSON.stringify(merged));
  return merged;
}
function saveData() { localStorage.setItem(LS_DATA, JSON.stringify(data)); }
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

function makeDefaultList(createdAt) {
  return {
    id: DEFAULT_LIST_ID,
    name: DEFAULT_LIST_NAME,
    sortIndex: 0,
    createdAt: createdAt || (typeof todayStr === "function" ? todayStr() : new Date().toISOString().slice(0, 10)),
  };
}

function migrateList(l, index) {
  if (!l || typeof l !== "object") return null;
  const sortRaw = l.sortIndex != null ? Number(l.sortIndex) : NaN;
  return {
    id: String(l.id || ("list-" + Date.now().toString(36) + index)),
    name: String(l.name || "List").trim() || "List",
    sortIndex: Number.isFinite(sortRaw) ? sortRaw : index,
    createdAt: l.createdAt || todayStr(),
  };
}

/** Normalize legacy payloads so old habits behave as daily good habits on a default list. */
function migrateData(raw) {
  if (!raw || typeof raw !== "object") {
    const list = makeDefaultList();
    return {
      habits: [], checks: {}, counts: {},
      lastUsedAt: {}, punches: [],
      lists: [list], activeListId: list.id,
    };
  }

  let lists = Array.isArray(raw.lists)
    ? raw.lists.map(migrateList).filter(Boolean)
    : [];
  if (!lists.length) lists = [makeDefaultList(raw.habits && raw.habits[0] && raw.habits[0].createdAt)];
  lists.sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
  lists.forEach((l, i) => { l.sortIndex = i; });

  const listIds = new Set(lists.map(l => String(l.id)));
  const fallbackListId = lists[0].id;

  const habits = Array.isArray(raw.habits)
    ? raw.habits.map(h => migrateHabit(h, fallbackListId, listIds))
    : [];
  // Existing habits without sortIndex inherit current array order (per list later).
  habits.forEach((h, i) => {
    if (h && (h.sortIndex == null || !Number.isFinite(Number(h.sortIndex)))) h.sortIndex = i;
  });
  // Normalize sortIndex within each list while preserving relative order.
  const byList = new Map();
  for (const h of habits) {
    const lid = String(h.listId || fallbackListId);
    if (!byList.has(lid)) byList.set(lid, []);
    byList.get(lid).push(h);
  }
  for (const group of byList.values()) {
    group.sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
    group.forEach((h, i) => { h.sortIndex = i; });
  }
  habits.sort((a, b) => {
    const la = String(a.listId || "");
    const lb = String(b.listId || "");
    if (la !== lb) return la.localeCompare(lb);
    return (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id));
  });

  const checks = raw.checks && typeof raw.checks === "object" ? raw.checks : {};
  // Strip legacy random-id synthetics before heal so every device rebuilds
  // the same deterministic gap/orphan punches from counts + lastUsedAt.
  const punches = stripSyntheticPunches(migratePunches(raw.punches));
  const lastUsedAt = migrateLastUsedAt(raw.lastUsedAt);
  const countsIn = raw.counts && typeof raw.counts === "object" ? raw.counts : {};
  // Count gaps first (lastUsedAt becomes newest slot); then promote any newer orphan.
  backfillCountGapsIntoPunches(punches, countsIn, lastUsedAt);
  promoteOrphanLastUsedIntoPunches(punches, lastUsedAt);
  const counts = reconcileCountsFromPunches(countsIn, punches);
  reconcileLastUsedAtFromPunches(lastUsedAt, punches);
  let activeListId = raw.activeListId != null ? String(raw.activeListId) : fallbackListId;
  if (!listIds.has(activeListId)) activeListId = fallbackListId;
  return { habits, checks, counts, lastUsedAt, punches, lists, activeListId };
}

/** Keep only valid habitId → ISO timestamp pairs; missing stays empty. */
function migrateLastUsedAt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, iso] of Object.entries(raw)) {
    if (!id) continue;
    const s = String(iso || "").trim();
    if (!s) continue;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) continue;
    out[String(id)] = new Date(t).toISOString();
  }
  return out;
}

/** Normalize punch log; drop invalid rows. Cap kept in recordPunch. */
function migratePunches(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const habitId = p.habitId != null ? String(p.habitId) : "";
    if (!habitId) continue;
    const at = String(p.at || "").trim();
    const t = Date.parse(at);
    if (!Number.isFinite(t)) continue;
    const delta = Number(p.delta);
    if (!Number.isFinite(delta) || delta === 0) continue;
    const isoAt = new Date(t).toISOString();
    const dayRaw = p.day != null ? String(p.day).trim() : "";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dayRaw)
      ? dayRaw
      : dateStr(new Date(t));
    out.push({
      id: String(p.id || ("p-" + t.toString(36))),
      habitId,
      at: isoAt,
      delta: delta > 0 ? 1 : -1,
      day,
    });
  }
  return out;
}

/** Calendar day a punch applies to (count key). Prefer explicit day. */
function punchDay(p) {
  if (!p) return null;
  const dayRaw = p.day != null ? String(p.day).trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayRaw)) return dayRaw;
  const t = Date.parse(p.at);
  if (!Number.isFinite(t)) return null;
  return dateStr(new Date(t));
}

/** Re-derive lastUsedAt from punch stacks so map never drifts from undos. */
function reconcileLastUsedAtFromPunches(lastUsedAt, punches) {
  if (!lastUsedAt || typeof lastUsedAt !== "object") return lastUsedAt;
  if (!Array.isArray(punches) || !punches.length) return lastUsedAt;
  const ids = new Set();
  for (const p of punches) {
    if (p && p.habitId != null) ids.add(String(p.habitId));
  }
  for (const id of ids) {
    const iso = lastUsedAtFromPunchesList(punches, id);
    if (iso) lastUsedAt[id] = iso;
    else delete lastUsedAt[id];
  }
  return lastUsedAt;
}

/**
 * For every habit/day that appears in the punch log OR still has a legacy
 * counts[day][habitId], set the count to the unmatched-+ length (day-scoped).
 * After backfillCountGapsIntoPunches, punch length should already match (or
 * exceed) the stored total — reconcile keeps count ≡ timeline. Days with a
 * stored count but zero punches stay unchanged until backfill runs.
 */
function reconcileCountsFromPunches(countsIn, punches) {
  const counts = countsIn && typeof countsIn === "object" ? { ...countsIn } : {};
  // Deep-copy day maps so we do not mutate the raw object in place oddly.
  for (const day of Object.keys(counts)) {
    if (counts[day] && typeof counts[day] === "object") {
      counts[day] = { ...counts[day] };
    }
  }
  if (!Array.isArray(punches) || !punches.length) return counts;

  const pairs = new Map(); // habitId -> Set(day)
  for (const p of punches) {
    if (!p || p.habitId == null) continue;
    const day = punchDay(p);
    if (!day) continue;
    const id = String(p.habitId);
    if (!pairs.has(id)) pairs.set(id, new Set());
    pairs.get(id).add(day);
  }
  // Also touch legacy count keys for habits that have any punches.
  for (const day of Object.keys(counts)) {
    const row = counts[day];
    if (!row || typeof row !== "object") continue;
    for (const id of Object.keys(row)) {
      if (!pairs.has(id)) pairs.set(id, new Set());
      pairs.get(id).add(day);
    }
  }

  for (const [id, days] of pairs) {
    const stack = unmatchedPlusStack(punches, id);
    const byDay = new Map();
    for (const x of stack) {
      if (!x.day) continue;
      byDay.set(x.day, (byDay.get(x.day) || 0) + 1);
    }
    for (const day of days) {
      const n = byDay.get(day) || 0;
      const hadPunchForDay = punches.some(
        p => p && String(p.habitId) === id && punchDay(p) === day
      );
      if (!hadPunchForDay) continue; // pure legacy count, no punch rows for day
      if (!counts[day]) counts[day] = {};
      if (n === 0) {
        delete counts[day][id];
        if (!Object.keys(counts[day]).length) delete counts[day];
      } else {
        counts[day][id] = n;
      }
    }
  }
  return counts;
}

/**
 * Heal / backfill punches are device-invented. Their ids used to include
 * Math.random(), so two phones filled the same count gap with different ids;
 * merge-by-id then kept BOTH and counts diverged forever.
 * Detect synthetics so merge can drop them and rebuild deterministically.
 */
function isSyntheticPunchId(id) {
  const s = String(id || "");
  return (
    s.startsWith("p-bf-") ||
    s.startsWith("p-orphan-") ||
    s.startsWith("p-bf-gap-") ||
    s.startsWith("p-bf-lu-")
  );
}

function stripSyntheticPunches(punches) {
  if (!Array.isArray(punches)) return [];
  return punches.filter(p => p && !isSyntheticPunchId(p.id));
}

/** Stable 32-bit hash for deterministic backfill ids/times (same input → same out). */
function stableHash32(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Local-calendar ms for YYYY-MM-DD at hour:minute:second (day key stays correct). */
function localDayWallMs(day, hour, minute, second) {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d, hour || 0, minute || 0, second || 0).getTime();
}

/**
 * Deterministic ISO timestamp for gap slot i of habit/day.
 * Derived from day + habitId + index hash so devices never invent different clocks.
 */
function deterministicGapAtIso(habitId, day, index, gap, anchorMs) {
  const STEP_MS = 60 * 1000;
  const id = String(habitId || "");
  const d = String(day || "");
  const i = Math.max(0, Math.floor(Number(index) || 0));
  const g = Math.max(1, Math.floor(Number(gap) || 1));
  let ms;
  if (Number.isFinite(anchorMs)) {
    ms = anchorMs - (g - i) * STEP_MS;
  } else {
    // No known punch: place in mid-morning band via hash (stable across devices).
    const h = stableHash32(id + "|" + d + "|" + i);
    const minuteOfDay = 8 * 60 + (h % (10 * 60)); // 08:00–17:59
    ms = localDayWallMs(d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, (h % 50));
  }
  if (dateStr(new Date(ms)) !== d) {
    ms = localDayWallMs(d, 0, 1 + i, (stableHash32(id + d + i) % 50));
  }
  return new Date(ms).toISOString();
}

/** Stable id for a count-gap backfill punch (no Math.random). */
function deterministicGapPunchId(habitId, day, index) {
  return "p-bf-gap-" + String(habitId) + "-" + String(day).replace(/-/g, "") + "-" + index;
}

/**
 * Heal legacy gaps: when counts[day][habitId] = N but fewer than N unmatched +
 * punches exist for that day, insert synthetic + punches so the timeline shows
 * every use. Known clocks (existing punches / lastUsedAt on that day) are kept;
 * remaining unknowns use deterministic times from day+habitId+index (same on
 * every device — never Math.random / Date.now).
 *
 * Gap punches are inserted *before* the first existing + for that habit/day in
 * the log so stack order stays chronological and lastUsed stays the newest node.
 * Mutates `punches` in place.
 */
function backfillCountGapsIntoPunches(punches, counts, lastUsedAt) {
  if (!Array.isArray(punches)) return punches;
  if (!counts || typeof counts !== "object") return punches;
  const lastMap = lastUsedAt && typeof lastUsedAt === "object" ? lastUsedAt : {};

  for (const day of Object.keys(counts)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const row = counts[day];
    if (!row || typeof row !== "object") continue;
    for (const habitId of Object.keys(row)) {
      const id = String(habitId || "");
      if (!id) continue;
      const want = Math.max(0, Math.floor(Number(row[id]) || 0));
      if (want <= 0) continue;

      let dayStack = unmatchedPlusStack(punches, id).filter(x => x.day === day);
      let gap = want - dayStack.length;
      if (gap <= 0) continue;

      // Newest missing slot: append lastUsedAt if it falls on this day and is new.
      const lu = lastMap[id] ? String(lastMap[id]) : null;
      const luMs = lu ? Date.parse(lu) : NaN;
      if (Number.isFinite(luMs) && dateStr(new Date(luMs)) === day) {
        const already = dayStack.some(x => {
          const tx = Date.parse(x.at);
          return Number.isFinite(tx) && Math.abs(tx - luMs) < 60000;
        });
        if (!already) {
          punches.push({
            id: "p-bf-lu-" + id + "-" + day.replace(/-/g, "") + "-" + luMs.toString(36),
            habitId: id,
            at: new Date(luMs).toISOString(),
            delta: 1,
            day,
          });
          gap -= 1;
          dayStack = unmatchedPlusStack(punches, id).filter(x => x.day === day);
        }
      }
      if (gap <= 0) continue;

      const knownMs = dayStack
        .map(x => Date.parse(x.at))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const anchorMs = knownMs.length ? knownMs[0] : NaN;

      // Insert older unknowns before the first + for this habit/day (keep last = newest).
      let insertAt = -1;
      for (let i = 0; i < punches.length; i++) {
        const p = punches[i];
        if (!p || String(p.habitId) !== id) continue;
        if (Number(p.delta) <= 0) continue;
        if (punchDay(p) !== day) continue;
        insertAt = i;
        break;
      }
      if (insertAt < 0) insertAt = punches.length;

      const toInsert = [];
      for (let i = 0; i < gap; i++) {
        toInsert.push({
          id: deterministicGapPunchId(id, day, i),
          habitId: id,
          at: deterministicGapAtIso(id, day, i, gap, anchorMs),
          delta: 1,
          day,
        });
      }
      punches.splice(insertAt, 0, ...toInsert);
    }
  }
  return punches;
}

/**
 * If lastUsedAt has a real clock that is not represented by an unmatched +
 * punch on that local calendar day, append a synthetic + punch (same ISO).
 * Mutates `punches` in place; returns it. Remaining count gaps are filled by
 * backfillCountGapsIntoPunches.
 */
function promoteOrphanLastUsedIntoPunches(punches, lastUsedAt) {
  if (!Array.isArray(punches)) return punches;
  if (!lastUsedAt || typeof lastUsedAt !== "object") return punches;
  for (const [habitId, iso] of Object.entries(lastUsedAt)) {
    const id = String(habitId || "");
    if (!id) continue;
    const s = String(iso || "").trim();
    const t = Date.parse(s);
    if (!Number.isFinite(t)) continue;
    const at = new Date(t).toISOString();
    const day = dateStr(new Date(t));
    const dayStack = unmatchedPlusStack(punches, id).filter(x => x.day === day);
    const already = dayStack.some(x => {
      const tx = Date.parse(x.at);
      return Number.isFinite(tx) && Math.abs(tx - t) < 60000;
    });
    if (already) continue;
    const lastPunchMs = dayStack.length
      ? Date.parse(dayStack[dayStack.length - 1].at)
      : NaN;
    // Stale lastUsedAt older than the latest punch on that day → ignore (map will sync).
    if (Number.isFinite(lastPunchMs) && t <= lastPunchMs) continue;
    punches.push({
      id: "p-orphan-" + id + "-" + t.toString(36),
      habitId: id,
      at,
      delta: 1,
      day,
    });
  }
  return punches;
}

/**
 * Apply a signed delta to counts[day][habitId], clamping at 0.
 * Used when merging local-only punches onto a cloud counts base.
 */
function applyCountDelta(counts, day, habitId, delta) {
  const d = String(day || "");
  const id = String(habitId || "");
  const nDelta = Number(delta);
  if (!d || !id || !Number.isFinite(nDelta) || nDelta === 0) return;
  if (!counts[d]) counts[d] = {};
  const next = Math.max(0, (Number(counts[d][id]) || 0) + nDelta);
  if (next === 0) {
    delete counts[d][id];
    if (!Object.keys(counts[d]).length) delete counts[d];
  } else {
    counts[d][id] = next;
  }
}

function migrateHabit(h, fallbackListId, listIds) {
  if (!h || typeof h !== "object") return h;
  const type = h.type === "bad" ? "bad" : "good";
  let schedule = h.schedule;
  if (!schedule || typeof schedule !== "object") {
    schedule = { kind: "daily" };
  } else if (schedule.kind === "weekdays") {
    const weekdays = Array.isArray(schedule.weekdays)
      ? [...new Set(schedule.weekdays.map(Number).filter(n => n >= 0 && n <= 6))].sort()
      : [];
    schedule = { kind: "weekdays", weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5] };
  } else if (schedule.kind === "once") {
    schedule = { kind: "once", date: schedule.date || todayStr() };
  } else {
    schedule = { kind: "daily" };
  }
  let dailyLimit = null;
  if (type === "bad" && h.dailyLimit != null && h.dailyLimit !== "") {
    const n = Number(h.dailyLimit);
    if (Number.isFinite(n) && n >= 0) dailyLimit = Math.floor(n);
  }
  const sortRaw = h.sortIndex != null ? Number(h.sortIndex) : NaN;
  let listId = h.listId != null ? String(h.listId) : fallbackListId;
  if (listIds && !listIds.has(listId)) listId = fallbackListId;
  return {
    id: h.id,
    name: h.name || "Habit",
    emoji: h.emoji || EMOJIS[0],
    color: h.color || COLORS[0],
    createdAt: h.createdAt || todayStr(),
    archived: !!h.archived,
    listId,
    type,
    schedule,
    dailyLimit,
    sortIndex: Number.isFinite(sortRaw) ? sortRaw : null,
  };
}

/* ---------------- date helpers ---------------- */
function todayStr() { return dateStr(new Date()); }
function dateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(str, n) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dateStr(dt);
}
function prettyDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
function weekdayOf(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/* ---------------- lists ---------------- */
function sortedLists() {
  return (data.lists || [])
    .slice()
    .sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
}

function getActiveListId() {
  const id = data.activeListId;
  if (id && (data.lists || []).some(l => String(l.id) === String(id))) return String(id);
  const first = sortedLists()[0];
  return first ? String(first.id) : DEFAULT_LIST_ID;
}

function getActiveList() {
  const id = getActiveListId();
  return (data.lists || []).find(l => String(l.id) === id) || sortedLists()[0] || makeDefaultList();
}

function setActiveList(listId) {
  if (!(data.lists || []).some(l => String(l.id) === String(listId))) return;
  data.activeListId = String(listId);
  saveData();
  render();
}

function countHabitsInList(listId) {
  return (data.habits || []).filter(h => !h.archived && String(h.listId) === String(listId)).length;
}

/** Good habits in a list that are scheduled on `date` (bad habits excluded). */
function goodHabitsForListOnDate(listId, date) {
  const lid = String(listId);
  return (data.habits || []).filter(h =>
    !h.archived &&
    h.type !== "bad" &&
    String(h.listId) === lid &&
    isScheduledOn(h, date)
  );
}

/**
 * Progress of positive habits for a list on a date.
 * pct = completed / scheduled good habits (0 when none scheduled).
 */
function listGoodProgress(listId, date) {
  const goods = goodHabitsForListOnDate(listId, date);
  const scheduled = goods.length;
  const done = goods.filter(h => isChecked(h.id, date)).length;
  const pct = scheduled ? Math.round((done / scheduled) * 100) : 0;
  return { done, scheduled, pct };
}

function nextListSortIndex() {
  let max = -1;
  for (const l of data.lists || []) {
    const n = Number(l.sortIndex);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Trim + lowercase for case-insensitive name compares. */
function normalizeNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

/** True if another list already uses this name (case-insensitive). */
function listNameTaken(name, excludeId) {
  const key = normalizeNameKey(name);
  if (!key) return false;
  return (data.lists || []).some(l =>
    l && String(l.id) !== String(excludeId || "") && normalizeNameKey(l.name) === key
  );
}

/**
 * Active (non-archived) habit with the same name (trimmed, case-insensitive),
 * excluding excludeId. Scans all lists — no duplicate names among active habits.
 */
function findDuplicateActiveHabit(name, excludeId) {
  const key = normalizeNameKey(name);
  if (!key) return null;
  return (data.habits || []).find(h =>
    h && !h.archived &&
    String(h.id) !== String(excludeId || "") &&
    normalizeNameKey(h.name) === key
  ) || null;
}

function createList(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) { toast("Give your list a name"); return null; }
  if (listNameTaken(trimmed)) {
    toast("A list with this name already exists");
    return null;
  }
  const list = {
    id: "list-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: trimmed,
    sortIndex: nextListSortIndex(),
    createdAt: todayStr(),
  };
  data.lists = sortedLists().concat([list]);
  data.activeListId = list.id;
  saveData();
  queueSync();
  render();
  toast("List created");
  return list;
}

function renameList(listId, name) {
  const list = (data.lists || []).find(l => String(l.id) === String(listId));
  if (!list) return false;
  const trimmed = String(name || "").trim();
  if (!trimmed) { toast("Give your list a name"); return false; }
  if (listNameTaken(trimmed, list.id)) {
    toast("A list with this name already exists");
    return false;
  }
  list.name = trimmed;
  saveData();
  queueSync();
  render();
  return true;
}

function deleteList(listId) {
  const lists = sortedLists();
  if (lists.length <= 1) {
    toast("Keep at least one list");
    return false;
  }
  const id = String(listId);
  const list = lists.find(l => String(l.id) === id);
  if (!list) return false;
  const habitCount = countHabitsInList(id);
  if (habitCount > 0) {
    if (!confirm(`Delete "${list.name}" and its ${habitCount} habit${habitCount === 1 ? "" : "s"}?`)) {
      return false;
    }
  } else if (!confirm(`Delete list "${list.name}"?`)) {
    return false;
  }

  const habitIds = new Set(
    (data.habits || []).filter(h => String(h.listId) === id).map(h => String(h.id))
  );
  data.habits = (data.habits || []).filter(h => String(h.listId) !== id);
  for (const d of Object.keys(data.checks || {})) {
    data.checks[d] = (data.checks[d] || []).filter(x => !habitIds.has(String(x)));
    if (!data.checks[d].length) delete data.checks[d];
  }
  for (const d of Object.keys(data.counts || {})) {
    if (!data.counts[d]) continue;
    for (const hid of habitIds) delete data.counts[d][hid];
    if (!Object.keys(data.counts[d]).length) delete data.counts[d];
  }
  data.lists = lists.filter(l => String(l.id) !== id);
  data.lists.forEach((l, i) => { l.sortIndex = i; });
  if (String(data.activeListId) === id) {
    data.activeListId = data.lists[0].id;
  }
  saveData();
  queueSync();
  render();
  toast("List deleted");
  return true;
}

function promptCreateList() {
  const name = prompt("New list name", "My Habits");
  if (name == null) return;
  createList(name);
}

function promptRenameList(listId) {
  const list = (data.lists || []).find(l => String(l.id) === String(listId || getActiveListId()));
  if (!list) return;
  const name = prompt("Rename list", list.name);
  if (name == null) return;
  renameList(list.id, name);
}

/* ---------------- schedule / habit helpers ---------------- */
function activeHabits() {
  const listId = getActiveListId();
  return data.habits
    .filter(h => !h.archived && String(h.listId) === listId)
    .slice()
    .sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
}

function nextSortIndex() {
  return nextSortIndexForList(getActiveListId());
}

function nextSortIndexForList(listId) {
  const lid = String(listId);
  let max = -1;
  for (const h of data.habits) {
    if (String(h.listId) !== lid) continue;
    const n = Number(h.sortIndex);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Move a habit to another list. Updates listId + sortIndex, persists, syncs.
 * Returns true if moved.
 */
function moveHabitToList(habitId, targetListId) {
  const h = data.habits.find(x => String(x.id) === String(habitId));
  if (!h) return false;
  const target = String(targetListId);
  if (!(data.lists || []).some(l => String(l.id) === target)) return false;
  if (String(h.listId) === target) return false;
  h.listId = target;
  h.sortIndex = nextSortIndexForList(target);
  saveData();
  queueSync();
  render();
  return true;
}

/**
 * Reorder active habits so the visible subset matches `orderedVisibleIds`
 * (other active habits keep their relative slots). Persists + syncs.
 *
 * IMPORTANT: never do `arr.find(x => x.id === ids[vi++])` — find() invokes the
 * predicate on every candidate, so vi++ burns through the id list and drops habits.
 */
function applyVisibleHabitOrder(orderedVisibleIds) {
  if (!Array.isArray(orderedVisibleIds) || orderedVisibleIds.length < 2) return;
  const active = activeHabits();
  if (active.length < 2) return;

  const byId = new Map(active.map(h => [String(h.id), h]));
  const orderedUnique = [];
  const seenOrdered = new Set();
  for (const raw of orderedVisibleIds) {
    const id = String(raw);
    if (!byId.has(id) || seenOrdered.has(id)) continue;
    orderedUnique.push(id);
    seenOrdered.add(id);
  }
  if (orderedUnique.length < 2) return;

  let vi = 0;
  const reordered = [];
  for (const h of active) {
    if (seenOrdered.has(String(h.id))) {
      const nextId = orderedUnique[vi++];
      const next = byId.get(nextId);
      // Fail-safe: never skip a slot — keep the original habit if lookup fails.
      reordered.push(next || h);
    } else {
      reordered.push(h);
    }
  }

  // Absolute fail-safe: refuse to persist if any active habit would be lost.
  if (
    reordered.length !== active.length ||
    new Set(reordered.map(h => String(h.id))).size !== active.length
  ) {
    console.warn("Habit reorder aborted — would drop or duplicate habits");
    render();
    return;
  }

  reordered.forEach((h, i) => { h.sortIndex = i; });
  saveData();
  queueSync();
  render();
}

/**
 * Whether a habit appears on a given date for scheduling / back-fill.
 * createdAt is NOT used here — users can log past days for daily/weekday habits.
 * (Stats still prefer createdAt as a soft history start where noted.)
 */
function isScheduledOn(habit, date) {
  const s = habit.schedule || { kind: "daily" };
  if (s.kind === "weekdays") {
    const days = Array.isArray(s.weekdays) ? s.weekdays : [];
    return days.includes(weekdayOf(date));
  }
  if (s.kind === "once") return s.date === date;
  return true; // daily
}

function isFutureDate(date) {
  return date > todayStr();
}

/** Keep the 7-day strip covering `date` (as the rightmost day if outside the window). */
function ensureDateInStrip(date) {
  const start = addDays(stripEndDate, -6);
  if (date < start || date > stripEndDate) stripEndDate = date;
}

function habitsForDate(date) {
  return activeHabits().filter(h => isScheduledOn(h, date));
}

function goodHabitsForDate(date) {
  return habitsForDate(date).filter(h => h.type !== "bad");
}

function scheduleLabel(habit) {
  const s = habit.schedule || { kind: "daily" };
  if (s.kind === "weekdays") {
    const days = (s.weekdays || []).slice().sort();
    if (days.length === 7) return "Every day";
    if (days.length === 5 && days.join() === "1,2,3,4,5") return "Weekdays";
    if (days.length === 2 && days.join() === "0,6") return "Weekends";
    if (days.length === 0) return "No days";
    return days.map(d => DOW_LABELS[d]).join(" · ");
  }
  if (s.kind === "once") {
    if (!s.date) return "One date";
    const [y, m, d] = s.date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return "Every day";
}

function emojiBg(color) {
  // Soft tinted chip — keeps icons refined instead of loud color blocks
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color + "2E";
  return "rgba(255,255,255,0.06)";
}

/* ---------------- good-habit checks ---------------- */
function isChecked(habitId, date) {
  return (data.checks[date] || []).includes(habitId);
}

let justCheckedId = null;

function toggleCheck(habitId, date) {
  const list = data.checks[date] || (data.checks[date] = []);
  const i = list.indexOf(habitId);
  if (i >= 0) list.splice(i, 1);
  else {
    list.push(habitId);
    recordPunch(habitId, 1, date);
  }
  if (list.length === 0) delete data.checks[date];
  // Flag so the re-render can play the satisfying tick animation once
  justCheckedId = i < 0 ? habitId : null;
  saveData();
  render();
  justCheckedId = null;
  queueSync();
  if (navigator.vibrate) navigator.vibrate(15);
}

/* ---------------- punch / last-used timestamps ---------------- */
const MAX_PUNCHES = 500;

/**
 * Effective last-used from a punch list: unmatched + punches form a stack;
 * each − pops one (same calendar day when known). Returns the top + timestamp or null.
 */
function lastUsedAtFromPunchesList(punches, habitId) {
  const id = String(habitId || "");
  if (!id || !Array.isArray(punches)) return null;
  const stack = unmatchedPlusStack(punches, id);
  return stack.length ? stack[stack.length - 1].at : null;
}

/**
 * Unmatched + punches for a habit (chronological).
 * Each − pops the latest unmatched + for the same calendar day (punch.day / local
 * date of `at`). Cross-day undos must not steal another day's use times — that
 * was dropping timeline nodes while counts[day] stayed high.
 * Legacy − rows without a resolvable day fall back to popping the global top.
 * Returns [{ at, day }, ...] still on the stack after all undos.
 */
function unmatchedPlusStack(punches, habitId) {
  const id = String(habitId || "");
  if (!id || !Array.isArray(punches)) return [];
  const stack = [];
  for (const p of punches) {
    if (!p || String(p.habitId) !== id) continue;
    const d = Number(p.delta);
    if (d > 0) {
      stack.push({ at: String(p.at), day: punchDay(p) });
    } else if (d < 0 && stack.length) {
      const minusDay = punchDay(p);
      if (minusDay) {
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].day === minusDay) {
            idx = i;
            break;
          }
        }
        if (idx >= 0) stack.splice(idx, 1);
        // No + left for that day → no-op (do not pop another day).
      } else {
        stack.pop();
      }
    }
  }
  return stack;
}

/** Unmatched + punches for habitId on a single calendar day (count key). */
function getUnmatchedPlusPunches(habitId, day, punches) {
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : "";
  if (!dayKey) return [];
  const list = punches || (typeof data !== "undefined" ? data.punches : null);
  return unmatchedPlusStack(list, habitId).filter(x => x.day === dayKey);
}

/** ISO clock times of unmatched + punches for habitId on calendar day. */
function useTimesForDay(habitId, day) {
  return badDayView(habitId, day).ats;
}

/**
 * Single source of truth for a bad habit on a calendar day.
 * After heal, punch length matches the stored day total so
 * `count === ats.length` and lastUsed is the last timeline node.
 * Display also appends orphan lastUsedAt when it is newer than punches
 * (even if some punches already exist for the day).
 */
function badDayView(habitId, day, punchesIn, lastUsedIn, countsIn) {
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : "";
  const id = String(habitId || "");
  const punches = Array.isArray(punchesIn)
    ? punchesIn
    : (Array.isArray(typeof data !== "undefined" ? data.punches : null) ? data.punches : []);
  const lastMap = lastUsedIn && typeof lastUsedIn === "object"
    ? lastUsedIn
    : (typeof data !== "undefined" && data.lastUsedAt && typeof data.lastUsedAt === "object"
      ? data.lastUsedAt
      : {});
  const counts = countsIn && typeof countsIn === "object"
    ? countsIn
    : (typeof data !== "undefined" && data.counts && typeof data.counts === "object"
      ? data.counts
      : {});
  const stored = (() => {
    if (!dayKey || !id) return 0;
    const row = counts[dayKey];
    if (!row || row[id] == null) return 0;
    return Number(row[id]) || 0;
  })();

  if (!dayKey || !id) {
    return { ats: [], count: stored, lastIso: null };
  }

  let ats = getUnmatchedPlusPunches(id, dayKey, punches).map(x => x.at);

  // Orphan / newer lastUsedAt on this day must appear as the last use time.
  const lu = lastMap[id] ? String(lastMap[id]) : null;
  const t = lu ? Date.parse(lu) : NaN;
  if (Number.isFinite(t) && dateStr(new Date(t)) === dayKey) {
    const luIso = new Date(t).toISOString();
    const already = ats.some(a => {
      const tx = Date.parse(a);
      return Number.isFinite(tx) && Math.abs(tx - t) < 60000;
    });
    if (!already) {
      const lastMs = ats.length ? Date.parse(ats[ats.length - 1]) : NaN;
      if (!ats.length || !Number.isFinite(lastMs) || t > lastMs) {
        ats = ats.concat([luIso]);
      }
    }
  }

  if (ats.length) {
    return { ats, count: ats.length, lastIso: ats[ats.length - 1] };
  }
  return { ats: [], count: stored, lastIso: null };
}

/**
 * Effective bad-habit count for a day — always matches timeline length when
 * any use events exist (see badDayView).
 */
function badCountForDay(habitId, day) {
  return badDayView(habitId, day).count;
}

function lastUsedAtFromPunches(habitId) {
  return lastUsedAtFromPunchesList(data.punches, habitId);
}

/** Keep lastUsedAt[habitId] in sync with the punch stack (or clear it). */
function syncLastUsedAtFromPunches(habitId) {
  const id = String(habitId || "");
  if (!id) return;
  if (!data.lastUsedAt || typeof data.lastUsedAt !== "object") data.lastUsedAt = {};
  const iso = lastUsedAtFromPunches(id);
  if (iso) data.lastUsedAt[id] = iso;
  else delete data.lastUsedAt[id];
}

/**
 * Undo the latest unmatched + punch for a habit on `day` (minus button).
 * Appends a compensating δ=-1 row (sync-safe: merge unions by id, so splicing
 * would resurrect the + from cloud) and refreshes lastUsedAt from the stack.
 * Only pops a + attributed to the same calendar day — never another day's use.
 */
function undoLatestPlusPunch(habitId, day) {
  const id = String(habitId || "");
  if (!id) return;
  if (!Array.isArray(data.punches)) data.punches = [];
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day))
    ? String(day)
    : todayStr();
  if (getUnmatchedPlusPunches(id, dayKey, data.punches).length) {
    const at = new Date().toISOString();
    data.punches.push({
      id: "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      habitId: id,
      at,
      delta: -1,
      day: dayKey,
    });
    if (data.punches.length > MAX_PUNCHES) {
      data.punches = data.punches.slice(-MAX_PUNCHES);
    }
  }
  syncLastUsedAtFromPunches(id);
}

/** Record a clock-time + punch and set lastUsedAt to now. `day` = counts key. */
function recordPunch(habitId, delta, day) {
  const id = String(habitId || "");
  if (!id) return;
  const d = Number(delta);
  if (!Number.isFinite(d) || d <= 0) return;
  const at = new Date().toISOString();
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day))
    ? String(day)
    : todayStr();
  if (!Array.isArray(data.punches)) data.punches = [];

  // Legacy days may have counts without punches. Backfill so the first live +
  // does not collapse the counter to 1 when punches become source of truth.
  const existing = getUnmatchedPlusPunches(id, dayKey, data.punches);
  const stored = getCount(id, dayKey);
  const gap = Math.max(0, stored - existing.length);
  if (gap > 0) {
    backfillCountGapsIntoPunches(data.punches, data.counts, data.lastUsedAt);
  }

  data.punches.push({
    id: "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    habitId: id,
    at,
    delta: 1,
    day: dayKey,
  });
  if (data.punches.length > MAX_PUNCHES) {
    data.punches = data.punches.slice(-MAX_PUNCHES);
  }
  if (!data.lastUsedAt || typeof data.lastUsedAt !== "object") data.lastUsedAt = {};
  data.lastUsedAt[id] = at;
}

function getLastUsedAt(habitId) {
  const map = data.lastUsedAt;
  if (!map || typeof map !== "object") return null;
  const iso = map[String(habitId)];
  return iso ? String(iso) : null;
}

/**
 * Relative label from an ISO timestamp.
 * "Just now" only under 30s so rapid +/− undos are distinguishable.
 */
function formatLastUsedAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 30) return "Just now";
  if (sec < 60) return sec + "s ago";
  const mins = Math.floor(sec / 60);
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

/**
 * Local clock time for a last-used / punch ISO.
 * Always 24h with leading zeros (e.g. "00:42", "13:06") so timeline nodes
 * match last-used and never render ambiguous "0:42" / locale 12h mix.
 */
function formatLastUsedClock(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

/** Short label for use-times compare rows: Today / Yesterday / "Sun 9". */
function useCompareDayLabel(day) {
  const dayKey = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : "";
  if (!dayKey) return "";
  const today = todayStr();
  if (dayKey === today) return "Today";
  if (dayKey === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return DOW_LABELS[dt.getDay()] + " " + d;
}

/** Minutes since local midnight for an HH:MM clock (clamped to the day). */
function minutesFromClock(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock || "").trim());
  if (!m) return 0;
  const hh = Math.min(23, Math.max(0, Number(m[1]) || 0));
  const mm = Math.min(59, Math.max(0, Number(m[2]) || 0));
  return hh * 60 + mm;
}

/** Proportional position on a 00:00–24:00 rail (0–100). */
function clockToRailPct(clock) {
  return (minutesFromClock(clock) / (24 * 60)) * 100;
}

/**
 * Layout nodes on the day rail: proportional left%, slight separation for
 * identical/near-identical times, and up/down label lanes so clocks never clip.
 */
function layoutUseRailNodes(clocks) {
  const list = Array.isArray(clocks) ? clocks.filter(Boolean) : [];
  const n = list.length;
  if (!n) return [];
  const MIN_SEP = 2.2;
  const CLOSE = 8.5;
  const pcts = list.map(clockToRailPct);
  for (let i = 1; i < n; i++) {
    if (pcts[i] - pcts[i - 1] < MIN_SEP) {
      pcts[i] = Math.min(100, pcts[i - 1] + MIN_SEP);
    }
  }
  // If right-edge overflow from nudging, compress slightly from the right.
  if (pcts[n - 1] > 100) {
    const overflow = pcts[n - 1] - 100;
    for (let i = 0; i < n; i++) pcts[i] = Math.max(0, pcts[i] - overflow * (i / (n - 1 || 1)));
  }
  const lanes = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let lane = i % 2;
    if (i > 0 && Math.abs(pcts[i] - pcts[i - 1]) < CLOSE) {
      lane = 1 - lanes[i - 1];
    }
    lanes[i] = lane;
  }
  const last = n - 1;
  return list.map((clock, i) => ({
    clock,
    pct: pcts[i],
    lane: lanes[i],
    latest: i === last,
  }));
}

/**
 * Fill one day rail: soft 00→24 track with proportional nodes + HH:MM labels.
 * Count N → N nodes. Empty days keep a muted rail + "No uses".
 */
function fillUseCompareRow(rowEl, clocks) {
  if (!rowEl) return;
  const track = rowEl.querySelector(".use-rail-track");
  const empty = rowEl.querySelector(".use-times-empty");
  const sr = rowEl.querySelector(".use-rail-sr");
  if (!track || !empty) return;
  const nodes = layoutUseRailNodes(clocks);
  const has = nodes.length > 0;
  empty.classList.toggle("hidden", has);
  empty.textContent = "No uses";
  rowEl.classList.toggle("is-empty", !has);
  rowEl.setAttribute("data-times", has ? nodes.map(x => x.clock).join(" ") : "");
  track.replaceChildren();
  if (sr) {
    sr.textContent = has ? nodes.map(x => x.clock).join(", ") : "No uses";
  }
  if (!has) return;

  const frag = document.createDocumentFragment();
  nodes.forEach((node, i) => {
    const el = document.createElement("div");
    el.className = "use-node"
      + (node.lane === 1 ? " lane-below" : " lane-above")
      + (node.latest ? " latest" : "");
    el.style.setProperty("--pct", String(node.pct));
    el.setAttribute("title", node.latest ? "Latest · " + node.clock : node.clock);
    el.setAttribute("data-clock", node.clock);

    const dot = document.createElement("span");
    dot.className = "use-node-dot";
    dot.setAttribute("aria-hidden", "true");

    const time = document.createElement("time");
    time.className = "use-node-label";
    time.setAttribute("datetime", node.clock);
    time.textContent = node.clock;

    el.appendChild(dot);
    el.appendChild(time);
    // Stagger entrance slightly for a calm motion (respect reduced-motion in CSS).
    el.style.setProperty("--i", String(i));
    frag.appendChild(el);
  });
  track.appendChild(frag);
}

/** Label + count badge for a compare row (e.g. "Today · 6"). */
function setUseCompareLabel(rowEl, dayLabel, count) {
  if (!rowEl) return;
  const lab = rowEl.querySelector(".use-times-day-label");
  if (!lab) return;
  lab.replaceChildren();
  const name = document.createElement("span");
  name.className = "use-times-day-name";
  name.textContent = dayLabel || "";
  lab.appendChild(name);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const badge = document.createElement("span");
  badge.className = "use-times-count";
  badge.textContent = " · " + n;
  lab.appendChild(badge);
  lab.setAttribute("title", (dayLabel || "Day") + ": " + n + (n === 1 ? " use" : " uses"));
}

function laterIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return ta >= tb ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return null;
}

/* ---------------- bad-habit counts ---------------- */
function getCount(habitId, date) {
  const day = data.counts[date];
  if (!day || day[habitId] == null) return 0;
  return Number(day[habitId]) || 0;
}

function hasCountRecord(habitId, date) {
  const day = data.counts[date];
  return !!(day && Object.prototype.hasOwnProperty.call(day, habitId));
}

function setCount(habitId, date, value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (!data.counts[date]) data.counts[date] = {};
  if (n === 0) {
    delete data.counts[date][habitId];
    if (Object.keys(data.counts[date]).length === 0) delete data.counts[date];
  } else {
    data.counts[date][habitId] = n;
  }
  saveData();
  render();
  queueSync();
  if (navigator.vibrate) navigator.vibrate(12);
}

function incrementCount(habitId, date) {
  recordPunch(habitId, 1, date);
  setCount(habitId, date, badCountForDay(habitId, date));
}

function decrementCount(habitId, date) {
  const cur = badCountForDay(habitId, date);
  if (cur <= 0) return;
  // Undo the latest + punch for this day so lastUsedAt / timeline stay aligned.
  undoLatestPlusPunch(habitId, date);
  const punches = Array.isArray(data.punches) ? data.punches : [];
  const id = String(habitId || "");
  const dayKey = date && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : "";
  const hasDayPunch = dayKey && punches.some(
    p => p && String(p.habitId) === id && punchDay(p) === dayKey
  );
  if (hasDayPunch) {
    setCount(habitId, date, getUnmatchedPlusPunches(id, dayKey, punches).length);
  } else {
    setCount(habitId, date, cur - 1);
  }
}

/**
 * Average of prior scheduled days that have a recorded count in the counts map.
 * Excludes `asOfDate` (defaults to today). Uses every prior key in counts — not
 * habit.createdAt — so back-filled days still contribute to the average.
 * Returns { avg, samples } — samples === 0 means insufficient history.
 */
function historicalAverage(habitId, asOfDate) {
  const habit = data.habits.find(h => h.id === habitId);
  if (!habit) return { avg: null, samples: 0 };
  const cutoff = asOfDate || todayStr();
  const values = [];
  for (const date of Object.keys(data.counts || {})) {
    if (date >= cutoff) continue;
    if (!isScheduledOn(habit, date)) continue;
    if (!hasCountRecord(habitId, date)) continue;
    values.push(getCount(habitId, date));
  }
  if (values.length < MIN_AVG_HISTORY_DAYS) return { avg: null, samples: values.length };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { avg, samples: values.length };
}

function totalCountSum(habitId) {
  let sum = 0;
  for (const date of Object.keys(data.counts || {})) {
    if (hasCountRecord(habitId, date)) sum += getCount(habitId, date);
  }
  return sum;
}

function daysWithCount(habitId) {
  return Object.keys(data.counts || {}).filter(d => hasCountRecord(habitId, d)).length;
}

/* ---------------- streaks (scheduled good habits only) ---------------- */
function historyStart(habit) {
  // Prefer createdAt, but never later than today; allow back-fill window of ~1 year
  const today = todayStr();
  const floor = addDays(today, -400);
  const created = habit && habit.createdAt ? habit.createdAt : today;
  return created < floor ? floor : created > today ? today : created;
}

function currentStreak(habitId) {
  const habit = data.habits.find(h => h.id === habitId);
  if (!habit || habit.type === "bad") return 0;
  let streak = 0;
  let day = todayStr();
  const start = historyStart(habit);
  // Today doesn't break the streak if not yet checked
  if (isScheduledOn(habit, day) && !isChecked(habitId, day)) day = addDays(day, -1);
  let guard = 0;
  while (day >= start && guard < 800) {
    if (!isScheduledOn(habit, day)) {
      day = addDays(day, -1);
      guard++;
      continue;
    }
    if (!isChecked(habitId, day)) break;
    streak++;
    day = addDays(day, -1);
    guard++;
  }
  return streak;
}

function bestStreak(habitId) {
  const habit = data.habits.find(h => h.id === habitId);
  if (!habit || habit.type === "bad") return 0;
  const start = historyStart(habit);
  const today = todayStr();
  let best = 0, run = 0;
  let day = start;
  let guard = 0;
  while (day <= today && guard < 800) {
    if (isScheduledOn(habit, day)) {
      if (isChecked(habitId, day)) {
        run++;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
    }
    day = addDays(day, 1);
    guard++;
  }
  return best;
}

function totalChecks(habitId) {
  return Object.keys(data.checks).filter(d => isChecked(habitId, d)).length;
}

function completionRate(habitId) {
  const habit = data.habits.find(h => h.id === habitId);
  if (!habit || habit.type === "bad") return null;
  const start = historyStart(habit);
  const today = todayStr();
  let scheduled = 0, done = 0;
  let day = start;
  let guard = 0;
  while (day <= today && guard < 800) {
    if (isScheduledOn(habit, day)) {
      scheduled++;
      if (isChecked(habitId, day)) done++;
    }
    day = addDays(day, 1);
    guard++;
  }
  if (!scheduled) return 0;
  return Math.round((done / scheduled) * 100);
}

/* ---------------- rendering ---------------- */
function render() {
  // Heal count↔timeline↔lastUsed drift before paint (selected day + all days).
  if (healDataDrift()) {
    saveData();
    queueHealUpload();
  }
  renderListTabs();
  renderDateStrip();
  renderHabits();
  renderStats();
  renderSettingsLists();
  updateFabVisibility();
}

function updateFabVisibility() {
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.toggle("view-settings", currentView === "settings");
}

function renderListTabs() {
  const tabsEl = document.getElementById("list-tabs");
  if (!tabsEl) return;
  const lists = sortedLists();
  const activeId = getActiveListId();
  tabsEl.innerHTML = "";
  for (const list of lists) {
    const count = countHabitsInList(list.id);
    const isActive = String(list.id) === activeId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "list-tab" + (isActive ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.listId = list.id;
    btn.setAttribute("aria-label", list.name);
    const nameSpan = document.createElement("span");
    nameSpan.className = "list-tab-name";
    nameSpan.textContent = list.name;
    btn.appendChild(nameSpan);
    if (!isActive && count > 0) {
      const badge = document.createElement("span");
      badge.className = "list-tab-badge";
      badge.textContent = String(count);
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => setActiveList(list.id));
    tabsEl.appendChild(btn);
  }

  const active = getActiveList();
  const statsTitle = document.getElementById("stats-list-title");
  if (statsTitle) statsTitle.textContent = (active ? active.name : "Habits") + " · Stats";
  renderActiveListProgress();
}

function renderActiveListProgress() {
  const wrap = document.getElementById("list-day-progress");
  const fillEl = document.getElementById("list-day-progress-fill");
  const metaEl = document.getElementById("list-day-progress-meta");
  if (!wrap || !fillEl || !metaEl) return;
  const prog = listGoodProgress(getActiveListId(), selectedDate);
  if (prog.scheduled <= 0) {
    wrap.classList.add("hidden");
    wrap.removeAttribute("aria-valuenow");
    fillEl.style.width = "0%";
    metaEl.textContent = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.classList.toggle("progress-complete", prog.done >= prog.scheduled);
  wrap.setAttribute("aria-valuenow", String(prog.pct));
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "100");
  wrap.setAttribute("aria-label", `${prog.pct}% complete — ${prog.done} of ${prog.scheduled} good habits`);
  fillEl.style.width = prog.pct + "%";
  metaEl.textContent = prog.pct + "%";
}

function renderSettingsLists() {
  const el = document.getElementById("settings-lists");
  if (!el) return;
  el.innerHTML = "";
  for (const list of sortedLists()) {
    const row = document.createElement("div");
    row.className = "settings-list-row";
    const count = countHabitsInList(list.id);
    row.innerHTML =
      `<div class="name"></div>` +
      `<div class="count"></div>` +
      `<button type="button" class="mini-btn" data-act="rename">Rename</button>` +
      `<button type="button" class="mini-btn danger" data-act="delete">Delete</button>`;
    row.querySelector(".name").textContent = list.name;
    row.querySelector(".count").textContent = count + " habit" + (count === 1 ? "" : "s");
    row.querySelector('[data-act="rename"]').onclick = () => promptRenameList(list.id);
    row.querySelector('[data-act="delete"]').onclick = () => deleteList(list.id);
    el.appendChild(row);
  }
}

function renderDateStrip() {
  const strip = document.getElementById("date-strip");
  strip.innerHTML = "";
  const picker = document.getElementById("date-picker");
  if (picker) picker.value = selectedDate;

  for (let i = 6; i >= 0; i--) {
    const d = addDays(stripEndDate, -i);
    const [y, m, day] = d.split("-").map(Number);
    const dt = new Date(y, m - 1, day);
    const goods = goodHabitsForDate(d);
    const done = goods.filter(h => isChecked(h.id, d)).length;
    const dotCls = goods.length && done === goods.length ? "all" : done > 0 ? "some" : "";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-chip" + (d === selectedDate ? " selected" : "") + (d === todayStr() ? " today" : "");
    btn.innerHTML =
      `<span class="dow">${dt.toLocaleDateString(undefined, { weekday: "short" })}</span>` +
      `<span class="dom">${day}</span>` +
      `<span class="dot ${dotCls}"></span>`;
    btn.onclick = () => { selectedDate = d; render(); };
    strip.appendChild(btn);
  }
}

function shiftWeek(deltaWeeks) {
  stripEndDate = addDays(stripEndDate, deltaWeeks * 7);
  const start = addDays(stripEndDate, -6);
  if (selectedDate < start || selectedDate > stripEndDate) {
    selectedDate = stripEndDate;
  }
  render();
}

function pickDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  selectedDate = date;
  ensureDateInStrip(date);
  render();
}

function renderHabits() {
  const listEl = document.getElementById("habit-list");
  const emptyEl = document.getElementById("empty-state");
  const habits = habitsForDate(selectedDate);
  const anyInList = activeHabits().length > 0;
  listEl.innerHTML = "";

  if (!habits.length) {
    emptyEl.classList.remove("hidden");
    const h2 = emptyEl.querySelector("h2");
    const p = emptyEl.querySelector("p");
    if (anyInList) {
      h2.textContent = "Nothing scheduled";
      p.textContent = "No habits are scheduled for this day. Add one or pick another date.";
    } else {
      h2.textContent = "No habits yet";
      p.textContent = "Add a habit to this list to start tracking.";
    }
    return;
  }
  emptyEl.classList.add("hidden");

  for (const h of habits) {
    let card;
    if (h.type === "bad") {
      card = renderBadHabitCard(h);
    } else {
      card = renderGoodHabitCard(h);
    }
    card.dataset.habitId = h.id;
    listEl.appendChild(card);
  }
  enableHabitListDrag(listEl);
}

function renderGoodHabitCard(h) {
  const done = isChecked(h.id, selectedDate);
  const streak = currentStreak(h.id);
  const future = isFutureDate(selectedDate);
  const card = document.createElement("div");
  card.className = "habit-card" + (done ? " done" : "") + (future ? " future" : "")
    + (done && h.id === justCheckedId ? " just-checked" : "");
  const streakPill = streak > 0
    ? `<span class="habit-pill streak">${streak} day${streak > 1 ? "s" : ""}</span>`
    : "";
  card.innerHTML =
    DRAG_HANDLE +
    `<div class="habit-emoji" style="background:${emojiBg(h.color)}">${h.emoji}</div>` +
    `<div class="habit-info">
       <div class="habit-name"></div>
       <div class="habit-meta">
         <span class="habit-pill schedule"></span>
         ${streakPill}
       </div>
     </div>` +
    `<button class="habit-edit" title="Edit" type="button" aria-label="Edit habit">${EDIT_ICON}</button>` +
    `<button class="habit-check" type="button" aria-label="${done ? "Uncheck" : "Check off"}"${future ? " disabled" : ""}>✓</button>`;
  card.querySelector(".habit-name").textContent = h.name;
  card.querySelector(".habit-pill.schedule").textContent = scheduleLabel(h);
  if (!future) {
    card.querySelector(".habit-check").onclick = () => toggleCheck(h.id, selectedDate);
  }
  card.querySelector(".habit-edit").onclick = () => openHabitModal(h.id);
  return card;
}

function renderBadHabitCard(h) {
  const prevDate = addDays(selectedDate, -1);
  // Heal selected + previous day if count, punch times, or lastUsedAt disagree.
  if (
    (dayViewDrift(h.id, selectedDate) || dayViewDrift(h.id, prevDate))
    && healDataDrift()
  ) {
    saveData();
    queueHealUpload();
  }

  // One array drives count, timeline, and last-used clock — they cannot diverge.
  const dayView = badDayView(h.id, selectedDate);
  const prevView = badDayView(h.id, prevDate);
  const dayUseAts = dayView.ats;
  const count = dayView.count;
  const { avg, samples } = historicalAverage(h.id, selectedDate);
  const overLimit = h.dailyLimit != null && count > h.dailyLimit;
  const overAvg = avg != null && samples >= MIN_AVG_HISTORY_DAYS && count > avg;
  const future = isFutureDate(selectedDate);
  const hasAvg = avg != null && samples >= MIN_AVG_HISTORY_DAYS;
  const warnings = [];
  if (overLimit) warnings.push(`Over daily limit (${h.dailyLimit})`);
  if (overAvg) warnings.push(`Above your average (${avg.toFixed(1)})`);
  const tips = [];
  if (h.dailyLimit == null) tips.push("Set a daily limit");
  else if (!hasAvg && !future) tips.push("Average after another logged day");

  const card = document.createElement("div");
  card.className = "habit-card bad-habit"
    + (overLimit || overAvg ? " warn" : "")
    + (overLimit ? " over-limit" : "")
    + (future ? " future" : "");
  const limitPill = h.dailyLimit != null
    ? `<span class="habit-pill limit">Limit ${h.dailyLimit}</span>`
    : "";
  const avgPill = hasAvg
    ? `<span class="habit-pill avg">Avg ${avg.toFixed(1)}</span>`
    : `<span class="habit-pill avg pending">Avg pending</span>`;
  const lastIso = dayView.lastIso || (dayUseAts.length ? null : getLastUsedAt(h.id));
  const lastLabel = formatLastUsedAgo(lastIso);
  const lastClock = formatLastUsedClock(lastIso);
  const lastUsedHtml = lastLabel
    ? `<div class="habit-last-used" title="${lastIso || ""}"><span class="last-rel">${lastLabel}</span>${lastClock ? `<span class="last-clock">${lastClock}</span>` : ""}</div>`
    : `<div class="habit-last-used never">Not used yet</div>`;
  const dayUseClocks = dayUseAts.map(formatLastUsedClock).filter(Boolean);
  const prevUseClocks = prevView.ats.map(formatLastUsedClock).filter(Boolean);
  const showUseCompare = dayUseClocks.length > 0 || prevUseClocks.length > 0;
  const selLabel = useCompareDayLabel(selectedDate);
  const prevLabel = useCompareDayLabel(prevDate);
  const useTimesHtml = showUseCompare
    ? `<div class="habit-use-times" aria-label="Use times: ${selLabel} vs ${prevLabel}">
         <div class="use-times-day" data-role="selected" data-times="">
           <div class="use-times-day-label"></div>
           <div class="use-rail">
             <div class="use-rail-scale" aria-hidden="true">
               <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
             </div>
             <div class="use-rail-body">
               <div class="use-rail-track"></div>
               <span class="use-times-empty hidden">No uses</span>
             </div>
             <span class="use-rail-sr visually-hidden"></span>
           </div>
         </div>
         <div class="use-times-day" data-role="prev" data-times="">
           <div class="use-times-day-label"></div>
           <div class="use-rail use-rail-prev">
             <div class="use-rail-body">
               <div class="use-rail-track"></div>
               <span class="use-times-empty hidden">No uses</span>
             </div>
             <span class="use-rail-sr visually-hidden"></span>
           </div>
         </div>
       </div>`
    : "";

  const alertHtml = [
    ...warnings.map(() => `<div class="habit-warn" role="alert"></div>`),
    ...tips.map(() => `<div class="habit-tip"></div>`),
  ].join("");

  card.innerHTML =
    DRAG_HANDLE +
    `<div class="habit-emoji" style="background:${emojiBg(h.color)}">${h.emoji}</div>` +
    `<div class="habit-info">
       <div class="habit-name"></div>
       <div class="habit-meta">
         <span class="habit-pill schedule"></span>
         ${limitPill}
         ${avgPill}
       </div>
       ${lastUsedHtml}
       ${alertHtml ? `<div class="habit-alerts">${alertHtml}</div>` : ""}
     </div>` +
    `<button class="habit-edit" title="Edit" type="button" aria-label="Edit habit">${EDIT_ICON}</button>` +
    `<div class="counter-controls" role="group" aria-label="Counter">
       <button class="counter-btn dec" type="button" aria-label="Decrease"${future ? " disabled" : ""}>−</button>
       <span class="counter-value" aria-live="polite">${count}</span>
       <button class="counter-btn inc" type="button" aria-label="Increase"${future ? " disabled" : ""}>+</button>
     </div>` +
    useTimesHtml;
  card.querySelector(".habit-name").textContent = h.name;
  card.querySelector(".habit-pill.schedule").textContent = scheduleLabel(h);
  card.querySelectorAll(".habit-warn").forEach((el, i) => { el.textContent = warnings[i]; });
  card.querySelectorAll(".habit-tip").forEach((el, i) => { el.textContent = tips[i]; });
  if (showUseCompare) {
    const selRow = card.querySelector('.use-times-day[data-role="selected"]');
    const prevRow = card.querySelector('.use-times-day[data-role="prev"]');
    if (selRow) {
      setUseCompareLabel(selRow, selLabel, dayUseClocks.length || dayView.count || 0);
      fillUseCompareRow(selRow, dayUseClocks);
    }
    if (prevRow) {
      setUseCompareLabel(prevRow, prevLabel, prevUseClocks.length || prevView.count || 0);
      fillUseCompareRow(prevRow, prevUseClocks);
    }
  }
  if (overLimit) {
    const val = card.querySelector(".counter-value");
    val.classList.add("over");
    val.title = `Over daily limit (${h.dailyLimit})`;
  }
  card.querySelector(".habit-edit").onclick = () => openHabitModal(h.id);
  if (!future) {
    card.querySelector(".counter-btn.inc").onclick = () => incrementCount(h.id, selectedDate);
    card.querySelector(".counter-btn.dec").onclick = () => decrementCount(h.id, selectedDate);
  }
  card.querySelector(".counter-btn.dec").disabled = future || count <= 0;
  return card;
}

function renderStats() {
  const habits = activeHabits();
  const listEl = document.getElementById("stats-list");

  listEl.innerHTML = "";
  if (!habits.length) {
    listEl.innerHTML = `<p class="muted center">Add habits to see stats here.</p>`;
    return;
  }
  for (const h of habits) {
    const card = document.createElement("div");
    card.className = "stat-card" + (h.type === "bad" ? " bad" : "");
    card.dataset.habitId = h.id;

    let meta;
    let chartHtml;
    if (h.type === "bad") {
      const { avg, samples } = historicalAverage(h.id);
      const avgTxt = samples >= MIN_AVG_HISTORY_DAYS ? avg.toFixed(1) : "n/a";
      meta = `Σ ${totalCountSum(h.id)} · ${daysWithCount(h.id)} days · avg ${avgTxt}` +
        (h.dailyLimit != null ? ` · limit ${h.dailyLimit}` : "");
      chartHtml = renderTrackTillHourChart(h);
    } else {
      meta = `${currentStreak(h.id)} streak · best ${bestStreak(h.id)} · ${completionRate(h.id)}%`;
      let cells = "";
      for (let i = 29; i >= 0; i--) {
        const d = addDays(todayStr(), -i);
        let cls = "heat-cell";
        if (!isScheduledOn(h, d)) cls += " off-day";
        else if (isChecked(h.id, d)) cls += " on";
        if (i === 0) cls += " today-cell";
        cells += `<div class="${cls}" title="${d}"></div>`;
      }
      chartHtml = `<div class="heatmap">${cells}</div>`;
    }

    card.innerHTML =
      `<div class="stat-head">
         ${DRAG_HANDLE}
         <div class="habit-emoji" style="background:${emojiBg(h.color)}">${h.emoji}</div>
         <div class="stat-title-wrap">
           <div class="stat-title"></div>
           <div class="stat-type">${h.type === "bad" ? "Counter" : "Habit"} · ${scheduleLabel(h)}</div>
         </div>
         <div class="stat-meta"></div>
       </div>
       ${chartHtml}`;
    card.querySelector(".stat-title").textContent = h.name;
    card.querySelector(".stat-meta").textContent = meta;
    listEl.appendChild(card);
  }
  listEl.querySelectorAll("[data-pace]").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.pace;
      if (mode !== "full" && mode !== "until") return;
      if (counterPaceMode === mode) return;
      counterPaceMode = mode;
      renderStats();
    });
  });
  enableHabitListDrag(listEl);
}

/**
 * Full-day target for a bad-habit counter:
 * prefer configured dailyLimit (> 0), else historical full-day average
 * from prior days with recorded counts (excludes today).
 */
function counterDayTarget(h) {
  if (h.dailyLimit != null && h.dailyLimit > 0) {
    return { target: h.dailyLimit, source: "limit" };
  }
  const { avg, samples } = historicalAverage(h.id);
  if (avg != null && samples >= MIN_AVG_HISTORY_DAYS) {
    return { target: avg, source: "average" };
  }
  return { target: null, source: "none" };
}

/** Minutes elapsed in the local calendar day (0–1439). */
function minutesElapsedToday(now) {
  const d = now || new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Expected count by now for Until-now pace: whole number proportional to day.
 * expected = round(target × minutesElapsedToday / (24×60))
 */
function expectedCountByNow(target, now) {
  if (target == null || !(target > 0)) return 0;
  const mins = minutesElapsedToday(now);
  return Math.round(target * mins / (24 * 60));
}

/**
 * Primary Stats viz for COUNTER habits: Today / Yesterday / 2 Days Ago
 * vs full-day average (or daily limit). Until now adds a plain pace note
 * (ahead/behind) without dual markers or fractional expected bars.
 */
function renderTrackTillHourChart(h) {
  const { target, source } = counterDayTarget(h);
  const today = todayStr();
  const rows = [
    { key: "today", label: "Today", date: today, isToday: true },
    { key: "yesterday", label: "Yesterday", date: addDays(today, -1), isToday: false },
    { key: "twoAgo", label: "2 days ago", date: addDays(today, -2), isToday: false },
  ].map(r => ({ ...r, count: getCount(h.id, r.date) }));

  const untilMode = counterPaceMode === "until";
  const targetNoun = source === "limit" ? "limit" : "average";
  const targetLine =
    source === "limit"
      ? `Limit: ${formatTarget(target)}/day`
      : target != null
        ? `Average: ${formatTarget(target)}/day`
        : "Average: —";

  if (target == null || !(target > 0)) {
    return (
      `<div class="track-chart">
         <div class="track-chart-title">Pace vs average</div>
         <div class="track-pending">
           <p>No average yet</p>
           <span>Set a daily limit, or log counts on a prior day.</span>
         </div>
         ${renderMiniCountChart(h)}
       </div>`
    );
  }

  const compareLabel = targetNoun === "limit" ? "limit" : "avg";
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const scaleMax = Math.max(target, maxCount, 1);

  let rowHtml = "";
  for (const row of rows) {
    // Always compare bars to the full-day avg/limit (fair, readable).
    const atOrOver = row.count >= target;
    const tone = atOrOver ? "over" : "ok";
    const showBar = row.count > 0;
    const barPct = Math.min(100, (row.count / scaleMax) * 100);
    const fillW = showBar ? Math.max(barPct, 2.5) : 0;
    const vals = `${row.count} used · ${compareLabel} ${formatTarget(target)}`;
    rowHtml +=
      `<div class="track-row${row.isToday ? " is-today" : ""}" title="${row.date}: ${vals}">
         <div class="track-label">${row.label}</div>
         <div class="track-rail-wrap">
           <div class="track-rail">
             ${showBar ? `<div class="track-fill tone-${tone}" style="width:${fillW.toFixed(2)}%"></div>` : `<div class="track-fill empty"></div>`}
           </div>
         </div>
         <div class="track-vals${atOrOver ? " over" : ""}">${vals}</div>
       </div>`;
  }

  let paceNote = "";
  if (untilMode) {
    const todayCount = rows.find(r => r.isToday)?.count || 0;
    const expected = expectedCountByNow(target);
    const delta = todayCount - expected;
    let paceText;
    if (delta > 0) paceText = `Pace: ahead by ${delta}`;
    else if (delta < 0) paceText = `Pace: behind by ${Math.abs(delta)}`;
    else paceText = "Pace: on track";
    paceNote =
      `<div class="track-pace-note" title="Expected by now (rounded): ${expected} of ${formatTarget(target)}/day">
         ${paceText}
         <span class="track-pace-sub">· expected ~${expected} by now</span>
       </div>`;
  }

  return (
    `<div class="track-chart">
       <div class="track-chart-head">
         <div class="track-chart-title">Pace vs average</div>
         <div class="track-chart-sub">${targetLine}</div>
       </div>
       <div class="pace-toggle" role="group" aria-label="Compare mode">
         <button type="button" class="pace-opt${untilMode ? "" : " selected"}" data-pace="full">Full day</button>
         <button type="button" class="pace-opt${untilMode ? " selected" : ""}" data-pace="until">Until now</button>
       </div>
       <div class="track-legend">
         <span class="track-legend-item ok"><i></i>Under ${targetNoun}</span>
         <span class="track-legend-item over"><i></i>At/over ${targetNoun}</span>
       </div>
       <div class="track-rows">${rowHtml}</div>
       ${paceNote}
       ${renderMiniCountChart(h)}
     </div>`
  );
}

function formatTarget(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

/** Compact 7-day spark bars under the primary track chart (secondary). */
function renderMiniCountChart(h) {
  const DAYS = 7;
  const today = todayStr();
  const { target } = counterDayTarget(h);
  const days = [];
  let max = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const c = getCount(h.id, d);
    if (c > max) max = c;
    days.push({ date: d, count: c, isToday: i === 0 });
  }
  const scaleMax = Math.max(max, target != null ? target : 0, h.dailyLimit != null ? h.dailyLimit : 0, 1);
  let cols = "";
  for (const day of days) {
    // Floor keeps a zero-height bar visible without flattening relative scale.
    const pct = day.count <= 0 ? 0 : Math.max(6, Math.round((day.count / scaleMax) * 100));
    const over = target != null ? day.count >= target : (h.dailyLimit != null && day.count >= h.dailyLimit);
    const under = day.count > 0 && !over;
    const toneCls = over ? " over" : under ? " under" : "";
    const dom = Number(day.date.split("-")[2]);
    cols +=
      `<div class="mini-col${day.isToday ? " today" : ""}${toneCls}${day.count === 0 ? " zero" : ""}" title="${day.date}: ${day.count}">
         <span class="mini-val${day.count === 0 ? " zero" : ""}">${day.count}</span>
         <div class="mini-bar-wrap"><div class="mini-bar" style="height:${day.count === 0 ? 3 : pct}%"></div></div>
         <span class="mini-day">${dom}</span>
       </div>`;
  }
  return `<div class="mini-count-chart" aria-label="Last 7 days"><div class="mini-count-label">Last 7 days</div><div class="mini-count-body">${cols}</div></div>`;
}

/* ---------------- drag-to-reorder (Today + Stats) ---------------- */
let habitDragState = null;

function enableHabitListDrag(listEl) {
  if (!listEl) return;
  const cards = [...listEl.querySelectorAll("[data-habit-id]")];
  if (cards.length < 2) return;
  for (const card of cards) {
    const handle = card.querySelector(".habit-drag");
    if (!handle || handle.dataset.dragBound) continue;
    handle.dataset.dragBound = "1";
    handle.addEventListener("pointerdown", e => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginHabitDrag(card, listEl, e);
    });
  }
}

function beginHabitDrag(card, listEl, e) {
  if (habitDragState) return;
  const handle = card.querySelector(".habit-drag");
  const cards = () => [...listEl.querySelectorAll("[data-habit-id]:not(.habit-drag-ghost)")];
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("habit-drag-ghost");
  ghost.removeAttribute("data-habit-id");
  ghost.style.width = rect.width + "px";
  ghost.style.height = rect.height + "px";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);

  const placeholder = document.createElement("div");
  placeholder.className = "habit-drag-placeholder";
  placeholder.style.height = rect.height + "px";
  card.after(placeholder);
  card.classList.add("habit-dragging-source");

  habitDragState = {
    listEl,
    card,
    ghost,
    placeholder,
    offsetY: e.clientY - rect.top,
    pointerId: e.pointerId,
  };

  try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  listEl.classList.add("is-reordering");
  document.body.classList.add("habit-drag-active");

  const onMove = ev => {
    if (!habitDragState || ev.pointerId !== habitDragState.pointerId) return;
    ev.preventDefault();
    ghost.style.top = (ev.clientY - habitDragState.offsetY) + "px";
    const midY = ev.clientY;
    const siblings = cards().filter(c => c !== card);
    let inserted = false;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (midY < r.top + r.height / 2) {
        listEl.insertBefore(placeholder, sib);
        inserted = true;
        break;
      }
    }
    if (!inserted) listEl.appendChild(placeholder);
  };

  const onUp = ev => {
    if (!habitDragState || ev.pointerId !== habitDragState.pointerId) return;
    finishHabitDrag();
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

function finishHabitDrag() {
  const state = habitDragState;
  habitDragState = null;
  if (!state) return;
  const { listEl, card, ghost, placeholder } = state;
  placeholder.replaceWith(card);
  card.classList.remove("habit-dragging-source");
  ghost.remove();
  listEl.classList.remove("is-reordering");
  document.body.classList.remove("habit-drag-active");

  const orderedIds = [...listEl.querySelectorAll("[data-habit-id]")]
    .map(el => el.dataset.habitId)
    .filter(id => id != null && id !== "");
  // Deduplicate while preserving DOM order (guards against nested/stray attrs).
  const seen = new Set();
  const uniqueOrdered = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueOrdered.push(id);
  }
  const visiblePrev = activeHabits().map(h => String(h.id)).filter(id => seen.has(id));
  const changed = uniqueOrdered.length === visiblePrev.length &&
    uniqueOrdered.length >= 2 &&
    uniqueOrdered.some((id, i) => id !== visiblePrev[i]);
  if (changed) applyVisibleHabitOrder(uniqueOrdered);
  else render();
}

/* ---------------- habit modal ---------------- */
function openHabitModal(habitId) {
  editingHabitId = typeof habitId === "string" ? habitId : null;
  const h = editingHabitId ? data.habits.find(x => x.id === editingHabitId) : null;

  clearHabitNameError();
  document.getElementById("modal-title").textContent = h ? "Edit habit" : "New habit";
  document.getElementById("habit-name").value = h ? h.name : "";
  document.getElementById("btn-delete-habit").classList.toggle("hidden", !h);
  modalEmoji = h ? h.emoji : EMOJIS[0];
  modalColor = h ? h.color : COLORS[Math.floor(Math.random() * COLORS.length)];
  modalType = h ? (h.type === "bad" ? "bad" : "good") : "good";
  const s = h && h.schedule ? h.schedule : { kind: "daily" };
  modalScheduleKind = s.kind === "weekdays" || s.kind === "once" ? s.kind : "daily";
  modalWeekdays = s.kind === "weekdays" && Array.isArray(s.weekdays) && s.weekdays.length
    ? [...s.weekdays]
    : [1, 3, 5];
  modalOnceDate = s.kind === "once" && s.date ? s.date : todayStr();
  modalDailyLimit = h && h.dailyLimit != null ? String(h.dailyLimit) : "";
  modalListId = h && h.listId ? String(h.listId) : getActiveListId();

  renderPickers();
  syncModalSections();
  document.getElementById("habit-modal").classList.remove("hidden");
  if (!h) setTimeout(() => document.getElementById("habit-name").focus(), 100);
}
function closeHabitModal() {
  clearHabitNameError();
  document.getElementById("habit-modal").classList.add("hidden");
}

function syncModalSections() {
  document.querySelectorAll("[data-type-opt]").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.typeOpt === modalType);
  });
  document.querySelectorAll("[data-schedule-opt]").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.scheduleOpt === modalScheduleKind);
  });
  document.getElementById("weekday-picker").classList.toggle("hidden", modalScheduleKind !== "weekdays");
  document.getElementById("once-date-wrap").classList.toggle("hidden", modalScheduleKind !== "once");
  document.getElementById("limit-wrap").classList.toggle("hidden", modalType !== "bad");
  document.getElementById("habit-once-date").value = modalOnceDate;
  document.getElementById("habit-daily-limit").value = modalDailyLimit;
  document.getElementById("habit-name").placeholder =
    modalType === "bad" ? "e.g. Cigarettes" : "e.g. Brush teeth";

  const listSelect = document.getElementById("habit-list-select");
  const listHint = document.getElementById("habit-list-hint");
  if (listSelect) {
    const lists = sortedLists();
    const selected = modalListId && lists.some(l => String(l.id) === String(modalListId))
      ? String(modalListId)
      : getActiveListId();
    modalListId = selected;
    listSelect.innerHTML = "";
    for (const list of lists) {
      const opt = document.createElement("option");
      opt.value = list.id;
      opt.textContent = list.name;
      if (String(list.id) === selected) opt.selected = true;
      listSelect.appendChild(opt);
    }
  }
  if (listHint) {
    listHint.textContent = editingHabitId
      ? "Change the list to move this habit."
      : "New habits go into the selected list.";
  }

  const wp = document.getElementById("weekday-picker");
  wp.innerHTML = "";
  DOW_LABELS.forEach((label, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (modalWeekdays.includes(i) ? " selected" : "");
    b.textContent = label;
    b.onclick = () => {
      if (modalWeekdays.includes(i)) {
        if (modalWeekdays.length > 1) modalWeekdays = modalWeekdays.filter(d => d !== i);
      } else {
        modalWeekdays = [...modalWeekdays, i].sort();
      }
      syncModalSections();
    };
    wp.appendChild(b);
  });
}

function renderPickers() {
  const eg = document.getElementById("emoji-grid");
  eg.innerHTML = "";
  for (const e of EMOJIS) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "emoji-cell" + (e === modalEmoji ? " selected" : "");
    c.textContent = e;
    c.onclick = () => { modalEmoji = e; renderPickers(); };
    eg.appendChild(c);
  }
  const cg = document.getElementById("color-grid");
  cg.innerHTML = "";
  for (const col of COLORS) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "color-cell" + (col === modalColor ? " selected" : "");
    c.style.background = col;
    c.onclick = () => { modalColor = col; renderPickers(); };
    cg.appendChild(c);
  }
}

function buildScheduleFromModal() {
  if (modalScheduleKind === "weekdays") {
    const weekdays = modalWeekdays.length ? [...modalWeekdays].sort() : [1];
    return { kind: "weekdays", weekdays };
  }
  if (modalScheduleKind === "once") {
    const date = document.getElementById("habit-once-date").value || todayStr();
    return { kind: "once", date };
  }
  return { kind: "daily" };
}

function showHabitNameError(msg) {
  toast(msg);
  const input = document.getElementById("habit-name");
  const err = document.getElementById("habit-name-error");
  if (input) {
    input.classList.add("input-error");
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }
  if (err) {
    err.textContent = msg;
    err.classList.remove("hidden");
  }
}

function clearHabitNameError() {
  const input = document.getElementById("habit-name");
  const err = document.getElementById("habit-name-error");
  if (input) {
    input.classList.remove("input-error");
    input.removeAttribute("aria-invalid");
  }
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
}

function saveHabit() {
  clearHabitNameError();
  const name = document.getElementById("habit-name").value.trim();
  if (!name) { showHabitNameError("Give your habit a name"); return; }
  if (modalScheduleKind === "weekdays" && !modalWeekdays.length) {
    toast("Pick at least one weekday");
    return;
  }
  let dailyLimit = null;
  if (modalType === "bad") {
    const raw = document.getElementById("habit-daily-limit").value.trim();
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { toast("Daily limit must be a number ≥ 0"); return; }
      dailyLimit = Math.floor(n);
    }
  }
  const schedule = buildScheduleFromModal();
  const listSelectEl = document.getElementById("habit-list-select");
  const chosenListId = (listSelectEl && listSelectEl.value)
    || modalListId
    || getActiveListId();
  if (!(data.lists || []).some(l => String(l.id) === String(chosenListId))) {
    toast("Pick a valid list");
    return;
  }
  if (findDuplicateActiveHabit(name, editingHabitId)) {
    showHabitNameError("A habit with this name already exists");
    return;
  }
  const fields = {
    name,
    emoji: modalEmoji,
    color: modalColor,
    type: modalType,
    schedule,
    dailyLimit,
  };
  if (editingHabitId) {
    const h = data.habits.find(x => x.id === editingHabitId);
    const prevList = String(h.listId);
    Object.assign(h, fields);
    if (prevList !== String(chosenListId)) {
      h.listId = String(chosenListId);
      h.sortIndex = nextSortIndexForList(chosenListId);
    }
  } else {
    data.habits.push({
      id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...fields,
      listId: String(chosenListId),
      createdAt: todayStr(),
      archived: false,
      sortIndex: nextSortIndexForList(chosenListId),
    });
    // Switch to the list where the habit was created if different.
    if (String(data.activeListId) !== String(chosenListId)) {
      data.activeListId = String(chosenListId);
    }
  }
  saveData();
  closeHabitModal();
  render();
  queueSync();
}
function deleteHabit() {
  if (!editingHabitId) return;
  if (!confirm("Delete this habit and its history?")) return;
  const id = editingHabitId;
  data.habits = data.habits.filter(h => h.id !== id);
  for (const d of Object.keys(data.checks)) {
    data.checks[d] = data.checks[d].filter(x => x !== id);
    if (!data.checks[d].length) delete data.checks[d];
  }
  for (const d of Object.keys(data.counts || {})) {
    if (data.counts[d] && Object.prototype.hasOwnProperty.call(data.counts[d], id)) {
      delete data.counts[d][id];
      if (!Object.keys(data.counts[d]).length) delete data.counts[d];
    }
  }
  if (data.lastUsedAt && Object.prototype.hasOwnProperty.call(data.lastUsedAt, id)) {
    delete data.lastUsedAt[id];
  }
  if (Array.isArray(data.punches)) {
    data.punches = data.punches.filter(p => String(p.habitId) !== String(id));
  }
  saveData();
  closeHabitModal();
  render();
  queueSync();
}

/* ---------------- Google Sheets sync (fail-safe) ---------------- */

/** HTTP error from cloud API — surfaced in Settings diagnostics. */
function GasHttpError(status, snippet) {
  this.name = "GasHttpError";
  this.status = status;
  this.snippet = snippet || "";
  this.message = "HTTP " + status + (snippet ? " — " + String(snippet).slice(0, 160) : "");
}
GasHttpError.prototype = Object.create(Error.prototype);

/** Safe base64 of UTF-8 JSON for GET/form fallbacks. */
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

async function gasJsonGet(url) {
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new GasHttpError(res.status, text);
  if (!String(text).trim()) throw new Error("Empty response from cloud");
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new GasHttpError(res.status || 200, "invalid JSON: " + String(text).slice(0, 120));
  }
}

/**
 * POST via XMLHttpRequest — Google Apps Script redirects POST and fetch()
 * often turns it into a broken GET (404/411). XHR survives the redirect on mobile.
 */
function gasPostJson(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
    xhr.timeout = 120000;
    xhr.onload = () => {
      const text = xhr.responseText || "";
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!String(text).trim()) {
          reject(new Error("Empty response on upload"));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new GasHttpError(xhr.status, "invalid JSON: " + String(text).slice(0, 120))); }
      } else {
        reject(new GasHttpError(xhr.status, text));
      }
    };
    xhr.onerror = () => reject(new GasHttpError(0, "Network error — can't reach cloud (XHR POST)"));
    xhr.ontimeout = () => reject(new Error("Upload timed out (120s)"));
    xhr.send(body);
  });
}

/**
 * Form-urlencoded POST with payload=base64(JSON). Works when text/plain POST
 * is stripped by a redirect but a form body still reaches Apps Script.
 */
function gasPostForm(url, payload) {
  const b64 = utf8ToBase64(JSON.stringify(payload));
  const body = "payload=" + encodeURIComponent(b64);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=utf-8");
    xhr.timeout = 120000;
    xhr.onload = () => {
      const text = xhr.responseText || "";
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!String(text).trim()) {
          reject(new Error("Empty response on form upload"));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new GasHttpError(xhr.status, "invalid JSON: " + String(text).slice(0, 120))); }
      } else {
        reject(new GasHttpError(xhr.status, text));
      }
    };
    xhr.onerror = () => reject(new GasHttpError(0, "Network error — can't reach cloud (form POST)"));
    xhr.ontimeout = () => reject(new Error("Form upload timed out (120s)"));
    xhr.send(body);
  });
}

/** Keep GET URLs under typical mobile / Apps Script query limits. */
const MAX_GET_SAVE_URL = 7000;
const GET_SAVE_CHUNK_CHARS = 1200;

/** Turn raw transport errors into Settings-friendly actions. */
function humanizeUploadError(err) {
  const status = err && err.status;
  const msg = err && err.message ? String(err.message) : String(err || "Unknown error");
  if (status === 401 || status === 403) {
    return "Backend auth blocked — redeploy Apps Script (Who has access: Anyone)";
  }
  if (status === 414 || /too large|URI Too Long|Chunk URL/i.test(msg)) {
    return "Upload too large for GET fallback — needs backend v39+ chunked save (redeploy Apps Script)";
  }
  if (status === 404 || status === 405 || status === 411) {
    return "Upload blocked by Apps Script redirect (HTTP " + status + ") — retry; redeploy backend if it persists";
  }
  if (/invalid JSON|Empty response/i.test(msg)) {
    return "Cloud returned a bad upload response (redirect/HTML) — retry; if it persists redeploy backend";
  }
  if (/Network error|Failed to fetch|Load failed|status\":\s*0|HTTP 0/i.test(msg)) {
    return "Network error on upload — check connection; Settings → Last error for details";
  }
  if (/timed out/i.test(msg)) {
    return "Upload timed out — try again on Wi‑Fi";
  }
  return msg;
}

/** Compact detail string for Settings → Last error (status + truncated body). */
function formatSyncErrorDetail(err) {
  const bits = [];
  if (err && err.status != null) bits.push("HTTP " + err.status);
  const msg = err && err.message ? String(err.message) : String(err || "Unknown error");
  bits.push(msg);
  if (err && err.snippet) {
    const snip = String(err.snippet).replace(/\s+/g, " ").trim().slice(0, 160);
    if (snip && msg.indexOf(snip) < 0) bits.push(snip);
  }
  return bits.join(" | ").slice(0, 500);
}

/** Remember backend capabilities from ?action=info for diagnostics. */
function rememberBackendInfo(info) {
  if (!info || typeof info !== "object") return;
  if (info.backendVersion != null) settings.backendVersion = info.backendVersion;
  if (info.supportsGetSave != null) settings.supportsGetSave = !!info.supportsGetSave;
  if (info.supportsChunkedSave != null) settings.supportsChunkedSave = !!info.supportsChunkedSave;
  if (info.supportsFormSave != null) settings.supportsFormSave = !!info.supportsFormSave;
}

async function enrichUploadError(postErr, getErr) {
  let backendHint = "";
  try {
    const info = await gasJsonGet(settings.scriptUrl + "?action=info");
    rememberBackendInfo(info);
    saveSettings();
    const ver = info && info.backendVersion != null ? Number(info.backendVersion) : null;
    if (ver != null && (ver < 39 || info.supportsChunkedSave === false)) {
      backendHint = " Backend needs redeploy (v39+ chunked GET save).";
    } else if (ver != null) {
      backendHint = " Backend v" + ver + " OK — retry Upload, or tap Replace with cloud on the other phone.";
    }
  } catch (_) {
    backendHint = " Could not reach backend info — check Web App URL / network.";
  }
  const primary = getErr || postErr;
  const detail = formatSyncErrorDetail(primary);
  return new Error(humanizeUploadError(primary) + " [" + detail + "]" + backendHint);
}

/** Reject non-save JSON (e.g. old backend ignoring saveChunk). */
function assertSaveTransportResult(out, via) {
  if (!out) throw new Error("Empty save result via " + via);
  if (out.waiting) return out;
  if (out.conflict) return out;
  if (out.ok && out.revision != null) return out;
  if (out.ok === false && out.error) throw new Error(out.error);
  throw new Error(
    "Save via " + via + " incomplete — redeploy Apps Script backend v39+ (" +
    String(out.message || out.error || "no revision").slice(0, 100) + ")"
  );
}

/** Chunked GET ?action=saveChunk when a single payload URL is too long. */
async function gasSaveViaChunks(b64) {
  const n = Math.ceil(b64.length / GET_SAVE_CHUNK_CHARS) || 1;
  const uploadId = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let last = null;
  for (let i = 0; i < n; i++) {
    const chunk = b64.slice(i * GET_SAVE_CHUNK_CHARS, (i + 1) * GET_SAVE_CHUNK_CHARS);
    const url = settings.scriptUrl +
      "?action=saveChunk&uploadId=" + encodeURIComponent(uploadId) +
      "&i=" + i + "&n=" + n +
      "&chunk=" + encodeURIComponent(chunk);
    if (url.length > MAX_GET_SAVE_URL) {
      throw new GasHttpError(414, "Chunk URL still too long (" + url.length + ")");
    }
    last = assertSaveTransportResult(await gasJsonGet(url), "saveChunk");
    if (last && !last.waiting) return last;
  }
  if (!last) throw new Error("Chunked save produced no response");
  if (last.waiting) {
    throw new Error("Chunked save incomplete — missing chunks (try again)");
  }
  return assertSaveTransportResult(last, "saveChunk");
}

/** GET ?action=save&payload=base64, or chunked save when URL would be too long. */
async function gasSaveViaGet(payload) {
  const json = JSON.stringify(payload);
  const b64 = utf8ToBase64(json);
  const url = settings.scriptUrl + "?action=save&payload=" + encodeURIComponent(b64);
  if (url.length <= MAX_GET_SAVE_URL) {
    return assertSaveTransportResult(await gasJsonGet(url), "GET save");
  }
  return gasSaveViaChunks(b64);
}

/**
 * Upload transport: text/plain POST → form POST → GET/chunked GET.
 * GET fallback always runs if every POST attempt fails (any reason).
 */
async function gasJsonPost(payload) {
  let postErr = null;
  try {
    return assertSaveTransportResult(await gasPostJson(settings.scriptUrl, payload), "POST");
  } catch (err) {
    postErr = err;
  }
  try {
    return assertSaveTransportResult(await gasPostForm(settings.scriptUrl, payload), "form POST");
  } catch (formErr) {
    if (!postErr) postErr = formErr;
    else {
      formErr.cause = postErr;
      postErr = formErr;
    }
  }
  try {
    return await gasSaveViaGet(payload);
  } catch (getErr) {
    throw await enrichUploadError(postErr, getErr);
  }
}

function recordSyncSuccess(kind) {
  const now = new Date().toISOString();
  settings.lastSyncError = null;
  if (kind === "pull") settings.lastPullOkAt = now;
  settings.lastSyncOkAt = now;
  saveSettings();
  updateSyncDiagnostics();
}

function recordSyncError(err, context) {
  const detail = formatSyncErrorDetail(err);
  const msg = (context ? context + ": " : "") + detail;
  settings.lastSyncError = { at: new Date().toISOString(), message: msg };
  saveSettings();
  updateSyncDiagnostics();
}

function updateSyncDiagnostics() {
  const okEl = document.getElementById("sync-last-ok");
  const errEl = document.getElementById("sync-last-error");
  if (okEl) {
    okEl.textContent = settings.lastSyncOkAt
      ? new Date(settings.lastSyncOkAt).toLocaleString()
      : "—";
  }
  if (errEl) {
    if (settings.lastSyncError && settings.lastSyncError.message) {
      const when = settings.lastSyncError.at
        ? new Date(settings.lastSyncError.at).toLocaleString() + " — "
        : "";
      errEl.textContent = when + settings.lastSyncError.message;
      errEl.classList.add("sync-error-text");
    } else {
      errEl.textContent = "None";
      errEl.classList.remove("sync-error-text");
    }
  }
}

function setSyncIndicator(state, text) {
  const el = document.getElementById("sync-indicator");
  if (el) el.className = "sync-indicator " + state;
  if (text) {
    const t = document.getElementById("sync-status-text");
    if (t) t.textContent = text;
  }
  updateSyncSafetyText(null);
}

/**
 * A device is "fresh" when it has never held real user data: no habits, or
 * only the auto-seeded starter habits with no check-in / count history.
 * Fresh devices must never overwrite populated cloud data.
 */
function isFreshLocal() {
  const habits = data.habits || [];
  const hasHistory =
    Object.keys(data.checks || {}).length > 0 ||
    Object.keys(data.counts || {}).length > 0;
  if (habits.length === 0) return true;
  const onlySeed = habits.every((h) => String(h.id || "").startsWith("h-seed"));
  return onlySeed && !hasHistory;
}

/** New/blank device that should auto-load cloud instead of uploading. */
function needsCloudOnboarding(cloud) {
  if (!cloud || !cloud.hasData) return false;
  // Only auto-restore seed/blank locals — never wipe real offline edits.
  return isFreshLocal();
}

function pollIntervalMs() {
  const n = Number(settings.pollIntervalMs);
  return n > 0 ? n : DEFAULT_POLL_MS;
}

/** Fetch cloud metadata; falls back to ?action=load for legacy backends. */
async function fetchCloudInfo() {
  const out = await gasJsonGet(settings.scriptUrl + "?action=info");
  rememberBackendInfo(out);
  if (out && out.ok && (out.hasData !== undefined || out.revision !== undefined)) {
    saveSettings();
    return {
      hasData: !!out.hasData,
      revision: out.revision != null ? out.revision : null,
      updatedAt: out.updatedAt || null,
      deviceId: out.deviceId || null,
      spreadsheetUrl: out.spreadsheetUrl || null,
      backendVersion: out.backendVersion != null ? out.backendVersion : null,
      supportsGetSave: !!out.supportsGetSave,
      supportsChunkedSave: !!out.supportsChunkedSave,
      supportsFormSave: !!out.supportsFormSave,
      legacy: false,
    };
  }
  // Legacy backend: no metadata in info → probe the actual snapshot.
  const o2 = await gasJsonGet(settings.scriptUrl + "?action=load");
  const hasData = !!(o2 && o2.ok && o2.data && Array.isArray(o2.data.habits) && o2.data.habits.length > 0);
  settings.supportsGetSave = false;
  settings.supportsChunkedSave = false;
  settings.supportsFormSave = false;
  saveSettings();
  return {
    hasData,
    revision: o2 && o2.revision != null ? o2.revision : null,
    updatedAt: (o2 && o2.updatedAt) || null,
    deviceId: (o2 && o2.deviceId) || null,
    spreadsheetUrl: (out && out.spreadsheetUrl) || null,
    backendVersion: null,
    supportsGetSave: false,
    supportsChunkedSave: false,
    supportsFormSave: false,
    legacy: !(o2 && o2.revision !== undefined),
  };
}

/** Whether this device may safely overwrite the given cloud state. */
function cloudSafeToOverwrite(cloud) {
  if (!cloud.hasData) return true;         // empty cloud → first save is fine
  if (isFreshLocal()) return false;        // blank device must never clobber
  if (cloud.legacy) return !!settings.lastSync; // old backend: only if we synced before
  return settings.lastSeenRevision != null &&
         String(settings.lastSeenRevision) === String(cloud.revision);
}

/**
 * Score today's activity in a snapshot. Used to block Upload from a device
 * that is missing today's punches when cloud already has them.
 */
function todayActivityScore(d, day) {
  day = day || todayStr();
  if (!d) return { punches: 0, checks: 0, countSum: 0, byHabit: {}, score: 0 };
  const byHabit = {};
  let punches = 0;
  for (const p of stripSyntheticPunches(d.punches || [])) {
    if (punchDay(p) !== day || !(Number(p.delta) > 0)) continue;
    punches++;
    const id = String(p.habitId || "");
    if (!id) continue;
    byHabit[id] = (byHabit[id] || 0) + 1;
  }
  const checks = ((d.checks && d.checks[day]) || []).length;
  let countSum = 0;
  const row = (d.counts && d.counts[day]) || {};
  for (const id of Object.keys(row)) countSum += Math.max(0, Number(row[id]) || 0);
  return {
    punches,
    checks,
    countSum,
    byHabit,
    score: punches * 100 + checks * 10 + countSum,
  };
}

/** True when cloud has today's check-ins/punches that local is missing. */
function cloudHasRicherToday(localData, cloudData) {
  const local = todayActivityScore(localData);
  const cloud = todayActivityScore(cloudData);
  if (cloud.score <= 0 && cloud.punches <= 0 && cloud.checks <= 0) return false;
  // Local clearly ahead or tied on every habit → safe to upload (don't block master phone).
  if (local.score >= cloud.score && local.punches >= cloud.punches && local.checks >= cloud.checks) {
    let localCoversCloudHabits = true;
    for (const id of Object.keys(cloud.byHabit || {})) {
      if ((local.byHabit[id] || 0) < (cloud.byHabit[id] || 0)) {
        localCoversCloudHabits = false;
        break;
      }
    }
    if (localCoversCloudHabits) return false;
  }
  if (cloud.punches > local.punches) return true;
  if (cloud.checks > local.checks) return true;
  // Any habit where cloud has more real + punches today than local.
  const ids = new Set([
    ...Object.keys(cloud.byHabit || {}),
    ...Object.keys(local.byHabit || {}),
  ]);
  for (const id of ids) {
    if ((cloud.byHabit[id] || 0) > (local.byHabit[id] || 0)) return true;
  }
  // Cloud has punch ids for today that local lacks — only when cloud is ahead overall.
  if (cloud.score > local.score || cloud.punches > local.punches) {
    const day = todayStr();
    const localIds = new Set(
      stripSyntheticPunches((localData && localData.punches) || [])
        .filter(p => punchDay(p) === day)
        .map(p => String(p.id))
    );
    for (const p of stripSyntheticPunches((cloudData && cloudData.punches) || [])) {
      if (punchDay(p) === day && p && p.id && !localIds.has(String(p.id))) return true;
    }
  }
  return cloud.score > local.score;
}

/**
 * Before a blind push: if cloud has today's punches this device is missing,
 * merge instead of overwriting (even when local has partial today activity).
 * Returns true if it handled sync. opts.force skips the guard (master upload).
 */
async function guardUploadAgainstLosingToday(opts) {
  opts = opts || {};
  if (opts.force) return false;
  let loaded;
  try {
    loaded = await fetchCloudSnapshot();
  } catch (_) {
    return false;
  }
  if (!loaded || !loaded.data) return false;
  if (!cloudHasRicherToday(data, loaded.data)) return false;
  updateSyncSafetyText(loaded);
  setSyncIndicator("pending", "Cloud has today's check-ins — merging…");
  if (!opts.silent) {
    toast("Cloud has today's check-ins — merging (not overwriting)");
  }
  await resolveConflictAuto(loaded, { silent: opts.silent, auto: !!opts.auto });
  return true;
}

function rememberRevision(out) {
  if (out && out.revision != null) {
    settings.lastSeenRevision = out.revision;
    settings.lastSeenUpdatedAt = out.updatedAt || new Date().toISOString();
  }
  if (out && out.spreadsheetUrl) settings.spreadsheetUrl = out.spreadsheetUrl;
}

function markUserEdit() {
  lastUserEditAt = Date.now();
}

/** True when a payload has at least one habit. */
function dataHasHabits(d) {
  return !!(d && Array.isArray(d.habits) && d.habits.length > 0);
}

/**
 * Merge local pending edits onto cloud (source of truth base):
 * lists + habits by id (cloud wins on same id), checks union,
 * punches union by id; counts reconciled FROM merged punches only
 * (no Math.max inflation). Legacy map-only habit/days (no punches on
 * either side) prefer cloud count, else local. lastUsedAt is derived
 * from the merged punch stack (so − undos win over a stale later map).
 * Returns null if merge isn't cleanly possible.
 */
function mergeHabitData(localData, cloudData) {
  if (!dataHasHabits(cloudData)) return null;
  if (!dataHasHabits(localData)) return null;
  const loc = migrateData(localData);
  const cld = migrateData(cloudData);
  if (!dataHasHabits(cld)) return null;

  const listsById = new Map();
  for (const l of cld.lists || []) {
    if (l && l.id != null) listsById.set(String(l.id), Object.assign({}, l));
  }
  for (const l of loc.lists || []) {
    if (!l || l.id == null) continue;
    const id = String(l.id);
    if (listsById.has(id)) continue; // same id → keep cloud
    listsById.set(id, Object.assign({}, l));
  }
  // Ensure at least one list.
  if (!listsById.size) {
    const def = makeDefaultList();
    listsById.set(def.id, def);
  }
  const lists = Array.from(listsById.values());
  const listIds = new Set(lists.map(l => String(l.id)));
  const fallbackListId = lists[0].id;

  const byId = new Map();
  // Cloud first (source of truth). Local-only habit ids are added; same-id keeps cloud fields.
  for (const h of cld.habits) {
    if (h && h.id != null) byId.set(String(h.id), Object.assign({}, h));
  }
  for (const h of loc.habits) {
    if (!h || h.id == null) continue;
    const id = String(h.id);
    // Skip seed-only locals that cloud never had (avoid re-seeding cloud).
    if (id.startsWith("h-seed") && !byId.has(id)) continue;
    if (byId.has(id)) continue; // same id → keep cloud
    byId.set(id, Object.assign({}, h));
  }
  const habits = Array.from(byId.values()).map(h => {
    let listId = h.listId != null ? String(h.listId) : fallbackListId;
    if (!listIds.has(listId)) listId = fallbackListId;
    return Object.assign({}, h, { listId });
  });

  const checks = {};
  const checkDates = new Set([
    ...Object.keys(cld.checks || {}),
    ...Object.keys(loc.checks || {}),
  ]);
  for (const day of checkDates) {
    const set = new Set([
      ...((cld.checks && cld.checks[day]) || []),
      ...((loc.checks && loc.checks[day]) || []),
    ].map(String));
    if (set.size) checks[day] = Array.from(set);
  }

  const punchById = new Map();
  // Union only real (user) punches. Synthetic heal punches are dropped and
  // rebuilt deterministically below so two devices never keep divergent random ids.
  for (const p of [
    ...stripSyntheticPunches(cld.punches || []),
    ...stripSyntheticPunches(loc.punches || []),
  ]) {
    if (!p || !p.id) continue;
    const key = String(p.id);
    if (!punchById.has(key)) punchById.set(key, p);
  }
  let punches = Array.from(punchById.values());
  punches.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (punches.length > MAX_PUNCHES) punches = punches.slice(-MAX_PUNCHES);

  // Counts: prefer punch-derived totals only (no Math.max inflation).
  // Legacy habit/days with zero punches on either side: cloud count, else local.
  let counts = reconcileCountsFromPunches({}, punches);
  const countDates = new Set([
    ...Object.keys(cld.counts || {}),
    ...Object.keys(loc.counts || {}),
  ]);
  for (const day of countDates) {
    const a = (cld.counts && cld.counts[day]) || {};
    const b = (loc.counts && loc.counts[day]) || {};
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
      const hadPunch = punches.some(
        p => p && String(p.habitId) === String(id) && punchDay(p) === day
      );
      if (hadPunch) continue; // already set from punch reconcile
      const cloudN = Math.max(0, Number(a[id]) || 0);
      const localN = Math.max(0, Number(b[id]) || 0);
      const keep = cloudN > 0 ? cloudN : localN; // cloud-first, never Math.max
      if (keep <= 0) continue;
      if (!counts[day]) counts[day] = {};
      counts[day][id] = keep;
    }
  }

  const lastUsedAt = {};
  const usedIds = new Set([
    ...Object.keys(cld.lastUsedAt || {}),
    ...Object.keys(loc.lastUsedAt || {}),
    ...punches.map(p => String(p.habitId)),
    ...Object.keys(counts).reduce((acc, day) => {
      const row = counts[day] || {};
      return acc.concat(Object.keys(row));
    }, []),
  ]);
  for (const id of usedIds) {
    const fromStack = lastUsedAtFromPunchesList(punches, id);
    const fromMaps = laterIso(
      (cld.lastUsedAt && cld.lastUsedAt[id]) || null,
      (loc.lastUsedAt && loc.lastUsedAt[id]) || null
    );
    if (fromStack) {
      // Keep a newer map clock (orphan lastUsedAt) so heal can promote it.
      lastUsedAt[id] = laterIso(fromStack, fromMaps) || fromStack;
      continue;
    }
    // Real punches existed but undos canceled all + → clear (do not resurrect map).
    const hadPunches = punches.some(p => p && String(p.habitId) === id);
    if (hadPunches) continue;
    // No real punches: map clocks often came from stripped random synthetics.
    // Keep the map only so backfill can use it as the newest slot; promote
    // + backfill will invent the same deterministic rows on every device.
    if (fromMaps) lastUsedAt[id] = fromMaps;
  }

  // Rebuild synthetic gap/orphan punches once, identically on every device.
  backfillCountGapsIntoPunches(punches, counts, lastUsedAt);
  promoteOrphanLastUsedIntoPunches(punches, lastUsedAt);
  const countsFinal = reconcileCountsFromPunches(counts, punches);
  reconcileLastUsedAtFromPunches(lastUsedAt, punches);
  punches.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (punches.length > MAX_PUNCHES) punches = punches.slice(-MAX_PUNCHES);

  let activeListId = loc.activeListId || cld.activeListId || fallbackListId;
  if (!listIds.has(String(activeListId))) activeListId = fallbackListId;

  const deduped = dedupeHabitsByName({
    habits, checks, counts: countsFinal, lastUsedAt, punches, lists, activeListId,
  });
  return migrateData(deduped);
}

/** Completeness score for choosing which duplicate habit to keep. */
function habitCompletenessScore(h, checks, counts, lastUsedAt, punches) {
  const id = String(h.id);
  let score = 0;
  if (!h.archived) score += 10;
  for (const day of Object.keys(checks || {})) {
    if ((checks[day] || []).map(String).includes(id)) score += 2;
  }
  for (const day of Object.keys(counts || {})) {
    const row = counts[day];
    if (row && Object.prototype.hasOwnProperty.call(row, id)) {
      score += 1 + (Number(row[id]) || 0);
    }
  }
  if (lastUsedAt && lastUsedAt[id]) score += 2;
  if (Array.isArray(punches)) {
    score += punches.filter(p => p && String(p.habitId) === id).length;
  }
  if (h.dailyLimit != null) score += 1;
  if (h.emoji) score += 0.1;
  if (h.schedule && h.schedule.kind) score += 0.1;
  return score;
}

/** Remap all history keys from fromId onto toId, then drop fromId. */
function remapHabitIdRefs(fromId, toId, checks, counts, lastUsedAt, punches) {
  const from = String(fromId);
  const to = String(toId);
  if (from === to) return;
  for (const day of Object.keys(checks || {})) {
    const list = checks[day] || [];
    let changed = false;
    const next = [];
    const seen = new Set();
    for (const x of list) {
      const id = String(x) === from ? to : String(x);
      if (seen.has(id)) { changed = true; continue; }
      seen.add(id);
      if (String(x) === from) changed = true;
      next.push(id);
    }
    if (changed) checks[day] = next;
  }
  for (const day of Object.keys(counts || {})) {
    const row = counts[day];
    if (!row || !Object.prototype.hasOwnProperty.call(row, from)) continue;
    const merged = Math.max(Number(row[to]) || 0, Number(row[from]) || 0);
    row[to] = merged;
    delete row[from];
  }
  if (lastUsedAt && Object.prototype.hasOwnProperty.call(lastUsedAt, from)) {
    lastUsedAt[to] = laterIso(lastUsedAt[to] || null, lastUsedAt[from] || null) || lastUsedAt[from];
    delete lastUsedAt[from];
  }
  if (Array.isArray(punches)) {
    for (const p of punches) {
      if (p && String(p.habitId) === from) p.habitId = to;
    }
  }
}

/**
 * After sync merge: collapse non-archived habits that share a name
 * (trimmed, case-insensitive). Prefer more complete / lower sortIndex /
 * earlier id; remap checks/counts/punches/lastUsedAt onto the kept id.
 */
function dedupeHabitsByName(payload) {
  const habits = (payload.habits || []).slice();
  const checks = payload.checks || {};
  const counts = payload.counts || {};
  const lastUsedAt = payload.lastUsedAt || {};
  const punches = Array.isArray(payload.punches) ? payload.punches.slice() : [];

  const groups = new Map();
  for (const h of habits) {
    if (!h || h.archived) continue;
    const key = normalizeNameKey(h.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }

  const drop = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const sa = habitCompletenessScore(a, checks, counts, lastUsedAt, punches);
      const sb = habitCompletenessScore(b, checks, counts, lastUsedAt, punches);
      if (sb !== sa) return sb - sa;
      const ia = Number(a.sortIndex);
      const ib = Number(b.sortIndex);
      const na = Number.isFinite(ia) ? ia : 1e9;
      const nb = Number.isFinite(ib) ? ib : 1e9;
      if (na !== nb) return na - nb;
      return String(a.id).localeCompare(String(b.id));
    });
    const keep = group[0];
    for (let i = 1; i < group.length; i++) {
      const dup = group[i];
      // Prefer keep's listId; if keep lacks a valid list and dup has one, adopt it.
      if (dup.listId != null && (keep.listId == null || keep.listId === "")) {
        keep.listId = dup.listId;
      }
      remapHabitIdRefs(dup.id, keep.id, checks, counts, lastUsedAt, punches);
      drop.add(String(dup.id));
    }
  }

  return Object.assign({}, payload, {
    habits: habits.filter(h => !drop.has(String(h.id))),
    checks,
    counts,
    lastUsedAt,
    punches,
  });
}

/** Load full cloud snapshot (for merge / conflict resolve). */
async function fetchCloudSnapshot() {
  const out = await gasJsonGet(settings.scriptUrl + "?action=load");
  if (!out || !out.ok || !out.data) return null;
  return out;
}

/**
 * Auto-resolve a stale/conflict revision: merge when safe, else pull cloud.
 * Never blank-overwrites the Sheet. No force path.
 */
async function resolveConflictAuto(cloudOrOut, opts) {
  opts = opts || {};
  setSyncIndicator("pending", "Syncing…");

  // Prefer embedded snapshot from conflict response; otherwise load.
  let cloudData = cloudOrOut && cloudOrOut.data ? cloudOrOut.data : null;
  let cloudRev = cloudOrOut && cloudOrOut.revision != null ? cloudOrOut.revision : null;
  let cloudMeta = cloudOrOut;
  if (!cloudData) {
    try {
      const loaded = await fetchCloudSnapshot();
      if (!loaded) {
        setSyncIndicator("error", "Can't load cloud to resolve");
        toast("Can't reach cloud — data is safe locally");
        return false;
      }
      cloudData = loaded.data;
      cloudRev = loaded.revision;
      cloudMeta = loaded;
    } catch (err) {
      setSyncIndicator("error", "Can't load cloud to resolve");
      toast("Can't reach cloud — data is safe locally");
      return false;
    }
  }

  updateSyncSafetyText(cloudMeta);

  // Blank/fresh local or blank-push conflict → prefer cloud, never overwrite.
  if (isFreshLocal() || (cloudOrOut && cloudOrOut.reason === "blank") || !dataHasHabits(data)) {
    rememberRevision(cloudMeta);
    saveSettings();
    const ok = await restoreFromSheet({
      skipConfirm: true,
      auto: !!opts.auto,
      fromPoll: !!opts.fromPoll,
      toastMsg: "Loaded cloud version",
    });
    return ok;
  }

  const pendingLocal = migrateData(JSON.parse(JSON.stringify(data)));
  const merged = mergeHabitData(pendingLocal, cloudData);

  if (!merged) {
    rememberRevision(cloudMeta);
    saveSettings();
    const ok = await restoreFromSheet({
      skipConfirm: true,
      auto: false,
      fromPoll: !!opts.fromPoll,
      toastMsg: "Loaded cloud version",
    });
    return ok;
  }

  // Apply merge locally, adopt cloud revision as base, then push.
  makeLocalBackup();
  data = merged;
  saveData();
  if (cloudRev != null) {
    settings.lastSeenRevision = cloudRev;
    settings.lastSeenUpdatedAt = (cloudMeta && cloudMeta.updatedAt) || new Date().toISOString();
  }
  saveSettings();
  render();

  let pushed = false;
  try {
    pushed = await pushSnapshot({ silent: true, afterMerge: true });
  } catch (err) {
    // Keep merged local data — never wipe the correct phone after a transport failure.
    localDirty = true;
    autoSyncArmed = true;
    recordSyncError(err, "Merge upload");
    const msg = humanizeUploadError(err);
    setSyncIndicator("error", "Merged locally — upload failed: " + msg);
    if (!opts.silent) toast("Merged on this phone — upload retry needed (see Last error)");
    return false;
  }
  if (pushed) {
    setSyncIndicator("ok", "Merged with cloud · rev " + (settings.lastSeenRevision != null ? settings.lastSeenRevision : "?"));
    if (!opts.silent) toast("Synced — merged with cloud");
    return true;
  }

  // Concurrent edit during merge push → keep merge locally and ask for retry (don't clobber).
  localDirty = true;
  autoSyncArmed = true;
  const conflictMsg = "Cloud changed during merge — tap Upload again (data kept on this phone)";
  recordSyncError(new Error(conflictMsg), "Merge conflict");
  setSyncIndicator("error", conflictMsg);
  if (!opts.silent) toast(conflictMsg);
  return false;
}

/**
 * Runs once at startup (and when the script URL changes): establishes cloud
 * state before auto-sync may fire. New/blank devices auto-restore from cloud.
 */
async function initSync() {
  stopPolling();
  if (!settings.scriptUrl) { autoSyncArmed = true; cloudChecked = true; return; }
  setSyncIndicator("pending", "Checking cloud…");
  let cloud;
  try {
    cloud = await fetchCloudInfo();
  } catch (err) {
    // Can't confirm cloud state → stay disarmed so we never overwrite blindly.
    autoSyncArmed = false;
    cloudChecked = true;
    recordSyncError(err, "Startup");
    setSyncIndicator("error", "Cloud check failed — " + err.message);
    updateSyncSafetyText(null);
    return;
  }
  cloudChecked = true;
  updateSyncSafetyText(cloud);

  // New / blank device with populated cloud → auto-restore (no reject modal).
  if (needsCloudOnboarding(cloud)) {
    autoSyncArmed = false;
    setSyncIndicator("pending", "Syncing…");
    toast("Syncing…");
    await restoreFromSheet({ skipConfirm: true, auto: true });
    startPolling();
    return;
  }

  if (cloudSafeToOverwrite(cloud)) {
    autoSyncArmed = true;
    if (cloud.hasData && cloud.revision != null &&
        String(settings.lastSeenRevision) === String(cloud.revision)) {
      setSyncIndicator("ok", "Up to date · rev " + cloud.revision);
    } else if (settings.lastSync) {
      setSyncIndicator("ok", "Last synced: " + new Date(settings.lastSync).toLocaleString());
    } else {
      setSyncIndicator("ok", cloud.hasData ? "Ready" : "Cloud empty — this device will seed it");
    }
    // Same revision can still diverge if this phone is missing today's cloud punches
    // (heal / partial local). Pull those in before any heal upload.
    if (cloud.hasData) {
      try {
        const loaded = await fetchCloudSnapshot();
        if (loaded && loaded.data && cloudHasRicherToday(data, loaded.data)) {
          setSyncIndicator("pending", "Cloud has today's check-ins — merging…");
          await resolveConflictAuto(loaded, { auto: true, silent: true });
          startPolling();
          return;
        }
      } catch (_) { /* ignore; fall through */ }
    }
    // Startup/heal may have invented deterministic punches — push so peers converge.
    if (localDirty || healPendingUpload) queueHealUpload();
    startPolling();
    return;
  }

  // Cloud moved ahead while this device has real data → merge or pull (no force UI).
  autoSyncArmed = false;
  setSyncIndicator("pending", "Cloud changed — syncing…");
  await resolveConflictAuto(cloud, { auto: true, silent: true });
  startPolling();
}

function queueSync() {
  markUserEdit();
  localDirty = true;
  if (!settings.scriptUrl || !settings.autoSync) return;
  if (!autoSyncArmed) return; // never auto-push before cloud state is known
  setSyncIndicator("pending");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, 2500);
}

/**
 * POST current `data` with baseRevision. Returns true on success.
 * On conflict, optionally auto-resolves (merge/pull) unless opts.skipResolve.
 * opts.force → master overwrite (backend force + adopt revision).
 */
async function pushSnapshot(opts) {
  opts = opts || {};
  if (opts.force) {
    try {
      const info = await fetchCloudInfo();
      if (info && info.revision != null) {
        settings.lastSeenRevision = info.revision;
        settings.lastSeenUpdatedAt = info.updatedAt || new Date().toISOString();
        saveSettings();
      }
    } catch (_) { /* proceed with last known base */ }
  }
  const out = await gasJsonPost({
    action: "save",
    data,
    baseRevision: settings.lastSeenRevision,
    deviceId: settings.deviceId,
    force: !!opts.force,
  });
  if (out && out.conflict) {
    updateSyncSafetyText(out);
    if (opts.force) {
      // Backend should accept force; if an old backend ignored it, retry with matching base.
      if (out.revision != null) {
        settings.lastSeenRevision = out.revision;
        settings.lastSeenUpdatedAt = out.updatedAt || new Date().toISOString();
        saveSettings();
        const out2 = await gasJsonPost({
          action: "save",
          data,
          baseRevision: settings.lastSeenRevision,
          deviceId: settings.deviceId,
          force: true,
        });
        if (out2 && out2.ok) {
          settings.lastSync = new Date().toISOString();
          rememberRevision(out2);
          saveSettings();
          autoSyncArmed = true;
          localDirty = false;
          recordSyncSuccess("push");
          updateSyncSafetyText(out2);
          return true;
        }
        if (out2 && out2.conflict) {
          throw new Error("Cloud has newer data — tap Replace with cloud on the other phone, or retry master upload");
        }
        throw new Error((out2 && out2.error) || "Master upload failed");
      }
      throw new Error("Master upload failed — cloud conflict with no revision");
    }
    if (opts.skipResolve || opts.afterMerge) return false;
    await resolveConflictAuto(out, { silent: opts.silent });
    return autoSyncArmed && !localDirty;
  }
  if (!out || !out.ok) throw new Error((out && out.error) || "Unknown error");
  settings.lastSync = new Date().toISOString();
  rememberRevision(out);
  saveSettings();
  autoSyncArmed = true;
  localDirty = false;
  recordSyncSuccess("push");
  updateSyncSafetyText(out);
  return true;
}

/**
 * Upload this device's data to the cloud (optimistic concurrency).
 * On stale revision: auto-merge pending local edits onto cloud, or pull cloud.
 * opts.silent → quieter status (used by poll when pushing pending edits).
 * opts.force → master overwrite (skips today-guard; adopts cloud rev as base).
 */
async function syncNow(opts) {
  opts = opts || {};
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return; }

  // New/blank device with cloud data → restore first instead of uploading seeds.
  if (!opts.force && isFreshLocal()) {
    let cloud;
    try {
      cloud = await fetchCloudInfo();
    } catch (err) {
      setSyncIndicator("error", "Can't reach cloud — not overwriting");
      toast("Can't reach cloud — data is safe locally");
      return;
    }
    updateSyncSafetyText(cloud);
    if (cloud.hasData && !cloudSafeToOverwrite(cloud)) {
      setSyncIndicator("pending", "Syncing…");
      toast("Syncing…");
      await restoreFromSheet({ skipConfirm: true, auto: true });
      return;
    }
    autoSyncArmed = true;
  } else if (!opts.force && !autoSyncArmed) {
    let cloud;
    try {
      cloud = await fetchCloudInfo();
    } catch (err) {
      setSyncIndicator("error", "Can't reach cloud — not overwriting");
      toast("Can't reach cloud — data is safe locally");
      return;
    }
    updateSyncSafetyText(cloud);
    if (!cloudSafeToOverwrite(cloud)) {
      await resolveConflictAuto(cloud, { silent: opts.silent });
      return;
    }
    autoSyncArmed = true;
  }

  // Device missing today's punches must not clobber cloud that has them.
  if (!opts.force) {
    try {
      if (await guardUploadAgainstLosingToday(opts)) return;
    } catch (err) {
      setSyncIndicator("error", "Upload blocked: " + humanizeUploadError(err));
      if (!opts.silent) toast("Upload blocked — see Settings → Last error");
      recordSyncError(err, "Upload guard");
      return;
    }
  }

  setSyncIndicator("pending", opts.force ? "Uploading as master…" : (opts.silent ? "Syncing…" : "Uploading…"));
  try {
    const ok = await pushSnapshot({ silent: opts.silent, force: !!opts.force });
    if (!ok) {
      // Conflict / merge path — not a generic transport failure.
      if (settings.lastSyncError && settings.lastSyncError.message) {
        const raw = settings.lastSyncError.message
          .replace(/^Upload:\s*/i, "")
          .replace(/^Merge upload:\s*/i, "")
          .replace(/^Merge conflict:\s*/i, "");
        setSyncIndicator("error", raw);
        if (!opts.silent && /conflict|Cloud changed|Replace with cloud|tap Upload again/i.test(raw)) {
          toast(raw.length > 90 ? "Cloud conflict — tap Upload again (see Last error)" : raw);
        }
        return;
      }
      const msg = opts.force
        ? "Master upload did not finish — try again"
        : "Cloud has newer data — tap Upload again to merge (data kept on this phone)";
      recordSyncError(new Error(msg), "Upload conflict");
      setSyncIndicator("error", msg);
      if (!opts.silent) toast(msg);
      return;
    }
    const rev = settings.lastSeenRevision != null ? " · rev " + settings.lastSeenRevision : "";
    setSyncIndicator("ok", "Uploaded: " + new Date(settings.lastSync).toLocaleString() + rev);
    if (!opts.silent) toast(settings.lastSeenRevision != null ? "Uploaded to cloud ✓" : "Synced ✓ (legacy backend)");
  } catch (err) {
    recordSyncError(err, "Upload");
    const nice = humanizeUploadError(err);
    setSyncIndicator("error", "Upload failed: " + nice);
    if (!opts.silent) toast("Upload failed — see Settings → Last error");
  }
}

/** Explicit master upload — replaces cloud with this phone after confirm. */
async function syncNowAsMaster() {
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return; }
  if (!confirm("Use this phone as master?\n\nThis replaces CLOUD data with THIS phone's copy. Only do this on the phone that has the correct entries (including today).")) {
    return;
  }
  await syncNow({ force: true });
}

/** Save a timestamped local snapshot before restore overwrites local data. */
function makeLocalBackup() {
  try {
    if (isFreshLocal()) return false; // nothing worth backing up
    const key = "ah.backup." + Date.now();
    localStorage.setItem(key, JSON.stringify(data));
    const keys = Object.keys(localStorage)
      .filter((k) => k.startsWith("ah.backup."))
      .sort();
    while (keys.length > 5) localStorage.removeItem(keys.shift());
    return true;
  } catch (e) {
    return false;
  }
}

async function restoreFromSheet(opts) {
  opts = opts || {};
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return false; }
  if (!opts.skipConfirm && !confirm("Replace this phone with cloud data?\n\nA local backup will be saved first, then this phone’s habits and today’s check-ins are replaced with the Google Sheet copy. Use this on the phone that is missing today’s entries.")) return false;
  setSyncIndicator("pending", opts.auto ? "Syncing…" : (opts.fromPoll ? "Refreshing…" : "Restoring…"));
  try {
    const out = await gasJsonGet(settings.scriptUrl + "?action=load");
    if (!out.ok) throw new Error(out.error || "Unknown error");
    if (out.data && Array.isArray(out.data.habits)) {
      const backedUp = makeLocalBackup();
      const rawPunchSig = JSON.stringify((out.data && out.data.punches) || []);
      data = migrateData(out.data);
      saveData();
      rememberRevision(out);
      settings.lastSync = new Date().toISOString();
      saveSettings();
      autoSyncArmed = true;
      // If restore migrated random synthetics → deterministic, push so peers match.
      const healed = JSON.stringify(data.punches || []) !== rawPunchSig;
      localDirty = healed;
      healPendingUpload = healed;
      lastPullAt = Date.now();
      recordSyncSuccess("pull");
      render();
      updateSyncSafetyText(out);
      if (healed) queueHealUpload();
      const rev = out.revision != null ? " · rev " + out.revision : "";
      setSyncIndicator("ok", (opts.auto ? "Loaded from Google Sheet" : "Restored from cloud") + rev);
      if (opts.toastMsg) toast(opts.toastMsg);
      else if (opts.auto) toast("Loaded from Google Sheet");
      else if (opts.fromPoll) toast("Updated from cloud");
      else toast(backedUp ? "Restored ✓ (local backup saved)" : "Restored from cloud ✓");
      return true;
    }
    throw new Error("Sheet has no saved data yet");
  } catch (err) {
    recordSyncError(err, opts.fromPoll ? "Poll pull" : "Restore");
    setSyncIndicator("error", "Restore failed: " + err.message);
    if (!opts.fromPoll) toast("Restore failed: " + err.message);
    return false;
  }
}

/* ---------------- periodic cloud refresh ---------------- */
function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  nextPollAt = null;
  updateSyncSafetyText(null);
}

function startPolling() {
  stopPolling();
  if (!settings.scriptUrl || settings.autoRefresh === false) return;
  scheduleNextPoll(pollIntervalMs());
}

function scheduleNextPoll(ms) {
  clearTimeout(pollTimer);
  const delay = Math.max(1000, ms || pollIntervalMs());
  nextPollAt = Date.now() + delay;
  pollTimer = setTimeout(() => { pollCloud(); }, delay);
  updateSyncSafetyText(null);
}

async function pollCloud(opts) {
  opts = opts || {};
  pollTimer = null;
  if (!settings.scriptUrl || settings.autoRefresh === false) return;
  if (typeof document !== "undefined" && document.hidden) {
    // Resume when the tab becomes visible again.
    return;
  }
  // Don't yank UI mid-edit (forced polls from tests/debug skip this).
  if (!opts.force) {
    const sinceEdit = Date.now() - lastUserEditAt;
    if (lastUserEditAt && sinceEdit < POLL_EDIT_DEBOUNCE_MS) {
      scheduleNextPoll(POLL_EDIT_DEBOUNCE_MS - sinceEdit + 200);
      return;
    }
  }
  if (!autoSyncArmed && settings.lastSeenRevision == null) {
    scheduleNextPoll();
    return;
  }

  let cloud;
  try {
    cloud = await fetchCloudInfo();
  } catch (err) {
    recordSyncError(err, "Poll");
    setSyncIndicator("error", "Cloud unreachable — " + err.message);
    scheduleNextPoll();
    return;
  }
  updateSyncSafetyText(cloud);

  const cloudRev = cloud.revision;
  const seen = settings.lastSeenRevision;
  const cloudAhead =
    cloud.hasData &&
    cloudRev != null &&
    (seen == null || String(cloudRev) !== String(seen));

  // Always consider a full snapshot when cloud moved OR local is dirty —
  // a dirty lagging phone must merge-in today's cloud punches, not blind-upload.
  if (cloudAhead || localDirty || syncTimer) {
    let loaded = null;
    try {
      loaded = await fetchCloudSnapshot();
    } catch (_) {
      loaded = null;
    }
    if (loaded && loaded.data && cloudHasRicherToday(data, loaded.data)) {
      setSyncIndicator("pending", "Cloud has today's check-ins — merging…");
      await resolveConflictAuto(loaded, { silent: true, auto: true, fromPoll: true });
    } else if (cloudAhead) {
      if (localDirty || syncTimer) {
        await syncNow({ silent: true });
      } else if (autoSyncArmed || seen != null) {
        await restoreFromSheet({ skipConfirm: true, fromPoll: true });
      }
    } else if (localDirty || syncTimer) {
      await syncNow({ silent: true });
    }
  }

  scheduleNextPoll();
}

function onVisibilityForPoll() {
  if (typeof document === "undefined") return;
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
    nextPollAt = null;
    updateSyncSafetyText(null);
  } else if (settings.scriptUrl && settings.autoRefresh !== false && cloudChecked) {
    // Immediate cheap check on resume, then resume interval.
    pollCloud();
  }
}

/* ---------------- sync modals + status ---------------- */
function formatAgo(ts) {
  if (!ts) return "—";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  return new Date(ts).toLocaleTimeString();
}

function formatNextRefresh() {
  if (settings.autoRefresh === false) return "off";
  if (typeof document !== "undefined" && document.hidden) return "paused (tab hidden)";
  if (!nextPollAt) return "—";
  const sec = Math.max(0, Math.round((nextPollAt - Date.now()) / 1000));
  if (sec <= 0) return "soon";
  if (sec < 60) return sec + "s";
  return Math.ceil(sec / 60) + "m";
}

function updateSyncSafetyText(cloud) {
  const el = document.getElementById("sync-safety-text");
  const revEl = document.getElementById("sync-rev-value");
  const syncEl = document.getElementById("sync-last-sync");
  const cloudRevEl = document.getElementById("sync-cloud-rev-value");
  if (revEl) {
    revEl.textContent = settings.lastSeenRevision != null
      ? String(settings.lastSeenRevision)
      : "—";
  }
  if (syncEl) {
    syncEl.textContent = settings.lastSync
      ? new Date(settings.lastSync).toLocaleString()
      : "Never synced";
  }
  if (cloudRevEl) {
    if (cloud && cloud.revision != null) cloudRevEl.textContent = String(cloud.revision);
    else if (settings.lastSeenRevision != null) cloudRevEl.textContent = String(settings.lastSeenRevision);
    else cloudRevEl.textContent = "—";
  }
  updateSyncDiagnostics();
  if (!el) return;
  const registered = !!settings.deviceId;
  const pullBit = lastPullAt
    ? formatAgo(lastPullAt)
    : (settings.lastSync ? formatAgo(new Date(settings.lastSync).getTime()) : "never");
  const parts = [
    registered ? "Device registered" : "Device —",
    "last pull " + pullBit,
    "next refresh in " + formatNextRefresh(),
  ];
  if (settings.lastSeenRevision != null) parts.push("rev " + settings.lastSeenRevision);
  if (cloud) {
    if (cloud.legacy) parts.push("legacy backend");
    else if (cloud.hasData || cloud.revision != null) parts.push("cloud rev " + (cloud.revision != null ? cloud.revision : "?"));
    else parts.push("cloud empty");
    if (cloud.backendVersion != null) parts.push("backend v" + cloud.backendVersion);
  } else if (settings.backendVersion != null) {
    parts.push("backend v" + settings.backendVersion);
  }
  el.textContent = parts.join(" · ");
}

function openSyncModal(cfg) {
  const modal = document.getElementById("sync-modal");
  if (!modal) return;
  document.getElementById("sync-modal-title").textContent = cfg.title || "Sync";
  document.getElementById("sync-modal-body").innerHTML = cfg.body || "";
  const actions = document.getElementById("sync-modal-actions");
  actions.innerHTML = "";
  (cfg.buttons || []).forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "btn " + (b.cls || "btn-ghost");
    btn.textContent = b.label;
    btn.addEventListener("click", b.onClick);
    actions.appendChild(btn);
  });
  modal.classList.remove("hidden");
}
function closeSyncModal() {
  const modal = document.getElementById("sync-modal");
  if (modal) modal.classList.add("hidden");
}

/* ---------------- backup / import ---------------- */
function exportJson() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "habits-backup-" + todayStr() + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.habits)) throw new Error("bad format");
      data = migrateData({
        habits: parsed.habits,
        checks: parsed.checks || {},
        counts: parsed.counts || {},
        lists: parsed.lists,
        activeListId: parsed.activeListId,
      });
      saveData();
      render();
      toast("Imported ✓");
      queueSync();
    } catch {
      toast("Invalid backup file");
    }
  };
  reader.readAsText(file);
}

/* ---------------- misc ui ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function switchView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  document.querySelectorAll(".nav-btn[data-view]").forEach(b =>
    b.classList.toggle("active", b.dataset.view === name));
  const tabsWrap = document.getElementById("list-tabs-wrap");
  if (tabsWrap) tabsWrap.classList.toggle("hidden", name === "settings");
  updateFabVisibility();
  if (name === "settings") renderSettingsLists();
}

/* ---------------- wire up ---------------- */
document.querySelectorAll(".nav-btn[data-view]").forEach(b =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

document.getElementById("btn-save-habit").addEventListener("click", saveHabit);
document.getElementById("btn-delete-habit").addEventListener("click", deleteHabit);
document.getElementById("habit-name").addEventListener("input", clearHabitNameError);
document.getElementById("habit-modal").addEventListener("click", e => {
  if (e.target.id === "habit-modal") closeHabitModal();
});
document.getElementById("habit-name").addEventListener("keydown", e => {
  if (e.key === "Enter") saveHabit();
});

document.querySelectorAll("[data-type-opt]").forEach(btn => {
  btn.addEventListener("click", () => {
    modalType = btn.dataset.typeOpt;
    syncModalSections();
  });
});
document.querySelectorAll("[data-schedule-opt]").forEach(btn => {
  btn.addEventListener("click", () => {
    modalScheduleKind = btn.dataset.scheduleOpt;
    syncModalSections();
  });
});
document.getElementById("habit-once-date").addEventListener("change", e => {
  modalOnceDate = e.target.value || todayStr();
});
document.getElementById("habit-daily-limit").addEventListener("input", e => {
  modalDailyLimit = e.target.value;
});

const urlInput = document.getElementById("script-url");
const autoSyncInput = document.getElementById("auto-sync");
const autoRefreshInput = document.getElementById("auto-refresh");
const pollIntervalInput = document.getElementById("poll-interval");
urlInput.value = settings.scriptUrl;
autoSyncInput.checked = settings.autoSync;
if (autoRefreshInput) autoRefreshInput.checked = settings.autoRefresh !== false;
if (pollIntervalInput) {
  const ms = pollIntervalMs();
  pollIntervalInput.value = String([15000, 45000, 60000].includes(ms) ? ms : DEFAULT_POLL_MS);
}
urlInput.addEventListener("change", async () => {
  settings.scriptUrl = urlInput.value.trim();
  saveSettings();
  autoSyncArmed = false;
  cloudChecked = false;
  await initSync();
});
autoSyncInput.addEventListener("change", () => { settings.autoSync = autoSyncInput.checked; saveSettings(); });
if (autoRefreshInput) {
  autoRefreshInput.addEventListener("change", () => {
    settings.autoRefresh = autoRefreshInput.checked;
    saveSettings();
    if (settings.autoRefresh) startPolling();
    else stopPolling();
  });
}
if (pollIntervalInput) {
  pollIntervalInput.addEventListener("change", () => {
    settings.pollIntervalMs = Number(pollIntervalInput.value) || DEFAULT_POLL_MS;
    saveSettings();
    if (settings.autoRefresh !== false) startPolling();
  });
}

document.getElementById("btn-sync-now").addEventListener("click", () => syncNow());
document.getElementById("btn-restore").addEventListener("click", () => restoreFromSheet());
const btnMaster = document.getElementById("btn-sync-master");
if (btnMaster) btnMaster.addEventListener("click", () => syncNowAsMaster());
const syncModal = document.getElementById("sync-modal");
if (syncModal) syncModal.addEventListener("click", (e) => { if (e.target.id === "sync-modal") closeSyncModal(); });
document.getElementById("btn-export").addEventListener("click", exportJson);
document.getElementById("btn-import").addEventListener("click", () => document.getElementById("import-file").click());
document.getElementById("import-file").addEventListener("change", e => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Delete ALL local habits and history? (The Google Sheet is not touched.)")) {
    data = migrateData({ habits: [], checks: {}, counts: {}, lists: [] });
    saveData();
    // Blank local state must not auto-overwrite the cloud afterwards.
    autoSyncArmed = false;
    localDirty = false;
    settings.lastSeenRevision = null;
    settings.lastSeenUpdatedAt = null;
    saveSettings();
    render();
    setSyncIndicator("warn", "Local data cleared — cloud untouched. Restoring…");
    // Treat like a new device: pull cloud automatically when URL is set.
    if (settings.scriptUrl) initSync();
    else setSyncIndicator("warn", "Local data cleared — cloud untouched. Restore to re-sync.");
  }
});

updateSyncSafetyText(null);
if (settings.lastSync) {
  setSyncIndicator("ok", "Last synced: " + new Date(settings.lastSync).toLocaleString());
}

// Keep the "next refresh in …" countdown reasonably fresh.
setInterval(() => {
  if (settings.autoRefresh !== false && nextPollAt) updateSyncSafetyText(null);
}, 5000);

document.addEventListener("visibilitychange", onVisibilityForPoll);

// First launch → seed daily good habits; otherwise persist any migration upgrades
if (!localStorage.getItem(LS_DATA)) {
  // Seed createdAt a month back so the current week is never empty for new users
  const seedCreated = addDays(todayStr(), -30);
  const defaultList = makeDefaultList(seedCreated);
  data.lists = [defaultList];
  data.activeListId = defaultList.id;
  data.habits = [
    { id: "h-seed1", name: "Brush teeth", emoji: "🦷", color: COLORS[0], createdAt: seedCreated, archived: false, listId: defaultList.id, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 0 },
    { id: "h-seed2", name: "Drink water", emoji: "💧", color: COLORS[6], createdAt: seedCreated, archived: false, listId: defaultList.id, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 1 },
    { id: "h-seed3", name: "Read 10 minutes", emoji: "📖", color: COLORS[2], createdAt: seedCreated, archived: false, listId: defaultList.id, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 2 },
  ];
  data.checks = {};
  data.counts = {};
}
saveData();

document.getElementById("btn-week-prev").addEventListener("click", () => shiftWeek(-1));
document.getElementById("btn-week-next").addEventListener("click", () => shiftWeek(1));
document.getElementById("btn-pick-date").addEventListener("click", () => {
  const picker = document.getElementById("date-picker");
  picker.value = selectedDate;
  if (typeof picker.showPicker === "function") {
    try { picker.showPicker(); } catch { picker.click(); }
  } else {
    picker.click();
  }
});
document.getElementById("date-picker").addEventListener("change", e => {
  if (e.target.value) pickDate(e.target.value);
});

/* ---------------- list menu ---------------- */
function closeListMenu() {
  const backdrop = document.getElementById("list-menu-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
  const btn = document.getElementById("btn-list-menu");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function openListMenu() {
  const backdrop = document.getElementById("list-menu-backdrop");
  const menu = document.getElementById("list-menu");
  const btn = document.getElementById("btn-list-menu");
  if (!backdrop || !menu || !btn) return;
  const rect = btn.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - 160, rect.bottom + 6) + "px";
  menu.style.right = Math.max(8, window.innerWidth - rect.right) + "px";
  menu.style.left = "auto";
  backdrop.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
}
const listMenuBtn = document.getElementById("btn-list-menu");
if (listMenuBtn) {
  listMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const backdrop = document.getElementById("list-menu-backdrop");
    if (backdrop && !backdrop.classList.contains("hidden")) closeListMenu();
    else openListMenu();
  });
}
const listMenuBackdrop = document.getElementById("list-menu-backdrop");
if (listMenuBackdrop) {
  listMenuBackdrop.addEventListener("click", (e) => {
    if (e.target.id === "list-menu-backdrop") closeListMenu();
  });
}
document.querySelectorAll("[data-list-action]").forEach(btn => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.listAction;
    closeListMenu();
    if (action === "rename") promptRenameList(getActiveListId());
    else if (action === "create") promptCreateList();
    else if (action === "delete") deleteList(getActiveListId());
  });
});
const btnNewListSettings = document.getElementById("btn-new-list-settings");
if (btnNewListSettings) btnNewListSettings.addEventListener("click", promptCreateList);
const btnTabNewList = document.getElementById("btn-tab-new-list");
if (btnTabNewList) btnTabNewList.addEventListener("click", promptCreateList);
const habitListSelect = document.getElementById("habit-list-select");
if (habitListSelect) {
  habitListSelect.addEventListener("change", (e) => {
    modalListId = e.target.value || getActiveListId();
  });
}
const btnSortHint = document.getElementById("btn-sort-hint");
if (btnSortHint) {
  btnSortHint.addEventListener("click", () => toast("My order — drag habits to rearrange"));
}
render();

// Establish cloud state before auto-sync may fire (fail-safe for new devices).
initSync();

// Test hooks (sync-tests.js / manual debug). Harmless in production.
try {
  window.__ahSync = {
    pollCloud: (opts) => pollCloud(opts),
    getPollState: () => ({ pollTimer, nextPollAt, localDirty, autoSyncArmed, lastSeenRevision: settings.lastSeenRevision }),
    markDirty: () => { localDirty = true; },
    mergeHabitData,
    punchDay,
    unmatchedPlusStack,
    getUnmatchedPlusPunches,
    useTimesForDay,
    badCountForDay,
    badDayView,
    promoteOrphanLastUsedIntoPunches,
    backfillCountGapsIntoPunches,
    healDataDrift,
    dayViewDrift,
    formatLastUsedClock,
    reconcileCountsFromPunches,
    applyCountDelta,
    migrateData,
    isSyntheticPunchId,
    stripSyntheticPunches,
    deterministicGapPunchId,
    deterministicGapAtIso,
    cloudHasRicherToday,
    todayActivityScore,
    syncNowAsMaster,
    gasJsonPost,
    gasPostJson,
    APP_VERSION,
    createList,
    renameList,
    deleteList,
    moveHabitToList,
    getActiveListId,
    findDuplicateActiveHabit,
    listNameTaken,
    dedupeHabitsByName,
    normalizeNameKey,
  };
} catch (e) { /* non-browser */ }

async function forceAppUpdateReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (_) { /* ignore */ }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k.indexOf("atomic-habits-") === 0)
          .map(k => caches.delete(k))
      );
    }
  } catch (_) { /* ignore */ }
  try { localStorage.setItem(LS_APP_VERSION, APP_VERSION); } catch (_) { /* ignore */ }
  location.reload(true);
}

function showUpdateBanner() {
  if (document.getElementById("app-update-banner")) return;
  const el = document.createElement("button");
  el.id = "app-update-banner";
  el.type = "button";
  el.className = "app-update-banner";
  el.textContent = "Update available (v" + APP_VERSION + ") — Tap to reload";
  el.addEventListener("click", () => { forceAppUpdateReload(); });
  document.body.insertBefore(el, document.body.firstChild);
}

try {
  const storedVer = localStorage.getItem(LS_APP_VERSION);
  if (storedVer !== APP_VERSION) showUpdateBanner();
} catch (_) { /* ignore */ }

// register the service worker for offline use / installability
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then(reg => { try { reg.update(); } catch (_) { /* ignore */ } })
    .catch(() => {});
}

try {
  const verEl = document.getElementById("app-version-label");
  if (verEl) verEl.textContent = "App version " + APP_VERSION;
} catch (_) { /* ignore */ }

try {
  localStorage.setItem(LS_APP_VERSION, APP_VERSION);
} catch (_) { /* ignore */ }
