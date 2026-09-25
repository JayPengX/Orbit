// ---- src/editor-backup.js ----
// Backup export/import: the v2 transfer format's encode/decode, settings
// validation for imported data, and the editor's dirty-state tracking.
import {
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAYS_INDEX_ORDER,
  WEEKDAY_LABELS,
  isPlainObject
} from './constants.js';
import { state } from './state.js';
import {
  applyProAccent,
  normalizeProAccent,
  normalizeProSecondary,
  normalizeStyleSlots
} from './appearance.js';
import { getCountdownEvents } from './dashboard.js';
import {
  ORBIT_APP_ID,
  ORBIT_STORAGE_SCHEMA,
  REVERSE_WEEK_LOGIC_DEFAULT,
  formatCountdownEventDate,
  isValidTimeRange,
  normalizeCountdownEvent,
  normalizeCountdownEvents,
  sanitizeBreakTimes,
  saveData,
  validateTimeIntervals
} from './data.js';
import {
  closeEditor,
  hideEditorDiscardConfirm,
  renderCountdownEvent,
  setEditorConfirmContent,
  setStatusText,
  showEditorConfirmSheet,
  sortEditorPeriodsByTime,
  syncEditorToggles
} from './editor-core.js';
import {
  renderEditorBells,
  renderEditorBreaks,
  renderEditorSchedule,
  saveEditor
} from './editor-schedule.js';
import { renderEditorTeachers } from './editor-teachers.js';
import { buildSchedule } from './schedule.js';
import { isSyncConfigured, isSyncViewer, pushSyncSnapshot, setSyncStatusUi } from './sync.js';
import { t } from './strings.js';

// Reads the editor form and converts it into the app data shape. With
// `includeDraft: true` (only editorFormSnapshotString below needs this),
// also returns each section's raw, unfiltered field values as *Draft
// arrays - the same DOM read collectEditorFormState() already does per
// row, just kept instead of discarded, so the snapshot doesn't have to
// re-walk the same rows a second time to get them.
function collectEditorFormState({ includeDraft = false } = {}) {
  const newDB = {},
    newLoc = {};
  const teacherCardsDraft = [];
  document.querySelectorAll('#teacher-list .teacher-card').forEach(card => {
    const origKeyRaw = card.dataset.origKey || '',
      subjectRaw = card.querySelector('.tc-subject').value,
      teacherRaw = card.querySelector('.tc-teacher').value,
      locationRaw = card.querySelector('.tc-location').value,
      key = origKeyRaw.trim(),
      subject = subjectRaw.trim(),
      teacher = teacherRaw.trim(),
      location = locationRaw.trim();
    if (key && subject) {
      newDB[key] = [subject, teacher, location];
      newLoc[key] = location;
    }
    if (includeDraft) teacherCardsDraft.push([origKeyRaw, subjectRaw, teacherRaw, locationRaw]);
  });
  const newWeekly = {};
  document.querySelectorAll('#schedule-grid .schedule-day-row').forEach(row => {
    const d = parseInt(row.dataset.day, 10);
    newWeekly[d] = Array.from(row.querySelectorAll('.period-select')).map(sel => sel.value);
  });
  const newBells = [];
  const bellRowsDraft = [];
  document.querySelectorAll('#bell-list .bell-row').forEach(row => {
    const s = row.querySelector('.bell-start').value,
      e = row.querySelector('.bell-end').value;
    if (s && e) newBells.push([s, e]);
    if (includeDraft) bellRowsDraft.push([s, e]);
  });
  const newBreaks = [];
  const breakRowsDraft = [];
  document.querySelectorAll('#break-list .break-row').forEach(row => {
    const nameRaw = row.querySelector('.break-name').value,
      start = row.querySelector('.break-start').value,
      end = row.querySelector('.break-end').value,
      name = nameRaw.trim();
    if (name && start && end) newBreaks.push({ name, start, end });
    if (includeDraft) breakRowsDraft.push([nameRaw, start, end, '']);
  });
  const reverseWeek = document.getElementById('toggle-reverse').classList.contains('on');
  const countdownEvents = Array.from(
    document.querySelectorAll('#countdown-event-list .countdown-event-row')
  )
    .map(row =>
      normalizeCountdownEvent({
        name: row.querySelector('.countdown-event-name')?.value,
        startDate: row.querySelector('.countdown-event-start')?.value,
        endDate: row.querySelector('.countdown-event-end')?.value
      })
    )
    .filter(Boolean);
  const normalizedCountdownEvents = normalizeCountdownEvents(countdownEvents);
  const proAccent = normalizeProAccent(state.applicationData.proAccent);
  const proSecondary = normalizeProSecondary(state.applicationData.proSecondary);
  return {
    teacherDB: newDB,
    teacherOrder: Array.from(document.querySelectorAll('#teacher-list .teacher-card'))
      .map(card => (card.dataset.origKey || '').trim())
      .filter(Boolean),
    locationDB: newLoc,
    weeklySchedule: newWeekly,
    bellTimes: newBells,
    breakTimes: newBreaks,
    countdownEvents: normalizedCountdownEvents,
    reverseWeek,
    proAccent,
    proSecondary,
    styleSlots: normalizeStyleSlots(state.applicationData.styleSlots),
    ...(includeDraft ? { teacherCardsDraft, bellRowsDraft, breakRowsDraft } : {})
  };
}
// Creates a stable snapshot so the app can detect unsaved editor changes.
function editorFormSnapshotString() {
  const s = collectEditorFormState({ includeDraft: true });
  return JSON.stringify({
    reverseWeek: s.reverseWeek,
    countdownEvents: s.countdownEvents,
    proAccent: s.proAccent,
    proSecondary: s.proSecondary,
    styleSlots: s.styleSlots,
    bellTimes: s.bellTimes,
    breakTimes: s.breakTimes,
    bellRowsDraft: s.bellRowsDraft,
    breakRowsDraft: s.breakRowsDraft,
    weeklySchedule: s.weeklySchedule,
    teacherDB: s.teacherDB,
    teacherOrder: s.teacherOrder,
    teacherCardsDraft: s.teacherCardsDraft
  });
}
// Checks whether the editor has unsaved changes.
function isEditorDirty() {
  if (!document.getElementById('editor-sheet').classList.contains('show')) return false;
  return editorFormSnapshotString() !== state.editorBaselineSnapshot;
}
let pendingTransferAction = null;
function confirmExportOverwrite() {
  hideEditorDiscardConfirm();
  exportEditorSettings();
}
function runTransferAction(action) {
  if (action === 'export') {
    const text = document.getElementById('settings-transfer-text');
    if (text?.value.trim()) {
      setEditorConfirmContent(
        t('editorBackup.overwriteExportTitle'),
        t('editorBackup.overwriteExportMessage'),
        t('editorBackup.overwriteExportConfirm'),
        t('editorBackup.overwriteAndExport'),
        confirmExportOverwrite,
        t('common.cancel'),
        { danger: true }
      );
      showEditorConfirmSheet();
      return;
    }
    exportEditorSettings();
  } else previewImportEditorSettings();
}
function requestTransferAction(action) {
  // Belt-and-suspenders, same as saveEditor(): the editor UI already locks
  // the manual-import button down for a viewer device (see styles.css's
  // .sync-viewer-locked and src/sync.js's applyEditorRoleLock), but that's
  // a CSS/pointer-events lock, not real access control. Export stays
  // allowed - reading out the current (received) schedule isn't editing.
  if (action === 'import' && isSyncViewer()) {
    setSyncStatusUi(t('sync.viewerLockedImport'), true);
    return;
  }
  if (!isEditorDirty()) {
    runTransferAction(action);
    return;
  }
  pendingTransferAction = action;
  const label = action === 'export' ? t('common.export') : t('common.import');
  setEditorConfirmContent(
    t('editorBackup.saveFirstTitle'),
    t('editorBackup.saveFirstMessage', { action: label }),
    '',
    t('editorBackup.saveThenAction', { action: label }),
    () => {
      saveEditor();
    },
    t('editorBackup.actionWithoutSaving', { action: label }),
    {
      cancelHandler: () => {
        const nextAction = pendingTransferAction;
        pendingTransferAction = null;
        hideEditorDiscardConfirm();
        if (nextAction === 'export') {
          exportEditorSettings(
            state.editorBaselineData || normalizeSettingsData(state.applicationData)
          );
        } else {
          runTransferAction(nextAction);
        }
      },
      extraLabel: t('common.cancel'),
      extraHandler: () => {
        pendingTransferAction = null;
        hideEditorDiscardConfirm();
      }
    }
  );
  showEditorConfirmSheet();
}
function cloneSettingsData(data) {
  return JSON.parse(JSON.stringify(data));
}
// ---- v2 transfer format ----
// A much shorter, denser format than v1: redundant fields (locationDB, which
// always mirrors teacherDB's 3rd column) are dropped, remaining structures
// are flattened into positional arrays (removing per-item key names), the
// payload is compressed with raw DEFLATE (no zlib header/checksum), and the
// compressed bytes are encoded with a 91-symbol printable alphabet instead
// of Base64 - Base64 spends 4 characters per 3 bytes (~1.33 chars/byte),
// while this alphabet spends under 1.23 bytes/char, so encoded text is
// roughly a quarter shorter for the same compressed bytes. The wrapping
// marker is a short, human-readable pair of bracketed start/end tags
// instead of the old ~90-character banner text, so a backup's boundaries
// are still obvious to a user scanning or pasting the text.
const TRANSFER_MAGIC_V2 = '[ORBIT]';
const TRANSFER_MAGIC_V2_END = '[/ORBIT]';
const BASE91_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~';
const BASE91_DECODE_MAP = Object.fromEntries(
  [...BASE91_ALPHABET].map((char, index) => [char, index])
);
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
function base91Decode(str) {
  const bytes = [];
  let b = 0,
    n = 0,
    v = -1;
  for (let i = 0; i < str.length; i++) {
    const c = BASE91_DECODE_MAP[str[i]];
    if (c === undefined) continue;
    if (v < 0) {
      v = c;
      continue;
    }
    v += c * 91;
    b |= v << n;
    n += (v & 8191) > 88 ? 13 : 14;
    while (n >= 8) {
      bytes.push(b & 255);
      b >>= 8;
      n -= 8;
    }
    v = -1;
  }
  if (v >= 0) bytes.push((b | (v << n)) & 255);
  return Uint8Array.from(bytes);
}
function encodeTransferPayloadV2(data) {
  const teacherEntries = Object.entries(data.teacherDB || {}).map(([key, value]) => [
    key,
    value[0] || '',
    value[1] || '',
    value[2] || ''
  ]);
  const weeklyDays = WEEKDAYS_INDEX_ORDER.map(day => (data.weeklySchedule || {})[day] || []);
  const breakEntries = (data.breakTimes || []).map(item => [
    item.name || '',
    item.start || '',
    item.end || ''
  ]);
  const countdownEntries = (data.countdownEvents || []).map(item => [
    item.name || '',
    item.startDate || '',
    item.endDate || ''
  ]);
  const styleSlotEntries = (data.styleSlots || []).map(slot => [
    slot.name || '',
    slot.primary || '',
    slot.secondary || ''
  ]);
  return [
    data.teacherOrder || [],
    teacherEntries,
    weeklyDays,
    data.bellTimes || [],
    breakEntries,
    countdownEntries,
    data.reverseWeek ? 1 : 0,
    data.proAccent,
    data.proSecondary,
    styleSlotEntries
  ];
}
function decodeTransferPayloadV2(array) {
  const [
    teacherOrder,
    teacherEntries,
    weeklyDays,
    bellTimes,
    breakEntries,
    countdownEntries,
    reverseWeekFlag,
    proAccent,
    proSecondary,
    styleSlotEntries
  ] = array;
  const teacherDB = {},
    locationDB = {};
  (teacherEntries || []).forEach(([key, subject, teacher, location]) => {
    teacherDB[key] = [subject, teacher, location];
    locationDB[key] = location;
  });
  const weeklySchedule = {};
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    weeklySchedule[day] = (weeklyDays || [])[day] || [];
  });
  const breakTimes = (breakEntries || []).map(([name, start, end]) => ({ name, start, end }));
  const countdownEvents = (countdownEntries || []).map(([name, startDate, endDate]) => ({
    name,
    startDate,
    endDate
  }));
  const styleSlots = (styleSlotEntries || []).map(([name, primary, secondary]) => ({
    name,
    primary,
    secondary
  }));
  return {
    teacherDB,
    teacherOrder: teacherOrder || [],
    locationDB,
    weeklySchedule,
    bellTimes: bellTimes || [],
    breakTimes,
    countdownEvents,
    reverseWeek: !!reverseWeekFlag,
    proAccent,
    proSecondary,
    styleSlots,
    __orbit: { app: ORBIT_APP_ID, schema: ORBIT_STORAGE_SCHEMA }
  };
}
async function encodeTransferDataV2(data) {
  const raw = JSON.stringify(encodeTransferPayloadV2(data));
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return TRANSFER_MAGIC_V2 + base91Encode(bytes) + TRANSFER_MAGIC_V2_END;
}
async function decodeTransferDataV2(value) {
  const encoded = value.slice(TRANSFER_MAGIC_V2.length, -TRANSFER_MAGIC_V2_END.length).trim();
  if (!encoded) throw new Error(t('editorBackup.pasteBackup'));
  const stream = new Blob([base91Decode(encoded)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const array = JSON.parse(await new Response(stream).text());
  if (!Array.isArray(array)) throw new Error(t('editorBackup.pasteBackup'));
  return decodeTransferPayloadV2(array);
}
async function encodeTransferData(data) {
  if (typeof CompressionStream !== 'function')
    throw new Error(t('editorBackup.noCompressionExport'));
  return encodeTransferDataV2(data);
}
async function decodeTransferData(text) {
  const value = String(text || '').trim();
  if (!value.startsWith(TRANSFER_MAGIC_V2) || !value.endsWith(TRANSFER_MAGIC_V2_END))
    throw new Error(t('editorBackup.pasteBackup'));
  if (typeof DecompressionStream !== 'function')
    throw new Error(t('editorBackup.noCompressionImport'));
  return decodeTransferDataV2(value);
}
function normalizeSettingsData(raw, { requireMarker = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error(t('editorBackup.mustBeJsonObject'));
  const marker = raw.__orbit;
  if (
    requireMarker &&
    (!marker || marker.app !== ORBIT_APP_ID || marker.schema !== ORBIT_STORAGE_SCHEMA)
  ) {
    throw new Error(t('editorBackup.notCreatedByThisApp'));
  }

  const source = raw;
  const required = ['teacherDB', 'locationDB', 'weeklySchedule', 'bellTimes'];
  required.forEach(key => {
    if (!(key in source)) throw new Error(t('editorBackup.missingField', { field: key }));
  });

  if (!isPlainObject(source.teacherDB))
    throw new Error(t('editorBackup.mustBeObject', { field: 'teacherDB' }));
  if (!isPlainObject(source.locationDB))
    throw new Error(t('editorBackup.mustBeObject', { field: 'locationDB' }));
  if (!isPlainObject(source.weeklySchedule))
    throw new Error(t('editorBackup.mustBeObject', { field: 'weeklySchedule' }));
  if (!Array.isArray(source.bellTimes))
    throw new Error(t('editorBackup.mustBeArray', { field: 'bellTimes' }));
  if (source.breakTimes !== undefined && !Array.isArray(source.breakTimes))
    throw new Error(t('editorBackup.mustBeArray', { field: 'breakTimes' }));
  if (source.countdownEvents !== undefined && !Array.isArray(source.countdownEvents))
    throw new Error(t('editorBackup.mustBeArray', { field: 'countdownEvents' }));
  if (Object.values(source.teacherDB).some(value => !Array.isArray(value)))
    throw new Error(t('editorBackup.teacherDbShape'));
  if (Object.values(source.weeklySchedule).some(value => !Array.isArray(value)))
    throw new Error(t('editorBackup.weeklyScheduleShape'));

  const teacherDB = {};
  Object.entries(source.teacherDB).forEach(([key, value]) => {
    if (!key || !Array.isArray(value)) return;
    const cleanKey = String(key).trim();
    if (!cleanKey) return;
    teacherDB[cleanKey] = [String(value[0] || ''), String(value[1] || ''), String(value[2] || '')];
  });

  const locationDB = {};
  Object.entries(source.locationDB).forEach(([key, value]) => {
    const cleanKey = String(key).trim();
    if (!cleanKey) return;
    if (teacherDB[cleanKey]) locationDB[cleanKey] = String(value || '');
  });

  const weeklySchedule = {};
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    const row = source.weeklySchedule[day] || source.weeklySchedule[String(day)] || [];
    if (!Array.isArray(row)) {
      weeklySchedule[day] = [];
      return;
    }
    // Blank out a cell pointing at an unknown class key rather than
    // dropping it - dropping would shift every later period that day up by
    // one, silently moving classes into the wrong periods.
    weeklySchedule[day] = row
      .map(item => String(item || ''))
      .map(item => (item && teacherDB[item] ? item : ''));
  });

  if (Object.values(weeklySchedule).some(row => row.some(key => key && !teacherDB[key])))
    throw new Error(t('editorBackup.scheduleUnknownTeacher'));
  if (
    source.bellTimes.some(
      item =>
        !Array.isArray(item) || !isValidTimeRange(String(item[0] || ''), String(item[1] || ''))
    )
  )
    throw new Error(t('editorBackup.invalidBellTimes'));

  const bellTimes = source.bellTimes.map(item => [String(item[0]), String(item[1])]);
  const breakTimes = sanitizeBreakTimes(bellTimes, source.breakTimes);
  const countdownEvents = normalizeCountdownEvents(source.countdownEvents);
  const teacherOrder = Array.isArray(source.teacherOrder)
    ? source.teacherOrder
        .map(String)
        .filter(key => teacherDB[key])
        .filter((key, index, self) => self.indexOf(key) === index)
    : Object.keys(teacherDB);
  Object.keys(teacherDB).forEach(key => {
    if (!teacherOrder.includes(key)) teacherOrder.push(key);
  });

  validateTimeIntervals(bellTimes, breakTimes);

  return {
    teacherDB,
    teacherOrder,
    locationDB,
    weeklySchedule,
    bellTimes,
    breakTimes,
    countdownEvents,
    reverseWeek:
      typeof source.reverseWeek === 'boolean' ? source.reverseWeek : REVERSE_WEEK_LOGIC_DEFAULT,
    proAccent: normalizeProAccent(source.proAccent),
    proSecondary: normalizeProSecondary(source.proSecondary),
    styleSlots: normalizeStyleSlots(source.styleSlots)
  };
}
// Reads "the current settings" as collectEditorFormState() sees them -
// which means the editor sheet's own form fields (#teacher-list,
// #schedule-grid, #countdown-event-list, etc.), not state.applicationData
// directly. That's deliberate when the editor is actually open, so an
// in-progress unsaved edit is what gets exported/diffed/merged against,
// not whatever was last saved. But those DOM lists are only ever populated
// by openEditor() - a caller that reaches this (AI import and manual
// paste-import both can, straight from the standalone transfer sheet,
// without ever opening the schedule editor first - see openTransferSheet)
// while the editor sheet has never been opened this session would
// otherwise read completely empty markup as "current", making a "merge"
// look like it kept everything while actually discarding every class and
// countdown event the editor never got a chance to render. Re-render the
// form from the real saved data first whenever the editor isn't open -
// there's no in-progress edit to lose in that case - so "current" always
// reflects state.applicationData at minimum.
function settingsDataForExport() {
  if (!document.getElementById('editor-sheet')?.classList.contains('show')) {
    renderEditorTeachers();
    renderEditorBells();
    renderEditorBreaks();
    renderEditorSchedule();
    renderCountdownEvent();
  }
  sortEditorPeriodsByTime();
  return {
    ...normalizeSettingsData({
      ...collectEditorFormState(),
      __orbit: { app: ORBIT_APP_ID, schema: ORBIT_STORAGE_SCHEMA }
    }),
    __orbit: { app: ORBIT_APP_ID, schema: ORBIT_STORAGE_SCHEMA }
  };
}
function setTransferStatus(message, isError = false) {
  setStatusText('settings-transfer-status', message, isError);
}
async function copyTransferText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the execCommand('copy') fallback below.
    }
  }
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  try {
    if (!document.execCommand('copy')) throw new Error(t('editorBackup.copyFailed'));
  } finally {
    helper.remove();
  }
}
async function exportEditorSettings(data = settingsDataForExport()) {
  try {
    const text = document.getElementById('settings-transfer-text');
    text.value = await encodeTransferData(data);
    await copyTransferText(text.value);
    text.focus();
    text.select();
    setTransferStatus(t('editorBackup.exportSuccess'));
  } catch {
    setTransferStatus(t('editorBackup.exportFailed'), true);
  }
}
function formatDiffValue(value) {
  return value ? String(value) : t('editorBackup.blankValue');
}
function formatClassRef(key, data) {
  if (!key) return t('editorBackup.emptyValue');
  const info = (data.teacherDB || {})[key] || [];
  const subject = info[0] || '';
  const teacher = info[1] || '';
  const details = [subject, teacher].filter(Boolean).join(' / ');
  return details || t('editorBackup.unnamedClass');
}
function pushDiff(lines, title, items) {
  if (!items.length) return;
  lines.push(`${title}:`);
  items.forEach(item => lines.push(`- ${item}`));
}
// Diffs two same-shaped arrays index by index (padding the shorter one with
// undefined), formatting each entry with `formatEntry` and building one diff
// line per changed index via `formatLine` - shared by the bell-time and
// break-time diffs below, which are otherwise identical shapes.
function diffIndexedArrays(currentList, nextList, formatEntry, formatLine) {
  const items = [];
  const total = Math.max((currentList || []).length, (nextList || []).length);
  for (let i = 0; i < total; i++) {
    const beforeText = formatEntry((currentList || [])[i]);
    const afterText = formatEntry((nextList || [])[i]);
    if (beforeText !== afterText) items.push(formatLine(i, beforeText, afterText));
  }
  return items;
}
function dayDiffLabel(day) {
  return WEEKDAY_LABELS[day] || t('editorBackup.dayNumber', { day });
}
// True when two identity-key arrays hold exactly the same multiset but in a
// different sequence - a pure drag-reorder with no addition or removal.
// Every per-item diff in describeSettingsDiff below compares by identity
// (a teacher key, a countdown event's name+dates), never by array position,
// so reordering items with no other change produces zero diff lines on its
// own - this is the one check that actually looks at position.
function isPureReorder(beforeKeys, afterKeys) {
  if (beforeKeys.length !== afterKeys.length) return false;
  if (beforeKeys.every((key, index) => key === afterKeys[index])) return false;
  const sortedBefore = [...beforeKeys].sort();
  const sortedAfter = [...afterKeys].sort();
  return sortedBefore.every((key, index) => key === sortedAfter[index]);
}
function describeSettingsDiff(current, next, { isImport = false } = {}) {
  const lines = [];
  const teacherItems = [];
  const sortByLabel = data => (a, b) =>
    formatClassRef(a, data).localeCompare(formatClassRef(b, data), 'zh-Hant');
  const teacherKeys = [
    ...new Set(Object.keys(current.teacherDB || {}).concat(Object.keys(next.teacherDB || {})))
  ].sort(sortByLabel(next.teacherDB ? next : current));
  teacherKeys.forEach(key => {
    const before = (current.teacherDB || {})[key];
    const after = (next.teacherDB || {})[key];
    if (!before && after)
      teacherItems.push(t('editorBackup.added', { item: formatClassRef(key, next) }));
    else if (before && !after)
      teacherItems.push(t('editorBackup.removed', { item: formatClassRef(key, current) }));
    else if (before && after) {
      if ((before[0] || '') !== (after[0] || ''))
        teacherItems.push(
          t('editorBackup.subjectChange', {
            ref: formatClassRef(key, next),
            before: formatDiffValue(before[0]),
            after: formatDiffValue(after[0])
          })
        );
      if ((before[1] || '') !== (after[1] || ''))
        teacherItems.push(
          t('editorBackup.teacherChange', {
            ref: formatClassRef(key, next),
            before: formatDiffValue(before[1]),
            after: formatDiffValue(after[1])
          })
        );
    }
  });
  pushDiff(lines, t('editorBackup.sectionTeachers'), teacherItems);
  if (
    isPureReorder(
      Array.isArray(current.teacherOrder) ? current.teacherOrder : [],
      Array.isArray(next.teacherOrder) ? next.teacherOrder : []
    )
  )
    lines.push(t('editorBackup.teacherOrderChanged'));

  const locationItems = [];
  const locationKeys = [
    ...new Set(Object.keys(current.locationDB || {}).concat(Object.keys(next.locationDB || {})))
  ].sort(sortByLabel(next.teacherDB ? next : current));
  locationKeys.forEach(key => {
    const before = (current.locationDB || {})[key] || '';
    const after = (next.locationDB || {})[key] || '';
    const data = after ? next : current;
    if (before !== after)
      locationItems.push(
        t('editorBackup.locationChange', {
          ref: formatClassRef(key, data),
          before: formatDiffValue(before),
          after: formatDiffValue(after)
        })
      );
  });
  pushDiff(lines, t('editorBackup.sectionLocations'), locationItems);

  const bellItems = diffIndexedArrays(
    current.bellTimes,
    next.bellTimes,
    item => (item ? `${item[0]}-${item[1]}` : t('editorBackup.noneValue')),
    (i, beforeText, afterText) =>
      t('editorBackup.periodChange', { number: i + 1, before: beforeText, after: afterText })
  );
  pushDiff(lines, t('editorBackup.sectionBellTimes'), bellItems);

  const breakItems = diffIndexedArrays(
    current.breakTimes,
    next.breakTimes,
    item => (item ? `${item.name} ${item.start}-${item.end}` : t('editorBackup.noneValue')),
    (i, beforeText, afterText) =>
      t('editorBackup.breakChange', { number: i + 1, before: beforeText, after: afterText })
  );
  pushDiff(lines, t('editorBackup.sectionBreakTimes'), breakItems);

  const scheduleItems = [];
  WEEKDAYS_DISPLAY_ORDER.forEach(day => {
    const beforeRow = (current.weeklySchedule || {})[day] || [];
    const afterRow = (next.weeklySchedule || {})[day] || [];
    const total = Math.max(beforeRow.length, afterRow.length);
    for (let i = 0; i < total; i++) {
      const before = beforeRow[i] || '';
      const after = afterRow[i] || '';
      if (before !== after)
        scheduleItems.push(
          t('editorBackup.scheduleCellChange', {
            day: dayDiffLabel(day),
            number: i + 1,
            before: formatClassRef(before, current),
            after: formatClassRef(after, next)
          })
        );
    }
  });
  pushDiff(lines, t('editorBackup.sectionScheduleContent'), scheduleItems);

  const currentCountdownEvents = getCountdownEvents(current);
  const nextCountdownEvents = getCountdownEvents(next);
  const countdownItems = [];
  const eventText = event => `${event.name} (${formatCountdownEventDate(event)})`;
  const matchedCurrent = new Set();
  nextCountdownEvents.forEach(event => {
    const exact = currentCountdownEvents.findIndex(
      (item, index) =>
        !matchedCurrent.has(index) &&
        item.name === event.name &&
        item.startDate === event.startDate &&
        item.endDate === event.endDate
    );
    if (exact !== -1) {
      matchedCurrent.add(exact);
      return;
    }
    const changed = currentCountdownEvents.findIndex(
      (item, index) => !matchedCurrent.has(index) && item.name === event.name
    );
    if (changed !== -1) {
      matchedCurrent.add(changed);
      countdownItems.push(
        t('editorBackup.eventChanged', {
          before: eventText(currentCountdownEvents[changed]),
          after: eventText(event)
        })
      );
    } else countdownItems.push(t('editorBackup.eventAdded', { event: eventText(event) }));
  });
  currentCountdownEvents.forEach((event, index) => {
    if (!matchedCurrent.has(index))
      countdownItems.push(t('editorBackup.eventRemoved', { event: eventText(event) }));
  });
  pushDiff(lines, t('editorBackup.sectionCountdownEvents'), countdownItems);
  if (isPureReorder(currentCountdownEvents.map(eventText), nextCountdownEvents.map(eventText)))
    lines.push(t('editorBackup.countdownOrderChanged'));
  if (!!current.reverseWeek !== !!next.reverseWeek)
    lines.push(
      t('editorBackup.reverseWeekChange', {
        before: current.reverseWeek ? t('common.on') : t('common.off'),
        after: next.reverseWeek ? t('common.on') : t('common.off')
      })
    );
  const currentProAccent = normalizeProAccent(current.proAccent);
  const nextProAccent = normalizeProAccent(next.proAccent);
  const describeColorChange = (label, before, after) =>
    isImport
      ? t('editorBackup.colorChangeImport', { label, before, after })
      : t('editorBackup.colorChangePlain', { label, before, after });
  const importedStyleItems = [];
  if (currentProAccent !== nextProAccent) {
    if (isImport)
      importedStyleItems.push(
        t('editorBackup.colorChangeImport', {
          label: t('editorBackup.primaryColor'),
          before: currentProAccent,
          after: nextProAccent
        })
      );
    else
      lines.push(
        describeColorChange(t('editorBackup.primaryColor'), currentProAccent, nextProAccent)
      );
  }
  const currentProSecondary = normalizeProSecondary(current.proSecondary);
  const nextProSecondary = normalizeProSecondary(next.proSecondary);
  if (currentProSecondary !== nextProSecondary) {
    if (isImport)
      importedStyleItems.push(
        t('editorBackup.colorChangeImport', {
          label: t('editorBackup.secondaryColor'),
          before: currentProSecondary,
          after: nextProSecondary
        })
      );
    else
      lines.push(
        describeColorChange(t('editorBackup.secondaryColor'), currentProSecondary, nextProSecondary)
      );
  }
  if (isImport) pushDiff(lines, t('editorBackup.sectionCurrentStyle'), importedStyleItems);
  const currentSlots = normalizeStyleSlots(current.styleSlots);
  const nextSlots = normalizeStyleSlots(next.styleSlots);
  const styleSlotItems = [];
  currentSlots.forEach((slot, index) => {
    const nextSlot = nextSlots[index];
    if (
      slot.name === nextSlot.name &&
      slot.primary === nextSlot.primary &&
      slot.secondary === nextSlot.secondary
    )
      return;
    const slotLabel = t('editorBackup.styleSlotLabel', { number: index + 1 });
    if (!slot.name && nextSlot.name)
      styleSlotItems.push(
        t('editorBackup.styleSlotAdded', {
          slot: slotLabel,
          name: nextSlot.name,
          primary: nextSlot.primary,
          secondary: nextSlot.secondary
        })
      );
    else if (slot.name && !nextSlot.name)
      styleSlotItems.push(
        t('editorBackup.styleSlotRemoved', {
          slot: slotLabel,
          name: slot.name,
          primary: slot.primary,
          secondary: slot.secondary
        })
      );
    else if (isImport)
      styleSlotItems.push(
        t('editorBackup.styleSlotChangedImport', {
          slot: slotLabel,
          before: slot.name || t('editorBackup.unnamedStyle'),
          after: nextSlot.name || t('editorBackup.unnamedStyle'),
          beforePrimary: slot.primary,
          afterPrimary: nextSlot.primary,
          beforeSecondary: slot.secondary,
          afterSecondary: nextSlot.secondary
        })
      );
    else
      styleSlotItems.push(
        t('editorBackup.styleSlotChangedPlain', {
          slot: slotLabel,
          before: slot.name || t('editorBackup.unnamedStyle'),
          after: nextSlot.name || t('editorBackup.unnamedStyle'),
          beforePrimary: slot.primary,
          afterPrimary: nextSlot.primary,
          beforeSecondary: slot.secondary,
          afterSecondary: nextSlot.secondary
        })
      );
  });
  pushDiff(lines, t('editorBackup.sectionPersonalStyles'), styleSlotItems);
  // No line cap here - the diff box that displays this (#editor-import-diff,
  // see editor-core.js's setEditorConfirmContent) already scrolls
  // (max-height + overflow:auto in styles.css), so a very long diff is
  // still fully there, just scrollable, instead of being silently cut off
  // with no way to see what got hidden.
  return lines.length ? lines.join('\n') : t('editorBackup.noChanges');
}
// Import is decoded and previewed first; confirmation is required before saving.
async function previewImportEditorSettings() {
  const text = document.getElementById('settings-transfer-text');
  try {
    const next = normalizeSettingsData(await decodeTransferData(text.value), {
      requireMarker: true
    });
    const current = settingsDataForExport();
    if (describeSettingsDiff(current, next) === t('editorBackup.noChanges')) {
      state.pendingEditorImportData = null;
      setTransferStatus(t('editorBackup.importFailedIdentical'), true);
      return;
    }
    state.pendingEditorImportData = next;
    showEditorImportModeConfirm(current, next);
  } catch {
    state.pendingEditorImportData = null;
    text.value = '';
    setTransferStatus(t('editorBackup.importFailedInvalid'), true);
  }
}
function mergeImportedSettings(current, imported, preserveStyle = false) {
  const merged = cloneSettingsData(current),
    addedActions = [],
    mergedActions = [],
    replacedActions = [];
  merged.teacherDB = { ...(current.teacherDB || {}) };
  const teacherKeyMap = {},
    currentTeacherKeyMap = {};
  Object.entries(imported.teacherDB || {}).forEach(([importedKey, importedInfo]) => {
    const matchedKey = current.teacherDB?.[importedKey]
      ? importedKey
      : Object.keys(current.teacherDB || {}).find(currentKey => {
          const currentInfo = current.teacherDB[currentKey] || [];
          return (
            (importedInfo[0] && currentInfo[0] === importedInfo[0]) ||
            (importedInfo[1] && currentInfo[1] === importedInfo[1])
          );
        });
    const targetKey = importedKey;
    teacherKeyMap[importedKey] = targetKey;
    if (matchedKey && matchedKey !== importedKey) {
      currentTeacherKeyMap[matchedKey] = importedKey;
      delete merged.teacherDB[matchedKey];
    }
    merged.teacherDB[importedKey] = importedInfo;
    const targetLabel = importedInfo[0] || targetKey;
    (matchedKey ? mergedActions : addedActions).push(
      matchedKey
        ? t('editorBackup.mergedClass', { name: targetLabel })
        : t('editorBackup.addedClass', { name: targetLabel })
    );
  });
  merged.locationDB = { ...(current.locationDB || {}) };
  Object.entries(imported.locationDB || {}).forEach(([importedKey, value]) => {
    const targetKey = teacherKeyMap[importedKey] || importedKey;
    const targetLabel = merged.teacherDB[targetKey]?.[0] || targetKey;
    const oldKey = Object.keys(currentTeacherKeyMap).find(
      key => currentTeacherKeyMap[key] === targetKey
    );
    if (oldKey && oldKey !== targetKey) delete merged.locationDB[oldKey];
    const currentValue = current.locationDB?.[targetKey] || current.locationDB?.[oldKey] || '';
    if (currentValue !== value)
      replacedActions.push(
        t('editorBackup.replacedClassLocation', {
          name: targetLabel,
          before: currentValue || t('editorBackup.blankValue'),
          after: value || t('editorBackup.blankValue')
        })
      );
    merged.locationDB[targetKey] = value;
  });
  merged.weeklySchedule = {};
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    const currentRow = current.weeklySchedule?.[day] || [],
      importedRow = imported.weeklySchedule?.[day] || [];
    const total = Math.max(currentRow.length, importedRow.length);
    merged.weeklySchedule[day] = Array.from({ length: total }, (_, index) => {
      const currentKey = currentTeacherKeyMap[currentRow[index]] || currentRow[index] || '',
        importedKey = teacherKeyMap[importedRow[index]] || importedRow[index] || '';
      if (currentKey && importedKey && currentKey !== importedKey)
        replacedActions.push(
          t('editorBackup.replacedDayPeriod', {
            day: dayDiffLabel(day),
            number: index + 1,
            before: formatClassRef(currentKey, current),
            after: formatClassRef(importedKey, merged)
          })
        );
      else if (!currentKey && importedKey)
        addedActions.push(
          t('editorBackup.addedDayPeriod', {
            day: dayDiffLabel(day),
            number: index + 1,
            value: formatClassRef(importedKey, merged)
          })
        );
      return importedKey || currentKey;
    });
  });
  const importedTeacherOrder = imported.teacherOrder || Object.keys(imported.teacherDB || {});
  const currentTeacherOrder = current.teacherOrder || Object.keys(current.teacherDB || {});
  merged.teacherOrder = [
    ...new Set(
      importedTeacherOrder
        .concat(currentTeacherOrder)
        .map(key => teacherKeyMap[key] || key)
        .filter(key => merged.teacherDB[key])
    )
  ];
  if (Array.isArray(imported.bellTimes) && imported.bellTimes.length) {
    merged.bellTimes = cloneSettingsData(imported.bellTimes);
    replacedActions.push(t('editorBackup.replacedBellTimes'));
  }
  const breaks = new Map((current.breakTimes || []).map(item => [item.name, item]));
  const importedBreakNames = new Set();
  (imported.breakTimes || []).forEach(item => {
    const currentBreak = breaks.get(item.name);
    if (!currentBreak) addedActions.push(t('editorBackup.addedBreak', { name: item.name }));
    else if (currentBreak.start === item.start && currentBreak.end === item.end)
      mergedActions.push(t('editorBackup.mergedBreak', { name: item.name }));
    else
      replacedActions.push(
        t('editorBackup.replacedBreak', {
          name: item.name,
          before: `${currentBreak.start}-${currentBreak.end}`,
          after: `${item.start}-${item.end}`
        })
      );
    breaks.set(item.name, item);
    importedBreakNames.add(item.name);
  });
  // Drop only the specific breaks that no longer fit the merged bell schedule instead of aborting
  // the whole merge. Imported 特殊時段 (from AI recognition or a regular paste-import) take
  // priority: when two entries' times conflict, the one NOT from this import is dropped, so the
  // imported time always wins instead of silently disappearing.
  const keptBreaks = [];
  const orderedBreakEntries = [...breaks.values()].sort(
    (a, b) => (importedBreakNames.has(b.name) ? 1 : 0) - (importedBreakNames.has(a.name) ? 1 : 0)
  );
  orderedBreakEntries.forEach(item => {
    try {
      validateTimeIntervals(merged.bellTimes, [...keptBreaks, item]);
      keptBreaks.push(item);
    } catch {
      replacedActions.push(t('editorBackup.removedBreakConflict', { name: item.name }));
    }
  });
  merged.breakTimes = keptBreaks;
  const events = new Map(getCountdownEvents(current).map(item => [item.name, item]));
  getCountdownEvents(imported).forEach(item => {
    const currentEvent = events.get(item.name);
    if (!currentEvent)
      addedActions.push(
        t('editorBackup.addedCountdown', { name: item.name, date: formatCountdownEventDate(item) })
      );
    else if (currentEvent.startDate === item.startDate && currentEvent.endDate === item.endDate)
      mergedActions.push(
        t('editorBackup.mergedCountdown', { name: item.name, date: formatCountdownEventDate(item) })
      );
    else
      replacedActions.push(
        t('editorBackup.replacedCountdown', {
          name: item.name,
          before: formatCountdownEventDate(currentEvent),
          after: formatCountdownEventDate(item)
        })
      );
    events.set(item.name, item);
  });
  merged.countdownEvents = [...events.values()];
  if (current.reverseWeek !== imported.reverseWeek)
    replacedActions.push(
      t('editorBackup.replacedReverseWeek', {
        value: imported.reverseWeek ? t('common.on') : t('common.off')
      })
    );
  merged.reverseWeek = imported.reverseWeek;
  // AI imports keep this browser's visual preferences; regular backups retain
  // the imported palette and saved presets.
  if (preserveStyle) {
    merged.proAccent = current.proAccent;
    merged.proSecondary = current.proSecondary;
    merged.styleSlots = normalizeStyleSlots(current.styleSlots).map(slot => ({ ...slot }));
  }
  return { data: normalizeSettingsData(merged), addedActions, mergedActions, replacedActions };
}
function showEditorImportModeConfirm(current, next, preserveStyle = false) {
  setEditorConfirmContent(
    t('editorBackup.importModeTitle'),
    t('editorBackup.importModeMessage'),
    t('editorBackup.importModeHint'),
    t('editorBackup.mergeImport'),
    () => showEditorImportConfirm(current, next, true, preserveStyle),
    t('editorBackup.directImport'),
    {
      cancelHandler: () => showEditorImportConfirm(current, next, false, preserveStyle),
      extraLabel: t('common.cancel'),
      extraHandler: hideEditorDiscardConfirm
    }
  );
  showEditorConfirmSheet();
}
function beginEditorImport(current, next, { preserveStyle = false } = {}) {
  try {
    const normalizedCurrent = normalizeSettingsData(current);
    const normalizedNext = normalizeSettingsData(next);
    state.pendingEditorImportData = normalizedNext;
    showEditorImportModeConfirm(normalizedCurrent, normalizedNext, preserveStyle);
  } catch (error) {
    state.pendingEditorImportData = null;
    setTransferStatus(
      t('editorBackup.importFailedWithReason', { reason: error.message || error }),
      true
    );
  }
}
function showEditorImportConfirm(current, next, isMerge, preserveStyle = false) {
  let result;
  try {
    if (isMerge) result = mergeImportedSettings(current, next, preserveStyle);
    else {
      const direct = cloneSettingsData(next);
      // AI imports are timetable-only and must not change this browser's visual
      // preferences; regular backups restore the saved visual preferences.
      direct.breakTimes = cloneSettingsData(next.breakTimes || []);
      if (preserveStyle) {
        direct.proAccent = current.proAccent;
        direct.proSecondary = current.proSecondary;
        direct.styleSlots = cloneSettingsData(current.styleSlots || []);
      }
      result = { data: normalizeSettingsData(direct), actions: [] };
    }
  } catch (error) {
    state.pendingEditorImportData = null;
    setEditorConfirmContent(
      t('editorBackup.importFailedTitle'),
      t('editorBackup.importFailedMessage'),
      error.message || String(error),
      t('common.back'),
      hideEditorDiscardConfirm,
      null
    );
    showEditorConfirmSheet();
    return;
  }
  state.pendingEditorImportData = result.data;
  const diff = isMerge
    ? [
        t('editorBackup.diffAdded'),
        ...result.addedActions.map(item => `- ${item}`),
        '',
        t('editorBackup.diffMerged'),
        ...result.mergedActions.map(item => `- ${item}`),
        '',
        t('editorBackup.diffReplaced'),
        ...result.replacedActions.map(item => `- ${item}`)
      ].join('\n')
    : describeSettingsDiff(current, next, { isImport: true });
  const identical = !isMerge && diff === t('editorBackup.noChanges');
  setEditorConfirmContent(
    isMerge
      ? t('editorBackup.confirmMergeImportTitle')
      : t('editorBackup.confirmDirectImportTitle'),
    identical
      ? t('editorBackup.identicalImportMessage')
      : isMerge
        ? t('editorBackup.mergeImportHint')
        : t('editorBackup.directImportWarning'),
    identical ? t('editorBackup.identicalImportDetail') : diff,
    isMerge ? t('editorBackup.confirmMerge') : t('editorBackup.confirmImport'),
    applyPendingImportSettings,
    t('common.back'),
    {
      // A direct import replaces the saved schedule; a merge only adds to it.
      danger: !isMerge && !identical,
      cancelHandler: () => showEditorImportModeConfirm(current, next, preserveStyle)
    }
  );
  showEditorConfirmSheet();
}
// `fromSync` distinguishes "this device's own edit just got saved" from
// "this data arrived from another device via sync.js's pullSyncSnapshot" -
// the two need different feedback (a viewer never *saved* anything, so a
// "已儲存" toast would be actively misleading - see the toast text below)
// and different side effects (only a genuine local save should turn around
// and push to sync; echoing back data sync itself just pulled would just
// bounce the same write straight back out).
function applyEditorSettingsData(
  next,
  { closeAfter = false, statusMessage = '', fromSync = false } = {}
) {
  state.applicationData = cloneSettingsData(next);
  state.applicationData.proAccent = normalizeProAccent(state.applicationData.proAccent);
  state.applicationData.proSecondary = normalizeProSecondary(state.applicationData.proSecondary);
  state.applicationData.styleSlots = normalizeStyleSlots(state.applicationData.styleSlots);
  saveData(state.applicationData);
  applyProAccent();
  buildSchedule();
  renderEditorTeachers();
  renderEditorBells();
  renderEditorBreaks();
  renderEditorSchedule();
  renderCountdownEvent();
  sortEditorPeriodsByTime();
  syncEditorToggles();
  state.editorBaselineSnapshot = editorFormSnapshotString();
  state.editorBaselineData = cloneSettingsData(state.applicationData);
  state.lastListKey = '';
  window.update();
  if (statusMessage) setTransferStatus(statusMessage);
  const toast = document.getElementById('save-toast');
  toast.textContent = fromSync ? t('editorBackup.updatedFromOtherDevice') : t('editorBackup.saved');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
  if (closeAfter) setTimeout(() => closeEditor(true), 400);
  // A real local change (never one sync itself just applied) pushes right
  // away instead of waiting for the next poll tick - see sync.js's syncTick
  // for the regular interval this supplements, not replaces: a failed push
  // here still gets picked up by the next tick's own push-then-pull pass.
  // Fire-and-forget - a slow or failed push is surfaced via the status line
  // but must never block or fail the save that already happened locally.
  if (!fromSync && isSyncConfigured() && !isSyncViewer()) {
    pushSyncSnapshot().then(result => {
      if (!result.ok) setSyncStatusUi(result.error, true);
    });
  }
}
function applyPendingImportSettings() {
  if (!state.pendingEditorImportData) {
    hideEditorDiscardConfirm();
    return;
  }
  applyEditorSettingsData(state.pendingEditorImportData, {
    closeAfter: true,
    statusMessage: t('editorBackup.importedAndSaved')
  });
  document.getElementById('settings-transfer-text').value = '';
  state.pendingEditorImportData = null;
  resetOCRImporterUI();
  hideEditorDiscardConfirm();
}
// A full local factory reset: wipes every key this app ever wrote to
// localStorage and reloads, landing back on the very first "開始使用"
// screen. This used to be a hidden trick (typing the literal word "reset"
// into the manual-import textarea, no confirmation at all) - now a real
// button in the time-simulation panel, gated behind the same confirm sheet
// every other irreversible action uses.
function resetAllAppData() {
  setEditorConfirmContent(
    t('editorBackup.resetAllTitle'),
    t('editorBackup.resetAllMessage'),
    t('editorBackup.resetAllDetail'),
    t('common.reset'),
    () => {
      localStorage.clear();
      location.reload();
    },
    t('common.cancel'),
    { danger: true }
  );
  showEditorConfirmSheet();
}
// Clears the AI photo-import box back to its empty state after a successful import/merge.
function resetOCRImporterUI() {
  const input = document.getElementById('ocr-import-image');
  if (input) input.value = '';
  const wrap = document.getElementById('ocr-import-image-wrap');
  wrap?.classList.remove('has-image');
  // Several files can be picked at once, and each decodable one gets its own
  // thumbnail cloned from the first (see mountOCRImporter's renderPreviews) -
  // so the clones have to go too, not just the original from the markup.
  wrap?.querySelectorAll('.ocr-import-image-preview').forEach((node, index) => {
    if (index > 0) {
      node.remove();
      return;
    }
    node.hidden = true;
    node.removeAttribute('src');
  });
  const filename = document.getElementById('ocr-import-filename');
  if (filename) filename.textContent = t('editorBackup.noFileSelected');
  const eta = document.getElementById('ocr-import-eta');
  if (eta) eta.textContent = '';
  const status = document.getElementById('ocr-import-status');
  if (status) {
    status.textContent = '';
    status.classList.remove('error');
  }
  const runBtn = document.getElementById('ocr-import-detect');
  if (runBtn) runBtn.disabled = true;
  const result = document.getElementById('ocr-import-result');
  if (result) {
    result.hidden = true;
    result.replaceChildren();
  }
}
function applyPendingSaveEditor() {
  if (!state.pendingEditorSaveData) {
    hideEditorDiscardConfirm();
    return;
  }
  const transferAction = pendingTransferAction;
  pendingTransferAction = null;
  applyEditorSettingsData(state.pendingEditorSaveData, { closeAfter: !transferAction });
  state.pendingEditorSaveData = null;
  hideEditorDiscardConfirm();
  if (transferAction) runTransferAction(transferAction);
}

// Exposed on window for inline HTML event handlers (onclick="..." in
// index.html and in generated template strings).
window.requestTransferAction = requestTransferAction;
window.resetAllAppData = resetAllAppData;

export {
  applyEditorSettingsData,
  applyPendingSaveEditor,
  beginEditorImport,
  cloneSettingsData,
  collectEditorFormState,
  copyTransferText,
  dayDiffLabel,
  decodeTransferData,
  describeSettingsDiff,
  editorFormSnapshotString,
  encodeTransferData,
  formatClassRef,
  isEditorDirty,
  normalizeSettingsData,
  resetAllAppData,
  resetOCRImporterUI,
  setTransferStatus,
  settingsDataForExport
};
