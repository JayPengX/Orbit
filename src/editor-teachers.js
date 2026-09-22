// ---- src/editor-teachers.js ----
// The teacher/subject list editor and the day-by-day period assignment UI.
import { WEEKDAYS_DISPLAY_ORDER, WEEKDAY_LABELS } from './constants.js';
import { state } from './state.js';
import { setOverlayVisible } from './dashboard.js';
import {
  bindEditorCardToggle,
  bindEditorDragReorder,
  esc,
  findScheduleImpacts,
  getEditorBellPeriodCount,
  getEditorClassLabelFromDom,
  hideEditorDiscardConfirm,
  refreshCountdownMoveButtons,
  refreshPeriodSelectOptions,
  setEditorConfirmContent,
  showEditorConfirmSheet
} from './editor-core.js';
import { subjectHue } from './schedule.js';
import { t } from './strings.js';

// refreshPeriodSelectOptions rebuilds every schedule-grid <select>'s full
// option list (one DOM query plus one innerHTML rebuild per select) from
// the live teacher fields - correct to call on every keystroke (the actual
// stored value, restored via `sel.value = cur` inside it, never lags), but
// wasteful to actually run that often. Debounced here for the two keystroke
// listeners below; every other caller (add/delete/reorder) still calls the
// real function directly, since those are one-shot actions, not typing.
let refreshPeriodSelectOptionsTimer = null;
function refreshPeriodSelectOptionsDebounced() {
  clearTimeout(refreshPeriodSelectOptionsTimer);
  refreshPeriodSelectOptionsTimer = setTimeout(refreshPeriodSelectOptions, 150);
}

// Renders the editable teacher list.
function renderEditorTeachers() {
  const container = document.getElementById('teacher-list');
  container.innerHTML = '';

  (state.applicationData.teacherOrder || Object.keys(state.applicationData.teacherDB))
    .filter(key => state.applicationData.teacherDB[key])
    .forEach(key => {
      const val = state.applicationData.teacherDB[key];
      const loc = state.applicationData.locationDB[key] || '';
      container.appendChild(makeTeacherCard(key, val[0], val[1], loc));
    });
  refreshTeacherMoveButtons();
}

// Generates a stable internal id for a class. Never shown or edited by the
// user - it only ever lives in dataset.origKey and the saved data's map keys.
function generateTeacherKey() {
  const existing = new Set(
    [...document.querySelectorAll('#teacher-list .teacher-card')].map(card => card.dataset.origKey)
  );
  let key;
  do {
    key = 'c' + Math.random().toString(36).slice(2, 8);
  } while (existing.has(key));
  return key;
}

// Creates one editable teacher row. Collapsed by default (pass
// options.expanded to start open, used for a freshly-added blank row) so a
// long class list reads as a scannable stack of summaries instead of a wall
// of open fields. Only the drag handle stays on the collapsed summary for
// reordering - the typed 順序 position input moves into the opened body,
// since a tiny always-visible number stepper sitting right next to the
// tap-to-expand area was too easy to bump by accident. Dragging still needs
// real, sustained movement (see bindEditorDragReorder's threshold), so a
// stray tap on the handle itself can't silently reorder the list either.
function makeTeacherCard(key, subject, teacher, location, options = {}) {
  const expanded = !!options.expanded;
  const div = document.createElement('div');
  div.className = expanded ? 'teacher-card is-expanded' : 'teacher-card';
  div.dataset.origKey = key;
  div.innerHTML = `<div class="teacher-card-summary"><div class="teacher-avatar"></div><div class="teacher-summary-text"></div><div class="teacher-order-actions"><span class="teacher-drag-handle" role="button" tabindex="0" title="${esc(t('editorCore.dragToReorder'))}" aria-label="${esc(t('editorCore.dragToReorder'))}">☰</span></div><button type="button" class="teacher-card-toggle" aria-expanded="${expanded}" aria-label="${esc(t('editorCore.expandToEdit'))}">⌄</button></div><div class="teacher-card-body"><div class="teacher-fields"><input class="editor-input tc-subject" placeholder="${esc(t('editorTeachers.subjectPlaceholder'))}" value="${esc(subject)}"><input class="editor-input tc-teacher" placeholder="${esc(t('editorTeachers.teacherPlaceholder'))}" value="${esc(teacher)}"><input class="editor-input tc-location" placeholder="${esc(t('editorTeachers.locationPlaceholderOptional'))}" value="${esc(location || '')}"></div><div class="teacher-card-body-actions"><label class="order-position-label">${esc(t('editorCore.orderLabel'))}<input class="order-position" type="number" min="1" inputmode="numeric" aria-label="${esc(t('editorTeachers.subjectTeacherOrderAriaLabel'))}"></label><div class="teacher-card-buttons"><button type="button" class="teacher-assign" onclick="assignTeacherFromMenu(this)" aria-label="${esc(t('editorTeachers.assignPeriodAriaLabel'))}">${esc(t('editorTeachers.assignButtonLabel'))}</button><button type="button" class="delete-btn" onclick="deleteTeacherCard(this)" aria-label="${esc(t('common.delete'))}">×</button></div></div></div>`;
  updateTeacherCardAvatar(div);
  updateTeacherCardSummary(div);
  bindEditorCardToggle(div);
  const positionInput = div.querySelector('.order-position');
  positionInput.addEventListener('change', event =>
    moveEditorRowToPosition(div, event.target.value, '#teacher-list .teacher-card')
  );
  positionInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveEditorRowToPosition(div, event.target.value, '#teacher-list .teacher-card');
      positionInput.blur();
    }
  });
  bindEditorDragReorder(div, '.teacher-drag-handle', '#teacher-list .teacher-card', () => {
    refreshTeacherMoveButtons();
    refreshPeriodSelectOptions();
  });

  div.querySelector('.tc-subject').addEventListener('input', function () {
    updateTeacherCardAvatar(div);
    updateTeacherCardSummary(div);
    refreshPeriodSelectOptionsDebounced();
  });
  div.querySelector('.tc-teacher').addEventListener('input', function () {
    updateTeacherCardSummary(div);
    refreshPeriodSelectOptionsDebounced();
  });
  return div;
}

// Updates a teacher card's colored initial avatar from its current subject text.
function updateTeacherCardAvatar(card) {
  const avatar = card.querySelector('.teacher-avatar');
  if (!avatar) return;
  const subject = (card.querySelector('.tc-subject')?.value || '').trim();
  const initial = subject ? [...subject][0] : '?';
  const hue = subjectHue(subject);
  avatar.textContent = initial;
  avatar.style.setProperty('--avatar-hue', String(hue));
}

// Updates a collapsed teacher card's one-line summary from its current
// subject text, so the class is still identifiable without opening it.
// Deliberately just the class name (not teacher/location too) - there's
// only so much width on a phone-sized sheet.
function updateTeacherCardSummary(card) {
  const label = card.querySelector('.teacher-summary-text');
  if (!label) return;
  const subject = (card.querySelector('.tc-subject')?.value || '').trim();
  const teacher = (card.querySelector('.tc-teacher')?.value || '').trim();
  label.textContent = subject || teacher || t('editorTeachers.unnamedSubject');
  label.classList.toggle('is-empty', !subject && !teacher);
}

let pendingAssignment = null;
let assignmentDraft = null;
function closeAssignSheet() {
  setOverlayVisible('assign-overlay', 'assign-sheet', false);
  pendingAssignment = null;
  assignmentDraft = null;
}
function openAssignSheet(key) {
  const grid = document.getElementById('assign-grid'),
    subtitle = document.getElementById('assign-subtitle'),
    tabs = document.getElementById('assign-day-tabs');
  if (!grid) return;
  subtitle.textContent = t('editorTeachers.assignSubtitle', {
    label: getEditorClassLabelFromDom(key) || key
  });
  grid.replaceChildren();
  assignmentDraft = { key, original: new Map(), draft: new Map() };
  const count = getEditorBellPeriodCount();
  WEEKDAYS_DISPLAY_ORDER.forEach(day => {
    for (let period = 0; period < count; period++) {
      const select = document
        .querySelector(`#schedule-grid .schedule-day-row[data-day="${day}"]`)
        ?.querySelectorAll('.period-select')[period];
      const slot = `${day}:${period}`,
        original = select?.value || '';
      assignmentDraft.original.set(slot, original);
      assignmentDraft.draft.set(slot, original);
    }
  });
  tabs.replaceChildren();
  WEEKDAYS_DISPLAY_ORDER.forEach(day => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'assign-day-tab';
    tab.dataset.day = day;
    tab.setAttribute('role', 'tab');
    tab.textContent = WEEKDAY_LABELS[day];
    tab.onclick = () => renderAssignmentDay(day);
    tabs.appendChild(tab);
  });
  state.assignmentDay = 1;
  renderAssignmentDay(state.assignmentDay);
  setOverlayVisible('assign-overlay', 'assign-sheet', true);
}
function renderAssignmentDay(day) {
  const grid = document.getElementById('assign-grid');
  if (!grid || !assignmentDraft) return;
  state.assignmentDay = day;
  document.querySelectorAll('#assign-day-tabs .assign-day-tab').forEach(tab => {
    const active = Number(tab.dataset.day) === day;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  grid.replaceChildren();
  const count = getEditorBellPeriodCount();
  const row = document.createElement('div');
  row.className = 'assign-day-row';
  const label = document.createElement('div');
  label.className = 'assign-day-label';
  label.textContent = WEEKDAY_LABELS[day];
  row.appendChild(label);
  const periods = document.createElement('div');
  periods.className = 'assign-periods';
  for (let period = 0; period < count; period++) {
    const slot = `${day}:${period}`,
      value = assignmentDraft.draft.get(slot) || '';
    const valueLabel = value ? getEditorClassLabelFromDom(value) || value : '';
    const box = document.createElement('button');
    box.type = 'button';
    box.dataset.slot = slot;
    box.className =
      'assign-box' +
      (value ? ' occupied' : '') +
      (value === assignmentDraft.key ? ' assigned' : '');
    box.textContent = `${period + 1} · ${valueLabel || '—'}`;
    box.title = value
      ? t('editorTeachers.periodCurrentlyIs', { number: period + 1, value: valueLabel })
      : t('editorTeachers.periodBlank', { number: period + 1 });
    box.onclick = () => assignToSlot(assignmentDraft.key, day, period);
    periods.appendChild(box);
  }
  row.appendChild(periods);
  grid.appendChild(row);
}
function assignToSlot(key, day, period) {
  if (!assignmentDraft) return;
  const slot = `${day}:${period}`,
    box = document.querySelector(`#assign-grid .assign-box[data-slot="${slot}"]`);
  const current = assignmentDraft.draft.get(slot) || '',
    original = assignmentDraft.original.get(slot) || '';
  if (current === key) assignmentDraft.draft.set(slot, original === key ? '' : original);
  else {
    if (current && current !== key) {
      pendingAssignment = { key, day, period };
      setEditorConfirmContent(
        t('editorTeachers.overwriteSlotTitle'),
        t('editorTeachers.overwriteSlotMessage', {
          number: period + 1,
          from: getEditorClassLabelFromDom(current) || current,
          to: getEditorClassLabelFromDom(key) || key
        }),
        '',
        t('editorTeachers.confirmOverwrite'),
        confirmAssignment,
        t('common.back')
      );
      showEditorConfirmSheet();
      return;
    }
    assignmentDraft.draft.set(slot, key);
  }
  if (box) {
    const value = assignmentDraft.draft.get(slot) || '';
    box.textContent = `${period + 1} · ${value ? getEditorClassLabelFromDom(value) || value : '—'}`;
    box.classList.toggle('assigned', value === key);
    box.classList.toggle('occupied', !!value);
  }
}
function confirmAssignment() {
  const pending = pendingAssignment;
  pendingAssignment = null;
  hideEditorDiscardConfirm();
  if (pending && assignmentDraft) {
    assignmentDraft.draft.set(`${pending.day}:${pending.period}`, pending.key);
    renderAssignmentDay(pending.day);
  }
}
function applyAssignments() {
  if (!assignmentDraft) return;
  assignmentDraft.draft.forEach((value, slot) => {
    const [day, period] = slot.split(':').map(Number);
    const select = document
      .querySelector(`#schedule-grid .schedule-day-row[data-day="${day}"]`)
      ?.querySelectorAll('.period-select')[period];
    if (select && select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  closeAssignSheet();
}
function assignTeacherFromMenu(button) {
  const card = button.closest('.teacher-card');
  const key = (card?.dataset.origKey || '').trim();
  if (!key) return;
  openAssignSheet(key);
}
function moveEditorRowToPosition(row, value, selector) {
  const rows = [...document.querySelectorAll(selector)].filter(item => item !== row);
  if (!rows.length) return;
  const position = Math.max(1, Math.min(rows.length + 1, Number.parseInt(value, 10) || 1));
  const target = rows[position - 1];
  if (target) target.parentElement.insertBefore(row, target);
  else rows[rows.length - 1].parentElement.appendChild(row);
  if (row.classList.contains('teacher-card')) {
    refreshTeacherMoveButtons();
    refreshPeriodSelectOptions();
  } else {
    refreshCountdownMoveButtons();
  }
}
function refreshTeacherMoveButtons() {
  const rows = Array.from(document.querySelectorAll('#teacher-list .teacher-card'));
  rows.forEach((row, index) => {
    const input = row.querySelector('.order-position');
    if (input) {
      input.max = String(rows.length);
      input.value = String(index + 1);
    }
  });
}

// Adds a blank teacher row to the editor, opened so it can be filled in
// right away.
function addTeacherRow() {
  const card = makeTeacherCard(generateTeacherKey(), '', '', '', { expanded: true });
  card.classList.add('row-enter');
  document.getElementById('teacher-list').appendChild(card);
  refreshPeriodSelectOptions();
}

function getTeacherDeleteKey(card) {
  return (card?.dataset.origKey || '').trim();
}
function getTeacherDeleteImpacts(key) {
  return findScheduleImpacts(select => select.value === key);
}
function applyTeacherCardDelete(btn) {
  const card = btn.closest('.teacher-card');
  const key = (card?.dataset.origKey || '').trim();
  card?.remove();
  document.querySelectorAll('#schedule-grid .period-select').forEach(select => {
    if (select.value === key) select.value = '';
  });
  refreshPeriodSelectOptions();
}
function confirmTeacherCardDelete() {
  if (!state.pendingTeacherDelete) {
    hideEditorDiscardConfirm();
    return;
  }
  const btn = state.pendingTeacherDelete.btn;
  state.pendingTeacherDelete = null;
  hideEditorDiscardConfirm();
  applyTeacherCardDelete(btn);
}

// Removes a teacher row from the editor.
function deleteTeacherCard(btn) {
  const card = btn.closest('.teacher-card');
  const key = getTeacherDeleteKey(card);
  const label = key ? getEditorClassLabelFromDom(key) || key : '';
  const impacts = key ? getTeacherDeleteImpacts(key) : [];
  if (impacts.length) {
    state.pendingTeacherDelete = { btn, key };
    setEditorConfirmContent(
      t('editorTeachers.deleteTitle', { label }),
      t('editorTeachers.deleteMessage'),
      impacts.join('\n'),
      t('common.delete'),
      confirmTeacherCardDelete,
      t('common.back')
    );
    showEditorConfirmSheet();
    return;
  }
  applyTeacherCardDelete(btn);
}

// Exposed on window for inline HTML event handlers (onclick="..." in
// index.html and in generated template strings).
window.addTeacherRow = addTeacherRow;
window.applyAssignments = applyAssignments;
window.assignTeacherFromMenu = assignTeacherFromMenu;
window.closeAssignSheet = closeAssignSheet;
window.deleteTeacherCard = deleteTeacherCard;

export { closeAssignSheet, moveEditorRowToPosition, renderEditorTeachers, updateTeacherCardAvatar };
