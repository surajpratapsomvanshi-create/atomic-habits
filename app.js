/* =====================================================================
   Atomic Habits Tracker — offline-first, syncs to Google Sheets
   Data model (localStorage "ah.data"):
   {
     habits: [{
       id, name, emoji, color, createdAt, archived,
       type: "good" | "bad",
       schedule: { kind: "daily" } |
                 { kind: "weekdays", weekdays: [0-6] } |
                 { kind: "once", date: "YYYY-MM-DD" },
       dailyLimit: number | null,  // bad habits only
       sortIndex: number           // display order (Today + Stats)
     }],
     checks: { "YYYY-MM-DD": ["habitId", ...] },   // good habits
     counts: { "YYYY-MM-DD": { habitId: number } } // bad habits
   }
   Legacy habits without type/schedule migrate to daily good habits.
   ===================================================================== */

const LS_DATA = "ah.data";
const LS_SETTINGS = "ah.settings";

/** Default Google Apps Script Web App URL (Atomic Habits backend). */
const DEFAULT_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxxcZhrVNYDpg4ZUfFQNDGudJKUJENaQRRcoyMio8_YEdo5GoKscHAGyUhEd0iK9NkG/exec";

const EMOJIS = ["🦷","💧","🏃","📖","🧘","💪","😴","🥗","✍️","🚭","🧹","💊","🌞","🎸","💻","🙏"];
const COLORS = ["#5b8def","#3ecf8e","#e8b84a","#f07178","#a78bfa","#f472b6","#22d3ee","#fb923c"];
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
let syncTimer = null;
/** Auto-sync stays disarmed until cloud state is loaded or confirmed empty. */
let autoSyncArmed = false;
/** True once initSync has finished its first cloud check. */
let cloudChecked = false;

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

/** Normalize legacy payloads so old habits behave as daily good habits. */
function migrateData(raw) {
  if (!raw || typeof raw !== "object") return { habits: [], checks: {}, counts: {} };
  const habits = Array.isArray(raw.habits) ? raw.habits.map(migrateHabit) : [];
  // Existing habits without sortIndex inherit current array order.
  habits.forEach((h, i) => {
    if (h && (h.sortIndex == null || !Number.isFinite(Number(h.sortIndex)))) h.sortIndex = i;
  });
  habits.sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
  habits.forEach((h, i) => { h.sortIndex = i; });
  const checks = raw.checks && typeof raw.checks === "object" ? raw.checks : {};
  const counts = raw.counts && typeof raw.counts === "object" ? raw.counts : {};
  return { habits, checks, counts };
}

function migrateHabit(h) {
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
  return {
    id: h.id,
    name: h.name || "Habit",
    emoji: h.emoji || EMOJIS[0],
    color: h.color || COLORS[0],
    createdAt: h.createdAt || todayStr(),
    archived: !!h.archived,
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

/* ---------------- schedule / habit helpers ---------------- */
function activeHabits() {
  return data.habits
    .filter(h => !h.archived)
    .slice()
    .sort((a, b) => (a.sortIndex - b.sortIndex) || String(a.id).localeCompare(String(b.id)));
}

function nextSortIndex() {
  let max = -1;
  for (const h of data.habits) {
    const n = Number(h.sortIndex);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Reorder active habits so the visible subset matches `orderedVisibleIds`
 * (other active habits keep their relative slots). Persists + syncs.
 */
function applyVisibleHabitOrder(orderedVisibleIds) {
  if (!Array.isArray(orderedVisibleIds) || orderedVisibleIds.length < 2) return;
  const active = activeHabits();
  const visibleSet = new Set(orderedVisibleIds);
  let vi = 0;
  const reordered = [];
  for (const h of active) {
    if (visibleSet.has(h.id)) {
      const next = active.find(x => x.id === orderedVisibleIds[vi++]);
      if (next) reordered.push(next);
    } else {
      reordered.push(h);
    }
  }
  reordered.forEach((h, i) => { h.sortIndex = i; });
  const archived = data.habits.filter(h => h.archived);
  archived.forEach((h, i) => { h.sortIndex = reordered.length + i; });
  data.habits = [...reordered, ...archived];
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
  if (i >= 0) list.splice(i, 1); else list.push(habitId);
  if (list.length === 0) delete data.checks[date];
  // Flag so the re-render can play the satisfying tick animation once
  justCheckedId = i < 0 ? habitId : null;
  saveData();
  render();
  justCheckedId = null;
  queueSync();
  if (navigator.vibrate) navigator.vibrate(15);
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
  setCount(habitId, date, getCount(habitId, date) + 1);
}

function decrementCount(habitId, date) {
  const cur = getCount(habitId, date);
  if (cur <= 0) return;
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
  renderHeader();
  renderDateStrip();
  renderHabits();
  renderStats();
}

/** Time-of-day greeting for the personalized header. */
function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return "Burning the midnight oil, Suraj";
  if (hr < 12) return "Good morning, Suraj";
  if (hr < 17) return "Good afternoon, Suraj";
  return "Good evening, Suraj";
}

function renderHeader() {
  if (currentView === "today") {
    const isToday = selectedDate === todayStr();
    document.getElementById("header-title").textContent = isToday ? greeting() : prettyDate(selectedDate).split(",")[0];
    document.getElementById("header-date").textContent = prettyDate(selectedDate);
  }

  const goods = goodHabitsForDate(selectedDate); // counters never affect the ring
  const done = goods.filter(h => isChecked(h.id, selectedDate)).length;
  const pct = goods.length ? Math.round((done / goods.length) * 100) : 0;
  const C = 2 * Math.PI * 19;
  document.getElementById("day-ring").style.strokeDashoffset = C * (1 - pct / 100);
  document.getElementById("day-ring-label").textContent = pct + "%";
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
  const anyActive = activeHabits().length > 0;
  listEl.innerHTML = "";

  if (!habits.length) {
    emptyEl.classList.remove("hidden");
    if (anyActive) {
      emptyEl.querySelector(".empty-emoji").textContent = "📅";
      emptyEl.querySelector("h2").textContent = "Nothing scheduled";
      emptyEl.querySelector("p").innerHTML = "No habits are scheduled for this day.<br/>Add one or pick another date.";
    } else {
      emptyEl.querySelector(".empty-emoji").textContent = "🌱";
      emptyEl.querySelector("h2").textContent = "No habits yet";
      emptyEl.querySelector("p").innerHTML = "Small habits, remarkable results.<br/>Add your first habit to get started.";
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
  const summaryEl = document.getElementById("stats-summary");
  const listEl = document.getElementById("stats-list");

  const goodHabits = habits.filter(h => h.type !== "bad");
  const badHabits = habits.filter(h => h.type === "bad");
  const totalDone = Object.values(data.checks).reduce((a, l) => a + l.length, 0);
  const bestOverall = goodHabits.reduce((a, h) => Math.max(a, bestStreak(h.id)), 0);
  const totalBadCounts = badHabits.reduce((a, h) => a + totalCountSum(h.id), 0);

  summaryEl.innerHTML =
    `<div class="summary-tile"><div class="num">${habits.length}</div><div class="lbl">Habits</div></div>` +
    `<div class="summary-tile"><div class="num">${totalDone}</div><div class="lbl">Check-ins</div></div>` +
    `<div class="summary-tile"><div class="num">${badHabits.length ? totalBadCounts : bestOverall + (bestOverall ? "🔥" : "")}</div><div class="lbl">${badHabits.length ? "Counter taps" : "Best streak"}</div></div>`;

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

/** Fraction of the local day elapsed (0–1), using hour + minute. */
function dayProgressFraction(now) {
  const d = now || new Date();
  return (d.getHours() + d.getMinutes() / 60) / 24;
}

/**
 * Primary Stats viz for COUNTER habits: Today / Yesterday / 2 Days Ago
 * horizontal bars vs full-day target, with a shared "Track till hour" band.
 */
function renderTrackTillHourChart(h) {
  const { target, source } = counterDayTarget(h);
  const today = todayStr();
  const rows = [
    { key: "today", label: "Today", date: today, isToday: true },
    { key: "yesterday", label: "Yesterday", date: addDays(today, -1), isToday: false },
    { key: "twoAgo", label: "2 Days Ago", date: addDays(today, -2), isToday: false },
  ].map(r => ({ ...r, count: getCount(h.id, r.date) }));

  if (target == null || !(target > 0)) {
    return (
      `<div class="track-chart">
         <div class="track-chart-title">Today's Target (Based on Full Day Average)</div>
         <div class="track-pending">
           <p>Set a daily limit</p>
           <span>Or log counts on a prior day to build an average target.</span>
         </div>
         ${renderMiniCountChart(h)}
       </div>`
    );
  }

  const now = new Date();
  const hourFrac = dayProgressFraction(now);
  const expected = target * hourFrac;
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const scaleMax = Math.max(target, maxCount, expected, 1);
  const trackPct = Math.min(100, (expected / scaleMax) * 100);
  const targetPct = Math.min(100, (target / scaleMax) * 100);
  const hourLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const targetLabel =
    source === "limit"
      ? `Daily limit ${formatTarget(target)}`
      : `Full-day avg ${formatTarget(target)}`;

  let rowHtml = "";
  for (const row of rows) {
    const barPct = Math.min(100, (row.count / scaleMax) * 100);
    // Strict rule: count >= target/average → red, otherwise green.
    const atOrOverTarget = row.count >= target;
    const tone = atOrOverTarget ? "over" : "ok";
    const showBar = row.count > 0;
    const fillW = showBar ? Math.max(barPct, 2.5) : 0;
    rowHtml +=
      `<div class="track-row${row.isToday ? " is-today" : ""}" title="${row.date}: ${row.count} / ${formatTarget(target)}">
         <div class="track-label">${row.label}</div>
         <div class="track-rail">
           <div class="track-till-region" style="width:${trackPct.toFixed(2)}%"></div>
           <div class="track-till-edge" style="left:${trackPct.toFixed(2)}%"></div>
           ${targetPct < 99.5 ? `<div class="track-target-mark" style="left:${targetPct.toFixed(2)}%"></div>` : ""}
           ${showBar ? `<div class="track-fill tone-${tone}" style="width:${fillW.toFixed(2)}%"></div>` : `<div class="track-fill empty"></div>`}
         </div>
         <div class="track-vals${atOrOverTarget ? " over" : ""}">${row.count}&nbsp;/&nbsp;${formatTarget(target)}</div>
       </div>`;
  }

  return (
    `<div class="track-chart">
       <div class="track-chart-head">
         <div class="track-chart-title">Today's Target (Based on Full Day Average)</div>
         <div class="track-chart-sub">${targetLabel} · track till ${hourLabel}</div>
       </div>
       <div class="track-legend">
         <span class="track-legend-item till"><i></i>Track till hour</span>
         <span class="track-legend-item target"><i></i>Full day</span>
       </div>
       <div class="track-rows">${rowHtml}</div>
       ${renderMiniCountChart(h)}
     </div>`
  );
}

function formatTarget(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
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
    const pct = day.count <= 0 ? 0 : Math.max(12, Math.round((day.count / scaleMax) * 100));
    const over = target != null ? day.count >= target : (h.dailyLimit != null && day.count >= h.dailyLimit);
    const under = day.count > 0 && !over;
    const toneCls = over ? " over" : under ? " under" : "";
    const dom = Number(day.date.split("-")[2]);
    cols +=
      `<div class="mini-col${day.isToday ? " today" : ""}${toneCls}${day.count === 0 ? " zero" : ""}" title="${day.date}: ${day.count}">
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

  const orderedIds = [...listEl.querySelectorAll("[data-habit-id]")].map(el => el.dataset.habitId);
  const visiblePrev = activeHabits().map(h => h.id).filter(id => orderedIds.includes(id));
  const changed = orderedIds.length === visiblePrev.length &&
    orderedIds.some((id, i) => id !== visiblePrev[i]);
  if (changed) applyVisibleHabitOrder(orderedIds);
  else render();
}

/* ---------------- habit modal ---------------- */
function openHabitModal(habitId) {
  editingHabitId = typeof habitId === "string" ? habitId : null;
  const h = editingHabitId ? data.habits.find(x => x.id === editingHabitId) : null;

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

  renderPickers();
  syncModalSections();
  document.getElementById("habit-modal").classList.remove("hidden");
  if (!h) setTimeout(() => document.getElementById("habit-name").focus(), 100);
}
function closeHabitModal() {
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

function saveHabit() {
  const name = document.getElementById("habit-name").value.trim();
  if (!name) { toast("Give your habit a name"); return; }
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
    Object.assign(h, fields);
  } else {
    data.habits.push({
      id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...fields,
      createdAt: todayStr(),
      archived: false,
      sortIndex: nextSortIndex(),
    });
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

/**
 * Runs once at startup: establishes cloud state before auto-sync may fire.
 * New/blank devices default to Restore rather than pushing.
 */
async function initSync() {
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
    return;
  }

  // Not safe to overwrite: cloud has data this device hasn't loaded/owned.
  autoSyncArmed = false;
  if (isFreshLocal()) {
    setSyncIndicator("warn", "Cloud has data — restore to this device first");
    showNewDeviceModal(cloud);
  } else {
    setSyncIndicator("warn", "Cloud changed elsewhere — resolve conflict");
    showConflictModal(cloud, { newDevice: false });
  }
}

function queueSync() {
  if (!settings.scriptUrl || !settings.autoSync) return;
  if (!autoSyncArmed) return; // never auto-push before cloud state is known
  setSyncIndicator("pending");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 2500); // debounce rapid taps
}

/**
 * Upload this device's data to the cloud.
 * opts.force  → bypass conflict/blank guards (explicit overwrite).
 * opts.silent → suppress the "verify cloud first" modal (used internally).
 */
async function syncNow(opts) {
  opts = opts || {};
  const force = opts.force === true;
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return; }

  // Guard: before any non-forced overwrite, verify we own the cloud state.
  if (!force && (!autoSyncArmed || isFreshLocal())) {
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
      showConflictModal(cloud, { newDevice: isFreshLocal() });
      return;
    }
    autoSyncArmed = true;
  }

  setSyncIndicator("pending", "Uploading…");
  try {
    // text/plain avoids the CORS preflight that Apps Script can't answer
    const res = await fetch(settings.scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "save",
        data,
        baseRevision: settings.lastSeenRevision,
        deviceId: settings.deviceId,
        force,
      }),
    });
    const out = await res.json();
    if (out && out.conflict) {
      autoSyncArmed = false;
      updateSyncSafetyText(out);
      setSyncIndicator("warn", "Conflict — cloud not overwritten");
      showConflictModal(out, { newDevice: isFreshLocal() });
      return;
    }
    if (!out || !out.ok) throw new Error((out && out.error) || "Unknown error");
    settings.lastSync = new Date().toISOString();
    rememberRevision(out);
    saveSettings();
    autoSyncArmed = true;
    updateSyncSafetyText(out);
    const rev = out.revision != null ? " · rev " + out.revision : "";
    setSyncIndicator("ok", "Uploaded: " + new Date(settings.lastSync).toLocaleString() + rev);
    toast(out.revision != null ? "Uploaded to cloud ✓" : "Synced ✓ (legacy backend)");
  } catch (err) {
    setSyncIndicator("error", "Upload failed: " + err.message);
    toast("Upload failed — data is safe locally");
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
  if (!settings.scriptUrl) { toast("Set the Web App URL in Settings first"); return; }
  if (!opts.skipConfirm && !confirm("Restore from cloud? A local backup will be saved first, then local data is replaced with the cloud copy.")) return;
  setSyncIndicator("pending", "Restoring…");
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
      render();
      updateSyncSafetyText(out);
      const rev = out.revision != null ? " · rev " + out.revision : "";
      setSyncIndicator("ok", "Restored from cloud" + rev);
      toast(backedUp ? "Restored ✓ (local backup saved)" : "Restored from cloud ✓");
    } else {
      throw new Error("Sheet has no saved data yet");
    }
  } catch (err) {
    setSyncIndicator("error", "Restore failed: " + err.message);
    toast("Restore failed: " + err.message);
  }
}

/** Explicit, guarded overwrite of cloud with this device's data. */
async function forceReplaceCloud() {
  const phrase = prompt(
    "This OVERWRITES cloud data for ALL devices with this device's data.\n" +
    "The previous cloud snapshot is archived in the Sheet's _history tab.\n\n" +
    "Type REPLACE to confirm:"
  );
  if (phrase == null) return;
  if (phrase.trim().toUpperCase() !== "REPLACE") { toast("Cancelled — cloud unchanged"); return; }
  closeSyncModal();
  await syncNow({ force: true });
}

/* ---------------- sync modals + status ---------------- */
function updateSyncSafetyText(cloud) {
  const el = document.getElementById("sync-safety-text");
  if (!el) return;
  const dev = settings.deviceId ? settings.deviceId.replace(/^dev-/, "") : "—";
  const seen = settings.lastSeenRevision != null ? settings.lastSeenRevision : "—";
  let cloudBit = "";
  if (cloud) {
    if (cloud.legacy) cloudBit = " · cloud: legacy backend (client-side guard only)";
    else if (cloud.hasData || cloud.revision != null) cloudBit = " · cloud rev " + (cloud.revision != null ? cloud.revision : "?");
    else cloudBit = " · cloud empty";
  }
  el.textContent = "Device " + dev + " · last seen rev " + seen + cloudBit;
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

function showNewDeviceModal(cloud) {
  const when = cloud && cloud.updatedAt ? new Date(cloud.updatedAt).toLocaleString() : "an earlier session";
  const revBit = cloud && cloud.revision != null ? " (revision " + cloud.revision + ")" : "";
  openSyncModal({
    title: "Cloud data found",
    body:
      "<p class=\"muted\">This looks like a new or blank device, and the cloud already has saved habits" + revBit + " from " + when + ".</p>" +
      "<p class=\"muted\">To protect your data, this device will <b>not</b> upload and overwrite the cloud automatically. Restore the cloud copy to this device first.</p>",
    buttons: [
      { label: "Keep local only", cls: "btn-ghost", onClick: () => { closeSyncModal(); setSyncIndicator("warn", "Auto-sync paused — cloud not overwritten"); } },
      { label: "Restore from cloud", cls: "btn-primary", onClick: async () => { closeSyncModal(); await restoreFromSheet({ skipConfirm: true }); } },
    ],
  });
}

function showConflictModal(cloud, opts) {
  opts = opts || {};
  const when = cloud && cloud.updatedAt ? new Date(cloud.updatedAt).toLocaleString() : "another device";
  const revBit = cloud && cloud.revision != null ? "revision " + cloud.revision : "a newer revision";
  const lead = opts.newDevice
    ? "This device is blank/new and the cloud already has data"
    : "The cloud has changed since this device last synced";
  openSyncModal({
    title: "Sync conflict",
    body:
      "<p class=\"muted\">" + lead + " (" + revBit + ", updated " + when + ").</p>" +
      "<p class=\"muted\">Nothing was overwritten. Choose how to resolve:</p>" +
      "<p class=\"muted\"><b>Restore cloud</b> is the safe option (a local backup is kept). " +
      "<b>Force replace</b> overwrites the cloud with this device — the previous cloud snapshot is archived in the Sheet's history.</p>",
    buttons: [
      { label: "Cancel", cls: "btn-ghost", onClick: () => { closeSyncModal(); setSyncIndicator("warn", "Conflict unresolved — cloud not overwritten"); } },
      { label: "Force replace cloud", cls: "btn-danger", onClick: () => forceReplaceCloud() },
      { label: "Restore cloud", cls: "btn-primary", onClick: async () => { closeSyncModal(); await restoreFromSheet({ skipConfirm: true }); } },
    ],
  });
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
  const titles = { today: null, stats: "Statistics", settings: "Settings" };
  if (titles[name]) {
    document.getElementById("header-title").textContent = titles[name];
    document.getElementById("header-date").textContent = "";
  } else {
    renderHeader();
  }
}

/* ---------------- wire up ---------------- */
document.querySelectorAll(".nav-btn[data-view]").forEach(b =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

document.getElementById("btn-save-habit").addEventListener("click", saveHabit);
document.getElementById("btn-delete-habit").addEventListener("click", deleteHabit);
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
urlInput.value = settings.scriptUrl;
autoSyncInput.checked = settings.autoSync;
urlInput.addEventListener("change", () => { settings.scriptUrl = urlInput.value.trim(); saveSettings(); });
autoSyncInput.addEventListener("change", () => { settings.autoSync = autoSyncInput.checked; saveSettings(); });

document.getElementById("btn-sync-now").addEventListener("click", () => syncNow());
document.getElementById("btn-restore").addEventListener("click", () => restoreFromSheet());
const btnForce = document.getElementById("btn-force-replace");
if (btnForce) btnForce.addEventListener("click", () => forceReplaceCloud());
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
    data = { habits: [], checks: {}, counts: {} };
    saveData();
    // Blank local state must not auto-overwrite the cloud afterwards.
    autoSyncArmed = false;
    settings.lastSeenRevision = null;
    settings.lastSeenUpdatedAt = null;
    saveSettings();
    render();
    setSyncIndicator("warn", "Local data cleared — cloud untouched. Restore to re-sync.");
  }
});

updateSyncSafetyText(null);
if (settings.lastSync) {
  setSyncIndicator("ok", "Last synced: " + new Date(settings.lastSync).toLocaleString());
}

// First launch → seed daily good habits; otherwise persist any migration upgrades
if (!localStorage.getItem(LS_DATA)) {
  // Seed createdAt a month back so the current week is never empty for new users
  const seedCreated = addDays(todayStr(), -30);
  data.habits = [
    { id: "h-seed1", name: "Brush teeth", emoji: "🦷", color: COLORS[0], createdAt: seedCreated, archived: false, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 0 },
    { id: "h-seed2", name: "Drink water", emoji: "💧", color: COLORS[6], createdAt: seedCreated, archived: false, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 1 },
    { id: "h-seed3", name: "Read 10 minutes", emoji: "📖", color: COLORS[2], createdAt: seedCreated, archived: false, type: "good", schedule: { kind: "daily" }, dailyLimit: null, sortIndex: 2 },
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

render();

// Establish cloud state before auto-sync may fire (fail-safe for new devices).
initSync();

// register the service worker for offline use / installability
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
