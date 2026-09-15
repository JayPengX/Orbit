import { beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { buildFixtureData, seedLocalStorage } from './helpers/fixtureData.js';

let describeSettingsDiff;
let settingsDataForExport;

beforeAll(async () => {
  seedLocalStorage();
  await loadApp();
  ({ describeSettingsDiff, settingsDataForExport } = await import('../src/editor-backup.js'));
});

// Regression coverage for a real reported bug: AI import (and manual
// paste-import) both call settingsDataForExport() to read "the current
// settings" for their merge-vs-replace confirm step, straight from the
// standalone transfer sheet - without ever requiring the schedule editor
// sheet to have been opened first (see openTransferSheet in editor-core.js,
// which can open on its own). settingsDataForExport() itself reads the
// editor sheet's own form DOM (#teacher-list, #countdown-event-list, etc.),
// which is only ever populated by openEditor(). Before this fix, a session
// that never opened the schedule editor got back completely empty markup as
// "current" - so picking "合併" (merge) during an AI import looked like a
// merge but actually discarded every existing class and countdown event the
// editor never got a chance to render.
describe('settingsDataForExport reflects saved data even if the editor sheet was never opened', () => {
  it('is not empty on a fresh app load, before openEditor() has ever run', () => {
    expect(document.getElementById('editor-sheet')?.classList.contains('show')).toBe(false);
    const current = settingsDataForExport();
    expect(Object.keys(current.teacherDB).length).toBeGreaterThan(0);
    expect(current.countdownEvents).toEqual([
      { name: '第一次段考', startDate: '2024-01-15', endDate: '2024-01-17' }
    ]);
  });
});

describe('describeSettingsDiff: pure reorder detection', () => {
  it('reports nothing for two identical settings objects', () => {
    const data = buildFixtureData();
    expect(describeSettingsDiff(data, data)).toBe('沒有變更。');
  });

  it('reports a reorder line when only teacherOrder changes', () => {
    const current = buildFixtureData();
    const next = { ...current, teacherOrder: ['C', 'A', 'B'] };
    expect(describeSettingsDiff(current, next)).toMatch(/課程順序已調整/);
  });

  it('does not report a reorder when teacherOrder is unchanged', () => {
    const current = buildFixtureData();
    const next = { ...current, teacherOrder: [...current.teacherOrder] };
    expect(describeSettingsDiff(current, next)).not.toMatch(/課程順序已調整/);
  });

  it('does not report a reorder when a teacher was actually added (not a pure reorder)', () => {
    const current = buildFixtureData();
    const next = {
      ...current,
      teacherDB: { ...current.teacherDB, D: ['歷史', '張老師', ''] },
      teacherOrder: [...current.teacherOrder, 'D']
    };
    const diff = describeSettingsDiff(current, next);
    expect(diff).toMatch(/新增/);
    expect(diff).not.toMatch(/課程順序已調整/);
  });

  it('reports a reorder line when only countdown event order changes', () => {
    const current = {
      ...buildFixtureData(),
      countdownEvents: [
        { name: '段考', startDate: '2024-01-15', endDate: '2024-01-17' },
        { name: '運動會', startDate: '2024-03-01', endDate: '2024-03-01' }
      ]
    };
    const next = { ...current, countdownEvents: [...current.countdownEvents].reverse() };
    expect(describeSettingsDiff(current, next)).toMatch(/倒數活動順序已調整/);
  });
});

describe('describeSettingsDiff: no truncation for a long diff', () => {
  it('keeps every changed line, even well past the old 70-line cap', () => {
    const current = buildFixtureData();
    const manyTeachers = {};
    const order = [];
    for (let i = 0; i < 100; i++) {
      manyTeachers[`t${i}`] = [`科目${i}`, `老師${i}`, ''];
      order.push(`t${i}`);
    }
    const next = { ...current, teacherDB: manyTeachers, teacherOrder: order };
    const diff = describeSettingsDiff(current, next);
    expect(diff).not.toMatch(/還有.*項變更未顯示/);
    // Every one of the 100 new-teacher lines should survive.
    for (let i = 0; i < 100; i++) {
      expect(diff).toContain(`科目${i}`);
    }
  });
});
