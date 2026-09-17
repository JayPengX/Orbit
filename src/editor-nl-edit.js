// ---- src/editor-nl-edit.js ----
// Natural-language schedule edits: turns a short Traditional Chinese
// instruction ("把我週二第三節改成物理") into a proposed new state for the
// schedule - classes, weeklySchedule, bellTimes, breakTimes,
// countdownEvents, reverseWeek - previewed as a diff and only ever applied
// after an explicit confirm - never silently. Same server-owns-the-prompt
// discipline as src/gemini-ocr.js's AI photo import: this module only ever
// sends {model, text, context} to the proxy; the Worker's /nl-edit path
// (see cloudflare-worker/orbit-worker.js) owns the actual prompt and
// response_schema, so the deployed proxy URL can never be used to run an
// arbitrary free-form prompt.
//
// Full-state, not fixed verbs: the model reads everything editable via this
// feature and returns the COMPLETE new version of it, echoing back anything
// the instruction didn't ask to change - rather than picking from a small
// set of named operations that could only ever describe "move one class"
// shaped edits. See NL_EDIT_RESPONSE_SCHEMA's own comment in
// orbit-worker.js for why that earlier design was too narrow (it had no way
// to add a bell period, a break time, or a countdown event, and sometimes
// forced a wrong answer through the nearest verb it did have rather than
// cleanly saying it couldn't). applyNlEditResult below is the real safety
// net once a result comes back - the same normalizeSettingsData() every
// other write path (manual save, AI photo import, backup import) already
// runs through, never trusting a class key, day/period reference, or time
// blindly.
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

// Same shared PROXY_URL as gemini-ocr.js and sync.js (see proxy-config.js) -
// a fork that hasn't deployed the Worker simply doesn't get this feature
// (see isNlEditConfigured's callers), no bring-your-own-key fallback. The
// `/nl-edit` path is hardcoded here, not part of the env var.
const NL_EDIT_PROXY_URL = proxyPath('/nl-edit');
function isNlEditConfigured() {
  return !!NL_EDIT_PROXY_URL;
}

// Everything this feature can read and rewrite - the AI can now genuinely
// add a bell period, a break time, or a countdown event, not just move
// classes around within weeklySchedule (see the Worker's own comment on why
// that used to be too narrow). Still never the whole app data blob - no
// style/sync state, same payload-size discipline as gemini-ocr.js.
function buildNlEditContext() {
  const data = settingsDataForExport();
  const classes = Object.entries(data.teacherDB || {}).map(([key, value]) => ({
    key,
    subject: value[0] || '',
    teacher: value[1] || '',
    location: data.locationDB?.[key] || ''
  }));
  return {
    weeklySchedule: data.weeklySchedule,
    classes,
    bellTimes: data.bellTimes,
    breakTimes: data.breakTimes,
    countdownEvents: data.countdownEvents,
    reverseWeek: data.reverseWeek
  };
}

// Same fence-stripping/brace-hunting salvage as gemini-ocr.js's
// parseResponse - the Worker's response_schema should already guarantee
// clean JSON, but this stays defensive rather than trusting that blindly
// (see validateNlEditResult/applyNlEditResult below for the same discipline
// applied to the parsed object's actual field values).
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

// One full pass over NL_EDIT_MODELS, fastest-first - factored out of
// callNlEditProxy so the location-block retry there can cleanly re-run it
// from scratch without duplicating the loop (see that function's own
// comment on why a fresh pass is worth retrying). Returns a discriminated
// result instead of throwing directly for the location-block case
// specifically, since callNlEditProxy needs to tell that one apart from
// every other failure (which isn't worth retrying a whole pass over).
async function tryNlEditModels(text, context) {
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
      return { ok: true, value: extractJsonObject(responseData.candidates?.[0]?.content?.parts?.[0]?.text) };
    }
    const errorJson = await response.json().catch(() => ({}));
    const message = errorJson.error?.message || response.statusText;
    if (response.status === 429 && /請求過於頻繁/.test(message)) throw new Error(message);
    // Google's Gemini API rejects the request based on the calling IP's
    // geolocation - here, the Cloudflare Worker's own egress IP, not the
    // end user's (see gemini-ocr.js's matching comment on AIVisionProcessor
    // for the full explanation). Every model in THIS pass shares that same
    // outbound path, so stop this pass immediately rather than burning
    // through the whole model list - callNlEditProxy decides whether a
    // fresh pass is worth retrying.
    if (response.status === 400 && /User location is not supported/i.test(message)) {
      return {
        ok: false,
        locationBlocked: true,
        error: new Error(
          'AI 服務暫時因伺服器所在地區限制而無法使用，這通常只是暫時性的網路路由問題，請稍後再試一次。'
        )
      };
    }
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

// Low-level call: same fastest-first-model/escalate-on-transient-failure
// shape as gemini-ocr.js's AIVisionProcessor.callGemini, PLUS the same
// location-block retry that function has - a brand new request has a real
// chance of landing on a different Cloudflare edge colo than the one that
// just got blocked, so it's worth retrying a couple of whole passes (with a
// short delay) before finally giving up, rather than surfacing the error on
// the very first hit.
async function callNlEditProxy(text, context) {
  if (!NL_EDIT_PROXY_URL) throw new Error(t('nlEdit.notConfigured'));
  if (!navigator.onLine) throw new Error(t('nlEdit.offline'));
  const LOCATION_BLOCK_RETRY_LIMIT = 2;
  const LOCATION_BLOCK_RETRY_DELAY_MS = 500;
  for (let locationAttempt = 0; ; locationAttempt++) {
    const result = await tryNlEditModels(text, context);
    if (result.ok) return result.value;
    if (!result.locationBlocked || locationAttempt >= LOCATION_BLOCK_RETRY_LIMIT) throw result.error;
    await new Promise(resolve => setTimeout(resolve, LOCATION_BLOCK_RETRY_DELAY_MS));
  }
}

// Cheap shape check only - is every field the right JS type at all? This
// can't fail on CONTENT (a bad class key, an out-of-range day, a malformed
// time) since it has no context to judge that against; applyNlEditResult
// below is what actually re-checks the content, by running it through the
// exact same normalizeSettingsData() every other write path in this app
// already trusts for that job.
function validateNlEditResult(result) {
  if (!result || typeof result !== 'object') return { valid: false, errors: [t('nlEdit.badResponse')] };
  if (!['ok', 'unclear', 'not_found'].includes(result.status)) {
    return { valid: false, errors: [t('nlEdit.badResponse')] };
  }
  if (result.status !== 'ok') return { valid: true, errors: [] };
  const shapeOk =
    Array.isArray(result.classes) &&
    result.weeklySchedule &&
    typeof result.weeklySchedule === 'object' &&
    Array.isArray(result.bellTimes) &&
    Array.isArray(result.breakTimes) &&
    Array.isArray(result.countdownEvents) &&
    typeof result.reverseWeek === 'boolean';
  if (!shapeOk) return { valid: false, errors: [t('nlEdit.badResponse')] };
  return { valid: true, errors: [] };
}

// Turns an already-shape-checked `result` (see validateNlEditResult) into a
// full next settings-data object, built on top of `current` (as
// settingsDataForExport() sees it) - pure data rearrangement, no DOM, so the
// caller can diff it with describeSettingsDiff before ever touching the
// real schedule. Overlays only the fields this feature is allowed to touch
// (classes -> teacherDB+locationDB, weeklySchedule, bellTimes, breakTimes,
// countdownEvents, reverseWeek) onto a clone of `current` - style, sync
// state, and teacherOrder's own existing order all pass through untouched
// (normalizeSettingsData below preserves teacherOrder's current order for
// still-existing keys and appends any new ones, rather than reordering
// everything to match "classes"' own array order).
//
// The AI manages class keys itself now (see buildNlEditPrompt's own
// explanation: reuse an existing key, invent a short new one for a
// genuinely new class) - there's no subject-matching reconciliation to do
// here any more the way the old fixed-verb design needed. Throws (a clear
// Chinese message) if normalizeSettingsData rejects the result as
// structurally unsound - the same defensive check AI photo import and
// manual backup import already run every result through, never trusting a
// day/period reference, bell time, or class key blindly.
function applyNlEditResult(current, result) {
  const next = cloneSettingsData(current);
  const teacherDB = {};
  const locationDB = {};
  (result.classes || []).forEach(entry => {
    const key = String(entry?.key || '').trim();
    if (!key) return;
    teacherDB[key] = [String(entry.subject || ''), String(entry.teacher || ''), String(entry.location || '')];
    locationDB[key] = String(entry.location || '');
  });
  next.teacherDB = teacherDB;
  next.locationDB = locationDB;
  next.weeklySchedule = result.weeklySchedule;
  next.bellTimes = result.bellTimes;
  next.breakTimes = result.breakTimes;
  next.countdownEvents = result.countdownEvents;
  next.reverseWeek = result.reverseWeek;
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
    const validation = validateNlEditResult(result);
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
    let next;
    try {
      next = applyNlEditResult(current, result);
    } catch (error) {
      status?.(error.message || t('nlEdit.badResponse'), true);
      return;
    }
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
  applyNlEditResult,
  buildNlEditContext,
  isNlEditConfigured,
  submitNlEdit,
  validateNlEditResult
};
