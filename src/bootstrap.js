// ---- src/bootstrap.js ----
// Boot sequence: load settings, build the schedule, start the per-second
// clock. Runs once every other module has finished defining its functions -
// see main.js for why import order matters here.
import { setStyleMode } from './appearance.js';
import { syncTestToolbar } from './dashboard.js';
import { mainClockTick, syncTestPlayPauseUi } from './dashboard-render.js';
import { loadData } from './data.js';
import { applyStaticTranslations } from './i18n-dom.js';
import { showOnboardingPrompt } from './onboarding.js';
import { buildSchedule } from './schedule.js';
import { state } from './state.js';
import { renderSyncPanel, startSyncLoop } from './sync.js';

// index.html's markup is static, so its own text/aria-label/title/
// placeholder content needs one DOM pass translated in from strings.js
// before anything else renders over it - see i18n-dom.js for the
// data-i18n* attribute contract this walks.
applyStaticTranslations();

// state.applicationData is set here, not in state.js's own initial value -
// see the comment on state.js for why.
// loadData() (data.js) is what actually guards against a corrupt/unexpected
// saved schedule - any failure there clears the stored key and returns a
// clean default schedule, so buildSchedule() below always has valid data to
// work with.
state.applicationData = loadData();
buildSchedule();
try {
  setStyleMode();
} catch {
  // Best-effort: a failure here (e.g. the DOM not being ready yet) shouldn't block boot.
}
setInterval(mainClockTick, 1000);
syncTestPlayPauseUi();
syncTestToolbar();
window.update();
renderSyncPanel();
startSyncLoop();
// Deferred rather than shown inline here: this runs before testsim-
// runtime.js's finishBoot() clears the loading spinner (see main.js's
// import order), so showing a modal this early would sit behind/under it.
// A plain setTimeout still fires well after that regardless of exactly
// where in the boot sequence it's scheduled from, since it can't run until
// the current synchronous script (the rest of this module-import chain)
// finishes - which is all "deferred" needs to mean here.
setTimeout(showOnboardingPrompt, 400);

// Caches the whole app shell so a return visit can load almost entirely
// from disk instead of the network - see public/sw.js for the actual
// caching strategy and why it can't go stale. import.meta.env.PROD (not a
// dev-mode check of our own) keeps this out of `vite dev`, where a service
// worker would just fight the dev server's own module reloading.
// updateViaCache:'none' stops the browser's own HTTP cache from ever
// serving a stale copy of sw.js itself when checking for an update.
if (import.meta.env?.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

// iOS Safari (standalone/home-screen mode especially) can carry a stale
// 100dvh/env(safe-area-inset-top) snapshot across a JS-driven reload
// (performForcedRefresh()'s location.replace() in testsim-runtime.js reproduces
// this every time) or across a tab restored from the background/app
// switcher (bfcache) - the page is then laid out against whatever viewport
// metrics WebKit had cached instead of the real ones. Two nudges, since
// each targets a different cached value: re-touching the viewport meta tag
// (removing and re-inserting it, not just rewriting its content - a
// content rewrite alone is a documented no-op here) is what's specifically
// known to force Safari to redo its safe-area-inset-* computation; the
// body height toggle forces a genuine layout pass so a stuck 100dvh/100lvh
// (see the standalone media query in styles.css) picks the current
// viewport back up too.
function nudgeSafeAreaRecalc() {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && viewport.parentNode) {
    const refreshed = viewport.cloneNode(true);
    viewport.replaceWith(refreshed);
  }
  document.body.style.height = '100.01dvh';
  requestAnimationFrame(() => {
    document.body.style.height = '';
  });
}
window.addEventListener('pageshow', nudgeSafeAreaRecalc);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') nudgeSafeAreaRecalc();
});

// Three decorative CSS animations in styles.css (.dashboard::before's
// glassDrift, .is-now .status-tag's pulse, .row.is-now's glow) run
// `infinite` with no stopping point of their own - fine for an ordinary
// browser tab, which the OS/browser throttles once backgrounded, but
// reported to leave an iPhone noticeably warm when this app is kept on the
// home screen: standalone-mode WebKit has not reliably applied that same
// throttling to a still-animating page the way it does an ordinary
// backgrounded Safari tab, so the compositor can keep repainting a hidden
// PWA indefinitely. Pausing them explicitly on visibilitychange (rather
// than trusting the platform to do it) is the actual fix - see styles.css's
// .orbit-motion-paused rules for where each is paused, and its own comment
// for why `animation-play-state:paused` rather than removing the animation
// outright (it resumes from the exact frame it left off on).
function setMotionPausedForVisibility() {
  document.body.classList.toggle('orbit-motion-paused', document.hidden);
}
setMotionPausedForVisibility();
document.addEventListener('visibilitychange', setMotionPausedForVisibility);
