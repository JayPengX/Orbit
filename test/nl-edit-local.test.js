import { describe, expect, it } from 'vitest';
import { parseLocalNlEdit } from '../src/nl-edit-local.js';
import { buildFixtureData } from './helpers/fixtureData.js';

// Fixture: 週一 = [A 數學, B 國文/公民, C 英文], 週三 = [A 數學, '', ''],
// three bell periods. Inputs are written the way normalizeNlEditText hands
// them over (NFKC-folded, a 的 between a day and run-together periods).
const current = buildFixtureData();
const edits = text => parseLocalNlEdit(text, current)?.scheduleEdits;

describe('parseLocalNlEdit - swap', () => {
  it.each([
    '星期一的一二節對調',
    '週一的1-2節對調',
    '週一第一節和第二節交換',
    '把週一第一、二節互換',
    '幫我把週一的第一節跟第二節的課對調一下',
    '週一1、2節對調'
  ])('%s', text => {
    expect(edits(text)).toEqual([
      { day: 1, period: 0, key: 'B' },
      { day: 1, period: 1, key: 'A' }
    ]);
  });

  it('swaps across days', () => {
    expect(edits('週一第三節和週三第一節對調')).toEqual([
      { day: 1, period: 2, key: 'A' },
      { day: 3, period: 0, key: 'C' }
    ]);
  });

  it('returns a full ok patch the rest of the pipeline accepts', () => {
    expect(parseLocalNlEdit('週一的一二節對調', current)).toMatchObject({
      status: 'ok',
      classUpserts: [],
      deletedClassKeys: [],
      bellTimesChanged: false,
      breakTimesChanged: false,
      countdownEventsChanged: false,
      reverseWeekChanged: false
    });
  });
});

describe('parseLocalNlEdit - clear', () => {
  it.each(['清空週一第二節', '把週一第二節刪掉', '週一第二節改成空堂', '週一第二節取消'])(
    '%s',
    text => {
      expect(edits(text)).toEqual([{ day: 1, period: 1, key: '' }]);
    }
  );

  it('clears a range', () => {
    expect(edits('清空週一第一到三節')).toEqual([
      { day: 1, period: 0, key: '' },
      { day: 1, period: 1, key: '' },
      { day: 1, period: 2, key: '' }
    ]);
  });
});

describe('parseLocalNlEdit - set to an existing class', () => {
  it.each(['週三第二節改成英文', '把週三第二節換成英文課', '週三的第二節改為英文。'])(
    '%s',
    text => {
      expect(edits(text)).toEqual([{ day: 3, period: 1, key: 'C' }]);
    }
  );

  it('matches an odd/even split class by its full subject', () => {
    expect(edits('週三第三節改成國文/公民')).toEqual([{ day: 3, period: 2, key: 'B' }]);
  });
});

describe('parseLocalNlEdit - move', () => {
  it('moves a class into an empty period', () => {
    expect(edits('把週三第一節移到週三第二節')).toEqual([
      { day: 3, period: 0, key: '' },
      { day: 3, period: 1, key: 'A' }
    ]);
  });
});

describe('parseLocalNlEdit - leaves everything else to the AI', () => {
  it.each([
    ['a class that does not exist yet', '週三第二節改成物理'],
    ['half of a split class', '週三第二節改成國文'],
    ['a period past the last bell time', '週一第四節和第五節對調'],
    ['a merged multi-digit period', '週一23節對調'],
    ['moving onto an occupied period', '把週一第一節移到週一第二節'],
    ['several days, one period', '週一二第三節對調'],
    ['a multi-part instruction', '週一的一二節對調，然後清空週三第一節'],
    ['a swap naming three periods', '週一第一二三節對調'],
    ['a reference by class name', '把數學課和英文課對調'],
    ['no day at all', '第一節和第二節對調'],
    ['a bell time change', '第一節改成八點開始'],
    ['a new class', '新增一個課程叫社團活動'],
    ['a relative day', '今天第一節改成英文']
  ])('%s', (_label, text) => {
    expect(parseLocalNlEdit(text, current)).toBeNull();
  });

  it('refuses a subject shared by two classes', () => {
    const data = buildFixtureData();
    data.teacherDB.D = ['英文', '張老師', ''];
    expect(parseLocalNlEdit('週三第二節改成英文', data)).toBeNull();
  });
});
