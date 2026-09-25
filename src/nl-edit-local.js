// ---- src/nl-edit-local.js ----
// Handles the most common natural-language schedule edits entirely in the
// browser, with no AI request at all: swapping two periods, moving a class
// to an empty period, clearing periods, and setting periods to a class that
// already exists. Everything costs API quota on the /nl-edit path (see
// src/editor-nl-edit.js), and these few shapes cover most everyday edits.
//
// Deliberately strict: the WHOLE instruction must be accounted for by one
// of the templates below (after dropping filler words like 把/的/幫我), and
// every day/period/class it names must exist - anything else returns null
// and falls through to the AI exactly as before. A miss here only costs the
// usual AI request; a wrong guess would still be caught by the confirm
// diff every edit goes through, but the point is to never guess at all.
//
// Returns the same sparse-patch shape the AI returns (see
// NL_EDIT_RESPONSE_SCHEMA in the shared-proxy repo's worker.js), so the
// result goes through the exact same applyNlEditResult/confirm path.

const CHINESE_DIGITS = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const DAY_NUMBERS = { 日: 0, 天: 0, 7: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const NUMERAL = '[一二兩三四五六七八九十0-9]';

const DAY_PATTERN = /(?:星期|禮拜|礼拜|週|周)([日天一二三四五六1-7])/y;
const PERIOD_PATTERN = new RegExp(
  `第?(${NUMERAL}+(?:(?:[、,和與跟及]|到|至|~|-)第?${NUMERAL}+)*)[節节堂]`,
  'y'
);

// Filler that carries no meaning for these templates. Only ever stripped
// from the part of the text around day/period references and verbs - never
// from a class name (see parseSetTarget).
const FILLER = /請|幫我|幫忙|麻煩|把|將|我的|我|的|課|一下|和|跟|與|及|、|,|。|!|\?|~|\s/g;

const SWAP_VERBS = /^(?:對調|交換|互換|調換|互調)$/;
const CLEAR_BEFORE = /^(?:清空|清掉|刪除|刪掉|删除|拿掉|取消|移除)$/;
const CLEAR_AFTER =
  /^(?:清空|清掉|刪除|刪掉|删除|拿掉|取消|移除|改成空堂|改為空堂|變成空堂|設為空堂|空堂)$/;
const MOVE_VERBS = /^(?:移到|搬到|挪到|換到|改到|移去|搬去|調到)$/;
const SET_VERBS = ['改成', '換成', '改為', '換為', '變成', '設為', '設成', '改上', '排'];
const EMPTY_TARGETS = new Set(['空堂', '空', '空白', '沒課', '無課', '沒有課']);

// "十" = 10, "十二" = 12, "二十" = 20; plain digits as written.
function parseNumber(raw) {
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  const match = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw);
  if (match)
    return (
      (match[1] ? CHINESE_DIGITS[match[1]] : 1) * 10 + (match[2] ? CHINESE_DIGITS[match[2]] : 0)
    );
  if (raw.length === 1 && CHINESE_DIGITS[raw]) return CHINESE_DIGITS[raw];
  return null;
}

// One run of numerals between separators. A run of single Chinese digits
// with no 十 ("二三") is several periods; anything else is one number.
function parseNumeralRun(raw) {
  if (/^[一二兩三四五六七八九]{2,}$/.test(raw)) return [...raw].map(char => CHINESE_DIGITS[char]);
  const value = parseNumber(raw);
  return value === null ? null : [value];
}

// "二三" / "2、3" / "二到四" / "第二、第三" -> 1-based period numbers.
function parsePeriodGroup(group) {
  const periods = [];
  const parts = group.replace(/第/g, '').split(/(到|至|~|-)|[、,和與跟及]/);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined || part === '') continue;
    if (/^(?:到|至|~|-)$/.test(part)) {
      const from = periods.pop();
      const next = parseNumber(parts[index + 1] || '');
      if (from === undefined || next === null || next < from) return null;
      for (let value = from; value <= next; value++) periods.push(value);
      index++;
      continue;
    }
    const values = parseNumeralRun(part);
    if (!values) return null;
    periods.push(...values);
  }
  return periods.length ? periods : null;
}

// Replaces each "day + periods" reference with "@" and collects the cells
// it names, in order. Periods named before any day, or a day with no
// periods after it, make the whole instruction unrecognizable here.
function extractCells(text) {
  const cells = [];
  let skeleton = '';
  let day = null;
  let dayHasPeriods = true;
  let index = 0;
  while (index < text.length) {
    DAY_PATTERN.lastIndex = index;
    const dayMatch = DAY_PATTERN.exec(text);
    if (dayMatch) {
      if (!dayHasPeriods) return null;
      day = DAY_NUMBERS[dayMatch[1]];
      dayHasPeriods = false;
      index = DAY_PATTERN.lastIndex;
      continue;
    }
    PERIOD_PATTERN.lastIndex = index;
    const periodMatch = PERIOD_PATTERN.exec(text);
    if (periodMatch) {
      if (day === null) return null;
      const periods = parsePeriodGroup(periodMatch[1]);
      if (!periods) return null;
      periods.forEach(period => cells.push({ day, period: period - 1 }));
      dayHasPeriods = true;
      skeleton += '@';
      index = PERIOD_PATTERN.lastIndex;
      continue;
    }
    skeleton += text[index];
    index++;
  }
  if (!dayHasPeriods) return null;
  return { cells, skeleton };
}

function cellKey(current, { day, period }) {
  return current.weeklySchedule?.[day]?.[period] || '';
}

function cellExists(current, { day, period }) {
  return (
    Array.isArray(current.weeklySchedule?.[day]) &&
    Number.isInteger(period) &&
    period >= 0 &&
    period < (current.bellTimes || []).length
  );
}

// The one existing class a "改成 X" target names, by exact subject (or
// "X課"), or the empty string for 空堂. null when it matches no class or
// several (e.g. two 數學 classes with different teachers) - the AI decides
// those, since it may need to create a class or ask which one.
function parseSetTarget(current, rawTarget) {
  const target = rawTarget.replace(/[。!?~\s]+$/g, '');
  if (EMPTY_TARGETS.has(target)) return '';
  const candidates = [target, target.replace(/(?:的課|課)$/, '')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const keys = Object.entries(current.teacherDB || {})
      .filter(([, value]) => String(value?.[0] || '') === candidate)
      .map(([key]) => key);
    if (keys.length === 1) return keys[0];
    if (keys.length > 1) return null;
  }
  return null;
}

function okPatch(scheduleEdits) {
  return {
    status: 'ok',
    reason: '',
    classUpserts: [],
    deletedClassKeys: [],
    scheduleEdits,
    bellTimesChanged: false,
    bellTimes: [],
    breakTimesChanged: false,
    breakTimes: [],
    countdownEventsChanged: false,
    countdownEvents: [],
    reverseWeekChanged: false,
    reverseWeek: false
  };
}

// `text` is the already-normalized instruction (see normalizeNlEditText);
// `current` is settingsDataForExport()'s view of the data.
function parseLocalNlEdit(text, current) {
  const extracted = extractCells(String(text || ''));
  if (!extracted || !extracted.cells.length) return null;
  const { cells, skeleton } = extracted;
  if (!cells.every(cell => cellExists(current, cell))) return null;

  // Set: "<cells> 改成 <class>" - the class name is taken from the raw
  // skeleton, never filler-stripped, so a subject like "課外活動" survives.
  for (const verb of SET_VERBS) {
    const verbIndex = skeleton.indexOf(verb);
    if (verbIndex === -1) continue;
    const before = skeleton.slice(0, verbIndex).replace(FILLER, '');
    if (!/^@+$/.test(before)) break;
    const key = parseSetTarget(current, skeleton.slice(verbIndex + verb.length).trim());
    if (key === null) return null;
    return okPatch(cells.map(cell => ({ ...cell, key })));
  }

  const reduced = skeleton.replace(FILLER, '');
  const leading = /^(@+)(.*)$/.exec(reduced);
  const trailing = /^(.*?)(@+)$/.exec(reduced);

  if (leading && SWAP_VERBS.test(leading[2]) && cells.length === 2) {
    const [first, second] = cells;
    return okPatch([
      { ...first, key: cellKey(current, second) },
      { ...second, key: cellKey(current, first) }
    ]);
  }

  if ((leading && CLEAR_AFTER.test(leading[2])) || (trailing && CLEAR_BEFORE.test(trailing[1]))) {
    return okPatch(cells.map(cell => ({ ...cell, key: '' })));
  }

  const move = /^@(.+)@$/.exec(reduced);
  if (move && MOVE_VERBS.test(move[1]) && cells.length === 2) {
    const [from, to] = cells;
    const key = cellKey(current, from);
    // Moving onto an occupied period could mean overwrite or swap - let
    // the AI (or the user, rephrasing) decide rather than guessing.
    if (!key || cellKey(current, to)) return null;
    return okPatch([
      { ...from, key: '' },
      { ...to, key }
    ]);
  }

  return null;
}

export { parseLocalNlEdit };
