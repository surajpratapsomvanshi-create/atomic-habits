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

let data = migrateData(load(LS_DATA, { habits: [], checks: {}, counts: {} }));
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
let localDirty = false;
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
  const counts = raw.counts && typeof raw.counts === "object" ? raw.counts : {};
  const lastUsedAt = migrateLastUsedAt(raw.lastUsedAt);
  const punches = migratePunches(raw.punches);
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
    out.push({
      id: String(p.id || ("p-" + t.toString(36))),
      habitId,
      at: new Date(t).toISOString(),
      delta: delta > 0 ? 1 : -1,
    });
  }
  return out;
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
    recordPunch(habitId, 1);
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

/** Record a clock-time punch. + updates lastUsedAt; − does not. */
function recordPunch(habitId, delta) {
  const id = String(habitId || "");
  if (!id) return;
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return;
  const at = new Date().toISOString();
  if (!Array.isArray(data.punches)) data.punches = [];
  data.punches.push({
    id: "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    habitId: id,
    at,
    delta: d > 0 ? 1 : -1,
  });
  if (data.punches.length > MAX_PUNCHES) {
    data.punches = data.punches.slice(-MAX_PUNCHES);
  }
  if (d > 0) {
    if (!data.lastUsedAt || typeof data.lastUsedAt !== "object") data.lastUsedAt = {};
    data.lastUsedAt[id] = at;
  }
}

function getLastUsedAt(habitId) {
  const map = data.lastUsedAt;
  if (!map || typeof map !== "object") return null;
  const iso = map[String(habitId)];
  return iso ? String(iso) : null;
}

/** Relative label from an ISO timestamp, e.g. "2h ago", "1d ago", "Just now". */
function formatLastUsedAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
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
  recordPunch(habitId, 1);
  setCount(habitId, date, getCount(habitId, date) + 1);
}

function decrementCount(habitId, date) {
  const cur = getCount(habitId, date);
  if (cur <= 0) return;
  // Log the − punch for sync history, but do not reset lastUsedAt.
  recordPunch(habitId, -1);
  setCount(habitId, date, cur - 1);
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
  const count = getCount(h.id, selectedDate);
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
  const lastIso = getLastUsedAt(h.id);
  const lastLabel = formatLastUsedAgo(lastIso);
  const lastUsedHtml = lastLabel
    ? `<div class="habit-last-used" title="${lastIso || ""}">${lastLabel}</div>`
    : `<div class="habit-last-used never">Not used yet</div>`;

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
     </div>`;
  card.querySelector(".habit-name").textContent = h.name;
  card.querySelector(".habit-pill.schedule").textContent = scheduleLabel(h);
  card.querySelectorAll(".habit-warn").forEach((el, i) => { el.textContent = warnings[i]; });
  card.querySelectorAll(".habit-tip").forEach((el, i) => { el.textContent = tips[i]; });
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
  const res = await fetch(settings.scriptUrl + "?action=info");
  const out = await res.json();
  if (out && out.ok && (out.hasData !== undefined || out.revision !== undefined)) {
    return {
      hasData: !!out.hasData,
      revision: out.revision != null ? out.revision : null,
      updatedAt: out.updatedAt || null,
      deviceId: out.deviceId || null,
      spreadsheetUrl: out.spreadsheetUrl || null,
      legacy: false,
    };
  }
  // Legacy backend: no metadata in info → probe the actual snapshot.
  const r2 = await fetch(settings.scriptUrl + "?action=load");
  const o2 = await r2.json();
  const hasData = !!(o2 && o2.ok && o2.data && Array.isArray(o2.data.habits) && o2.data.habits.length > 0);
  return {
    hasData,
    revision: o2 && o2.revision != null ? o2.revision : null,
    updatedAt: (o2 && o2.updatedAt) || null,
    deviceId: (o2 && o2.deviceId) || null,
    spreadsheetUrl: (out && out.spreadsheetUrl) || null,
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
 * lists + habits by id (cloud wins on same id), checks union, counts take max,
 * lastUsedAt takes later timestamp per habit, punches union by id.
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

  const counts = {};
  const countDates = new Set([
    ...Object.keys(cld.counts || {}),
    ...Object.keys(loc.counts || {}),
  ]);
  for (const day of countDates) {
    const a = (cld.counts && cld.counts[day]) || {};
    const b = (loc.counts && loc.counts[day]) || {};
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    const row = {};
    for (const id of ids) {
      row[id] = Math.max(Number(a[id]) || 0, Number(b[id]) || 0);
    }
    if (Object.keys(row).length) counts[day] = row;
  }

  const lastUsedAt = {};
  const usedIds = new Set([
    ...Object.keys(cld.lastUsedAt || {}),
    ...Object.keys(loc.lastUsedAt || {}),
  ]);
  for (const id of usedIds) {
    const later = laterIso(
      (cld.lastUsedAt && cld.lastUsedAt[id]) || null,
      (loc.lastUsedAt && loc.lastUsedAt[id]) || null
    );
    if (later) lastUsedAt[id] = later;
  }

  const punchById = new Map();
  for (const p of [...(cld.punches || []), ...(loc.punches || [])]) {
    if (!p || !p.id) continue;
    const key = String(p.id);
    if (!punchById.has(key)) punchById.set(key, p);
  }
  let punches = Array.from(punchById.values());
  punches.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (punches.length > MAX_PUNCHES) punches = punches.slice(-MAX_PUNCHES);

  let activeListId = loc.activeListId || cld.activeListId || fallbackListId;
  if (!listIds.has(String(activeListId))) activeListId = fallbackListId;

  const deduped = dedupeHabitsByName({ habits, checks, counts, lastUsedAt, punches, lists, activeListId });
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
  const res = await fetch(settings.scriptUrl + "?action=load");
  const out = await res.json();
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

  const pushed = await pushSnapshot({ silent: true, afterMerge: true });
  if (pushed) {
    setSyncIndicator("ok", "Merged with cloud · rev " + (settings.lastSeenRevision != null ? settings.lastSeenRevision : "?"));
    if (!opts.silent) toast("Synced — merged with cloud");
    return true;
  }

  // Concurrent edit during merge push → take cloud (never force).
  rememberRevision(cloudMeta);
  saveSettings();
  await restoreFromSheet({
    skipConfirm: true,
    fromPoll: true,
    toastMsg: "Loaded cloud version",
  });
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
    setSyncIndicator("error", "Cloud check failed — auto-sync paused. Tap Restore or Upload.");
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
 */
async function pushSnapshot(opts) {
  opts = opts || {};
  const res = await fetch(settings.scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "save",
      data,
      baseRevision: settings.lastSeenRevision,
      deviceId: settings.deviceId,
    }),
  });
  const out = await res.json();
  if (out && out.conflict) {
    updateSyncSafetyText(out);
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
  updateSyncSafetyText(out);
  return true;
}

/**
 * Upload this device's data to the cloud (optimistic concurrency).
 * On stale revision: auto-merge pending local edits onto cloud, or pull cloud.
 * opts.silent → quieter status (used by poll when pushing pending edits).
 */
async function syncNow(opts) {
  opts = opts || {};
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return; }

  // New/blank device with cloud data → restore first instead of uploading seeds.
  if (isFreshLocal()) {
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
  } else if (!autoSyncArmed) {
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

  setSyncIndicator("pending", opts.silent ? "Syncing…" : "Uploading…");
  try {
    const ok = await pushSnapshot({ silent: opts.silent });
    if (!ok) return;
    const rev = settings.lastSeenRevision != null ? " · rev " + settings.lastSeenRevision : "";
    setSyncIndicator("ok", "Uploaded: " + new Date(settings.lastSync).toLocaleString() + rev);
    if (!opts.silent) toast(settings.lastSeenRevision != null ? "Uploaded to cloud ✓" : "Synced ✓ (legacy backend)");
  } catch (err) {
    setSyncIndicator("error", "Upload failed: " + err.message);
    if (!opts.silent) toast("Upload failed — data is safe locally");
  }
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
  if (!opts.skipConfirm && !confirm("Restore from cloud? A local backup will be saved first, then local data is replaced with the cloud copy.")) return false;
  setSyncIndicator("pending", opts.auto ? "Syncing…" : (opts.fromPoll ? "Refreshing…" : "Restoring…"));
  try {
    const res = await fetch(settings.scriptUrl + "?action=load");
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || "Unknown error");
    if (out.data && Array.isArray(out.data.habits)) {
      const backedUp = makeLocalBackup();
      data = migrateData(out.data);
      saveData();
      rememberRevision(out);
      settings.lastSync = new Date().toISOString();
      saveSettings();
      autoSyncArmed = true;
      localDirty = false;
      lastPullAt = Date.now();
      render();
      updateSyncSafetyText(out);
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

  if (cloudAhead) {
    if (localDirty || syncTimer) {
      // Local has pending edits — try push; auto-merge on conflict.
      await syncNow({ silent: true });
    } else if (autoSyncArmed || seen != null) {
      await restoreFromSheet({ skipConfirm: true, fromPoll: true });
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
    migrateData,
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

// register the service worker for offline use / installability
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
