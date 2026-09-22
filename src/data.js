// ---- src/data.js ----
// Reads/writes/validates/normalizes localStorage data. No DOM, no other
// src/ module may be assumed ready yet when this one's top-level code runs
// (see state.js's comment on the circular-import TDZ this ran into).
import { normalizeProAccent, normalizeProSecondary, normalizeStyleSlots } from './appearance.js';
import { editorTimeToMinutes } from './editor-core.js';
import {
  DEFAULT_STYLE_PRIMARY,
  DEFAULT_STYLE_SECONDARY,
  WEEKDAYS_INDEX_ORDER,
  isPlainObject
} from './constants.js';
import { t } from './strings.js';

// App defaults and live simulator state.
const REVERSE_WEEK_LOGIC_DEFAULT = false;
window.MANUALLY_TEST = false;
window.TEST_DAY = 1;
window.TEST_TIME_SEC = 8 * 3600;
window.IS_SIMULATING = false;

const DEFAULT_TEACHER_DB = {
  '01國文': ['國文', ''],
  '02英文': ['英文', ''],
  '03數學': ['數學', ''],
  '04歷史': ['歷史', ''],
  '10自主': ['自主學習', ''],
  '07體育': ['體育', ''],
  '08班會': ['班會課', ''],
  '06公民': ['公民', ''],
  '05地理': ['地理', '']
};

const DEFAULT_LOCATION_DB = {
  國文: '',
  英文: '',
  數學: '',
  歷史: '',
  自主: '',
  體育: '',
  班會: '',
  公民: '',
  地理: '',
  國寫: '',
  學策: '',
  英作: ''
};

const DEFAULT_WEEKLY_SCHEDULE = {
  1: [],
  2: [],
  3: [],
  4: [],
  5: []
};

const DEFAULT_BELL_TIMES = [
  ['08:00', '08:50'],
  ['09:10', '10:00'],
  ['10:10', '11:00'],
  ['11:10', '12:00'],
  ['13:00', '13:50'],
  ['14:00', '14:50'],
  ['15:00', '15:50'],
  ['15:55', '16:45']
];

const DEFAULT_BREAK_TIMES = [
  {
    name: '打掃時間',
    start: '08:50',
    end: '09:10'
  },
  {
    name: '中午時間',
    start: '12:00',
    end: '13:00'
  }
];
const DEFAULT_COUNTDOWN_EVENT = {
  name: '116 學測',
  startDate: '2027-01-22',
  endDate: '2027-01-24'
};
const DEFAULT_COUNTDOWN_EVENTS = [DEFAULT_COUNTDOWN_EVENT];
// Shared validation and normalization keeps saved and imported data predictable.
function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return false;
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}
// `allowOvernight` lets a range's end be earlier than its start, meaning it
// crosses midnight (e.g. 18:00 -> 05:00). Only named breaks ("special time")
// may do this - bell periods (class time) always stay within one day.
function isValidTimeRange(start, end, allowOvernight = false) {
  if (!isValidTime(start) || !isValidTime(end)) return false;
  const startMin = editorTimeToMinutes(start);
  const endMin = editorTimeToMinutes(end);
  return allowOvernight ? endMin !== startMin : endMin > startMin;
}
// Splits a start/end range into 1 or 2 same-day [start, end) pieces so an
// overnight range (end <= start, meaning it crosses midnight) can be
// compared for overlap using plain minute-of-day numbers. Every bell period
// and break recurs identically every day, so two recurring ranges overlap
// at some point iff their day-pieces overlap within a single day.
function timeRangeToDayPieces(startMin, endMin) {
  if (endMin > startMin) return [[startMin, endMin]];
  const pieces = [];
  if (startMin < 1440) pieces.push([startMin, 1440]);
  if (endMin > 0) pieces.push([0, endMin]);
  return pieces;
}
// `kind` ('bell' | 'break') travels alongside each interval/error purely so
// callers (editor-schedule.js's showEditorTimeConflict) can tell which
// editor fold to send the user to - it must not be derived by pattern-
// matching the (now-translatable) error message text, which would only
// ever match the zh-TW wording.
function validateTimeIntervals(bellTimes, breakTimes) {
  const intervals = [];
  const addInterval = (start, end, label, kind, allowOvernight) => {
    if (!isValidTimeRange(start, end, allowOvernight)) {
      const error = new Error(t('editorSchedule.invalidTimeRange', { label }));
      error.conflictKind = kind;
      throw error;
    }
    timeRangeToDayPieces(editorTimeToMinutes(start), editorTimeToMinutes(end)).forEach(
      ([pieceStart, pieceEnd]) => intervals.push({ start: pieceStart, end: pieceEnd, label, kind })
    );
  };
  (bellTimes || []).forEach((item, index) =>
    addInterval(
      item[0],
      item[1],
      t('editorSchedule.periodLabel', { number: index + 1 }),
      'bell',
      false
    )
  );
  (breakTimes || []).forEach(item =>
    addInterval(
      item.start,
      item.end,
      t('editorSchedule.breakLabel', { name: item.name }),
      'break',
      true
    )
  );
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  intervals.forEach((item, index) => {
    if (index > 0 && item.start < intervals[index - 1].end) {
      const error = new Error(
        t('editorSchedule.timeConflict', { labelA: intervals[index - 1].label, labelB: item.label })
      );
      error.conflictKind =
        intervals[index - 1].kind === 'break' || item.kind === 'break' ? 'break' : 'bell';
      throw error;
    }
  });
}
function normalizeCountdownEvent(value) {
  const source = value && typeof value === 'object' ? value : {};
  const name = String(source.name || '')
    .trim()
    .slice(0, 80);
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
  const legacyDate = String(source.date || '').trim();
  let startDate = String(source.startDate || legacyDate || '').trim();
  let endDate = String(source.endDate || legacyDate || startDate || '').trim();
  if (!name || !isDate(startDate) || !isDate(endDate)) return null;
  if (endDate < startDate) {
    const swap = startDate;
    startDate = endDate;
    endDate = swap;
  }
  return { name, startDate, endDate };
}
// Formats a countdown event's date(s) for display, e.g. "2027.01.22" or "2027.01.22–01.24".
function formatCountdownEventDate(event) {
  const dot = value => String(value || '').replaceAll('-', '.');
  if (!event) return '';
  if (event.startDate === event.endDate) return dot(event.startDate);
  const endShort = event.endDate.slice(
    event.startDate.slice(0, 4) === event.endDate.slice(0, 4) ? 5 : 0
  );
  return `${dot(event.startDate)}–${dot(endShort)}`;
}
function normalizeCountdownEvents(value) {
  const source = Array.isArray(value) ? value : [];
  const events = source.map(normalizeCountdownEvent).filter(Boolean).slice(0, 12);
  return events.length
    ? events
    : Array.isArray(value)
      ? []
      : DEFAULT_COUNTDOWN_EVENTS.map(event => ({ ...event }));
}
const ORBIT_APP_ID = 'Orbit_Color';
const ORBIT_STORAGE_SCHEMA = 'r8N3wL0yS5qM9uV7';

function getDefaultData() {
  return {
    teacherDB: DEFAULT_TEACHER_DB,
    teacherOrder: Object.keys(DEFAULT_TEACHER_DB),
    locationDB: { ...DEFAULT_LOCATION_DB },
    weeklySchedule: { ...DEFAULT_WEEKLY_SCHEDULE },
    bellTimes: DEFAULT_BELL_TIMES.map(period => [...period]),
    breakTimes: DEFAULT_BREAK_TIMES.map(item => ({ ...item })),
    countdownEvents: DEFAULT_COUNTDOWN_EVENTS.map(event => ({ ...event })),
    reverseWeek: REVERSE_WEEK_LOGIC_DEFAULT,
    proAccent: DEFAULT_STYLE_PRIMARY,
    proSecondary: DEFAULT_STYLE_SECONDARY,
    styleSlots: normalizeStyleSlots([])
  };
}

function sanitizeBreakTimes(bellTimes, breakTimes = []) {
  const validBreaks = [];
  const source = Array.isArray(breakTimes) ? breakTimes : [];
  source.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const name = String(item.name || '').trim();
    const start = String(item.start || '').trim();
    const end = String(item.end || '').trim();
    if (!name && !start && !end) return;
    if (!name || !isValidTimeRange(start, end, true)) return;
    try {
      validateTimeIntervals(bellTimes, [...validBreaks, { name, start, end }]);
      validBreaks.push({ name, start, end });
    } catch {
      // Keep a valid timetable even if one optional break conflicts.
    }
  });

  DEFAULT_BREAK_TIMES.forEach(defaultBreak => {
    if (validBreaks.some(item => item.name === defaultBreak.name)) return;
    try {
      validateTimeIntervals(bellTimes, [...validBreaks, { ...defaultBreak }]);
      validBreaks.push({ ...defaultBreak });
    } catch {
      // Only add the default break when it fits the current timetable.
    }
  });

  return validBreaks;
}

// If localStorage's saved schedule fails to load for any reason - it isn't
// valid JSON, it's missing required fields, a field is the wrong shape, or
// something later on chokes while reading it - this clears the stored key
// outright rather than leaving corrupt data sitting there to fail the same
// way on every future load. loadData() falls back to a clean default
// schedule either way; clearing it here just means that's a one-time thing,
// not a repeat failure on the next visit too.
function clearStoredData() {
  try {
    localStorage.removeItem('classFocusData');
  } catch {
    /* localStorage unavailable (private browsing, etc.) - nothing to clear. */
  }
}

// Whether this browser has ever actually saved a schedule - i.e. a
// brand-new user, as opposed to one who's just looking at the (indistinguish-
// able-looking) default data loadData() also returns on a first run. Used to
// decide whether to show the first-run onboarding prompt (src/onboarding.js).
function hasSavedSchedule() {
  try {
    return !!localStorage.getItem('classFocusData');
  } catch {
    return false;
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem('classFocusData');
    if (!raw) return getDefaultData();

    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('saved schedule is not an object');

    const required = ['teacherDB', 'locationDB', 'weeklySchedule', 'bellTimes'];
    if (!required.every(key => Object.prototype.hasOwnProperty.call(parsed, key)))
      throw new Error('saved schedule is missing required fields');
    if (!isPlainObject(parsed.teacherDB))
      throw new Error('saved schedule has an invalid teacherDB');
    if (!isPlainObject(parsed.locationDB))
      throw new Error('saved schedule has an invalid locationDB');
    if (!isPlainObject(parsed.weeklySchedule))
      throw new Error('saved schedule has an invalid weeklySchedule');
    if (!Array.isArray(parsed.bellTimes))
      throw new Error('saved schedule has an invalid bellTimes');
    if (Object.values(parsed.teacherDB).some(value => !Array.isArray(value)))
      throw new Error('saved schedule has an invalid teacherDB entry');
    if (Object.values(parsed.weeklySchedule).some(value => !Array.isArray(value)))
      throw new Error('saved schedule has an invalid weeklySchedule entry');
    if (
      !parsed.bellTimes.every(
        item =>
          Array.isArray(item) &&
          item.length >= 2 &&
          isValidTimeRange(String(item[0] || ''), String(item[1] || ''))
      )
    )
      throw new Error('saved schedule has an invalid bellTimes entry');

    const bellTimes = parsed.bellTimes.map(item => [String(item[0]), String(item[1])]);
    const normalized = {
      teacherDB: Object.fromEntries(
        Object.entries(parsed.teacherDB).map(([key, value]) => [
          String(key).trim(),
          Array.isArray(value)
            ? [String(value[0] || ''), String(value[1] || ''), String(value[2] || '')]
            : ['', '', '']
        ])
      ),
      teacherOrder: Array.isArray(parsed.teacherOrder)
        ? parsed.teacherOrder.filter(Boolean).map(String)
        : Object.keys(parsed.teacherDB),
      locationDB: Object.fromEntries(
        Object.entries(parsed.locationDB).map(([key, value]) => [
          String(key).trim(),
          String(value || '')
        ])
      ),
      weeklySchedule: Object.fromEntries(
        WEEKDAYS_INDEX_ORDER.map(day => {
          const row = Array.isArray(
            parsed.weeklySchedule[day] || parsed.weeklySchedule[String(day)]
          )
            ? parsed.weeklySchedule[day] || parsed.weeklySchedule[String(day)]
            : [];
          return [day, row.map(item => String(item || ''))];
        })
      ),
      bellTimes,
      breakTimes: sanitizeBreakTimes(bellTimes, parsed.breakTimes),
      countdownEvents: normalizeCountdownEvents(parsed.countdownEvents),
      reverseWeek:
        typeof parsed.reverseWeek === 'boolean' ? parsed.reverseWeek : REVERSE_WEEK_LOGIC_DEFAULT,
      proAccent: normalizeProAccent(parsed.proAccent),
      proSecondary: normalizeProSecondary(parsed.proSecondary),
      styleSlots: normalizeStyleSlots(parsed.styleSlots)
    };

    return normalized;
  } catch {
    clearStoredData();
    return getDefaultData();
  }
}
// Persists the editable schedule data in the browser.
function saveData(d) {
  try {
    localStorage.setItem(
      'classFocusData',
      JSON.stringify({ ...d, __orbit: { app: ORBIT_APP_ID, schema: ORBIT_STORAGE_SCHEMA } })
    );
  } catch {
    // localStorage can throw (private browsing, quota exceeded) - nothing
    // more useful to do here than drop this save attempt.
  }
}
export {
  ORBIT_APP_ID,
  ORBIT_STORAGE_SCHEMA,
  REVERSE_WEEK_LOGIC_DEFAULT,
  formatCountdownEventDate,
  getDefaultData,
  hasSavedSchedule,
  isValidTimeRange,
  loadData,
  normalizeCountdownEvent,
  normalizeCountdownEvents,
  sanitizeBreakTimes,
  saveData,
  validateTimeIntervals
};
