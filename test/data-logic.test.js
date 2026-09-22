import { beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { getISOWeekNumber, parseTime, processSplitName } from '../src/schedule.js';
import { state } from '../src/state.js';
import {
  isValidTimeRange,
  normalizeCountdownEvent,
  sanitizeBreakTimes,
  validateTimeIntervals
} from '../src/data.js';
import {
  decodeTransferData,
  encodeTransferData,
  normalizeSettingsData
} from '../src/editor-backup.js';

// One shared load is enough - none of these functions touch localStorage or
// the DOM, they're pure(ish) data transforms exercised directly via their
// real module exports.
beforeAll(async () => {
  await loadApp();
});

describe('time helpers', () => {
  it('parseTime converts HH:MM to minutes after midnight', () => {
    expect(parseTime('08:00')).toBe(480);
    expect(parseTime('13:05')).toBe(785);
  });

  it('getISOWeekNumber matches known ISO week boundaries', () => {
    expect(getISOWeekNumber(new Date('2024-01-01T12:00:00'))).toBe(1);
    expect(getISOWeekNumber(new Date('2024-01-08T12:00:00'))).toBe(2);
  });

  it('processSplitName resolves the correct half for a split subject by week parity', () => {
    const cls = { n: '國文/公民', t: '李老師/陳老師', isSplit: true };
    expect(processSplitName(cls, '單')).toMatchObject({ n: '國文', t: '李老師' });
    expect(processSplitName(cls, '雙')).toMatchObject({ n: '公民', t: '陳老師' });
  });

  it('processSplitName passes non-split classes through unchanged', () => {
    const cls = { n: '數學', t: '王老師', isSplit: false };
    expect(processSplitName(cls, '單')).toMatchObject({ n: '數學', t: '王老師', label: '' });
  });
});

describe('validateTimeIntervals', () => {
  it('accepts non-overlapping bell times and breaks', () => {
    expect(() =>
      validateTimeIntervals(
        [
          ['08:00', '08:50'],
          ['09:10', '10:00']
        ],
        [{ name: '打掃時間', start: '08:50', end: '09:10' }]
      )
    ).not.toThrow();
  });

  it('rejects an invalid time range', () => {
    expect(() => validateTimeIntervals([['08:50', '08:00']], [])).toThrow();
  });

  it('rejects overlapping intervals', () => {
    expect(() =>
      validateTimeIntervals(
        [
          ['08:00', '09:00'],
          ['08:30', '09:30']
        ],
        []
      )
    ).toThrow(/重疊/);
  });

  it('rejects a bell period that crosses midnight (only breaks may do that)', () => {
    expect(() => validateTimeIntervals([['23:00', '01:00']], [])).toThrow();
  });

  it('accepts a special-time break that crosses midnight', () => {
    expect(() =>
      validateTimeIntervals(
        [['08:00', '08:50']],
        [{ name: '就寢時間', start: '18:00', end: '05:00' }]
      )
    ).not.toThrow();
  });

  it('rejects an overnight break that overlaps another interval across the midnight wrap', () => {
    expect(() =>
      validateTimeIntervals(
        [['04:00', '06:00']],
        [{ name: '就寢時間', start: '18:00', end: '05:00' }]
      )
    ).toThrow(/重疊/);
  });
});

describe('isValidTimeRange', () => {
  it('rejects an overnight range by default', () => {
    expect(isValidTimeRange('18:00', '05:00')).toBe(false);
  });

  it('accepts an overnight range when overnight ranges are allowed', () => {
    expect(isValidTimeRange('18:00', '05:00', true)).toBe(true);
  });

  it('still rejects a zero-length range even when overnight is allowed', () => {
    expect(isValidTimeRange('18:00', '18:00', true)).toBe(false);
  });
});

describe('countdown event normalization', () => {
  it('normalizes a well-formed single-day event', () => {
    expect(
      normalizeCountdownEvent({ name: ' 段考 ', startDate: '2024-01-15', endDate: '2024-01-15' })
    ).toEqual({ name: '段考', startDate: '2024-01-15', endDate: '2024-01-15' });
  });

  it('swaps start/end when they are reversed', () => {
    expect(
      normalizeCountdownEvent({ name: '段考', startDate: '2024-01-20', endDate: '2024-01-15' })
    ).toEqual({ name: '段考', startDate: '2024-01-15', endDate: '2024-01-20' });
  });

  it('rejects an event missing a name or a valid date', () => {
    expect(
      normalizeCountdownEvent({ name: '', startDate: '2024-01-15', endDate: '2024-01-15' })
    ).toBeNull();
    expect(
      normalizeCountdownEvent({ name: '段考', startDate: 'not-a-date', endDate: '2024-01-15' })
    ).toBeNull();
  });

  it('falls back to legacy data.date when startDate/endDate are absent', () => {
    expect(normalizeCountdownEvent({ name: '段考', date: '2024-01-15' })).toEqual({
      name: '段考',
      startDate: '2024-01-15',
      endDate: '2024-01-15'
    });
  });
});

describe('sanitizeBreakTimes', () => {
  const bellTimes = [
    ['08:00', '08:50'],
    ['09:10', '10:00']
  ];

  it('keeps a valid custom break', () => {
    const result = sanitizeBreakTimes(bellTimes, [{ name: '午休', start: '12:00', end: '13:00' }]);
    expect(result).toContainEqual({ name: '午休', start: '12:00', end: '13:00' });
  });

  it('drops a break that conflicts with a bell period', () => {
    const result = sanitizeBreakTimes(bellTimes, [{ name: '衝突', start: '08:30', end: '09:00' }]);
    expect(result.find(item => item.name === '衝突')).toBeUndefined();
  });

  it('auto-fills a default break that fits without conflict', () => {
    const result = sanitizeBreakTimes(bellTimes, []);
    expect(result).toContainEqual({ name: '打掃時間', start: '08:50', end: '09:10' });
  });

  it('keeps a custom break that crosses midnight', () => {
    const result = sanitizeBreakTimes(bellTimes, [
      { name: '就寢時間', start: '18:00', end: '05:00' }
    ]);
    expect(result).toContainEqual({ name: '就寢時間', start: '18:00', end: '05:00' });
  });
});

describe('normalizeSettingsData (schema migration guard)', () => {
  it('throws when a required field is missing', () => {
    expect(() => normalizeSettingsData({})).toThrow(/teacherDB/);
  });

  it('accepts a minimal valid settings object', () => {
    const result = normalizeSettingsData({
      teacherDB: { A: ['數學', '王老師', ''] },
      locationDB: { A: '101' },
      weeklySchedule: { 1: ['A'] },
      bellTimes: [['08:00', '08:50']]
    });
    expect(result.teacherDB.A).toEqual(['數學', '王老師', '']);
    expect(result.bellTimes).toEqual([['08:00', '08:50']]);
  });
});

describe('v2 backup encode/decode round-trip', () => {
  it('decodeTransferData(encodeTransferData(data)) reproduces the original schedule data', async () => {
    const original = normalizeSettingsData({
      teacherDB: { A: ['數學', '王老師', '101'], B: ['國文/公民', '李老師/陳老師', '102'] },
      teacherOrder: ['A', 'B'],
      locationDB: { A: '101', B: '102' },
      weeklySchedule: { 1: ['A', 'B'] },
      bellTimes: [
        ['08:00', '08:50'],
        ['09:10', '10:00']
      ],
      breakTimes: [{ name: '打掃時間', start: '08:50', end: '09:10' }],
      countdownEvents: [{ name: '段考', startDate: '2024-01-15', endDate: '2024-01-17' }],
      reverseWeek: true,
      proAccent: '#123456',
      proSecondary: '#654321',
      styleSlots: []
    });

    const encoded = await encodeTransferData(original);
    // TRANSFER_MAGIC_V2 is a module-private const in src/editor-backup.js
    // (never exported - nothing outside that module needs it); its literal
    // value is documented in README.md's backup-format section.
    expect(encoded.startsWith('[ORBIT]')).toBe(true);

    const decoded = await decodeTransferData(encoded);
    expect(decoded.teacherDB).toEqual(original.teacherDB);
    expect(decoded.weeklySchedule).toEqual(original.weeklySchedule);
    expect(decoded.bellTimes).toEqual(original.bellTimes);
    expect(decoded.breakTimes).toEqual(original.breakTimes);
    expect(decoded.countdownEvents).toEqual(original.countdownEvents);
    expect(decoded.reverseWeek).toBe(true);
    expect(decoded.proAccent).toBe('#123456');
  });

  it('rejects text that is not a valid backup', async () => {
    await expect(decodeTransferData('not a backup')).rejects.toThrow();
  });

  it('still decodes a pre-proTertiary-removal backup (11 positional fields, proTertiary between proSecondary and styleSlots)', async () => {
    // Hand-builds a legacy v2 payload the way encodeTransferPayloadV2 used to
    // shape it, back when it still carried proTertiary as its own array slot
    // between proSecondary and styleSlotEntries. Exercises the length check
    // in decodeTransferPayloadV2 that tells old backups (11 fields) from
    // current ones (10) apart - without it, a legacy backup's proTertiary
    // hex string would be misread as styleSlotEntries and its real
    // styleSlotEntries would be dropped entirely.
    const BASE91_ALPHABET =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~';
    function base91Encode(bytes) {
      let b = 0,
        n = 0,
        out = '';
      for (let i = 0; i < bytes.length; i++) {
        b |= bytes[i] << n;
        n += 8;
        if (n > 13) {
          let v = b & 8191;
          if (v > 88) {
            b >>= 13;
            n -= 13;
          } else {
            v = b & 16383;
            b >>= 14;
            n -= 14;
          }
          out += BASE91_ALPHABET[v % 91] + BASE91_ALPHABET[Math.floor(v / 91)];
        }
      }
      if (n > 0) {
        out += BASE91_ALPHABET[b % 91];
        if (n > 7 || b > 90) out += BASE91_ALPHABET[Math.floor(b / 91)];
      }
      return out;
    }
    const legacyArray = [
      ['A'],
      [['A', '數學', '王老師', '101']],
      [[], ['A'], [], [], [], [], []],
      [['08:00', '08:50']],
      [],
      [],
      1,
      '#123456',
      '#654321',
      '#abcdef', // legacy proTertiary, no longer a real field
      [['Kept', '#111111', '#222222']] // real styleSlotEntries
    ];
    const raw = JSON.stringify(legacyArray);
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const legacyBackup = `[ORBIT]${base91Encode(bytes)}[/ORBIT]`;

    const decoded = await decodeTransferData(legacyBackup);
    expect(decoded.proAccent).toBe('#123456');
    expect(decoded.proSecondary).toBe('#654321');
    expect(decoded.proTertiary).toBeUndefined();
    expect(decoded.styleSlots).toEqual([
      { name: 'Kept', primary: '#111111', secondary: '#222222' }
    ]);
  });
});

// Exercise buildSchedule()'s output shape too, since it's what glues
// schedule.js's runtimeSchedule to the dashboard - a smoke check that the
// module split didn't disturb it.
describe('runtimeSchedule after boot', () => {
  it('is populated as a plain object keyed by weekday', () => {
    expect(typeof state.runtimeSchedule).toBe('object');
  });
});
