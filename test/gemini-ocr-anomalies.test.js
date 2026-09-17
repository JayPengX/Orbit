import { beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// detectScheduleAnomalies is a second, content-level pass over an
// already structurally-valid AI-recognized candidate (see
// DataValidator.validate for the structural checks it does NOT duplicate)
// - these warnings are always informational, never something that blocks
// or hides the ImportPreview's confirm button (see gemini-ocr.test.js for
// that separate behavior).
let detectScheduleAnomalies;

beforeAll(async () => {
  seedLocalStorage();
  await loadApp();
  ({ detectScheduleAnomalies } = await import('../src/gemini-ocr.js'));
});

function candidate(overrides = {}) {
  return {
    teacherDB: {},
    weeklySchedule: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
    bellTimes: [],
    breakTimes: [],
    ...overrides
  };
}

describe('detectScheduleAnomalies', () => {
  it('reports nothing for a clean, non-overlapping schedule', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        teacherDB: { c1: ['國文', '陳老師', ''] },
        weeklySchedule: { 1: ['c1', ''] },
        bellTimes: [
          ['08:00', '08:50'],
          ['09:00', '09:50']
        ],
        breakTimes: [{ name: '午休', start: '12:00', end: '13:00' }]
      })
    );
    expect(warnings).toEqual([]);
  });

  it('flags two bell periods whose own time ranges overlap, even with nothing assigned', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        bellTimes: [
          ['08:00', '09:00'],
          ['08:30', '09:30']
        ]
      })
    );
    expect(warnings.some(text => /第 1 節與第 2 節的時間重疊/.test(text))).toBe(true);
  });

  it('flags a class assigned to a period that overlaps a recognized break', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        teacherDB: { c1: ['國文', '', ''] },
        weeklySchedule: { 1: ['', 'c1'] },
        bellTimes: [
          ['08:00', '08:50'],
          ['12:00', '12:50']
        ],
        breakTimes: [{ name: '午休', start: '12:00', end: '13:00' }]
      })
    );
    expect(warnings.some(text => /午休.*國文/.test(text))).toBe(true);
  });

  it('does not flag a break-time period that is left empty', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        teacherDB: { c1: ['國文', '', ''] },
        weeklySchedule: { 1: ['c1', ''] },
        bellTimes: [
          ['08:00', '08:50'],
          ['12:00', '12:50']
        ],
        breakTimes: [{ name: '午休', start: '12:00', end: '13:00' }]
      })
    );
    expect(warnings.some(text => /午休/.test(text))).toBe(false);
  });

  it('flags two overlapping-time periods on the same day that both have a class assigned (衝堂)', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        teacherDB: { c1: ['國文', '', ''], c2: ['英文', '', ''] },
        weeklySchedule: { 2: ['c1', 'c2'] },
        bellTimes: [
          ['08:00', '09:00'],
          ['08:30', '09:30']
        ]
      })
    );
    expect(warnings.some(text => /衝堂/.test(text) && text.includes('國文') && text.includes('英文'))).toBe(
      true
    );
  });

  it('does not report a same-day clash when the overlapping period is empty', () => {
    const warnings = detectScheduleAnomalies(
      candidate({
        teacherDB: { c1: ['國文', '', ''] },
        weeklySchedule: { 2: ['c1', ''] },
        bellTimes: [
          ['08:00', '09:00'],
          ['08:30', '09:30']
        ]
      })
    );
    expect(warnings.some(text => /衝堂/.test(text))).toBe(false);
  });

  it('flags an implausibly short period as likely a misread bell time', () => {
    const warnings = detectScheduleAnomalies(candidate({ bellTimes: [['08:00', '08:02']] }));
    expect(warnings.some(text => /只有 2 分鐘/.test(text))).toBe(true);
  });

  it('flags an implausibly long period as likely a misread bell time', () => {
    const warnings = detectScheduleAnomalies(candidate({ bellTimes: [['08:00', '13:00']] }));
    expect(warnings.some(text => /長達.*小時/.test(text))).toBe(true);
  });

  it('flags a period whose end time is not after its start time', () => {
    const warnings = detectScheduleAnomalies(candidate({ bellTimes: [['09:00', '08:00']] }));
    expect(warnings.some(text => /結束時間不晚於開始時間/.test(text))).toBe(true);
  });

  it('handles an empty candidate without throwing', () => {
    expect(() => detectScheduleAnomalies({})).not.toThrow();
    expect(detectScheduleAnomalies({})).toEqual([]);
  });
});
