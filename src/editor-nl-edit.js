// ---- src/editor-nl-edit.js ----
// Natural-language schedule edits: turns a short Traditional Chinese
// instruction ("把我週二第三節改成物理") into one structured edit against
// teacherDB/weeklySchedule, previewed as a diff and only ever applied after
// an explicit confirm - never silently. Same server-owns-the-prompt
// discipline as src/gemini-ocr.js's AI photo import: this module only ever
// sends {model, text, context} to the proxy; the Worker's /nl-edit path
// (see cloudflare-worker/orbit-worker.js) owns the actual prompt and
// response_schema, so the deployed proxy URL can never be used to run an
// arbitrary free-form prompt.
import { state } from './state.js';
import { t } from './strings.js';
import { isSyncViewer } from './sync.js';
import {
  applyPendingSaveEditor,
  cloneSettingsData,
  describeSettingsDiff,
  normalizeSettingsData,
  settingsDataForExport
} from './editor-backup.js';
import {
  hideEditorDiscardConfirm,
  setEditorConfirmContent,
  showEditorConfirmSheet
} from './editor-core.js';
import { proxyPath } from './proxy-config.js';

// Must match GEMINI_ALLOWED_MODELS in cloudflare-worker/orbit-worker.js -
// the Worker's /nl-edit path reuses the exact same vetted model list as
// /gemini (see that file's own comment on why these two models specifically
// - fastest first, escalate to the stronger one only on a transient
// failure, same fallback shape as AIVisionProcessor.callGemini below).
const NL_EDIT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.7-flash'];

// Mirrors the Worker's own MAX_NL_EDIT_OPS (cloudflare-worker/orbit-worker.js)
// - the Worker never parses the structured response itself (see
// callNlEditProxy), so this is the real enforcement point, not just a
// display hint.
const MAX_NL_EDIT_OPS = 8;

// Same shared PROXY_URL as gemini-ocr.js and sync.js (see proxy-config.js) -
// a fork that hasn't deployed the Worker simply doesn't get this feature
// (see isNlEditConfigured's callers), no bring-your-own-key fallback. The
// `/nl-edit` path is hardcoded here, not part of the env var.
const NL_EDIT_PROXY_URL = proxyPath('/nl-edit');
function isNlEditConfigured() {
  return !!NL_EDIT_PROXY_URL;
}

// The small, fixed shape sent as `context` - just enough for the Worker's
// prompt to resolve "my Tuesday period 3" or "the physics class" against
// the caller's real schedule, never the whole app data blob (no style,
// countdown events, sync state, etc - see README's payload-size notes on
// gemini-ocr.js for the same discipline applied there).
function buildNlEditContext() {
  const data = settingsDataForExport();
  const classes = Object.entries(data.teacherDB || {}).map(([key, value]) => ({
    key,
    subject: value[0] || '',
    teacher: value[1] || '',
    location: data.locationDB?.[key] || ''
  }));
  return { weeklySchedule: data.weeklySchedule, classes, bellTimes: data.bellTimes };
}

// Same fence-stripping/brace-hunting salvage as gemini-ocr.js's
// parseResponse - the Worker's response_schema should already guarantee
// clean JSON, but this stays defensive rather than trusting that blindly
// (see validateNlEditResult below for the same discipline applied to the
// parsed object's actual field values).
function extractJsonObject(rawText) {
  if (!rawText) throw new Error(t('nlEdit.badResponse'));
  const fenceStripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  const cleaned =
    firstBrace !== -1 && lastBrace > firstBrace
      ? fenceStripped.slice(firstBrace, lastBrace + 1)
      : fenceStripped;
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`AI 回傳的內容不是有效的 JSON：${error.message}`, { cause: error });
  }
}

// Low-level call: the same fastest-first/escalate-on-transient-failure
// shape as gemini-ocr.js's AIVisionProcessor.callGemini, just without that
// one's image-specific ETA/console-timing plumbing - a short text
// instruction is small and fast enough not to need it. The prompt and
// generation config are NOT sent from here, same reasoning as
// AIVisionProcessor.callGemini: the proxy owns both and builds the full
// Gemini request itself from just {model, text, context}.
async function callNlEditProxy(text, context) {
  if (!NL_EDIT_PROXY_URL) throw new Error(t('nlEdit.notConfigured'));
  if (!navigator.onLine) throw new Error(t('nlEdit.offline'));
  let lastError = null;
  for (const model of NL_EDIT_MODELS) {
    let response;
    try {
      response = await fetch(NL_EDIT_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, text, context })
      });
    } catch (networkError) {
      lastError = new Error(`無法連線至 AI 服務：${networkError.message}`);
      continue;
    }
    if (response.ok) {
      const responseData = await response.json();
      return extractJsonObject(responseData.candidates?.[0]?.content?.parts?.[0]?.text);
    }
    const errorJson = await response.json().catch(() => ({}));
    const message = errorJson.error?.message || response.statusText;
    if (response.status === 429 && /請求過於頻繁/.test(message)) throw new Error(message);
    // Retryable on the next model: retired/unknown model (404), overloaded
    // (503), rate-limited (429), or transient server errors (5xx) - same
    // set AIVisionProcessor.callGemini treats as retryable.
    lastError = new Error(`AI 指令解析失敗（${response.status}）：${message}`);
    const retryableStatus =
      response.status === 404 ||
      response.status === 429 ||
      response.status === 503 ||
      response.status >= 500;
    if (!retryableStatus) throw lastError;
  }
  throw lastError || new Error('AI 指令解析失敗：沒有可用的模型。');
}

function isValidDay(value) {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}
function isValidPeriod(value, periodCount) {
  return Number.isInteger(value) && value >= 0 && value < periodCount;
}

// A plain {day: [key, ...]} map, deep-cloned from context.weeklySchedule -
// just enough state for validateNlEditResult to track slot occupancy AS IT
// WOULD STAND after each earlier op in the same list, without needing the
// full settingsData shape (teacherDB, locationDB, ...) applyNlEditOps below
// works with. Kept in sync with that function's own moveSlot/swapSlot/
// clearSlot bookkeeping by hand - there are only three slot-shaped
// operations to mirror, so this stays a small, easy-to-eyeball duplication
// rather than something worth a shared abstraction over.
function cloneWeeklySchedule(weeklySchedule) {
  const next = {};
  for (const [day, row] of Object.entries(weeklySchedule || {})) next[day] = [...(row || [])];
  return next;
}
function scheduleSlot(weeklySchedule, day, period) {
  return (weeklySchedule[day] || [])[period] || '';
}
function setScheduleSlot(weeklySchedule, day, period, value) {
  const row = [...(weeklySchedule[day] || [])];
  while (row.length <= period) row.push('');
  row[period] = value;
  weeklySchedule[day] = row;
}

// Never trusts the model's answer blindly - same discipline as
// gemini-ocr.js's DataValidator: every op is re-checked against the actual
// schedule this ran against (the same `context` that was sent), not just
// against the response_schema's shape, which only guarantees the JSON
// parses and each field has the right type, not that a day/period number is
// actually in range or that a slot an op reads from is actually occupied.
//
// `result.ops` is validated IN ORDER against a running simulated schedule
// (see cloneWeeklySchedule above) so a later op can legally reference a
// slot an earlier op in the same list just emptied or filled - see
// buildNlEditPrompt's own explanation of this sequencing on the Worker
// side. The first invalid op stops validation there (errors are prefixed
// with "第 N 項：" once there's more than one op, so a multi-edit
// instruction's failure clearly points at which part of it didn't work).
function validateNlEditResult(result, context) {
  if (!result || typeof result !== 'object') return { valid: false, errors: [t('nlEdit.badResponse')] };
  if (!['ok', 'unclear', 'not_found'].includes(result.status)) {
    return { valid: false, errors: [t('nlEdit.badResponse')] };
  }
  if (result.status !== 'ok') return { valid: true, errors: [] };
  if (!Array.isArray(result.ops) || !result.ops.length) return { valid: false, errors: [t('nlEdit.badResponse')] };
  if (result.ops.length > MAX_NL_EDIT_OPS) return { valid: false, errors: [t('nlEdit.tooManyOps')] };

  const periodCount = (context.bellTimes || []).length;
  const schedule = cloneWeeklySchedule(context.weeklySchedule);
  for (let i = 0; i < result.ops.length; i++) {
    const op = result.ops[i];
    // t() takes no interpolation params (see strings.js) - substituted by
    // hand here rather than teaching it a templating syntax for this one
    // call site.
    const prefix = result.ops.length > 1 ? t('nlEdit.opPrefix').replace('{n}', String(i + 1)) : '';
    if (!op || typeof op !== 'object') return { valid: false, errors: [prefix + t('nlEdit.badResponse')] };
    if (op.op === 'setSlot') {
      if (!isValidDay(op.day) || !isValidPeriod(op.period, periodCount)) {
        return { valid: false, errors: [prefix + t('nlEdit.outOfRange')] };
      }
      if (!String(op.subject || '').trim()) return { valid: false, errors: [prefix + t('nlEdit.missingSubject')] };
      setScheduleSlot(schedule, op.day, op.period, '#'); // placeholder key - only occupancy matters here
    } else if (op.op === 'moveSlot' || op.op === 'swapSlot') {
      if (
        !isValidDay(op.fromDay) ||
        !isValidDay(op.toDay) ||
        !isValidPeriod(op.fromPeriod, periodCount) ||
        !isValidPeriod(op.toPeriod, periodCount)
      ) {
        return { valid: false, errors: [prefix + t('nlEdit.outOfRange')] };
      }
      const fromValue = scheduleSlot(schedule, op.fromDay, op.fromPeriod);
      const toValue = scheduleSlot(schedule, op.toDay, op.toPeriod);
      if (op.op === 'moveSlot' && !fromValue) {
        return { valid: false, errors: [prefix + t('nlEdit.emptySource')] };
      }
      if (op.op === 'swapSlot' && !fromValue && !toValue) {
        return { valid: false, errors: [prefix + t('nlEdit.emptySource')] };
      }
      setScheduleSlot(schedule, op.toDay, op.toPeriod, fromValue);
      setScheduleSlot(schedule, op.fromDay, op.fromPeriod, op.op === 'swapSlot' ? toValue : '');
    } else if (op.op === 'clearSlot') {
      if (!isValidDay(op.day) || !isValidPeriod(op.period, periodCount)) {
        return { valid: false, errors: [prefix + t('nlEdit.outOfRange')] };
      }
      setScheduleSlot(schedule, op.day, op.period, '');
    } else {
      return { valid: false, errors: [prefix + t('nlEdit.badResponse')] };
    }
  }
  return { valid: true, errors: [] };
}

function nextNlClassKey(teacherDB) {
  let n = 1;
  while (teacherDB[`nl${n}`]) n++;
  return `nl${n}`;
}
// Reuses an existing class when the instruction's subject (and teacher, if
// given) already matches one - the same "don't create a visible duplicate
// row for the same course" reasoning as gemini-ocr.js's addClass - and
// otherwise creates a new one rather than guessing at fields the model
// wasn't given.
function resolveClassKey(teacherDB, subject, teacher, location) {
  const cleanSubject = String(subject || '').trim();
  const cleanTeacher = String(teacher || '').trim();
  const cleanLocation = String(location || '').trim();
  const entries = Object.entries(teacherDB || {});
  let match = entries.find(([, value]) => value[0] === cleanSubject && value[1] === cleanTeacher);
  if (!match && !cleanTeacher) match = entries.find(([, value]) => value[0] === cleanSubject);
  if (match) {
    const [key, value] = match;
    return {
      key,
      teacherDB: {
        ...teacherDB,
        [key]: [cleanSubject, cleanTeacher || value[1] || '', cleanLocation || value[2] || '']
      }
    };
  }
  const key = nextNlClassKey(teacherDB || {});
  return {
    key,
    teacherDB: { ...(teacherDB || {}), [key]: [cleanSubject, cleanTeacher, cleanLocation] }
  };
}
// One op's worth of the same row-splicing setScheduleSlot above does for
// validation's lighter-weight simulation - kept separate because this one
// mutates the full settingsData shape (weeklySchedule lives one level
// deeper, under `next.weeklySchedule`) rather than a bare {day: [key,...]}
// map.
function setNextScheduleSlot(next, day, period, value) {
  const row = [...(next.weeklySchedule[day] || [])];
  while (row.length <= period) row.push('');
  row[period] = value;
  next.weeklySchedule = { ...next.weeklySchedule, [day]: row };
}
function nextScheduleSlot(next, day, period) {
  return (next.weeklySchedule[day] || [])[period] || '';
}

// Applies one already-validated op (see validateNlEditResult) onto `next`
// in place (reassigning its own properties, same mutation style as
// setNextScheduleSlot) - called once per op, in order, by applyNlEditOps
// below.
function applyOneNlEditOp(next, op) {
  if (op.op === 'setSlot') {
    const { key, teacherDB } = resolveClassKey(next.teacherDB, op.subject, op.teacher, op.location);
    next.teacherDB = teacherDB;
    next.locationDB = { ...next.locationDB, [key]: teacherDB[key][2] };
    if (!next.teacherOrder.includes(key)) next.teacherOrder = [...next.teacherOrder, key];
    setNextScheduleSlot(next, op.day, op.period, key);
  } else if (op.op === 'clearSlot') {
    setNextScheduleSlot(next, op.day, op.period, '');
  } else {
    // moveSlot / swapSlot: both are "put whatever's in slot A into slot B",
    // differing only in whether slot A also receives what used to be in B
    // (swapSlot) or is simply left empty (moveSlot).
    const fromValue = nextScheduleSlot(next, op.fromDay, op.fromPeriod);
    const toValue = nextScheduleSlot(next, op.toDay, op.toPeriod);
    setNextScheduleSlot(next, op.toDay, op.toPeriod, fromValue);
    setNextScheduleSlot(next, op.fromDay, op.fromPeriod, op.op === 'swapSlot' ? toValue : '');
  }
}

// Turns an already-validated `result` (see validateNlEditResult) into a
// full next settings-data object, built on top of `current` (as
// settingsDataForExport() sees it) - pure data rearrangement, no DOM, so
// the caller can diff it with describeSettingsDiff before ever touching the
// real schedule. Applies every op in result.ops in order, each one seeing
// the effect of every op before it - same sequencing validateNlEditResult
// already checked against, just now actually mutating the full settings
// shape (teacherDB/locationDB/teacherOrder too, not just weeklySchedule).
function applyNlEditOps(current, result) {
  const next = cloneSettingsData(current);
  for (const op of result.ops) applyOneNlEditOp(next, op);
  return normalizeSettingsData(next);
}

// A single-button info sheet - same shape as editor-core.js's own "AI 辨識
// 中" dialog (setEditorConfirmContent with cancelLabel null) - for the two
// non-crashing failure states this feature has to treat as first-class,
// not as thrown errors: "I can't understand this command" (unclear) and
// "this refers to something that doesn't exist" (not_found).
function showNlEditInfo(title, message) {
  setEditorConfirmContent(title, message, '', t('nlEdit.dismiss'), hideEditorDiscardConfirm, null);
  showEditorConfirmSheet();
}

// The confirm-before-apply step every proposed edit goes through, reusing
// editor-backup.js's own diff/save machinery rather than inventing a
// second one: describeSettingsDiff produces the same human-readable diff
// text the schedule editor's own save confirmation uses, and
// applyPendingSaveEditor (via state.pendingEditorSaveData) is the exact
// same "apply, save, toast, push to sync if configured" path a normal
// manual save goes through - see editor-schedule.js's saveEditor(). Nothing
// here is ever applied without this step.
function showNlEditConfirm(current, next) {
  const diff = describeSettingsDiff(current, next);
  if (diff === '沒有變更。') {
    showNlEditInfo(t('nlEdit.noChangeTitle'), t('nlEdit.noChangeMessage'));
    return;
  }
  state.pendingEditorSaveData = next;
  setEditorConfirmContent(
    t('nlEdit.confirmTitle'),
    t('nlEdit.confirmMessage'),
    diff,
    t('nlEdit.confirmApply'),
    applyPendingSaveEditor,
    t('nlEdit.confirmCancel')
  );
  showEditorConfirmSheet();
}

// The entry point the UI wiring below calls. `status` reports progress/
// errors back to the caller's own status line; `onDone` always fires last
// (success, failure, or a first-class unclear/not_found outcome) so the UI
// can re-enable its controls.
async function submitNlEdit(rawText, { status, onDone } = {}) {
  const text = String(rawText || '').trim();
  try {
    if (isSyncViewer()) {
      status?.(t('nlEdit.viewerLocked'), true);
      return;
    }
    if (!text) {
      status?.(t('nlEdit.emptyInput'), true);
      return;
    }
    if (!isNlEditConfigured()) {
      status?.(t('nlEdit.notConfigured'), true);
      return;
    }
    if (!navigator.onLine) {
      status?.(t('nlEdit.offline'), true);
      return;
    }
    status?.(t('nlEdit.working'));
    const current = settingsDataForExport();
    const context = buildNlEditContext();
    const result = await callNlEditProxy(text, context);
    const validation = validateNlEditResult(result, context);
    if (!validation.valid) {
      status?.(validation.errors.join('') || t('nlEdit.badResponse'), true);
      return;
    }
    if (result.status === 'unclear') {
      status?.('');
      showNlEditInfo(t('nlEdit.unclearTitle'), result.reason?.trim() || t('nlEdit.unclearMessage'));
      return;
    }
    if (result.status === 'not_found') {
      status?.('');
      showNlEditInfo(
        t('nlEdit.notFoundTitle'),
        result.reason?.trim() || t('nlEdit.notFoundMessage')
      );
      return;
    }
    const next = applyNlEditOps(current, result);
    status?.(t('nlEdit.ready'));
    showNlEditConfirm(current, next);
  } catch (error) {
    status?.(error.message, true);
  } finally {
    onDone?.();
  }
}

// Wires the schedule editor's always-present "AI 課表編輯" box (see
// index.html - it lives at the top of #editor-sheet-body, not the transfer
// sheet, since it edits the schedule directly) - unlike gemini-ocr.js's OCR
// importer, there's no lazy mount here: no image canvas/preview plumbing to
// defer, just one text input and one button.
function mountNlEditor() {
  const input = document.getElementById('nl-edit-input');
  const button = document.getElementById('nl-edit-submit');
  const statusElement = document.getElementById('nl-edit-status');
  if (!input || !button || !statusElement) return;
  const setStatus = (message, isError = false) => {
    statusElement.textContent = message || '';
    statusElement.classList.toggle('error', isError);
  };
  const run = async () => {
    button.disabled = true;
    input.disabled = true;
    await submitNlEdit(input.value, {
      status: setStatus,
      onDone: () => {
        button.disabled = false;
        input.disabled = false;
      }
    });
  };
  button.addEventListener('click', run);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    run();
  });
}
mountNlEditor();

export {
  applyNlEditOps,
  buildNlEditContext,
  isNlEditConfigured,
  resolveClassKey,
  submitNlEdit,
  validateNlEditResult
};
