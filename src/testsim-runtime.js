// ---- src/testsim-runtime.js ----
// Time-simulation state machine (Test Mode): the manual/auto-advancing
// simulated clock, its persistence, and the runtime patches it applies to
// dashboard.js's update()/openTestPanel/toggleTestPanel - see the
// window.update() comment in the README for why those are patched rather
// than replaced.
import { state } from './state.js';
import { closeTestPanel, syncTestToolbar } from './dashboard.js';
import { syncTestPlayPauseUi } from './dashboard-render.js';
import { parseTime } from './schedule.js';

// Everything below is module-private already - this file used to wrap it all
// in an IIFE, which a module doesn't need: nothing here is exported, so
// module scope is exactly the privacy the wrapper was providing.
const END_OF_DAY_MINUTES = 24 * 60;
const END_OF_DAY_SECONDS = 24 * 3600;
const START_LEAD_SECONDS = 5;
const DAY_START_SECONDS = 8 * 3600;
let lastSimSecond = Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : null;
let endOfDayArmed = false;
let pausedAtManualRollover = false;
let savedPausedSecond = null;
let savedPausedDay = null;
let sliderEndpointLock = false;
let lastTestingState = !!(window.MANUALLY_TEST || window.IS_SIMULATING);
let updatePatched = false;
let panelPatched = false;
let defaultsInitialized = false;
const TEST_STATE_STORAGE_KEY = 'orbitTestState';

// Discovered from the DOM rather than hardcoded, since the build now
// bundles src/*.js into a single content-hashed asset (its filename
// changes on every deploy) - reading the actual <script>/<link> the page
// loaded is the only way to name "the app's own assets" that stays
// correct in both `vite dev` (unbundled) and the built site.
function getVersionedAssetUrls() {
  const urls = [];
  const script = document.querySelector('script[type="module"][src]');
  if (script) urls.push(script.src);
  const stylesheet = document.querySelector('link[rel="stylesheet"][href]');
  if (stylesheet) urls.push(stylesheet.href);
  return urls;
}
function el(id) {
  return document.getElementById(id);
}
// Date plus hash, not just a content hash: the date is what makes a
// glance enough to tell whether this load is on today's deploy, while the
// hash is what still tells two same-day pushes apart (a plain date
// repeats across every push made that day). Both are injected by
// vite.config.js from the checked-out commit, so this - along with
// index.html's ?v= query strings and public/sw.js's cache name, both
// derived from the same commit's hash - always matches what's actually
// deployed without anyone having to remember to bump anything by hand.
// typeof, not a direct reference: Vite text-replaces this literal token at
// build time, so it's simply an undeclared identifier if these unbuilt
// source files ever get served directly - a bare reference would throw a
// ReferenceError and abort the whole boot chain before the spinner clears
// (see the matching import.meta.env guards in sync.js/gemini-ocr.js).
const APP_VERSION_DATE = typeof __APP_VERSION_DATE__ !== 'undefined' ? __APP_VERSION_DATE__ : '?';
const APP_VERSION_HASH = typeof __APP_VERSION_HASH__ !== 'undefined' ? __APP_VERSION_HASH__ : '?';
function syncAppVersion() {
  const version = el('app-version');
  if (version) version.textContent = '版本 ' + APP_VERSION_DATE + ' · ' + APP_VERSION_HASH;
}
function clampInt(value, min, max, fallback) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}
function normalizeDay(day) {
  let n = parseInt(day, 10);
  if (!Number.isFinite(n)) n = new Date().getDay();
  return ((n % 7) + 7) % 7;
}
function normalizeSeconds(seconds) {
  let n = Math.round(Number(seconds));
  if (!Number.isFinite(n)) n = DAY_START_SECONDS;
  return ((n % END_OF_DAY_SECONDS) + END_OF_DAY_SECONDS) % END_OF_DAY_SECONDS;
}
function selectedDay() {
  return normalizeDay(el('test-day-input') && el('test-day-input').value);
}
function resetRenderState() {
  if (typeof state.viewDay !== 'undefined') state.viewDay = window.TEST_DAY;
  if (typeof state.autoAdvancedAfterFinishedDay !== 'undefined')
    state.autoAdvancedAfterFinishedDay = null;
  if (typeof state.lastListKey !== 'undefined') state.lastListKey = '';
  if (typeof state.lastAutoScrollKey !== 'undefined') state.lastAutoScrollKey = '';
}
function writeDay(day) {
  window.TEST_DAY = normalizeDay(day);
  const dayInput = el('test-day-input');
  if (dayInput) dayInput.value = String(window.TEST_DAY);
  resetRenderState();
}
function persistTestState() {
  try {
    if (!window.MANUALLY_TEST) {
      localStorage.removeItem(TEST_STATE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      TEST_STATE_STORAGE_KEY,
      JSON.stringify({
        day: normalizeDay(window.TEST_DAY),
        seconds: Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : DAY_START_SECONDS,
        simulating: !!window.IS_SIMULATING,
        endOfDayArmed: !!endOfDayArmed,
        pausedAtManualRollover: !!pausedAtManualRollover,
        savedPausedSecond: Number.isFinite(savedPausedSecond) ? savedPausedSecond : null,
        savedPausedDay: Number.isFinite(savedPausedDay) ? savedPausedDay : null
      })
    );
  } catch (error) {
    console.warn('Unable to persist test mode state.', error);
  }
}
function restoreTestState() {
  try {
    const raw = localStorage.getItem(TEST_STATE_STORAGE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (
      !state ||
      typeof state !== 'object' ||
      typeof state.day !== 'number' ||
      typeof state.seconds !== 'number'
    ) {
      localStorage.removeItem(TEST_STATE_STORAGE_KEY);
      return false;
    }
    window.MANUALLY_TEST = true;
    window.TEST_DAY = normalizeDay(state.day);
    window.TEST_TIME_SEC = Math.max(0, Math.min(END_OF_DAY_SECONDS, Math.round(state.seconds)));
    window.IS_SIMULATING = state.simulating === true;
    endOfDayArmed = state.endOfDayArmed === true;
    pausedAtManualRollover = state.pausedAtManualRollover === true;
    savedPausedSecond = Number.isFinite(state.savedPausedSecond) ? state.savedPausedSecond : null;
    savedPausedDay = Number.isFinite(state.savedPausedDay)
      ? normalizeDay(state.savedPausedDay)
      : null;
    writeDay(window.TEST_DAY);
    return true;
  } catch (error) {
    console.warn('Unable to restore test mode state.', error);
    localStorage.removeItem(TEST_STATE_STORAGE_KEY);
    return false;
  }
}
function unlockTestControls() {
  const slider = el('test-time-slider');
  const hour = el('in-h');
  const minute = el('in-m');
  if (slider) {
    slider.min = '0';
    slider.max = String(END_OF_DAY_MINUTES);
    slider.step = '1';
  }
  if (hour) {
    hour.min = '0';
    hour.max = '24';
  }
  if (minute) {
    minute.min = '0';
    minute.max = '59';
  }
}
function setStartOfDayInputs() {
  endOfDayArmed = false;
  const h = el('in-h');
  const m = el('in-m');
  const slider = el('test-time-slider');
  if (h) h.value = '0';
  if (m) m.value = '0';
  if (slider) slider.value = '0';
}
function setEndOfDayInputs() {
  endOfDayArmed = true;
  pausedAtManualRollover = false;
  const h = el('in-h');
  const m = el('in-m');
  const slider = el('test-time-slider');
  if (h) h.value = '24';
  if (m) m.value = '0';
  if (slider) slider.value = String(END_OF_DAY_MINUTES);
}
function forceStartOfDayInputs() {
  setStartOfDayInputs();
  requestAnimationFrame(function () {
    setStartOfDayInputs();
    setTimeout(setStartOfDayInputs, 0);
    setTimeout(setStartOfDayInputs, 50);
  });
}
function clearSavedPausedTime() {
  savedPausedSecond = null;
  savedPausedDay = null;
}
function clearSliderEndpointLock() {
  sliderEndpointLock = false;
}
function getTypedTargetSeconds() {
  let h = parseInt((el('in-h') || {}).value, 10);
  let m = parseInt((el('in-m') || {}).value, 10);
  if (!Number.isFinite(h)) h = 8;
  if (!Number.isFinite(m)) m = 0;
  if (h >= 24) return END_OF_DAY_SECONDS;
  return Math.max(0, Math.min(23, h)) * 3600 + Math.max(0, Math.min(59, m)) * 60;
}
function selectedTargetSeconds() {
  if (
    pausedAtManualRollover &&
    !window.IS_SIMULATING &&
    Number.isFinite(window.TEST_TIME_SEC) &&
    window.TEST_TIME_SEC < START_LEAD_SECONDS
  )
    return window.TEST_TIME_SEC;
  const slider = el('test-time-slider');
  if (endOfDayArmed || (slider && parseInt(slider.value, 10) >= END_OF_DAY_MINUTES))
    return END_OF_DAY_SECONDS;
  return getTypedTargetSeconds();
}
function setSimSeconds(seconds, opts) {
  opts = opts || {};
  unlockTestControls();
  window.TEST_TIME_SEC = normalizeSeconds(seconds);
  if (opts.writeInputs !== false) window.updateInputDisplay();
  if (opts.writeSlider !== false) {
    const slider = el('test-time-slider');
    if (slider) slider.value = String(Math.floor(window.TEST_TIME_SEC / 60));
  }
}
function syncTestChrome() {
  syncTestPlayPauseUi();
  enableExitButton();
  syncTestToolbar();
  syncTestingBody();
}
function refreshTestUi() {
  syncTestChrome();
  window.update();
  lastSimSecond = Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : null;
}
function pauseForEditing() {
  if (window.MANUALLY_TEST || window.IS_SIMULATING) {
    window.MANUALLY_TEST = true;
    window.IS_SIMULATING = false;
    syncTestChrome();
  }
}
function setDefaultsToCurrentTime(force) {
  const now = new Date();
  const dayInput = el('test-day-input');
  const hourInput = el('in-h');
  const minInput = el('in-m');
  const slider = el('test-time-slider');
  if (!dayInput || !hourInput || !minInput || !slider) return;
  unlockTestControls();
  if (force || !window.MANUALLY_TEST) {
    window.TEST_DAY = now.getDay();
    window.TEST_TIME_SEC = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    dayInput.value = String(window.TEST_DAY);
    hourInput.value = now.getHours();
    minInput.value = now.getMinutes();
    slider.value = String(now.getHours() * 60 + now.getMinutes());
  }
}
function mergeNextClassWithTimer() {
  const timeCard = document.querySelector('.dashboard .time-card');
  const nextBox = document.querySelector('.dashboard > .next-box');
  if (!timeCard || !nextBox || timeCard.contains(nextBox)) return;
  timeCard.classList.add('v3-11-next-module');
  timeCard.appendChild(nextBox);
}
function patchPanelOpeners() {
  if (panelPatched) return;
  ['toggleTestPanel', 'openTestPanel'].forEach(function (name) {
    const original = window[name];
    window[name] = function () {
      if (!window.MANUALLY_TEST) setDefaultsToCurrentTime(true);
      const result = original.apply(this, arguments);
      setDefaultsToCurrentTime(false);
      return result;
    };
  });
  panelPatched = true;
}
function syncCrossDayBeforeRender() {
  if (!window.MANUALLY_TEST || !window.IS_SIMULATING || !Number.isFinite(window.TEST_TIME_SEC)) {
    lastSimSecond = Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : null;
    return;
  }
  let currentSecond = window.TEST_TIME_SEC;
  if (
    lastSimSecond !== null &&
    lastSimSecond >= END_OF_DAY_SECONDS - START_LEAD_SECONDS &&
    currentSecond < START_LEAD_SECONDS
  ) {
    writeDay(normalizeDay(window.TEST_DAY) + 1);
    endOfDayArmed = false;
    setStartOfDayInputs();
    syncTestChrome();
    currentSecond = 0;
  }
  lastSimSecond = currentSecond;
}
function getTestAwareNow() {
  const now = new Date();
  if (window.MANUALLY_TEST && Number.isFinite(window.TEST_TIME_SEC)) {
    now.setHours(Math.floor(window.TEST_TIME_SEC / 3600));
    now.setMinutes(Math.floor((window.TEST_TIME_SEC % 3600) / 60));
    now.setSeconds(Math.floor(window.TEST_TIME_SEC % 60));
    now.setMilliseconds(0);
  }
  return now;
}
function applyDashboardState() {
  const dashboard = document.querySelector('.dashboard');
  if (!dashboard || typeof state.runtimeSchedule === 'undefined') return;
  const now = getTestAwareNow();
  const curDay = window.MANUALLY_TEST ? normalizeDay(window.TEST_DAY) : now.getDay();
  const today = state.runtimeSchedule[curDay] || [];
  const firstClass = today[0];
  const lastClass = today[today.length - 1];
  const mins = now.getHours() * 60 + now.getMinutes();
  const hasParser = typeof parseTime === 'function';
  const finishedSchoolDay = !!(hasParser && lastClass && mins >= parseTime(lastClass.e));
  const outsideClassRange = !!(
    hasParser &&
    firstClass &&
    lastClass &&
    (mins < parseTime(firstClass.s) || mins >= parseTime(lastClass.e))
  );
  // True once nothing on today's schedule still starts after now, even mid-way through the
  // last class or its trailing break — not just once the whole day is over. Without this, the
  // dashboard kept showing an empty "next class" panel throughout the entire last period.
  const hasUpcomingClass = today.some(function (c) {
    return hasParser && parseTime(c.s) > mins;
  });
  const noUpcomingClass = !!(
    today.length &&
    !hasUpcomingClass &&
    !finishedSchoolDay &&
    !outsideClassRange
  );
  dashboard.classList.toggle('v3-15-day-finished', finishedSchoolDay);
  dashboard.classList.toggle('v3-16-outside-class-range', outsideClassRange);
  dashboard.classList.toggle('orbit-no-school-day', !today.length);
  dashboard.classList.toggle('orbit-no-upcoming-class', noUpcomingClass);
}
function syncTestingBody() {
  if (document.body)
    document.body.classList.toggle('testing', !!(window.MANUALLY_TEST || window.IS_SIMULATING));
}
function finishBoot() {
  if (document.body) document.body.classList.remove('orbit-booting');
}
function suppressListAnimationForThisFrame() {
  if (!document.body) return;
  document.body.classList.add('orbit-suppress-list-animation');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      if (document.body) document.body.classList.remove('orbit-suppress-list-animation');
    });
  });
}
function patchUpdate() {
  if (updatePatched || typeof window.update !== 'function') return;
  const originalUpdate = window.update;
  window.update = function () {
    const wasTesting = lastTestingState;
    const isTesting = !!(window.MANUALLY_TEST || window.IS_SIMULATING);
    if (wasTesting && !isTesting) suppressListAnimationForThisFrame();
    syncCrossDayBeforeRender();
    const result = originalUpdate.apply(this, arguments);
    if (
      endOfDayArmed &&
      window.MANUALLY_TEST &&
      window.IS_SIMULATING &&
      Number.isFinite(window.TEST_TIME_SEC) &&
      window.TEST_TIME_SEC >= END_OF_DAY_SECONDS - START_LEAD_SECONDS
    ) {
      setEndOfDayInputs();
    }
    if (
      pausedAtManualRollover &&
      window.MANUALLY_TEST &&
      !window.IS_SIMULATING &&
      Number.isFinite(window.TEST_TIME_SEC) &&
      window.TEST_TIME_SEC < START_LEAD_SECONDS
    ) {
      forceStartOfDayInputs();
    }
    if (window.MANUALLY_TEST && window.IS_SIMULATING && !endOfDayArmed) window.updateInputDisplay();
    applyDashboardState();
    syncTestingBody();
    lastTestingState = !!(window.MANUALLY_TEST || window.IS_SIMULATING);
    persistTestState();
    finishBoot();
    return result;
  };
  updatePatched = true;
}
function enableExitButton() {
  const exit = el('test-exit-btn');
  if (!exit) return;
  exit.disabled = false;
  exit.removeAttribute('disabled');
  exit.style.opacity = '1';
}
window.updateInputDisplay = function () {
  unlockTestControls();
  const hEl = el('in-h');
  const mEl = el('in-m');
  const active = document.activeElement;
  if (active === hEl || active === mEl) return;
  let seconds = Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : DAY_START_SECONDS;
  if (seconds >= END_OF_DAY_SECONDS) {
    if (hEl) hEl.value = '24';
    if (mEl) mEl.value = '0';
    return;
  }
  seconds = normalizeSeconds(seconds);
  if (hEl) hEl.value = String(Math.floor(seconds / 3600));
  if (mEl) mEl.value = String(Math.floor((seconds % 3600) / 60));
};

window.syncTestFromSlider = function () {
  unlockTestControls();
  const slider = el('test-time-slider');
  const sliderMinute = slider ? parseInt(slider.value, 10) : 0;
  if (sliderEndpointLock) {
    if (sliderMinute < END_OF_DAY_MINUTES - 1) {
      sliderEndpointLock = false;
    } else {
      forceStartOfDayInputs();
      return;
    }
  }
  if (slider && sliderMinute >= END_OF_DAY_MINUTES - 1) {
    clearSavedPausedTime();
    const wasRunning = !!(window.MANUALLY_TEST && window.IS_SIMULATING);
    window.TEST_DAY = selectedDay();
    if (wasRunning) {
      sliderEndpointLock = true;
      writeDay(window.TEST_DAY + 1);
      window.MANUALLY_TEST = true;
      window.IS_SIMULATING = false;
      window.TEST_TIME_SEC = 0;
      forceStartOfDayInputs();
      pausedAtManualRollover = true;
    } else {
      window.TEST_TIME_SEC = END_OF_DAY_SECONDS;
      setEndOfDayInputs();
    }
    refreshTestUi();
    if (wasRunning) forceStartOfDayInputs();
    return;
  }
  clearSavedPausedTime();
  sliderEndpointLock = false;
  endOfDayArmed = false;
  pausedAtManualRollover = false;
  pauseForEditing();
  window.TEST_DAY = selectedDay();
  setSimSeconds(clampInt(slider && slider.value, 0, END_OF_DAY_MINUTES - 1, 8 * 60) * 60, {
    writeInputs: true,
    writeSlider: false
  });
  refreshTestUi();
};

window.syncTestFromInputs = function () {
  unlockTestControls();
  const h = parseInt((el('in-h') || {}).value, 10);
  if (Number.isFinite(h) && h >= 24) {
    clearSavedPausedTime();
    window.TEST_DAY = selectedDay();
    window.TEST_TIME_SEC = END_OF_DAY_SECONDS;
    setEndOfDayInputs();
    refreshTestUi();
    return;
  }
  clearSavedPausedTime();
  endOfDayArmed = false;
  pausedAtManualRollover = false;
  pauseForEditing();
  window.TEST_DAY = selectedDay();
  setSimSeconds(getTypedTargetSeconds(), { writeInputs: false, writeSlider: true });
  refreshTestUi();
};

window.syncTestDayChange = function () {
  clearSavedPausedTime();
  endOfDayArmed = false;
  pausedAtManualRollover = false;
  pauseForEditing();
  writeDay(selectedDay());
  setSimSeconds(DAY_START_SECONDS, { writeInputs: true, writeSlider: true });
  refreshTestUi();
};

function startManualEndpointRun(day) {
  writeDay(day);
  window.MANUALLY_TEST = true;
  window.IS_SIMULATING = true;
  window.TEST_TIME_SEC = END_OF_DAY_SECONDS - START_LEAD_SECONDS;
  endOfDayArmed = true;
  pausedAtManualRollover = false;
  setEndOfDayInputs();
  refreshTestUi();
}

window.toggleTestPlayPause = function (event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }
  unlockTestControls();
  const wasRunning = !!(window.MANUALLY_TEST && window.IS_SIMULATING);
  const day = selectedDay();
  const targetSeconds = selectedTargetSeconds();

  if (!wasRunning && savedPausedSecond !== null) {
    writeDay(savedPausedDay);
    window.MANUALLY_TEST = true;
    window.IS_SIMULATING = true;
    window.TEST_TIME_SEC = savedPausedSecond;
    clearSavedPausedTime();
    endOfDayArmed = false;
    refreshTestUi();
    return false;
  }
  if (!wasRunning && pausedAtManualRollover && targetSeconds < START_LEAD_SECONDS) {
    window.MANUALLY_TEST = true;
    window.IS_SIMULATING = true;
    window.TEST_TIME_SEC = 0;
    setStartOfDayInputs();
    pausedAtManualRollover = false;
    refreshTestUi();
    return false;
  }
  if (!wasRunning && targetSeconds < START_LEAD_SECONDS) {
    writeDay(day);
    window.MANUALLY_TEST = true;
    window.IS_SIMULATING = true;
    window.TEST_TIME_SEC = targetSeconds;
    setStartOfDayInputs();
    pausedAtManualRollover = false;
    refreshTestUi();
    return false;
  }
  if (!wasRunning && targetSeconds >= END_OF_DAY_SECONDS) {
    startManualEndpointRun(day);
    return false;
  }
  if (!wasRunning) {
    writeDay(day);
    window.MANUALLY_TEST = true;
    window.IS_SIMULATING = true;
    setSimSeconds(targetSeconds - START_LEAD_SECONDS, { writeInputs: false, writeSlider: true });
  } else {
    window.IS_SIMULATING = false;
    savedPausedSecond = Number.isFinite(window.TEST_TIME_SEC) ? window.TEST_TIME_SEC : null;
    savedPausedDay = normalizeDay(window.TEST_DAY);
  }
  if (!(window.MANUALLY_TEST && window.IS_SIMULATING)) endOfDayArmed = false;
  refreshTestUi();
  return false;
};

window.exitTestMode = function () {
  window.MANUALLY_TEST = false;
  window.IS_SIMULATING = false;
  endOfDayArmed = false;
  pausedAtManualRollover = false;
  clearSavedPausedTime();
  try {
    localStorage.removeItem(TEST_STATE_STORAGE_KEY);
  } catch (error) {
    console.warn('Unable to clear test mode state.', error);
  }
  const status = el('sim-status');
  if (status) status.innerText = '';
  const indicator = el('sim-indicator');
  if (indicator) indicator.style.display = 'none';
  enableExitButton();
  syncTestPlayPauseUi();
  syncTestingBody();
  syncTestToolbar();
  if (typeof closeTestPanel === 'function') closeTestPanel();
  window.update();
};
// Compares the module script this page actually has loaded against the one
// a fresh copy of index.html would load right now, using the same
// cache-defeating fetch as the reload logic below. Vite fingerprints that
// filename from the built bundle's content (see vite.config.js), so any
// real deploy changes it; comparing the raw `src` attribute (not the
// resolved `.src` property) keeps both sides as plain relative strings from
// the same base, so no URL-resolution mismatch can produce a false positive.
function fetchesNewerScript(currentSrc) {
  return fetch(`index.html?check=${Date.now()}`, { cache: 'no-store' })
    .then(res => res.text())
    .then(html => {
      const match = html.match(/<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/i);
      const remoteSrc = match ? match[1] : null;
      return !remoteSrc || remoteSrc !== currentSrc;
    });
}

window.checkForAppUpdate = function () {
  const btn = el('test-refresh-btn');
  if (btn && btn.disabled) return; // already in progress - ignore repeat clicks
  if (btn) {
    btn.disabled = true;
    btn.textContent = '檢查中…';
  }
  const currentScript = document.querySelector('script[type="module"][src]');
  const currentSrc = currentScript && currentScript.getAttribute('src');
  // No script tag to compare against (shouldn't happen in a real build) -
  // treat it the same as a positive "there's an update", same as a failed
  // check below: refresh anyway rather than leaving the button stuck on a
  // comparison that can never succeed.
  (currentSrc ? fetchesNewerScript(currentSrc) : Promise.resolve(true))
    .then(hasUpdate => {
      if (hasUpdate) {
        performForcedRefresh(btn);
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '檢查更新';
        }
        const toast = el('save-toast');
        if (toast) {
          toast.textContent = '✅ 已是最新版本';
          toast.classList.add('show');
          setTimeout(() => toast.classList.remove('show'), 2500);
        }
      }
    })
    .catch(() => performForcedRefresh(btn));
};

function performForcedRefresh(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  function reloadNow() {
    const url = new URL(window.location.href);
    url.searchParams.set('refresh', String(Date.now()));
    window.location.replace(url.toString());
  }
  function timeout(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  // Clear every layer that could otherwise keep this tab on an old
  // version: the service worker's own Cache Storage (public/sw.js),
  // the service worker registration itself (update() makes the browser
  // re-check sw.js for changes right now instead of whenever it next
  // feels like it), and the browser's HTTP cache for the app shell's own
  // assets (re-fetched below with cache:'reload').
  const cacheCleanup =
    'caches' in window
      ? caches
          .keys()
          .then(function (keys) {
            return Promise.all(
              keys.map(function (key) {
                return caches.delete(key);
              })
            );
          })
          .catch(function () {})
      : Promise.resolve();
  const swCleanup =
    'serviceWorker' in navigator
      ? navigator.serviceWorker
          .getRegistration()
          .then(function (reg) {
            return reg ? reg.update() : null;
          })
          .catch(function () {})
      : Promise.resolve();
  const refetches = [window.location.href.replace(/[?#].*$/, '')]
    .concat(getVersionedAssetUrls())
    .map(function (url) {
      return fetch(url, { cache: 'reload' }).catch(function () {});
    });
  // A true hard reload beats waiting forever: race the actual cleanup
  // against a short timeout so a slow or stuck network never leaves the
  // button just sitting there disabled and looking broken.
  Promise.race([Promise.all([cacheCleanup, swCleanup].concat(refetches)), timeout(4000)]).then(
    reloadNow,
    reloadNow
  );
}

// Binds `handler` to `events` (one name or a list) on the element with id
// `id`, exactly once - a re-render can call the bind*() functions below
// again on the same still-present DOM node, and this is what keeps that
// idempotent. `flagName` namespaces the "already bound" marker so unrelated
// bindOnce() calls on the same element (there are none today, but nothing
// stops a future one) can't stomp each other's flag. With
// `replaceToStripOnclick`, the node is cloned and swapped in first - the
// clone carries the markup's `onclick="..."` attribute but none of its own
// JS-attached listeners, which is what actually strips a stale one; plain
// `removeAttribute`/`onclick = null` on the original wouldn't touch a
// listener added via addEventListener. Returns the (possibly replaced) node
// when it just bound for the first time, null otherwise, so a caller with
// its own one-time setup (bindExitButtons' disabled-reset) can piggyback on
// the same guard instead of tracking it separately.
function bindOnce(id, flagName, events, handler, { replaceToStripOnclick = false } = {}) {
  let node = el(id);
  if (!node || node.dataset[flagName]) return null;
  if (replaceToStripOnclick) {
    const clone = node.cloneNode(true);
    clone.removeAttribute('onclick');
    clone.onclick = null;
    node.parentNode.replaceChild(clone, node);
    node = clone;
  }
  (Array.isArray(events) ? events : [events]).forEach(eventName =>
    node.addEventListener(eventName, handler, true)
  );
  node.dataset[flagName] = '1';
  return node;
}
function bindPlayButton() {
  bindOnce('test-play-pause-btn', 'orbitConsolidatedBound', 'click', window.toggleTestPlayPause, {
    replaceToStripOnclick: true
  });
}
function bindExitButtons() {
  const exit = bindOnce('test-exit-btn', 'orbitConsolidatedBound', 'click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    window.exitTestMode();
  });
  if (exit) {
    exit.disabled = false;
    exit.removeAttribute('disabled');
  }
}
function bindInputPauses() {
  ['in-h', 'in-m', 'test-day-input'].forEach(id =>
    bindOnce(id, 'orbitConsolidatedPauseBound', ['focus', 'input'], pauseForEditing)
  );
  bindOnce(
    'test-time-slider',
    'orbitEndpointLockBound',
    ['pointerup', 'mouseup', 'touchend', 'keyup', 'blur', 'change'],
    clearSliderEndpointLock
  );
}
function init() {
  mergeNextClassWithTimer();
  unlockTestControls();
  syncAppVersion();
  const restoredTestState = restoreTestState();
  if (!defaultsInitialized && !restoredTestState) {
    setDefaultsToCurrentTime(true);
    defaultsInitialized = true;
  }
  if (restoredTestState) {
    window.updateInputDisplay();
    const slider = el('test-time-slider');
    if (slider) slider.value = String(Math.floor(window.TEST_TIME_SEC / 60));
  }
  patchPanelOpeners();
  patchUpdate();
  bindPlayButton();
  bindExitButtons();
  bindInputPauses();
  syncTestChrome();
  applyDashboardState();
  finishBoot();
  window.update();
}

init();
