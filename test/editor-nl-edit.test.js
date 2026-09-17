import { beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// Pure-logic pieces of the natural-language schedule edit feature -
// building the context sent to the proxy, re-validating whatever comes
// back against that same context (never trusting the model blindly - same
// discipline as gemini-ocr.js's DataValidator), and turning an
// already-validated ops list into a proposed next settings-data object.
// None of this needs a configured proxy or a network call - see
// editor-nl-edit-proxy.test.js for the end-to-end request/confirm flow.
let applyNlEditOps;
let buildNlEditContext;
let isNlEditConfigured;
let resolveClassKey;
let validateNlEditResult;

beforeAll(async () => {
  seedLocalStorage();
  await loadApp();
  ({ applyNlEditOps, buildNlEditContext, isNlEditConfigured, resolveClassKey, validateNlEditResult } =
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
  it('sends the current weeklySchedule, bellTimes, and a flat classes array - never the whole app data blob', () => {
    const context = buildNlEditContext();
    expect(context.weeklySchedule[1]).toEqual(['A', 'B', 'C']);
    expect(context.bellTimes).toHaveLength(3);
    expect(context.classes).toEqual(
      expect.arrayContaining([
        { key: 'A', subject: '數學', teacher: '王老師', location: '101' },
        { key: 'C', subject: '英文', teacher: '林老師', location: '103' }
      ])
    );
    // No style, countdown, or sync fields - see gemini-ocr.js's own
    // payload-size discipline for the same reasoning applied there.
    expect(context.proAccent).toBeUndefined();
    expect(context.countdownEvents).toBeUndefined();
  });
});

describe('validateNlEditResult', () => {
  const context = () => buildNlEditContext();

  it('rejects a response with no recognizable status', () => {
    expect(validateNlEditResult({ status: 'weird' }, context()).valid).toBe(false);
    expect(validateNlEditResult(null, context()).valid).toBe(false);
  });

  it('accepts unclear/not_found regardless of the other fields - there is nothing else to check', () => {
    expect(validateNlEditResult({ status: 'unclear', reason: '看不懂', ops: [] }, context()).valid).toBe(
      true
    );
    expect(
      validateNlEditResult({ status: 'not_found', reason: '沒有這堂課', ops: [] }, context()).valid
    ).toBe(true);
  });

  it('rejects an "ok" result with no ops, or ops that is not an array', () => {
    expect(validateNlEditResult({ status: 'ok', reason: '', ops: [] }, context()).valid).toBe(false);
    expect(validateNlEditResult({ status: 'ok', reason: '' }, context()).valid).toBe(false);
  });

  it('rejects a result with more ops than the client-side cap allows', () => {
    const op = { op: 'setSlot', day: 2, period: 0, subject: '物理', teacher: '', location: '' };
    const result = validateNlEditResult(
      { status: 'ok', reason: '', ops: Array.from({ length: 9 }, () => op) },
      context()
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a setSlot naming a day or period outside the current schedule', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'setSlot', day: 9, period: 0, subject: '物理' }] },
      context()
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a setSlot with no subject', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'setSlot', day: 2, period: 0, subject: '' }] },
      context()
    );
    expect(result.valid).toBe(false);
  });

  it('accepts an in-range setSlot', () => {
    const result = validateNlEditResult(
      {
        status: 'ok',
        ops: [{ op: 'setSlot', day: 2, period: 0, subject: '物理', teacher: '', location: '' }]
      },
      context()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a moveSlot whose source period is currently empty', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'moveSlot', fromDay: 2, fromPeriod: 0, toDay: 1, toPeriod: 0 }] },
      context()
    );
    expect(result.valid).toBe(false);
  });

  it('accepts a moveSlot from an occupied period to an empty one', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 }] },
      context()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a swapSlot where both slots are currently empty', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'swapSlot', fromDay: 2, fromPeriod: 0, toDay: 2, toPeriod: 1 }] },
      context()
    );
    expect(result.valid).toBe(false);
  });

  it('accepts a swapSlot where only one side is occupied - equivalent to a move', () => {
    const result = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'swapSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 }] },
      context()
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a clearSlot on an occupied slot, and on an already-empty one', () => {
    const occupied = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'clearSlot', day: 1, period: 0 }] },
      context()
    );
    expect(occupied.valid).toBe(true);
    const empty = validateNlEditResult(
      { status: 'ok', ops: [{ op: 'clearSlot', day: 2, period: 0 }] },
      context()
    );
    expect(empty.valid).toBe(true);
  });

  it('validates later ops against the effect of earlier ones in the same list', () => {
    // day 2 period 0 starts empty - a moveSlot into it, then a moveSlot OUT
    // of it, should both be valid in sequence even though the second one
    // would be invalid (source empty) against the ORIGINAL context alone.
    const result = validateNlEditResult(
      {
        status: 'ok',
        ops: [
          { op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 },
          { op: 'moveSlot', fromDay: 2, fromPeriod: 0, toDay: 3, toPeriod: 1 }
        ]
      },
      context()
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a later op that is invalid given the earlier ops in the same list', () => {
    // day 1 period 0 is moved away by the first op, so the second op's
    // source is empty by the time it runs - even though it looks occupied
    // in the original, unmodified context.
    const result = validateNlEditResult(
      {
        status: 'ok',
        ops: [
          { op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 },
          { op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 1 }
        ]
      },
      context()
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('第 2 項');
  });
});

describe('resolveClassKey', () => {
  it('reuses an existing class with the exact same subject+teacher', () => {
    const teacherDB = { A: ['數學', '王老師', '101'] };
    const { key, teacherDB: next } = resolveClassKey(teacherDB, '數學', '王老師', '');
    expect(key).toBe('A');
    // Location wasn't given - keeps the existing one rather than blanking it.
    expect(next.A).toEqual(['數學', '王老師', '101']);
  });

  it('reuses an existing class by subject alone when no teacher was given', () => {
    const teacherDB = { C: ['英文', '林老師', '103'] };
    const { key, teacherDB: next } = resolveClassKey(teacherDB, '英文', '', '');
    expect(key).toBe('C');
    expect(next.C).toEqual(['英文', '林老師', '103']);
  });

  it('creates a new class when nothing matches', () => {
    const teacherDB = { A: ['數學', '王老師', '101'] };
    const { key, teacherDB: next } = resolveClassKey(teacherDB, '物理', '', '');
    expect(key).toBe('nl1');
    expect(next.nl1).toEqual(['物理', '', '']);
    expect(next.A).toEqual(['數學', '王老師', '101']);
  });

  it('picks the next free nl-prefixed key when one is already taken', () => {
    const teacherDB = { nl1: ['物理', '', ''] };
    const { key } = resolveClassKey(teacherDB, '化學', '', '');
    expect(key).toBe('nl2');
  });
});

// Every test below builds its own minimal currentData rather than sharing
// one fixture, same as the original single-op tests - keeps each test's
// starting schedule obvious from reading it alone.
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

describe('applyNlEditOps', () => {
  it('setSlot reuses an existing class instead of creating a duplicate', () => {
    const currentData = makeCurrentData({
      teacherDB: { A: ['數學', '王老師', '101'], C: ['英文', '林老師', '103'] },
      teacherOrder: ['A', 'C'],
      locationDB: { A: '101', C: '103' }
    });
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'setSlot', day: 2, period: 0, subject: '英文', teacher: '', location: '' }]
    });
    expect(next.weeklySchedule[2][0]).toBe('C');
    expect(Object.keys(next.teacherDB)).toEqual(['A', 'C']);
  });

  it('setSlot with a brand-new subject creates a new class entry', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'setSlot', day: 2, period: 0, subject: '物理', teacher: '', location: '' }]
    });
    const newKey = next.weeklySchedule[2][0];
    expect(newKey).toBeTruthy();
    expect(next.teacherDB[newKey][0]).toBe('物理');
  });

  it('moveSlot relocates the class and clears its old slot', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 }]
    });
    expect(next.weeklySchedule[1][0]).toBe('');
    expect(next.weeklySchedule[2][0]).toBe('A');
  });

  it('swapSlot exchanges both slots\' contents', () => {
    const currentData = makeCurrentData({
      teacherDB: { A: ['數學', '王老師', '101'], C: ['英文', '林老師', '103'] },
      teacherOrder: ['A', 'C'],
      locationDB: { A: '101', C: '103' },
      weeklySchedule: { 0: [], 1: ['A'], 2: ['C'], 3: [], 4: [], 5: [], 6: [] }
    });
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'swapSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 }]
    });
    expect(next.weeklySchedule[1][0]).toBe('C');
    expect(next.weeklySchedule[2][0]).toBe('A');
  });

  it('swapSlot with one empty side behaves like a plain move', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'swapSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 }]
    });
    expect(next.weeklySchedule[1][0]).toBe('');
    expect(next.weeklySchedule[2][0]).toBe('A');
  });

  it('clearSlot empties a slot without touching any other slot or class', () => {
    const currentData = makeCurrentData();
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [{ op: 'clearSlot', day: 1, period: 0 }]
    });
    expect(next.weeklySchedule[1][0]).toBe('');
    expect(next.teacherDB.A).toBeTruthy(); // the class itself still exists, just unscheduled here
  });

  it('applies several ops in order, each seeing the effect of the ones before it', () => {
    const currentData = makeCurrentData();
    // Move A out of day1/period0, then set a new 物理 class into that now-
    // empty slot - only valid in this order, which is exactly the point.
    const next = applyNlEditOps(currentData, {
      status: 'ok',
      ops: [
        { op: 'moveSlot', fromDay: 1, fromPeriod: 0, toDay: 2, toPeriod: 0 },
        { op: 'setSlot', day: 1, period: 0, subject: '物理', teacher: '', location: '' }
      ]
    });
    expect(next.weeklySchedule[2][0]).toBe('A');
    const newKey = next.weeklySchedule[1][0];
    expect(newKey).toBeTruthy();
    expect(newKey).not.toBe('A');
    expect(next.teacherDB[newKey][0]).toBe('物理');
  });
});
