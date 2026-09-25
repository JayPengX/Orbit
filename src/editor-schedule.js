// ---- src/editor-schedule.js ----
// The weekly schedule grid and bell-time editor forms.
import { WEEKDAYS_DISPLAY_ORDER, WEEKDAY_LABELS } from './constants.js';
import { state } from './state.js';
import { validateTimeIntervals } from './data.js';
import {
  collectEditorFormState,
  describeSettingsDiff,
  normalizeSettingsData
} from './editor-backup.js';
import {
  editorTimeToMinutes,
  esc,
  findScheduleImpacts,
  getEditorBellPeriodCount,
  getEditorTeacherEntriesFromDom,
  hideEditorDiscardConfirm,
  openEditorFold,
  setEditorConfirmContent,
  showEditorConfirmSheet,
  showEditorSaveConfirm,
  sortEditorPeriodsByTime
} from './editor-core.js';
import { pad2 } from './schedule.js';
import { isSyncViewer, setSyncStatusUi } from './sync.js';
import { t } from './strings.js';

// Renders the day-by-day period selectors from the saved or currently edited
// schedule.
function renderEditorSchedule(weeklyScheduleOverride) {
  const container = document.getElementById('schedule-grid');
  const entries = getEditorTeacherEntriesFromDom();
  const periodCount = getEditorBellPeriodCount();
  const weeklySchedule = weeklyScheduleOverride || state.applicationData.weeklySchedule;

  container.innerHTML = '';

  WEEKDAYS_DISPLAY_ORDER.forEach(day => {
    const row = document.createElement('div');
    const daySchedule = weeklySchedule[day] || [];
    let periodHtml = '';

    row.className = 'schedule-day-row';
    row.dataset.day = String(day);

    for (let i = 0; i < periodCount; i++) {
      const value = daySchedule[i] || '';
      const options = entries
        .map(
          item =>
            `<option value="${esc(item.key)}" title="${esc(item.label)}"${value === item.key ? ' selected' : ''}>${esc(item.label)}</option>`
        )
        .join('');

      periodHtml += `<select class="period-select" data-period="${i}"><option value="">-</option>${options}</select>`;
    }

    row.innerHTML = `<div class="schedule-day-label">${WEEKDAY_LABELS[day]}</div><div class="schedule-periods">${periodHtml}</div>`;
    container.appendChild(row);
  });
}

// Renders editable bell-time rows.
function renderEditorBells() {
  const container = document.getElementById('bell-list');
  container.innerHTML = '';

  state.applicationData.bellTimes.forEach((bellTime, index) => {
    container.appendChild(makeBellRow(index + 1, bellTime[0], bellTime[1]));
  });

  refreshBellNumbers();
}

// Creates one editable class-period time row.
function makeBellRow(number, startValue, endValue) {
  const row = document.createElement('div');
  row.className = 'bell-row';
  row.innerHTML = `<div class="bell-num">${number}</div><div class="bell-inputs"><input class="time-input bell-start" type="time" value="${esc(startValue)}"><span class="time-sep">→</span><input class="time-input bell-end" type="time" value="${esc(endValue)}"></div><button type="button" class="delete-btn" onclick="deleteBellRow(this)" aria-label="${esc(t('editorSchedule.deletePeriod'))}">×</button>`;
  return row;
}

// Renumbers bell rows after adding or deleting periods.
function refreshBellNumbers() {
  document.querySelectorAll('#bell-list .bell-row').forEach((row, index) => {
    row.querySelector('.bell-num').textContent = index + 1;
  });
}

// Adds a new bell-time row using the previous row as a starting point.
function addBellRow() {
  const rows = document.querySelectorAll('#bell-list .bell-row');
  const last = rows[rows.length - 1];
  let startValue = '17:00';
  let endValue = '17:50';

  if (last && last.querySelector('.bell-end')) {
    startValue = last.querySelector('.bell-end').value;
    const [hours, minutes] = startValue.split(':').map(Number);
    const endMinutes = hours * 60 + minutes + 50;
    endValue = `${pad2(Math.floor(endMinutes / 60))}:${pad2(endMinutes % 60)}`;
  }

  const row = makeBellRow(rows.length + 1, startValue, endValue);
  row.classList.add('row-enter');
  document.getElementById('bell-list').appendChild(row);
  refreshBellNumbers();
  const draft = collectEditorFormState();
  renderEditorSchedule(draft.weeklySchedule);
  sortEditorPeriodsByTime();
}

function getBellDeleteImpacts(index) {
  return findScheduleImpacts((select, selectIndex) => selectIndex === index && !!select.value);
}
function applyBellRowDelete(btn) {
  const row = btn.closest('.bell-row');
  const index = Array.from(document.querySelectorAll('#bell-list .bell-row')).indexOf(row);
  if (index < 0) return;
  row.remove();
  document.querySelectorAll('#schedule-grid .schedule-day-row').forEach(dayRow => {
    const select = dayRow.querySelectorAll('.period-select')[index];
    if (select) select.remove();
  });
  refreshBellNumbers();
  const draft = collectEditorFormState();
  renderEditorSchedule(draft.weeklySchedule);
  sortEditorPeriodsByTime();
}
function confirmBellRowDelete() {
  if (!state.pendingBellDelete) {
    hideEditorDiscardConfirm();
    return;
  }
  const btn = state.pendingBellDelete.btn;
  state.pendingBellDelete = null;
  hideEditorDiscardConfirm();
  applyBellRowDelete(btn);
}

// Deletes a bell-time row and rebuilds dependent schedule controls.
function deleteBellRow(btn) {
  const row = btn.closest('.bell-row');
  const index = Array.from(document.querySelectorAll('#bell-list .bell-row')).indexOf(row);
  const impacts = getBellDeleteImpacts(index);
  if (impacts.length) {
    state.pendingBellDelete = { btn, index };
    setEditorConfirmContent(
      t('editorSchedule.deletePeriodTitle', { number: index + 1 }),
      t('editorSchedule.deletePeriodMessage', { number: index + 1 }),
      impacts.join('\n'),
      t('common.delete'),
      confirmBellRowDelete,
      t('common.back'),
      { danger: true }
    );
    showEditorConfirmSheet();
    return;
  }
  applyBellRowDelete(btn);
}

// Renders named break blocks such as cleaning time.
function renderEditorBreaks() {
  const container = document.getElementById('break-list');
  container.innerHTML = '';

  (state.applicationData.breakTimes || []).forEach(item => {
    container.appendChild(makeBreakRow(item.name, item.start, item.end));
  });
  sortEditorBreaksByTime();
}

// Creates one editable named break row.
function makeBreakRow(name, start, end) {
  const row = document.createElement('div');
  row.className = 'bell-row break-row';
  row.innerHTML = `<div class="teacher-fields"><input class="editor-input break-name" placeholder="${esc(t('editorSchedule.namePlaceholder'))}" value="${esc(name || '')}"><div class="bell-inputs"><input class="time-input break-start" type="time" value="${esc(start || '08:50')}"><span class="time-sep">→</span><input class="time-input break-end" type="time" value="${esc(end || '09:10')}"></div></div><button class="delete-btn" onclick="deleteBreakRow(this)" aria-label="${esc(t('editorSchedule.deleteBreak'))}">×</button>`;
  return row;
}

// Adds a blank named break row.
function addBreakRow() {
  const row = makeBreakRow('', '', '');
  row.classList.add('row-enter');
  document.getElementById('break-list').appendChild(row);
  sortEditorBreaksByTime();
}

function sortEditorBreaksByTime() {
  const list = document.getElementById('break-list');
  if (!list) return;
  Array.from(list.querySelectorAll('.break-row'))
    .sort(
      (a, b) =>
        editorTimeToMinutes(a.querySelector('.break-start')?.value) -
        editorTimeToMinutes(b.querySelector('.break-start')?.value)
    )
    .forEach(row => list.appendChild(row));
}

// Deletes a named break row.
function deleteBreakRow(btn) {
  btn.closest('.break-row').remove();
}

// Saves editor changes, rebuilds the schedule, and closes the editor.
function saveEditor() {
  // Belt-and-suspenders: the editor UI already locks itself down for a
  // viewer device (see src/sync.js's applyEditorRoleLock), but this is a
  // plain CSS/pointer-events lock, not real access control (same as the
  // rest of sync - see README). Refusing here too means a save can't slip
  // through even if something bypasses the UI lock.
  if (isSyncViewer()) {
    setSyncStatusUi(t('sync.viewerLockedSave'), true);
    return;
  }
  sortEditorPeriodsByTime();
  sortEditorBreaksByTime();
  const draft = collectEditorFormState();
  try {
    validateTimeIntervals(draft.bellTimes, draft.breakTimes);
  } catch (error) {
    showEditorTimeConflict(error.message, error.conflictKind === 'break');
    return;
  }
  const next = normalizeSettingsData(draft);
  const baseline = state.editorBaselineData || normalizeSettingsData(state.applicationData);
  const diff = describeSettingsDiff(baseline, next);
  state.pendingEditorSaveData = next;
  showEditorSaveConfirm(diff);
}

function showEditorTimeConflict(message, isBreakConflict) {
  setEditorConfirmContent(
    t('editorSchedule.timeOverlapTitle'),
    t('editorSchedule.timeOverlapMessage'),
    message,
    t('editorSchedule.goAdjustTime'),
    () => {
      hideEditorDiscardConfirm();
      openEditorFold(isBreakConflict ? 'editor-fold-breaks' : 'editor-fold-bells');
    },
    t('editorSchedule.backToEditing')
  );
  showEditorConfirmSheet();
}

// Exposed on window for inline HTML event handlers (onclick="..." in
// index.html and in generated template strings).
window.addBellRow = addBellRow;
window.addBreakRow = addBreakRow;
window.deleteBellRow = deleteBellRow;
window.deleteBreakRow = deleteBreakRow;
window.saveEditor = saveEditor;

export {
  refreshBellNumbers,
  renderEditorBells,
  renderEditorBreaks,
  renderEditorSchedule,
  saveEditor
};
