import { describe, expect, it } from 'vitest';
import { computeDashboardViewModel } from '../src/schedule-calc.js';

// A 3-period Monday with one split (單/雙 week) class in the middle, and the
// default 打掃時間 break sitting exactly between periods 0 and 1 - same
// shape as test/helpers/fixtureData.js, but exercised directly against the
// pure function instead of through a full app boot.
const todaySchedule = [
  { key: 'A', n: '數學', t: '王老師', s: '08:00', e: '08:50', isSplit: false, loc: '101' },
  {
    key: 'B',
    n: '國文/公民',
    t: '李老師/陳老師',
    s: '09:10',
    e: '10:00',
    isSplit: true,
    loc: '102'
  },
  { key: 'C', n: '英文', t: '林老師', s: '10:10', e: '11:00', isSplit: false, loc: '103' }
];
const breakTimes = [{ name: '打掃時間', start: '08:50', end: '09:10' }];

function at(hh, mm, ss = 0) {
  const now = new Date('2024-01-08T00:00:00'); // a Monday, arbitrary - only H:M:S matter here
  now.setHours(hh, mm, ss, 0);
  return now;
}

function compute(now, overrides = {}) {
  return computeDashboardViewModel({
    now,
    curDay: 1,
    week: '單',
    todaySchedule,
    breakTimes,
    ...overrides
  });
}

describe('computeDashboardViewModel - boundary cases', () => {
  it('before the first period: 尚未開始, no timer, no progress', () => {
    const vm = compute(at(7, 30));
    expect(vm.statusText).toBe('尚未開始');
    expect(vm.timerVisible).toBe(false);
    expect(vm.progressVisible).toBe(false);
    expect(vm.dotState).toBe('wait');
  });

  it('exactly at a period start boundary: counts as in-class', () => {
    const vm = compute(at(8, 0, 0));
    expect(vm.statusText).toBe('數學');
    expect(vm.dotState).toBe('active');
  });

  it('one second before a period ends: still in-class, 1 second left', () => {
    const vm = compute(at(8, 49, 59));
    expect(vm.statusText).toBe('數學');
    expect(vm.timerValue).toBe('0:01');
  });

  it('exactly at a period end boundary: no longer in that class', () => {
    const vm = compute(at(8, 50, 0));
    expect(vm.statusText).not.toBe('數學');
  });

  it('mid-class: progress is proportional to elapsed time', () => {
    // 08:25:00 is 25 of 50 minutes into 08:00-08:50 -> 50%
    const vm = compute(at(8, 25, 0));
    expect(vm.progressPercent).toBeCloseTo(50, 5);
    expect(vm.progressIsClass).toBe(true);
  });

  it('during the auto-injected break between periods: shows the break name, not a class', () => {
    const vm = compute(at(9, 0, 0));
    expect(vm.statusText).toBe('打掃時間');
    expect(vm.dotState).toBe('wait');
    expect(vm.teacherText).toBe('');
  });

  it('during a between-period gap with no named break: 下課, counts down to the next period', () => {
    // there's no break defined for 10:00-10:10; falls through to the
    // generic "下課, waiting for next period" branch
    const vm = compute(at(10, 5, 0), { breakTimes: [] });
    expect(vm.statusText).toBe('下課');
    expect(vm.timerVisible).toBe(true);
  });

  it('split-week class resolves the correct half for each week label', () => {
    const single = compute(at(9, 30, 0), { week: '單' });
    expect(single.statusText).toBe('國文');
    expect(single.teacherText).toBe('李老師');

    const double = compute(at(9, 30, 0), { week: '雙' });
    expect(double.statusText).toBe('公民');
    expect(double.teacherText).toBe('陳老師');
  });

  it('after the last period ends: 放學時間, isDayFinished true', () => {
    const vm = compute(at(11, 0, 0));
    expect(vm.statusText).toBe('放學時間');
    expect(vm.isDayFinished).toBe(true);
    expect(vm.dotState).toBe('none');
  });

  it('on a day with no classes at all: 今日無課', () => {
    const vm = compute(at(9, 0, 0), { todaySchedule: [] });
    expect(vm.statusText).toBe('今日無課');
    expect(vm.isSchoolDay).toBe(false);
    expect(vm.isDayFinished).toBe(false);
  });

  it('next-class preview reflects the split label too', () => {
    const vm = compute(at(8, 20, 0), { week: '雙' });
    expect(vm.nextText).toBe('公民');
    expect(vm.nextMeta).toBe('09:10 · 陳老師 · 102');
  });

  it('last class of the day has no next class: weekday-dependent sign-off text', () => {
    const friday = compute(at(10, 30, 0), { curDay: 5 });
    expect(friday.nextText).toBe('週末愉快');
    const tuesday = compute(at(10, 30, 0), { curDay: 2 });
    expect(tuesday.nextText).toBe('再見');
  });
});

describe('computeDashboardViewModel - overnight (cross-midnight) special time', () => {
  const overnightBreak = [{ name: '就寢時間', start: '18:00', end: '05:00' }];
  const formatCountdownFor = totalSeconds =>
    `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;

  it('is active before midnight, counting down toward the next-day end', () => {
    // 22:00 -> 05:00 next day is 7h = 25200s away
    const vm = compute(at(22, 0, 0), { breakTimes: overnightBreak });
    expect(vm.statusText).toBe('就寢時間');
    expect(vm.timerValue).toBe(formatCountdownFor(7 * 3600));
    expect(vm.progressPercent).toBeCloseTo((4 / 11) * 100, 5); // 4h of 18:00-05:00's 11h
  });

  it('is still active in the early-morning tail after midnight', () => {
    // 02:00 -> 05:00 is 3h away; 8h elapsed of the 11h window
    const vm = compute(at(2, 0, 0), { breakTimes: overnightBreak });
    expect(vm.statusText).toBe('就寢時間');
    expect(vm.timerValue).toBe(formatCountdownFor(3 * 3600));
    expect(vm.progressPercent).toBeCloseTo((8 / 11) * 100, 5);
  });

  it('is not active outside the overnight window', () => {
    const vm = compute(at(12, 0, 0), { breakTimes: overnightBreak });
    expect(vm.statusText).not.toBe('就寢時間');
  });
});
