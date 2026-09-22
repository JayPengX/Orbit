// Test-environment gaps, patched once for every test file (wired up as
// vite.config.js's `setupFiles`) rather than inside loadApp() - tests that
// exercise src/ modules directly, without booting the whole app, need the
// same globals.
//
// None of these are app bugs: every API below exists and behaves as used
// here in every real browser Orbit Class targets. They're missing from jsdom,
// or from the VM realm the fast pool runs test files in.
import { Blob as NodeBlob } from 'node:buffer';
import { CompressionStream, DecompressionStream } from 'node:stream/web';

// The v2 backup format's gzip encode/decode pipeline (editor-backup.js).
// A VM realm doesn't inherit these from the host the way the default pool's
// context does, so they're pulled in from node:stream/web by name.
globalThis.CompressionStream = CompressionStream;
globalThis.DecompressionStream = DecompressionStream;

// jsdom's own Blob has no .stream(), which that same pipeline reads from.
globalThis.Blob = NodeBlob;

// jsdom doesn't implement the scroll methods at all; the dashboard's
// auto-scroll-to-current-class code calls them from a requestAnimationFrame
// callback.
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollBy = () => {};

// jsdom's own navigator.language/languages default to "en-US" (not an app
// bug - that's just jsdom's own fallback, not a real browser reporting a
// real device's setting), which would make src/strings.js's locale
// auto-detection pick 'en' for every test and break every existing test
// that asserts exact zh-TW copy. Orbit Class's actual user base is
// Taiwanese schools, so pinning the test environment to zh-TW here matches
// the locale almost every real session actually boots into, and keeps
// language-detection itself testable in isolation (see strings.test.js)
// without every unrelated test having to know detection even exists.
Object.defineProperty(window.navigator, 'language', { value: 'zh-TW', configurable: true });
Object.defineProperty(window.navigator, 'languages', {
  value: ['zh-TW'],
  configurable: true
});
