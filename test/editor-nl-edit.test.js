import { beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// Pure-logic pieces of the natural-language schedule edit feature -
// building the context sent to the proxy, cheaply shape-checking whatever
// comes back, and turning an already-shape-checked sparse PATCH into a
// proposed next settings-data object (the real content-level safety net,
// since this runs the result through the exact same normalizeSettingsData()
// every other write path in this app already trusts). None of this needs a
// configured proxy or a network call - see editor-nl-edit-proxy.test.js for
// the end-to-end request/confirm flow.
let applyNlEditResult;
let buildNlEditContext;
let isNlEditConfigured;
let validateNlEditResult;

beforeAll(async () => {
  seedLocalStorage();
  await loadApp();
  ({ applyNlEditResult, buildNlEditContext, isNlEditConfigured, validateNlEditResult } =
    await import('../src/editor-nl-edit.js'));
});

describe('isNlEditConfigured', () => {
  it('is false when no proxy URL was baked in at build time', () => {
    expect(isNlEditConfigured()).toBe(false);
  });
});

// Fixture (test/helpers/fixtureData.js): 3 bell periods; day 1 = [A, B, C];
// day 2 is empty; day 3 = [A, '', '']. A=數學/王老師/101,
// B=國文/公民 (李老師/陳老師)/102, C=英文/林老師/103.
describe('buildNlEditContext', () => {
  it('sends every editable field - classes, weeklySchedule, bellTimes, breakTimes, countdownEvents, reverseWeek', () => {
    const context = buildNlEditContext();
    expect(context.weeklySchedule[1]).toEqual(['A', 'B', 'C']);
    expect(context.bellTimes).toHaveLength(3);
    expect(context.classes).toEqual(
      expect.arrayContaining([
        { key: 'A', subject: '數學', teacher: '王老師', location: '101' },
        { key: 'C', subject: '英文', teacher: '林老師', location: '103' }
      ])
    );
    expect(Array.isArray(context.breakTimes)).toBe(true);
    expect(Array.isArray(context.countdownEvents)).toBe(true);
    expect(typeof context.reverseWeek).toBe('boolean');
    // No style or sync fields - see gemini-ocr.js's own payload-size
    // discipline for the same reasoning applied here.
    expect(context.proAccent).toBeUndefined();
    expect(context.teacherOrder).toBeUndefined();
  });
});

describe('validateNlEditResult', () => {
  it('rejects a response with no recognizable status', () => {
    expect(validateNlEditResult({ status: 'weird' }).valid).toBe(false);
    expect(validateNlEditResult(null).valid).toBe(false);
  });

  it('accepts unclear/not_found regardless of the other fields - there is nothing else to check', () => {
    expect(validateNlEditResult({ status: 'unclear', reason: '看不懂' }).valid).toBe(true);
    expect(validateNlEditResult({ status: 'not_found', reason: '沒有這堂課' }).valid).toBe(true);
  });

  // A patch that touches nothing - every array empty, every *Changed flag
  // false - is still a well-shaped "ok" result (it just means "no change",
  // handled by showNlEditConfirm's own describeSettingsDiff check, not by
  // shape validation).
  const okFields = () => ({
    classUpserts: [],
    deletedClassKeys: [],
    scheduleEdits: [],
    bellTimesChanged: false,
    bellTimes: [],
    breakTimesChanged: false,
    breakTimes: [],
    countdownEventsChanged: false,
    countdownEvents: [],
    reverseWeekChanged: false,
    reverseWeek: false
  });

  it('accepts a well-shaped "ok" result', () => {
    expect(validateNlEditResult({ status: 'ok', ...okFields() }).valid).toBe(true);
  });

  it('rejects an "ok" result missing any required field, or with the wrong type', () => {
    for (const key of Object.keys(okFields())) {
      const fields = okFields();
      delete fields[key];
      expect(validateNlEditResult({ status: 'ok', ...fields }).valid).toBe(false);
    }
    expect(
      validateNlEditResult({ status: 'ok', ...okFields(), classUpserts: 'not an array' }).valid
    ).toBe(false);
    expect(
      validateNlEditResult({ status: 'ok', ...okFields(), reverseWeek: 'not a boolean' }).valid
    ).toBe(false);
    expect(
      validateNlEditResult({ status: 'ok', ...okFields(), bellTimesChanged: 'not a boolean' }).valid
    ).toBe(false);
  });
});

// Every test below builds its own minimal currentData rather than sharing
// one fixture - keeps each test's starting point obvious from reading it
// alone. patch() fills in every field a well-shaped "ok" patch needs,
// letting each test override only the ones it actually cares about - the
// same "only what changed" shape applyNlEditResult itself now expects from
// the real AI response.
function makeCurrentData(overrides) {
  return JSON.parse(
    JSON.stringify({
      teacherDB: { A: ['數學', '王老師', '101'] },
      teacherOrder: ['A'],
      locationDB: { A: '101' },
      weeklySchedule: { 0: [], 1: ['A'], 2: [], 3: [], 4: [], 5: [], 6: [] },
      bellTimes: [['08:00', '08:50']],
      breakTimes: [],
      countdownEvents: [],
      reverseWeek: false,
      proAccent: '#0A84FF',
      proSecondary: '#5856D6',
      proTertiary: '#5856D6',
      styleSlots: [],
      ...overrides
    })
  );
}
function patch(overrides) {
  return {
    classUpserts: [],
    deletedClassKeys: [],
    scheduleEdits: [],
    bellTimesChanged: false,
    bellTimes: [],
    breakTimesChanged: false,
    breakTimes: [],
    countdownEventsChanged: false,
    countdownEvents: [],
    reverseWeekChanged: false,
    reverseWeek: false,
    ...overrides
  };
}

describe('applyNlEditResult', () => {
  it('sets an existing class into a slot via a single scheduleEdits entry, without touching classUpserts', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({ scheduleEdits: [{ day: 2, period: 0, key: 'A' }] })
    );
    expect(next.weeklySchedule[2][0]).toBe('A');
    expect(next.teacherDB.A).toEqual(['數學', '王老師', '101']);
  });

  it('creates a brand-new class the AI invented a new key for, via classUpserts + scheduleEdits', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({
        classUpserts: [{ key: 'new1', subject: '物理', teacher: '', location: '' }],
        scheduleEdits: [{ day: 2, period: 0, key: 'new1' }]
      })
    );
    expect(next.weeklySchedule[2][0]).toBe('new1');
    expect(next.teacherDB.new1[0]).toBe('物理');
    // The untouched pre-existing class is carried over unchanged, even
    // though this patch never mentioned it.
    expect(next.teacherDB.A).toEqual(['數學', '王老師', '101']);
  });

  it('drops a class via deletedClassKeys, without the patch having to repeat any other class', () => {
    const currentData = makeCurrentData({
      teacherDB: { A: ['數學', '王老師', '101'], B: ['英文', '林老師', '103'] },
      teacherOrder: ['A', 'B'],
      locationDB: { A: '101', B: '103' },
      weeklySchedule: { 0: [], 1: ['A', 'B'], 2: [], 3: [], 4: [], 5: [], 6: [] }
    });
    const next = applyNlEditResult(
      currentData,
      patch({
        deletedClassKeys: ['B'],
        scheduleEdits: [{ day: 1, period: 1, key: '' }]
      })
    );
    expect(next.teacherDB.B).toBeUndefined();
    expect(next.teacherDB.A).toEqual(['數學', '王老師', '101']);
    expect(next.weeklySchedule[1]).toEqual(['A', '']);
  });

  it('quietly clears any leftover schedule cell pointing at a deleted key, even if the patch forgot to', () => {
    const currentData = makeCurrentData({
      teacherDB: { A: ['數學', '王老師', '101'], B: ['英文', '林老師', '103'] },
      teacherOrder: ['A', 'B'],
      locationDB: { A: '101', B: '103' },
      weeklySchedule: { 0: [], 1: ['A', 'B'], 2: [], 3: [], 4: [], 5: [], 6: [] }
    });
    // deletedClassKeys names B, but scheduleEdits (unlike a well-behaved AI
    // response) never clears day 1 period 1 - normalizeSettingsData is the
    // real safety net that keeps this from leaving a dangling reference.
    const next = applyNlEditResult(currentData, patch({ deletedClassKeys: ['B'] }));
    expect(next.teacherDB.B).toBeUndefined();
    expect(next.weeklySchedule[1]).not.toContain('B');
  });

  it('leaves every class/cell the patch never mentions completely untouched', () => {
    const currentData = makeCurrentData({
      teacherDB: { A: ['數學', '王老師', '101'], B: ['英文', '林老師', '103'] },
      teacherOrder: ['A', 'B'],
      locationDB: { A: '101', B: '103' },
      weeklySchedule: { 0: [], 1: ['A', 'B'], 2: [], 3: [], 4: [], 5: [], 6: [] }
    });
    // A patch that only touches day 2 - day 1's A/B classes and cells are
    // never named anywhere in it.
    const next = applyNlEditResult(
      currentData,
      patch({
        classUpserts: [{ key: 'new1', subject: '物理', teacher: '', location: '' }],
        scheduleEdits: [{ day: 2, period: 0, key: 'new1' }]
      })
    );
    expect(next.weeklySchedule[1]).toEqual(['A', 'B']);
    expect(next.teacherDB.A).toEqual(['數學', '王老師', '101']);
    expect(next.teacherDB.B).toEqual(['英文', '林老師', '103']);
  });

  it('adds a new bell period alongside a class scheduled into it', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({
        classUpserts: [{ key: 'new1', subject: '生物', teacher: '林老師', location: '' }],
        scheduleEdits: [{ day: 1, period: 1, key: 'new1' }],
        bellTimesChanged: true,
        bellTimes: [
          ['08:00', '08:50'],
          ['09:10', '10:00']
        ]
      })
    );
    expect(next.bellTimes).toHaveLength(2);
    expect(next.weeklySchedule[1][1]).toBe('new1');
  });

  it('leaves bellTimes untouched when bellTimesChanged is false, even if the field carries a stray value', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({ bellTimesChanged: false, bellTimes: [['not', 'used']] })
    );
    expect(next.bellTimes).toEqual([['08:00', '08:50']]);
  });

  it('adds a new break time directly, independent of weeklySchedule', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({
        breakTimesChanged: true,
        breakTimes: [{ name: '午休', start: '12:00', end: '13:00' }]
      })
    );
    // normalizeSettingsData's sanitizeBreakTimes may also auto-merge in a
    // default break time that happens not to conflict (see
    // test/helpers/fixtureData.js's own comment on this) - only assert the
    // one this test actually added made it through.
    expect(next.breakTimes).toEqual(
      expect.arrayContaining([{ name: '午休', start: '12:00', end: '13:00' }])
    );
  });

  it('adds a new countdown event directly', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditResult(
      currentData,
      patch({
        countdownEventsChanged: true,
        countdownEvents: [{ name: '期末考', startDate: '2026-01-10', endDate: '2026-01-12' }]
      })
    );
    expect(next.countdownEvents).toEqual([
      { name: '期末考', startDate: '2026-01-10', endDate: '2026-01-12' }
    ]);
  });

  it('flips reverseWeek directly', () => {
    const currentData = makeCurrentData({ reverseWeek: false });
    const next = applyNlEditResult(
      currentData,
      patch({ reverseWeekChanged: true, reverseWeek: true })
    );
    expect(next.reverseWeek).toBe(true);
  });

  it('leaves reverseWeek untouched when reverseWeekChanged is false', () => {
    const currentData = makeCurrentData({ reverseWeek: false });
    const next = applyNlEditResult(
      currentData,
      patch({ reverseWeekChanged: false, reverseWeek: true })
    );
    expect(next.reverseWeek).toBe(false);
  });

  it('throws a clear error when the returned data is structurally unsound', () => {
    const currentData = makeCurrentData();
    expect(() =>
      applyNlEditResult(
        currentData,
        patch({ bellTimesChanged: true, bellTimes: [['not', 'a', 'valid', 'time', 'range']] })
      )
    ).toThrow();
  });
});
