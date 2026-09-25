// ---- src/editor-core.js ----
// The schedule editor's main open/close/save flow and its confirmation
// sheets (unsaved-changes, delete-row); the other editor-*.js modules own
// one specific sub-form each and are driven from here.
import { state } from './state.js';
import { closeStylePanel, openStylePanel } from './appearance.js';
import { closeTestPanel, getCountdownEvents, setOverlayVisible } from './dashboard.js';
import {
  applyPendingSaveEditor,
  collectEditorFormState,
  dayDiffLabel,
  decodeTransferData,
  describeSettingsDiff,
  editorFormSnapshotString,
  formatClassRef,
  isEditorDirty,
  normalizeSettingsData,
  resetOCRImporterUI,
  setTransferStatus,
  settingsDataForExport
} from './editor-backup.js';
import {
  refreshBellNumbers,
  renderEditorBells,
  renderEditorBreaks,
  renderEditorSchedule
} from './editor-schedule.js';
import {
  closeAssignSheet,
  moveEditorRowToPosition,
  renderEditorTeachers
} from './editor-teachers.js';
// Circular import, same as sync.js <-> editor-backup.js <-> appearance.js
// elsewhere in this codebase - safe because every use here is inside a
// function body (openEditor/toggleTestPanel-equivalent checks), never at
// module-evaluation time.
import { clearSyncInputFields, isSyncViewer } from './sync.js';
import { t } from './strings.js';

// Builds a short display label for a class from its subject/teacher text.
// Teacher is appended in parentheses whenever the subject alone would be
// ambiguous (shared by another class) or when the subject is blank.
function formatClassLabel(subject, teacher, needsTeacher) {
  const cleanSubject = (subject || '').trim();
  const cleanTeacher = (teacher || '').trim();
  if (!cleanSubject) return cleanTeacher || t('editorCore.unnamedClassLabel');
  if (needsTeacher && cleanTeacher) return `${cleanSubject}（${cleanTeacher}）`;
  return cleanSubject;
}
// Collects available classes (key + display label) from the editor form's
// live subject/teacher inputs, so labels stay accurate mid-edit.
function getEditorTeacherEntriesFromDom() {
  const cards = [...document.querySelectorAll('#teacher-list .teacher-card')];
  const rows = cards
    .map(card => ({
      key: (card.dataset.origKey || '').trim(),
      subject: (card.querySelector('.tc-subject')?.value || '').trim(),
      teacher: (card.querySelector('.tc-teacher')?.value || '').trim()
    }))
    .filter(row => row.key);
  const subjectCounts = {};
  rows.forEach(row => {
    subjectCounts[row.subject] = (subjectCounts[row.subject] || 0) + 1;
  });
  const seen = new Set();
  const entries = [];
  rows.forEach(row => {
    if (seen.has(row.key)) return;
    seen.add(row.key);
    entries.push({
      key: row.key,
      label: formatClassLabel(row.subject, row.teacher, subjectCounts[row.subject] > 1)
    });
  });
  return entries;
}
// Looks up a single class's display label by key from the editor form's live inputs.
function getEditorClassLabelFromDom(key) {
  const entry = getEditorTeacherEntriesFromDom().find(item => item.key === key);
  return entry ? entry.label : '';
}
// Returns how many bell periods the editor should render.
function getEditorBellPeriodCount() {
  const n = document.querySelectorAll('#bell-list .bell-row').length;
  return n > 0 ? n : (state.applicationData.bellTimes || []).length;
}
// Converts an HH:MM value into minutes for editor sorting.
function editorTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return 9999;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}
// Sorts bell rows by start time and moves the matching schedule dropdowns with them.
function sortEditorPeriodsByTime() {
  const bellList = document.getElementById('bell-list');
  const rows = Array.from(bellList.querySelectorAll('.bell-row'));
  if (rows.length < 2) return;

  const ordered = rows
    .map((row, index) => ({
      row,
      index,
      start: editorTimeToMinutes(row.querySelector('.bell-start')?.value),
      end: editorTimeToMinutes(row.querySelector('.bell-end')?.value)
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  if (ordered.every((item, newIndex) => item.index === newIndex)) return;

  ordered.forEach(item => bellList.appendChild(item.row));

  document.querySelectorAll('#schedule-grid .schedule-day-row').forEach(dayRow => {
    const periods = dayRow.querySelector('.schedule-periods');
    const selects = Array.from(periods.querySelectorAll('.period-select'));
    ordered.forEach((item, newIndex) => {
      const select = selects[item.index];
      if (select) {
        select.dataset.period = String(newIndex);
        periods.appendChild(select);
      }
    });
  });

  refreshBellNumbers();
}
// Refreshes every class-period dropdown after teacher keys or names change.
function refreshPeriodSelectOptions() {
  const entries = getEditorTeacherEntriesFromDom();
  document.querySelectorAll('#schedule-grid .period-select').forEach(sel => {
    const cur = sel.value;
    const list =
      entries.some(item => item.key === cur) || !cur
        ? entries
        : entries.concat({ key: cur, label: cur });
    const opts =
      `<option value="">-</option>` +
      list
        .map(
          item =>
            `<option value="${esc(item.key)}" title="${esc(item.label)}">${esc(item.label)}</option>`
        )
        .join('');
    sel.innerHTML = opts;
    sel.value = cur;
  });
}
// Sets a status line's text/color - shared by the transfer sheet's and the
// sync panel's near-identical status messages.
function setStatusText(elementId, message, isError = false) {
  const status = document.getElementById(elementId);
  if (!status) return;
  status.textContent = message || '';
  status.style.color = isError ? '#ff6b6b' : 'var(--sub)';
}
// Finds schedule-grid cells matching `matchFn(select, index)`, formatted as
// "$day 第 $period 節：$classRef" - shared by the teacher-delete and
// bell-row-delete confirmation sheets, which each warn about exactly this
// before removing something a schedule cell still references.
function findScheduleImpacts(matchFn) {
  const data = collectEditorFormState();
  const impacts = [];
  document.querySelectorAll('#schedule-grid .schedule-day-row').forEach(dayRow => {
    const day = parseInt(dayRow.dataset.day, 10);
    dayRow.querySelectorAll('.period-select').forEach((select, index) => {
      if (matchFn(select, index))
        impacts.push(
          t('editorCore.scheduleImpactLine', {
            day: dayDiffLabel(day),
            number: index + 1,
            ref: formatClassRef(select.value, data)
          })
        );
    });
  });
  return impacts;
}
// Escapes text before inserting it into generated HTML.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Opens the schedule editor and prepares its editable fields.
// Editor navigation and confirmation sheets manage unsaved changes safely.
//
// A viewer device is refused outright, full stop - unlike the style tool's
// opt-out-dependent lock, there's no case where a viewer should ever get
// into the schedule editor at all (see applyEditorRoleLock in sync.js,
// which disables the triggering #btn-edit itself for exactly this reason -
// this is the real access check behind that CSS/pointer-events lock, same
// belt-and-suspenders reasoning as every other role guard in this app).
function openEditor() {
  if (isSyncViewer()) return;
  closeAssignSheet();
  hideEditorDiscardConfirm();
  closeTestPanel();
  document.querySelector('.top-actions')?.classList.remove('open');

  setOverlayVisible('editor-sheet-overlay', 'editor-sheet', true, 'editor-open');
  applyOfflineLock();

  try {
    renderEditorTeachers();
    renderEditorBells();
    renderEditorBreaks();
    renderEditorSchedule();
    renderCountdownEvent();
    sortEditorPeriodsByTime();
    syncEditorToggles();
    orderEditorFolds();
    moveEditorControlsIntoLayers();
    ensureEditorBackButtons();
    openEditorFold('editor-fold-schedule');
    state.editorBaselineSnapshot = editorFormSnapshotString();
    state.editorBaselineData = settingsDataForExport();
  } catch (error) {
    console.error(error);
  }
}

// Opens the standalone "同步 / 匯入匯出" sheet - sync setup, manual
// export/import, AI photo import, and (tucked away as an intentionally-
// activated advanced disclosure) time simulation. Split out from the
// schedule editor entirely so a sync viewer, who's never allowed into the
// schedule editor at all (see openEditor above), can still reach this -
// pairing status, unlink, and AI import/manual import each have their own
// narrower guard instead (see applyEditorRoleLock).
function openTransferSheet() {
  const editor = document.getElementById('editor-sheet');
  if (editor && editor.classList.contains('show')) {
    if (isEditorDirty()) {
      state.pendingAfterEditorDiscard = 'transfer';
      showEditorDiscardConfirm();
      return;
    }
    closeEditor(true);
  }
  hideEditorDiscardConfirm();
  closeTestPanel();
  closeStylePanel();
  document.querySelector('.top-actions')?.classList.remove('open');
  setOverlayVisible('transfer-sheet-overlay', 'transfer-sheet', true, 'transfer-open');
  setTransferStatus('');
  applyOfflineLock();
}

// AI import and setting up sync (creating or joining) both need a real
// network request the moment they're used; there's no point leaving them
// looking usable while there's plainly no connection at all. Checked right
// when the transfer sheet opens (openTransferSheet's actual moment of
// interest), and kept live afterward via the online/offline listeners below
// in case connectivity changes while it's still open - no need to close and
// reopen to notice. navigator.onLine only reliably catches "no network
// interface at all" (e.g. airplane mode), not "connected but no real
// internet", but that's still worth catching for free - the actual network
// calls underneath still have their own error handling for everything else.
// Unlinking an existing sync (pure local state) and manual export/import
// (also pure local) are deliberately left alone - neither needs a network.
// A function, not a plain constant, so it re-resolves against whatever
// locale is active at the moment it's actually shown - a module-level
// constant would freeze in whatever locale was active when this module
// first loaded, and never pick up a later language switch.
function offlineMessage() {
  return t('editorCore.offlineMessage');
}
// Toggles .is-offline on both sheets that can host a network-dependent AI
// box - the transfer sheet (AI import, sync) and the schedule editor
// (#nl-edit-box, see index.html) - rather than just whichever one happens
// to be open right now, so either one is already in the right state the
// moment it's opened instead of needing its own separate call site.
function applyOfflineLock() {
  const transferSheet = document.getElementById('transfer-sheet');
  const editorSheet = document.getElementById('editor-sheet');
  if (!transferSheet && !editorSheet) return;
  const offline = !navigator.onLine;
  const wasOffline =
    !!transferSheet?.classList.contains('is-offline') ||
    !!editorSheet?.classList.contains('is-offline');
  transferSheet?.classList.toggle('is-offline', offline);
  editorSheet?.classList.toggle('is-offline', offline);
  const ocrStatus = document.getElementById('ocr-import-status');
  const syncStatus = document.getElementById('sync-status');
  const nlEditStatus = document.getElementById('nl-edit-status');
  if (offline) {
    const message = offlineMessage();
    if (ocrStatus) ocrStatus.textContent = message;
    if (syncStatus) syncStatus.textContent = message;
    if (nlEditStatus) nlEditStatus.textContent = message;
  } else if (wasOffline) {
    // Only clear it if it's still showing our own message - connectivity
    // could have come back after some other, more recent status (a real
    // recognition error, a sync result) already replaced it.
    const message = offlineMessage();
    if (ocrStatus?.textContent === message) ocrStatus.textContent = '';
    if (syncStatus?.textContent === message) syncStatus.textContent = '';
    if (nlEditStatus?.textContent === message) nlEditStatus.textContent = '';
  }
}
window.addEventListener('online', applyOfflineLock);
window.addEventListener('offline', applyOfflineLock);

function orderEditorFolds() {
  const body = document.getElementById('editor-sheet-body');
  const saveBtn = body && body.querySelector('.save-btn');
  if (!body || !saveBtn) return;
  [
    'editor-fold-schedule',
    'editor-fold-countdown',
    'editor-fold-teachers',
    'editor-fold-bells',
    'editor-fold-breaks'
  ].forEach(id => {
    const section = document.getElementById(id);
    if (section) body.insertBefore(section, saveBtn);
  });
}
// Toggles a collapsible editor tile's body open/closed on click - shared by
// teacher cards and countdown events, the two editor lists built on this
// same collapsed-summary/drag-handle/expandable-body shell. Ignores clicks
// on the drag handle so dragging to reorder still works without opening
// the card.
function bindEditorCardToggle(card) {
  const summary = card.querySelector('.teacher-card-summary');
  summary.addEventListener('click', event => {
    if (event.target.closest('.teacher-order-actions')) return;
    setEditorCardExpanded(card, !card.classList.contains('is-expanded'));
  });
}
function setEditorCardExpanded(card, expanded) {
  card.classList.toggle('is-expanded', expanded);
  card.querySelector('.teacher-card-toggle')?.setAttribute('aria-expanded', String(expanded));
}
function renderCountdownEvent() {
  const list = document.getElementById('countdown-event-list');
  if (!list) return;
  list.innerHTML = '';
  getCountdownEvents().forEach((event, index) => addCountdownEventRow(event, index));
  refreshCountdownMoveButtons();
}
// Built on the exact same collapsible-tile shell as makeTeacherCard in
// editor-teachers.js (.teacher-card/-summary/-body/-toggle, the drag handle,
// the 順序 position input relocated into the body) - same reasoning applies
// here too: a dozen countdown events would otherwise mean a dozen fully open
// name+date-range forms to scroll past.
function addCountdownEventRow(event = { name: '', startDate: '', endDate: '' }, index) {
  const list = document.getElementById('countdown-event-list');
  if (!list || list.children.length >= 12) return;
  const expanded = index === undefined;
  const row = document.createElement('div');
  row.className = expanded
    ? 'teacher-card countdown-event-row is-expanded row-enter'
    : 'teacher-card countdown-event-row';
  row.innerHTML = `<div class="teacher-card-summary"><div class="teacher-summary-text"></div><div class="teacher-order-actions"><span class="teacher-drag-handle" role="button" tabindex="0" title="${esc(t('editorCore.dragToReorder'))}" aria-label="${esc(t('editorCore.dragToReorder'))}">☰</span></div><button type="button" class="teacher-card-toggle" aria-expanded="${expanded}" aria-label="${esc(t('editorCore.expandToEdit'))}">⌄</button></div><div class="teacher-card-body"><div class="countdown-event-fields"><label>${esc(t('editorCore.eventNameLabel'))}<input class="editor-input countdown-event-name" maxlength="80" placeholder="例如：116 學測"></label><label class="countdown-event-daterange-label">${esc(t('editorCore.dateLabel'))}<div class="countdown-date-range"><input class="editor-input countdown-event-start" type="date" aria-label="${esc(t('editorCore.startDateLabel'))}"><span class="time-sep">→</span><input class="editor-input countdown-event-end" type="date" aria-label="${esc(t('editorCore.endDateLabel'))}"></div></label></div><div class="teacher-card-body-actions"><label class="order-position-label">${esc(t('editorCore.orderLabel'))}<input class="order-position" type="number" min="1" inputmode="numeric" aria-label="${esc(t('editorCore.countdownOrderAriaLabel'))}"></label><div class="teacher-card-buttons"><button type="button" class="delete-btn" aria-label="${esc(t('editorCore.removeCountdownAriaLabel'))}">×</button></div></div></div>`;
  const nameInput = row.querySelector('.countdown-event-name');
  const summaryText = row.querySelector('.teacher-summary-text');
  nameInput.value = event.name;
  summaryText.textContent = event.name.trim() || t('editorCore.countdownEventFallback');
  nameInput.addEventListener('input', () => {
    summaryText.textContent = nameInput.value.trim() || t('editorCore.countdownEventFallback');
  });
  const startInput = row.querySelector('.countdown-event-start');
  const endInput = row.querySelector('.countdown-event-end');
  startInput.value = event.startDate || event.date || '';
  endInput.value = event.endDate || event.date || '';
  startInput.addEventListener('change', () => {
    if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
  });
  row.querySelector('.delete-btn').addEventListener('click', () => {
    if (list.children.length > 1) row.remove();
    else row.querySelectorAll('input').forEach(input => (input.value = ''));
  });
  bindEditorCardToggle(row);
  list.appendChild(row);
  row.querySelector('.order-position').value = String(list.children.length);
  const positionInput = row.querySelector('.order-position');
  positionInput.addEventListener('change', event =>
    moveEditorRowToPosition(row, event.target.value, '#countdown-event-list .countdown-event-row')
  );
  positionInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveEditorRowToPosition(
        row,
        event.target.value,
        '#countdown-event-list .countdown-event-row'
      );
      positionInput.blur();
    }
  });
  bindCountdownDrag(row);
  refreshCountdownMoveButtons();
}
function refreshCountdownMoveButtons() {
  const rows = [...document.querySelectorAll('#countdown-event-list .countdown-event-row')];
  rows.forEach((row, index) => {
    row
      .querySelector('.teacher-drag-handle')
      ?.setAttribute('aria-label', t('editorCore.dragCountdownReorderAriaLabel'));
    const input = row.querySelector('.order-position');
    if (input) {
      input.max = String(rows.length);
      input.value = String(index + 1);
    }
  });
}
function getEditorScrollContainer(handle) {
  const sheet = handle.closest('.editor-sheet');
  if (!sheet) return null;
  const body = sheet.querySelector('#editor-sheet-body');
  const activeFold = sheet.querySelector('details.editor-fold.active .editor-fold-body');
  const candidates = [activeFold, body, sheet].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.scrollHeight > candidate.clientHeight) return candidate;
  }
  return body || sheet;
}
function autoScrollEditorWhileDragging(handle, clientY) {
  const scroller = getEditorScrollContainer(handle);
  if (!scroller) return;
  const bounds = scroller.getBoundingClientRect();
  const edge = 72;
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (clientY < bounds.top + edge) {
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop - Math.ceil((bounds.top + edge - clientY) / 4)
    );
  } else if (clientY > bounds.bottom - edge) {
    scroller.scrollTop = Math.min(
      maxScroll,
      scroller.scrollTop + Math.ceil((clientY - (bounds.bottom - edge)) / 4)
    );
  }
}
// Shared vertical drag-to-reorder for editor list rows (teacher cards, countdown
// events): drags `row` by the handle matching `handleSelector`, reordering it among
// its siblings matching `siblingsSelector`, auto-scrolling the editor sheet near its
// edges, and calling `onMove` (if given) after every reorder and once dragging ends.
//
// The handle keeps touch-action:none permanently (see its CSS) - reordering has to
// own the whole gesture, since Chromium (confirmed by hand: toggling touch-action
// after touchstart does nothing) decides once, at the very first touch, whether a
// touch sequence is allowed to scroll natively at all, before any JS ever runs.
// Because of that, a touch on the handle used to always start reordering, even a
// fast swipe through it meant only to scroll the list (reported as "it happens
// when I am scrolling").
//
// On touch, a press now only arms real reordering after HOLD_MS of holding still
// (the same idea Sortable.js's touch `delay` option uses). If the finger instead
// moves past MOVE_THRESHOLD_PX before that - a swipe, not a hold-and-grab - this
// scrolls the editor sheet by hand for the rest of that gesture instead: touch-
// action:none already told the browser not to do it natively, so nothing else
// will. A mouse press has no such conflict (there's no separate mouse gesture
// fighting for the same button) and arms immediately, exactly as before.
function bindEditorDragReorder(row, handleSelector, siblingsSelector, onMove) {
  const handle = row.querySelector(handleSelector);
  if (!handle || handle.dataset.bound) return;
  handle.dataset.bound = '1';
  handle.style.touchAction = 'none';
  const MOVE_THRESHOLD_PX = 8;
  const HOLD_MS = 150;
  let tracking = false;
  let engaged = false;
  let scrolling = false;
  let pointerType = 'mouse';
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let scrollFrame = 0;
  let armTimer = 0;
  const reorderTo = clientY => {
    lastY = clientY;
    autoScrollEditorWhileDragging(handle, clientY);
    const siblings = [...document.querySelectorAll(siblingsSelector)].filter(item => item !== row);
    const target = siblings.find(
      item => clientY < item.getBoundingClientRect().top + item.offsetHeight / 2
    );
    if (target) target.parentElement.insertBefore(row, target);
    else if (siblings.length) siblings[siblings.length - 1].parentElement.appendChild(row);
    onMove?.();
  };
  const engage = () => {
    if (!tracking || engaged || scrolling) return;
    engaged = true;
    row.classList.add('is-dragging');
    scrollFrame = requestAnimationFrame(autoScroll);
  };
  const move = event => {
    if (!tracking) return;
    event.preventDefault();
    if (engaged) {
      reorderTo(event.clientY);
      return;
    }
    if (scrolling) {
      const scroller = getEditorScrollContainer(handle);
      if (scroller) scroller.scrollTop -= event.clientY - lastY;
      lastY = event.clientY;
      return;
    }
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy < MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) return;
    clearTimeout(armTimer);
    if (pointerType === 'touch') {
      scrolling = true;
      lastY = event.clientY;
    } else {
      engage();
      reorderTo(event.clientY);
    }
  };
  const autoScroll = () => {
    if (!engaged) return;
    const scroller = getEditorScrollContainer(handle);
    const before = scroller?.scrollTop || 0;
    autoScrollEditorWhileDragging(handle, lastY);
    if (scroller && scroller.scrollTop !== before) reorderTo(lastY);
    scrollFrame = requestAnimationFrame(autoScroll);
  };
  const finish = event => {
    if (!tracking) return;
    tracking = false;
    scrolling = false;
    clearTimeout(armTimer);
    if (engaged) {
      engaged = false;
      row.classList.remove('is-dragging');
      cancelAnimationFrame(scrollFrame);
    }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('blur', finish);
    if (event?.pointerId !== undefined && handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    onMove?.();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    tracking = true;
    engaged = false;
    scrolling = false;
    pointerType = event.pointerType;
    startX = event.clientX;
    startY = event.clientY;
    lastY = event.clientY;
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    armTimer = setTimeout(engage, pointerType === 'touch' ? HOLD_MS : 0);
  });
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}
function bindCountdownDrag(row) {
  bindEditorDragReorder(row, '.teacher-drag-handle', '#countdown-event-list .countdown-event-row');
}
function moveEditorControlsIntoLayers() {
  const sheet = document.getElementById('editor-sheet');
  const scheduleBody = document.querySelector('#editor-fold-schedule .editor-fold-body');
  const options = document.getElementById('editor-fold-options');
  const toggleRow = options && options.querySelector('.toggle-row');
  const drillActions = scheduleBody && scheduleBody.querySelector('.editor-drill-actions');
  if (sheet) sheet.classList.add('is-layered');
  if (toggleRow && scheduleBody && !scheduleBody.querySelector('.editor-inline-options')) {
    const wrap = document.createElement('div');
    wrap.className = 'editor-inline-options';
    wrap.appendChild(toggleRow);
    if (drillActions) scheduleBody.insertBefore(wrap, drillActions);
    else scheduleBody.prepend(wrap);
  }
  if (options) options.style.display = 'none';
}
function ensureEditorBackButtons() {
  document.querySelectorAll('#editor-sheet details.editor-fold').forEach(section => {
    if (section.hasAttribute('data-no-back-button')) return;
    if (section.closest('#ocr-import-result')) return;
    const body = section.querySelector('.editor-fold-body');
    if (!body || body.querySelector('.editor-back-row')) return;
    const row = document.createElement('div');
    row.className = 'editor-back-row';
    row.innerHTML = `<button type="button" class="editor-back-btn" onclick="openEditorFold('editor-fold-schedule')">${esc(t('editorCore.backToSchedule'))}</button>`;
    body.prepend(row);
  });
}
function clearTransferField() {
  const text = document.getElementById('settings-transfer-text');
  if (text) {
    text.value = '';
    text.blur();
  }
  setTransferStatus('');
}
function openEditorFold(id) {
  document.querySelectorAll('#editor-sheet details.editor-fold').forEach(section => {
    const active = section.id === id;
    section.open = active;
    section.classList.toggle('active', active);
  });
}

function setEditorConfirmContent(
  title,
  message,
  diffText,
  confirmLabel,
  confirmHandler,
  cancelLabel = t('common.cancel'),
  options = {}
) {
  const sheet = document.getElementById('editor-confirm-sheet');
  const titleEl = document.getElementById('editor-confirm-title');
  const msgEl = document.getElementById('editor-confirm-msg');
  const overlay = document.getElementById('editor-confirm-overlay');
  const buttons = sheet.querySelectorAll('.editor-confirm-btn');
  const cancelBtn = buttons[0];
  const confirmBtn = buttons[1];
  let extraBtn = document.getElementById('editor-confirm-extra-btn');
  if (!extraBtn) {
    extraBtn = document.createElement('button');
    extraBtn.id = 'editor-confirm-extra-btn';
    extraBtn.type = 'button';
    extraBtn.className = 'editor-confirm-btn';
    sheet.querySelector('.editor-confirm-actions').appendChild(extraBtn);
  }
  const canCancel = cancelLabel !== null && !options.required;
  let diffEl = document.getElementById('editor-import-diff');
  if (!diffEl) {
    diffEl = document.createElement('div');
    diffEl.id = 'editor-import-diff';
    diffEl.className = 'editor-import-diff';
    msgEl.insertAdjacentElement('afterend', diffEl);
  }
  titleEl.textContent = title;
  msgEl.textContent = message;
  diffEl.textContent = diffText || '';
  diffEl.scrollTop = 0;
  diffEl.style.display = diffText ? 'block' : 'none';
  cancelBtn.style.display = canCancel ? '' : 'none';
  cancelBtn.textContent = canCancel ? cancelLabel : '';
  cancelBtn.onclick = canCancel ? options.cancelHandler || hideEditorDiscardConfirm : null;
  // One colour rule for every dialog this sheet hosts: the button that just
  // backs out (or picks the other option) is neutral, the dialog's own
  // action is the filled accent button, and only an action that deletes,
  // discards or overwrites something (options.danger) is red.
  cancelBtn.classList.remove('primary', 'danger');
  confirmBtn.classList.toggle('danger', !!options.danger);
  confirmBtn.classList.toggle('primary', !options.danger);
  extraBtn.style.display = options.extraLabel ? '' : 'none';
  extraBtn.textContent = options.extraLabel || '';
  extraBtn.onclick = options.extraLabel ? options.extraHandler || hideEditorDiscardConfirm : null;
  // extraBtn is a singleton reused across every caller of this function, so
  // its danger styling has to be reset on every call - otherwise a
  // destructive extra option (e.g. sync's "整個刪除同步") would leak its
  // red styling onto the next, unrelated dialog's plain extra button.
  extraBtn.classList.toggle('danger', !!options.extraDanger);
  // Three buttons stack (see .editor-confirm-actions.has-extra): the action
  // on top and the button that only closes the sheet always last - that's
  // the cancel slot unless a caller turned it into a second choice
  // (options.cancelHandler) and put Cancel on the extra button instead.
  const actions = sheet.querySelector('.editor-confirm-actions');
  const hasExtra = !!options.extraLabel;
  actions.classList.toggle('has-extra', hasExtra);
  confirmBtn.style.order = hasExtra ? '0' : '';
  cancelBtn.style.order = hasExtra ? (options.cancelHandler ? '1' : '2') : '';
  extraBtn.style.order = hasExtra ? (options.cancelHandler ? '2' : '1') : '';
  overlay.onclick = canCancel
    ? hideEditorDiscardConfirm
    : function (event) {
        event.stopPropagation();
      };
  confirmBtn.textContent = confirmLabel;
  confirmBtn.onclick = confirmHandler;
}
function showEditorConfirmSheet() {
  setOverlayVisible('editor-confirm-overlay', 'editor-confirm-sheet', true);
}
function getEditorUnsavedDiff() {
  try {
    sortEditorPeriodsByTime();
    return describeSettingsDiff(
      state.editorBaselineData || normalizeSettingsData(state.applicationData),
      settingsDataForExport()
    );
  } catch {
    return '';
  }
}
// Unsaved-schedule-changes only now - pasted-text/AI-photo import data lives
// entirely in the standalone transfer sheet these days (see
// showTransferDiscardConfirm below), so there's nothing else this sheet's
// own close needs to warn about.
function showEditorDiscardConfirm() {
  setEditorConfirmContent(
    t('editorCore.discardChangesTitle'),
    t('editorCore.discardChangesMessage'),
    getEditorUnsavedDiff(),
    t('editorCore.discard'),
    discardEditorChangesAndClose,
    t('common.back'),
    { danger: true }
  );
  showEditorConfirmSheet();
}
// The transfer sheet's counterpart to showEditorDiscardConfirm above -
// pasted-text or AI/OCR import data that was never actually applied isn't
// reflected in any settings diff, so it gets its own explanation of what's
// about to be lost instead.
function showTransferDiscardConfirm() {
  setEditorConfirmContent(
    t('editorCore.unimportedContentTitle'),
    getUnconsumedImportWarningText(),
    '',
    t('editorCore.discardAndLeaveTransfer'),
    discardTransferChangesAndClose,
    t('common.back'),
    { danger: true }
  );
  showEditorConfirmSheet();
}
function showEditorSaveConfirm(diffText) {
  setEditorConfirmContent(
    t('editorCore.saveChangesTitle'),
    t('editorCore.saveChangesMessage'),
    diffText,
    t('common.save'),
    applyPendingSaveEditor,
    t('common.back')
  );
  showEditorConfirmSheet();
}
// Hides the discard confirmation sheet.
function hideEditorDiscardConfirm() {
  state.pendingAfterEditorDiscard = null;
  state.pendingEditorImportData = null;
  state.pendingEditorSaveData = null;
  state.pendingBellDelete = null;
  state.pendingTeacherDelete = null;
  state.pendingStyleSaveData = null;
  state.pendingStyleSlotIndex = null;
  state.pendingStyleSlotSaveIndex = null;
  const diffEl = document.getElementById('editor-import-diff');
  if (diffEl) diffEl.scrollTop = 0;
  setOverlayVisible('editor-confirm-overlay', 'editor-confirm-sheet', false);
}

// Discards editor changes and closes the editor.
function discardEditorChangesAndClose() {
  const pending = state.pendingAfterEditorDiscard;
  state.pendingAfterEditorDiscard = null;
  hideEditorDiscardConfirm();
  closeEditor(true);
  applyPendingSheetAfterDiscard(pending);
}
// The transfer sheet's counterpart to discardEditorChangesAndClose above.
function discardTransferChangesAndClose() {
  const pending = state.pendingAfterEditorDiscard;
  state.pendingAfterEditorDiscard = null;
  hideEditorDiscardConfirm();
  closeTransferSheet(true);
  applyPendingSheetAfterDiscard(pending);
}
// Shared by both discard-and-close flows above - whichever sheet the user
// was actually trying to switch to when the discard warning interrupted
// them (see openTransferSheet/toggleTestPanel/toggleStylePanel, which each
// set state.pendingAfterEditorDiscard before showing the warning).
function applyPendingSheetAfterDiscard(pending) {
  if (pending === 'test') {
    // testsim-runtime.js monkey-patches window.openTestPanel (via a
    // window[name] = ... loop, not a plain window.openTestPanel = ...
    // assignment) - go through window here so that patch still applies,
    // same reasoning as window.update() elsewhere.
    window.openTestPanel();
  } else if (pending === 'style') {
    openStylePanel();
  } else if (pending === 'transfer') {
    openTransferSheet();
  }
}

function getUnconsumedImportWarningText() {
  const text = document.getElementById('settings-transfer-text');
  const hasPastedText = !!(text && text.value.trim());
  const result = document.getElementById('ocr-import-result');
  const hasAiPreview = !!(result && !result.hidden && result.childElementCount > 0);

  if (hasPastedText && hasAiPreview) return t('editorCore.unimportedPastedAndAiWarning');
  if (hasPastedText) return t('editorCore.unimportedPastedWarning');
  if (hasAiPreview) return t('editorCore.unimportedAiWarning');
  return t('editorCore.unimportedGenericWarning');
}

async function hasDuplicateTransferData() {
  const text = document.getElementById('settings-transfer-text');
  if (!text || !text.value.trim()) return false;
  try {
    const next = normalizeSettingsData(await decodeTransferData(text.value), {
      requireMarker: true
    });
    const current = settingsDataForExport();
    return describeSettingsDiff(current, next) === t('editorBackup.noChanges');
  } catch {
    return false;
  }
}

// True when there is pasted-JSON or AI-photo-recognized import data sitting around that was
// never actually applied — used so we can warn the user before it gets wiped on exit.
async function hasUnconsumedImportData() {
  const text = document.getElementById('settings-transfer-text');
  const hasPastedText = !!(text && text.value.trim());
  const result = document.getElementById('ocr-import-result');
  const hasAiPreview = !!(result && !result.hidden && result.childElementCount > 0);
  if (hasPastedText && (await hasDuplicateTransferData())) return false;
  return hasPastedText || hasAiPreview || !!state.pendingEditorImportData;
}

// Reminds the user that unapplied import data (pasted text or AI photo result) is being discarded.
function notifyDiscardedImportData() {
  const toast = document.getElementById('save-toast');
  if (!toast) return;
  const previousText = toast.textContent;
  toast.textContent = t('editorCore.clearedUnimportedContent');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.textContent = previousText;
    }, 300);
  }, 2500);
}

// Closes the editor, asking for confirmation when there are unsaved
// schedule changes. Import data (pasted JSON, AI photo results) lives
// entirely in the transfer sheet now - see closeTransferSheet below.
function closeEditor(force) {
  const sheet = document.getElementById('editor-sheet');

  if (!sheet.classList.contains('show')) {
    hideEditorDiscardConfirm();
    setOverlayVisible('editor-sheet-overlay', 'editor-sheet', false, 'editor-open');
    return;
  }

  if (!force && isEditorDirty()) {
    showEditorDiscardConfirm();
    return;
  }

  hideEditorDiscardConfirm();
  setOverlayVisible('editor-sheet-overlay', 'editor-sheet', false, 'editor-open');
  closeTestPanel();
}
// The transfer sheet's counterpart to closeEditor above - asks for
// confirmation when there's pasted-text or AI-photo import data sitting
// around that was never actually applied, and refuses outright while a
// Gemini recognition request is still in flight (closing mid-request would
// lose the result the moment it comes back with nowhere to show it).
async function closeTransferSheet(force) {
  const sheet = document.getElementById('transfer-sheet');
  if (!sheet) return;

  if (state.isOcrProcessing) {
    setEditorConfirmContent(
      t('editorCore.aiRecognizingTitle'),
      t('editorCore.aiRecognizingMessage'),
      '',
      t('nlEdit.dismiss'),
      hideEditorDiscardConfirm,
      null
    );
    showEditorConfirmSheet();
    return;
  }

  if (!sheet.classList.contains('show')) {
    hideEditorDiscardConfirm();
    setOverlayVisible('transfer-sheet-overlay', 'transfer-sheet', false, 'transfer-open');
    clearSyncInputFields();
    return;
  }

  const hadUnconsumedImportData = await hasUnconsumedImportData();
  if (!force && hadUnconsumedImportData) {
    showTransferDiscardConfirm();
    return;
  }

  hideEditorDiscardConfirm();
  setOverlayVisible('transfer-sheet-overlay', 'transfer-sheet', false, 'transfer-open');
  // Wipe any AI import data (pasted JSON and AI-recognized photo result) so it never lingers
  // into the next time the transfer sheet opens.
  clearTransferField();
  resetOCRImporterUI();
  // Same reasoning, for the sync code/passcode fields instead of the
  // manual-backup text - see clearSyncInputFields's own comment.
  clearSyncInputFields();
  state.pendingEditorImportData = null;
  closeTestPanel();
  if (hadUnconsumedImportData) notifyDiscardedImportData();
}

// Updates editor toggle controls from the saved app data.
function syncEditorToggles() {
  const btn = document.getElementById('toggle-reverse');
  btn.classList.toggle('on', !!state.applicationData.reverseWeek);
}

// Toggles whether odd/even week logic is reversed.
function toggleReverse() {
  const btn = document.getElementById('toggle-reverse');
  btn.classList.toggle('on');
}

// Exposed on window for inline HTML event handlers (onclick="..." in
// index.html and in generated template strings).
window.addCountdownEventRow = addCountdownEventRow;
window.closeEditor = closeEditor;
window.closeTransferSheet = closeTransferSheet;
window.discardEditorChangesAndClose = discardEditorChangesAndClose;
window.discardTransferChangesAndClose = discardTransferChangesAndClose;
window.hideEditorDiscardConfirm = hideEditorDiscardConfirm;
window.openEditor = openEditor;
window.openEditorFold = openEditorFold;
window.openTransferSheet = openTransferSheet;
window.toggleReverse = toggleReverse;

export {
  applyOfflineLock,
  bindEditorCardToggle,
  bindEditorDragReorder,
  closeEditor,
  closeTransferSheet,
  discardEditorChangesAndClose,
  discardTransferChangesAndClose,
  editorTimeToMinutes,
  esc,
  findScheduleImpacts,
  formatClassLabel,
  getEditorBellPeriodCount,
  getEditorClassLabelFromDom,
  getEditorTeacherEntriesFromDom,
  hasUnconsumedImportData,
  hideEditorDiscardConfirm,
  openEditorFold,
  openTransferSheet,
  refreshCountdownMoveButtons,
  refreshPeriodSelectOptions,
  renderCountdownEvent,
  setEditorConfirmContent,
  setStatusText,
  showEditorConfirmSheet,
  showEditorDiscardConfirm,
  showEditorSaveConfirm,
  showTransferDiscardConfirm,
  sortEditorPeriodsByTime,
  syncEditorToggles
};
