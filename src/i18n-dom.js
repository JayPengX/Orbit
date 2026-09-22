// ---- src/i18n-dom.js ----
// index.html's markup is static (rendered before any JS runs), so its
// Chinese text can't just be swapped for a t() call the way every other
// module's dynamically-built strings were. Instead, the markup carries
// data-i18n* attributes naming a strings.js key, and this module's one job
// is to walk the DOM once at boot and fill each one in from the active
// locale - the same lookup table and fallback behavior as every other
// string in the app, just applied to markup instead of to a render call.
//
// Four attributes, one per thing that might need translating on a given
// element:
//   data-i18n              - element.textContent
//   data-i18n-aria-label    - the aria-label attribute
//   data-i18n-title         - the title attribute
//   data-i18n-placeholder   - the placeholder attribute
//   data-i18n-alt           - the alt attribute
// An element can carry more than one (e.g. a button whose visible label and
// title differ) since each is applied independently.
import { getLocale, t } from './strings.js';

function applyStaticTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  root.querySelectorAll('[data-i18n-alt]').forEach(el => {
    el.setAttribute('alt', t(el.getAttribute('data-i18n-alt')));
  });
  // Keeps the lang attribute honest for screen readers and browser
  // features (spellcheck, translation offers, etc.) that key off it.
  document.documentElement.lang = getLocale();
}

export { applyStaticTranslations };
