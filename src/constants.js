// ---- src/constants.js ----
// Plain constants shared across modules. Kept in
// their own leaf module (imports nothing but strings.js, itself a leaf)
// rather than declared in either
// one, because data.js and appearance.js import *from each other*
// (data.js needs appearance.js's normalize* functions, appearance.js used
// to need these two constants from data.js) - a real circular import, and
// unlike function declarations (hoisted, safe either way), a `const` read
// at another module's own top level can hit "Cannot access before
// initialization" depending on which side of the cycle evaluates first.
// It did, reliably, under the browser's native module loader (though not
// under every bundler's reordering, which is how this got missed at
// first). Moving the constants to a module neither side needs anything
// else from removes the cycle entirely instead of just working around one
// symptom of it.
import { t } from './strings.js';
// A rich indigo-violet paired with a vivid rose-magenta, not the generic
// iOS-system blue this used to be (#0A84FF/#5856D6) - that read as a stock
// system color rather than something Orbit actually chose, especially once
// it's the *only* color a first-time user sees before ever opening the
// style tool's other presets.
const DEFAULT_STYLE_PRIMARY = '#6C5DD3';
const DEFAULT_STYLE_SECONDARY = '#E8497B';

// The weekday names, and the two day orders the app walks days in. Both
// used to be re-declared inline in every module that needed them (six
// copies of the label table, thirteen of the arrays), which is exactly the
// kind of thing that drifts one copy at a time. Keyed 0-6 to match
// Date.getDay(), so a lookup is `WEEKDAY_LABELS[day]` wherever a day number
// is already in hand. The values are `t()` lookups behind getters (rather
// than a plain object built once) so a locale switch is picked up on the
// next read without needing to reconstruct this table.
//
// WARNING for a future translator/locale author: these render inside
// several fixed-width, 7-across UI slots sized around zh-TW's 2-character
// originals (週三 etc.) - the nav bar's day tabs (.nav-item, src/schedule.js),
// the teacher-assignment day tabs (.assign-day-tab, src/editor-teachers.js),
// and the editor's day labels (.schedule-day-label, src/editor-schedule.js,
// src/gemini-ocr.js). .nav-item and .assign-day-tab now clip an over-long
// label with an ellipsis instead of visually bleeding into the next tab (a
// real bug this app shipped once - see css/styles.css's comment on
// .nav-item), so a too-long translation is a cosmetic issue, not a broken
// layout - but a short abbreviation (see locales/en.js's weekday.* keys)
// still looks far better than "Wed…". Take a real screenshot after
// translating these, don't just trust that ellipsis makes it safe to ignore.
const WEEKDAY_LABELS = Object.freeze({
  get 0() {
    return t('weekday.sunday');
  },
  get 1() {
    return t('weekday.monday');
  },
  get 2() {
    return t('weekday.tuesday');
  },
  get 3() {
    return t('weekday.wednesday');
  },
  get 4() {
    return t('weekday.thursday');
  },
  get 5() {
    return t('weekday.friday');
  },
  get 6() {
    return t('weekday.saturday');
  }
});

// Mon-first: the order days are *presented* in (nav bar, editor rows, day
// tabs) - Sunday reads as the end of the week here, not the start.
const WEEKDAYS_DISPLAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

// Sun-first: Date.getDay()'s own numbering, for storage and iteration where
// order is irrelevant but matching the stored key layout is not.
const WEEKDAYS_INDEX_ORDER = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

// Milliseconds in a day, for the date-difference arithmetic in dashboard.js
// and schedule.js that would otherwise spell 86400000 out by hand.
const MS_PER_DAY = 86400000;

// A non-null, non-array object - the shape every saved/imported settings
// field (teacherDB, locationDB, weeklySchedule...) is required to have.
// Shared by data.js's loadData and editor-backup.js's normalizeSettingsData,
// whose validation passes both repeat this same three-part check per field.
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export {
  DEFAULT_STYLE_PRIMARY,
  DEFAULT_STYLE_SECONDARY,
  WEEKDAY_LABELS,
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAYS_INDEX_ORDER,
  MS_PER_DAY,
  isPlainObject
};
