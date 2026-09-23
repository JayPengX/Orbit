// ---- src/strings.js ----
// A lookup table for UI strings, keyed by a dotted namespace.key (e.g.
// 'dashboard.notStarted'). Call `t('the.key')` where a literal used to be,
// optionally with a second argument for {placeholder}-style interpolation
// (e.g. `t('dashboard.periodCount', { count })` against a value of
// "{count} 節"). Every key must exist in src/locales/zh-TW.js - that's the
// fallback locale for anything missing from another one, and Orbit Class's
// original (and still primary) language, so it's treated as the source of
// truth.
//
// Each locale's actual strings live in their own file under src/locales/ -
// see zh-TW.js and en.js there. Adding a new language: copy en.js to
// src/locales/<code>.js, translate its values, then add one import and one
// STRINGS entry below, plus a branch in detectLocale() if it should be
// auto-detected.
import zhTW from './locales/zh-TW.js';
import en from './locales/en.js';

const STRINGS = { 'zh-TW': zhTW, en };

// ---- Locale detection, override, and persistence ----
//
// detectLocale() reads the browser's reported language(s) and maps anything
// starting 'zh' to 'zh-TW' and anything starting 'en' to 'en', defaulting to
// 'zh-TW' for everything else (matches the assumption test/helpers/setupEnv.js
// pins the test environment to, and Orbit Class's actual user base, which is
// Taiwanese schools).
function detectLocale() {
  const candidates = [];
  try {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  } catch {
    /* navigator unavailable (non-browser environment) - fall through to default. */
  }
  for (const raw of candidates) {
    const lang = String(raw || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh-TW';
    if (lang.startsWith('en')) return 'en';
  }
  return 'zh-TW';
}

// A manual override (from the appearance/language setting) is persisted
// under its own localStorage key, the same direct-localStorage-plus-
// try/catch pattern src/onboarding.js already uses for its own standalone
// flag (ONBOARDING_SEEN_KEY) - there's no existing generic "app settings"
// store this can hook into: data.js's saveData/loadData is specifically the
// validated schedule-data schema (teacherDB/weeklySchedule/bellTimes/...),
// and a UI locale preference doesn't belong inside that shape.
const LOCALE_OVERRIDE_KEY = 'orbitLocaleOverride';

function readStoredLocaleOverride() {
  try {
    const value = localStorage.getItem(LOCALE_OVERRIDE_KEY);
    return value === 'zh-TW' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

let currentLocale = readStoredLocaleOverride() || detectLocale();

/**
 * Returns the active locale ('zh-TW' or 'en').
 */
function getLocale() {
  return currentLocale;
}

/**
 * Sets the active locale and persists it as a manual override, so it
 * survives reloads instead of being re-detected from the browser every time.
 */
function setLocale(locale) {
  currentLocale = locale === 'en' ? 'en' : 'zh-TW';
  try {
    localStorage.setItem(LOCALE_OVERRIDE_KEY, currentLocale);
  } catch {
    /* localStorage unavailable (private browsing, etc.) - the in-memory
       value above still takes effect for the rest of this session. */
  }
}

/**
 * Looks up a UI string by key in the current locale, falling back to zh-TW
 * (and then the key itself) if a locale is ever missing one. `vars`, when
 * given, fills in {name}-style placeholders in the resolved string.
 */
function t(key, vars) {
  const raw = STRINGS[currentLocale]?.[key] ?? STRINGS['zh-TW'][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export { detectLocale, getLocale, setLocale, t };
