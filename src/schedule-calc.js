// ---- src/schedule-calc.js ----
// Pure computation for the dashboard's "what's happening right now" state -
// no DOM access, no shared `state` reads/writes. Extracted out of
// dashboard.js's update() (which still owns the per-second orchestration
// and all the actual DOM writes) specifically so this part - the part with
// real branching logic worth getting right - can be unit tested and
// reasoned about without booting the whole app.
import { pad2, parseTime, processSplitName } from './schedule.js';
import { t } from './strings.js';

function formatCountdown(diffSeconds) {
  return `${Math.floor(diffSeconds / 60)}:${pad2(diffSeconds % 60)}`;
}

function decorateSpecialTimeName(name) {
  return name ? name.trim() : '';
}

// A named break/special time (e.g. 18:00 -> 05:00 lights-out) recurs every
// day regardless of whether that day has any classes, so its countdown and
// progress need computing the same way whether or not it's a school day.
function computeBreakView(activeBreak, secs) {
  const SECONDS_PER_DAY = 86400;
  const breakStart = parseTime(activeBreak.start) * 60;
  let breakEnd = parseTime(activeBreak.end) * 60;
  let curSecs = secs;
  if (breakEnd <= breakStart) {
    // Crosses midnight: push the end (and "now", if we're past midnight in
    // the early-morning tail) onto the same continuous timeline as the
    // start so the countdown/progress math below stays linear.
    breakEnd += SECONDS_PER_DAY;
    if (curSecs < breakStart) curSecs += SECONDS_PER_DAY;
  }
  return {
    statusText: decorateSpecialTimeName(activeBreak.name),
    timerValue: formatCountdown(breakEnd - curSecs),
    progressPercent: Math.min(100, ((curSecs - breakStart) / (breakEnd - breakStart)) * 100)
  };
}

/**
 * @param {object} input
 * @param {Date} input.now
 * @param {number} input.curDay - 0-6, Date.getDay() convention
 * @param {string} input.week - '單' or '雙', from getWeekType()
 * @param {Array} input.todaySchedule - runtimeSchedule[curDay]
 * @param {Array} input.breakTimes - applicationData.breakTimes
 * @returns a plain view-model object describing everything the dashboard
 *   needs to render for "now" - no DOM, no side effects, safe to call as
 *   often as needed (including every second, which is exactly how the
 *   real per-second tick uses it).
 */
export function computeDashboardViewModel({ now, curDay, week, todaySchedule, breakTimes }) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const secs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const today = todaySchedule || [];
  const lastClass = today[today.length - 1];
  const isSchoolDay = today.length > 0;
  const isDayFinished = isSchoolDay && !!lastClass && mins >= parseTime(lastClass.e);

  let curIdx = -1;
  let nxtIdx = -1;
  today.forEach((c, i) => {
    if (mins >= parseTime(c.s) && mins < parseTime(c.e)) curIdx = i;
    if (mins < parseTime(c.s) && nxtIdx === -1) nxtIdx = i;
  });
  const activeBreak =
    curIdx === -1
      ? (breakTimes || []).find(item => {
          if (!item.name || !item.start || !item.end) return false;
          const startMin = parseTime(item.start);
          const endMin = parseTime(item.end);
          // endMin <= startMin means the break crosses midnight (e.g. 18:00
          // -> 05:00): it's active from start through midnight, then again
          // from midnight through end, so either side of "now" counts.
          return endMin > startMin
            ? mins >= startMin && mins < endMin
            : mins >= startMin || mins < endMin;
        })
      : null;

  // statusText/nextText/nextMeta/dotState/timerVisible/progressVisible are
  // unconditionally set in every branch below (isSchoolDay true or false),
  // so they're declared without an initial value on purpose.
  let statusText;
  let nextText;
  let teacherText = '';
  let placeText = '';
  let nextMeta;
  let classLabel = '';
  let dotState; // 'none' | 'wait' | 'active'
  let timerVisible;
  let timerLabel = '';
  let timerValue = '';
  let progressVisible;
  let progressIsClass = false;
  let progressPercent = 0;
  let activeClassKey = '';
  let upcomingClassKey = '';

  if (isSchoolDay) {
    if (activeBreak) {
      const breakView = computeBreakView(activeBreak, secs);
      statusText = breakView.statusText;
      dotState = 'wait';
      timerVisible = true;
      timerLabel = t('dashboard.duringClass');
      timerValue = breakView.timerValue;
      progressVisible = true;
      progressIsClass = false;
      progressPercent = breakView.progressPercent;
      curIdx = -1;
      nxtIdx = today.findIndex(c => parseTime(c.s) >= parseTime(activeBreak.end));
    } else if (curIdx !== -1) {
      const info = processSplitName(today[curIdx], week);
      statusText = info.n;
      teacherText = info.t;
      classLabel = info.label || '';
      placeText = today[curIdx].loc || '';
      activeClassKey = today[curIdx].key || '';
      dotState = 'active';
      timerVisible = true;
      timerLabel = t('dashboard.betweenClasses');
      const endSec = parseTime(today[curIdx].e) * 60;
      const startSec = parseTime(today[curIdx].s) * 60;
      timerValue = formatCountdown(endSec - secs);
      progressVisible = true;
      progressIsClass = true;
      progressPercent = Math.min(100, ((secs - startSec) / (endSec - startSec)) * 100);
    } else {
      dotState = 'wait';
      const firstStart = parseTime('08:00');
      const lastEnd = lastClass ? parseTime(lastClass.e) : parseTime('16:45');
      if (mins < firstStart) {
        statusText = t('dashboard.notStarted');
        timerVisible = false;
        progressVisible = false;
      } else if (mins >= lastEnd) {
        statusText = t('dashboard.schoolOver');
        dotState = 'none';
        timerVisible = false;
        progressVisible = false;
      } else {
        timerVisible = true;
        timerLabel = t('dashboard.duringClass');
        statusText = t('dashboard.betweenClasses');
        if (nxtIdx !== -1) {
          const nextStart = parseTime(today[nxtIdx].s) * 60;
          timerValue = formatCountdown(nextStart - secs);
          const prevEnd =
            nxtIdx > 0 ? parseTime(today[nxtIdx - 1].e) * 60 : parseTime('08:00') * 60;
          progressVisible = true;
          progressIsClass = false;
          progressPercent = Math.min(100, ((secs - prevEnd) / (nextStart - prevEnd)) * 100);
        } else {
          progressVisible = false;
        }
      }
    }
    if (nxtIdx !== -1) {
      const info = processSplitName(today[nxtIdx], week);
      nextText = info.n;
      nextMeta = [today[nxtIdx].s, info.t, today[nxtIdx].loc].filter(Boolean).join(' · ');
      upcomingClassKey = today[nxtIdx].key || '';
    } else {
      nextText = curDay === 5 ? t('dashboard.seeYouWeekend') : t('dashboard.seeYouTomorrow');
      nextMeta = '';
    }
  } else if (activeBreak) {
    const breakView = computeBreakView(activeBreak, secs);
    statusText = breakView.statusText;
    dotState = 'wait';
    timerVisible = true;
    timerLabel = t('dashboard.duringClass');
    timerValue = breakView.timerValue;
    progressVisible = true;
    progressIsClass = false;
    progressPercent = breakView.progressPercent;
    nextText = t('dashboard.seeYouMonday');
    nextMeta = '';
  } else {
    statusText = t('dashboard.noSchoolToday');
    nextText = t('dashboard.seeYouMonday');
    dotState = 'none';
    timerVisible = false;
    progressVisible = false;
    nextMeta = '';
  }

  const compactStatus = !timerVisible;
  const metaRowVisible = !compactStatus && !!(teacherText || placeText || classLabel);

  return {
    curDay,
    curIdx,
    nxtIdx,
    isSchoolDay,
    isDayFinished,
    activeBreakName: activeBreak ? activeBreak.name : '',
    statusText,
    teacherText,
    placeText,
    classLabel,
    nextText,
    nextMeta,
    dotState,
    timerVisible,
    timerLabel,
    timerValue,
    progressVisible,
    progressIsClass,
    progressPercent,
    compactStatus,
    metaRowVisible,
    activeClassKey,
    upcomingClassKey
  };
}

export { pad2 };
