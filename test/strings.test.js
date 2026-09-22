import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, getLocale, setLocale, t } from '../src/strings.js';

describe('t()', () => {
  it('resolves a known key to its zh-TW string', () => {
    expect(t('dashboard.notStarted')).toBe('尚未開始');
  });

  it('falls back to the key itself for an unknown key, rather than throwing', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('fills in {placeholder}-style tokens from the vars object', () => {
    expect(t('dashboard.periodCount', { count: 3 })).toBe('3 節');
  });

  it('leaves an unmatched token alone rather than throwing when vars is missing a key', () => {
    expect(t('dashboard.periodCount', {})).toBe('{count} 節');
  });

  it('returns the raw string unchanged when vars is omitted, even for a key with tokens', () => {
    expect(t('dashboard.periodCount')).toBe('{count} 節');
  });
});

// setLocale persists an override (see readStoredLocaleOverride in
// strings.js), so every test that changes the active locale resets it back
// to zh-TW afterward - both so later tests in this file see the same
// default every other test in the suite assumes, and so nothing leaks a
// stored override into a later test file's fresh module registry via
// localStorage (test isolation covers module state, not browser storage).
afterEach(() => {
  setLocale('zh-TW');
  try {
    localStorage.removeItem('orbitLocaleOverride');
  } catch {
    /* localStorage unavailable - nothing to clean up. */
  }
});

describe('detectLocale()', () => {
  it("maps an English navigator.language to 'en'", () => {
    const originalLanguage = navigator.language;
    const originalLanguages = navigator.languages;
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
    try {
      expect(detectLocale()).toBe('en');
    } finally {
      Object.defineProperty(navigator, 'language', { value: originalLanguage, configurable: true });
      Object.defineProperty(navigator, 'languages', {
        value: originalLanguages,
        configurable: true
      });
    }
  });

  it("maps a Chinese navigator.language to 'zh-TW'", () => {
    // test/helpers/setupEnv.js already pins this to 'zh-TW' for every test,
    // so this doubles as a check that the pin itself round-trips correctly.
    expect(detectLocale()).toBe('zh-TW');
  });

  it("defaults to 'zh-TW' for an unrecognized language", () => {
    const originalLanguage = navigator.language;
    const originalLanguages = navigator.languages;
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
    Object.defineProperty(navigator, 'languages', { value: ['fr-FR'], configurable: true });
    try {
      expect(detectLocale()).toBe('zh-TW');
    } finally {
      Object.defineProperty(navigator, 'language', { value: originalLanguage, configurable: true });
      Object.defineProperty(navigator, 'languages', {
        value: originalLanguages,
        configurable: true
      });
    }
  });
});

describe('getLocale()/setLocale()', () => {
  it('defaults to zh-TW in this test environment', () => {
    expect(getLocale()).toBe('zh-TW');
  });

  it('switches the active locale and what t() resolves against', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('dashboard.notStarted')).toBe('Not started yet');
  });

  it('persists the override so it survives being re-read from storage', () => {
    setLocale('en');
    expect(localStorage.getItem('orbitLocaleOverride')).toBe('en');
  });

  it('falls back to zh-TW for an invalid value rather than storing garbage', () => {
    setLocale('fr');
    expect(getLocale()).toBe('zh-TW');
  });
});
