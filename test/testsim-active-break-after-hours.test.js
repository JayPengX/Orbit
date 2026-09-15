import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// Regression test for a real bug found via UX-testing: an active named
// break that runs past the school day (e.g. an overnight 18:00 -> 05:00
// special time) had its status text update correctly, but its timer never
// appeared. The cause lived outside schedule-calc.js entirely -
// testsim-runtime.js's applyDashboardState() independently re-derived "is
// there a timer to show right now" from just the first/last class times,
// with no idea breakTimes existed, and toggled CSS classes
// (v3-15-day-finished / v3-16-outside-class-range / orbit-no-school-day)
// that force .time-card (the element holding the timer) to display:none
// whenever that guess said school hours were over - even while
// computeDashboardViewModel() correctly said a break's timer should show.

const FIXED_MONDAY = new Date('2024-01-08T08:00:00');

function setSimTime(hours, minutes) {
  window.MANUALLY_TEST = true;
  window.IS_SIMULATING = false;
  window.TEST_DAY = 1;
  window.TEST_TIME_SEC = hours * 3600 + minutes * 60;
}

describe('an active break after the school day ends stays visible', () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_MONDAY);
    // Monday's last class ends at 11:00 in the base fixture; this overnight
    // break runs well past it and across midnight.
    seedLocalStorage({ breakTimes: [{ name: 'sleep', start: '18:00', end: '05:00' }] });
    await loadApp();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('does not hide the timer UI once the active break is well after the last class', () => {
    setSimTime(20, 0); // 20:00 - an hour after the fixture's 11:00 school-day end
    window.update();

    expect(document.getElementById('now-name').innerText).toBe('sleep');
    expect(document.getElementById('timer-group').style.display).toBe('flex');
    expect(document.getElementById('timer-val').innerText).toBe('9:00:00');

    const dashboard = document.querySelector('.dashboard');
    expect(dashboard.classList.contains('v3-15-day-finished')).toBe(false);
    expect(dashboard.classList.contains('v3-16-outside-class-range')).toBe(false);
    expect(dashboard.classList.contains('orbit-no-school-day')).toBe(false);
  });

  it('still hides the timer UI once the break itself has ended', () => {
    // 13:30 - after the last class (11:00) and the auto-injected 中午時間
    // break (12:00-13:00), before the overnight break starts (18:00).
    setSimTime(13, 30);
    window.update();

    expect(document.getElementById('now-name').innerText).toBe('放學時間');
    expect(document.getElementById('timer-group').style.display).toBe('none');
    expect(document.querySelector('.dashboard').classList.contains('orbit-no-school-day')).toBe(
      true
    );
  });
});
