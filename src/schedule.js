// ---- src/schedule.js ----
// Turns settings data (from data.js) into the day-by-day runtime schedule,
// plus the pure day/week-parity time helpers most other modules rely on.
import {
  MS_PER_DAY,
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAYS_INDEX_ORDER,
  WEEKDAY_LABELS
} from './constants.js';
import { state } from './state.js';
import { t } from './strings.js';

// Builds the runtime schedule rows from teacher, location, and bell-time data.
function buildSchedule() {
  state.runtimeSchedule = {};
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    state.runtimeSchedule[day] = (state.applicationData.weeklySchedule[day] || [])
      .map((key, i) => {
        if (!key) return null;
        const m = state.applicationData.teacherDB[key] || [
          t('common.unknown'),
          t('common.unknown')
        ];
        const bt = state.applicationData.bellTimes[i];
        if (!bt) return null;
        return {
          key,
          n: m[0],
          t: m[1],
          s: bt[0],
          e: bt[1],
          isSplit: m[0].includes('/'),
          loc: state.applicationData.locationDB[key] || ''
        };
      })
      .filter(Boolean);
  });
  renderNavBar();
}
// Renders weekday navigation buttons for whichever days actually have
// classes (Mon-Fri included - an empty weekday is just as pointless to show
// a tab for as an empty Saturday/Sunday). Falls back to the plain Mon-Fri
// set when nothing has been scheduled at all yet, so a first-time user still
// has something to tap instead of a blank nav bar.
function renderNavBar() {
  const navBar = document.querySelector('.nav-bar');
  if (!navBar) return;
  let days = WEEKDAYS_DISPLAY_ORDER.filter(d => (state.runtimeSchedule[d] || []).length > 0);
  if (!days.length) days = [1, 2, 3, 4, 5];
  navBar.innerHTML = days
    .map(
      d =>
        `<button class="nav-item" data-day="${d}" onclick="handleNav(${d})" tabindex="0">${WEEKDAY_LABELS[d]}</button>`
    )
    .join('');
}
// Converts an HH:MM time string into minutes after midnight.
function parseTime(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
// Pads a number to two digits for clock display.
function pad2(n) {
  return String(n).padStart(2, '0');
}
// Calculates the ISO week number used for odd/even week logic.
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - ys) / MS_PER_DAY + 1) / 7);
}
// Returns the current odd/even week label, respecting the reverse-week setting.
function getWeekType() {
  const now = new Date();
  const wn = getISOWeekNumber(now);
  const even = wn % 2 === 0;
  return state.applicationData.reverseWeek ? (even ? '單' : '雙') : even ? '雙' : '單';
}
// Creates the small odd/even week badge used in the schedule UI.
function getWeekLabelHtml(w) {
  const label = w === '單' ? t('week.odd') : t('week.even');
  return `<span class="week-label ${w === '單' ? 'label-odd' : 'label-even'}">${label}</span>`;
}
// Returns the next weekday tab after the given day.
function getNextSchoolDay(day) {
  for (let step = 1; step <= 7; step++) {
    const next = (day + step) % 7;
    if ((state.runtimeSchedule[next] || []).length > 0) return next;
  }
  if (day >= 1 && day <= 4) return day + 1;
  return 1;
}
// Chooses the correct subject and teacher for split odd/even-week classes.
function processSplitName(c, week) {
  if (!c.isSplit)
    return {
      n: c.n,
      t: c.t,
      label: ''
    };
  const nP = c.n.split('/'),
    tP = c.t.split('/');
  return {
    n: week === '單' ? nP[0].trim() : nP[1].trim(),
    t: week === '單' ? tP[0].trim() : (tP[1] || tP[0]).trim(),
    label: getWeekLabelHtml(week)
  };
}

// Deterministic per-subject color hue, shared by the teacher/subject editor's
// avatars and the dashboard's class cards so the same subject always reads
// as the same color in both places.
const SUBJECT_HUES = [6, 28, 48, 145, 168, 200, 225, 265, 290, 330];
function subjectHue(subject) {
  const text = String(subject || '').trim();
  if (!text) return SUBJECT_HUES[0];
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return SUBJECT_HUES[hash % SUBJECT_HUES.length];
}

export {
  buildSchedule,
  getISOWeekNumber,
  getNextSchoolDay,
  getWeekLabelHtml,
  getWeekType,
  pad2,
  parseTime,
  processSplitName,
  subjectHue
};
