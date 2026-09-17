// ---- src/sync.js ----
// Optional cross-device sync: mirrors the already-saved schedule
// (state.applicationData) to a Firestore document and polls it for changes
// made from other devices. Reuses the same compressed v2 backup string the
// manual export/import flow already produces (editor-backup.js) as the
// document payload, so this is really "auto-paste the export text into a
// shared doc, auto-import it elsewhere" rather than a separate data format.
//
// No server of Orbit's own, in the sense that end users never run or pay
// for anything: every read/write goes through a Cloudflare Worker (see
// cloudflare-worker/orbit-worker.js's /sync path, backed by the same shared
// PROXY_URL as gemini-ocr.js and editor-nl-edit.js - see proxy-config.js)
// that the app's owner - not each user - deploys once. The Worker holds its
// own Firebase service-account credentials server-side and applies real,
// cross-request rate limiting, then proxies to Firestore - the same
// reasoning as gemini-ocr.js talking to the Gemini proxy instead of Gemini
// directly.
//
// One shared sync code plus a separate manager passcode - the passcode is
// the only thing "manager mode" is gated by, both here and server-side (see
// the Worker's handleSyncRequest): reading (GET) never needs it, anyone
// with the plain sync code can receive updates, exactly like the original
// single-code design. Only writing (PATCH) and deleting (DELETE) require
// the correct passcode - the Worker checks it against the hash it stored at
// creation time, so this isn't just a client-side convention any more.
//
// This feature simply doesn't work without PROXY_URL set (see
// isSyncProxyConfigured) - same as gemini-ocr.js's AI import without its own
// proxy URL. There's no fallback to talking to Firestore directly from the
// browser any more: that path had no real rate limiting (Firestore rules
// can validate a request's shape but can't count requests), so it only ever
// made sense as a stopgap before this Worker existed.
import { state } from './state.js';
import {
  applyEditorSettingsData,
  cloneSettingsData,
  copyTransferText,
  decodeTransferData,
  encodeTransferData,
  isEditorDirty,
  normalizeSettingsData
} from './editor-backup.js';
import {
  hideEditorDiscardConfirm,
  setEditorConfirmContent,
  setStatusText,
  showEditorConfirmSheet
} from './editor-core.js';
import { proxyPath } from './proxy-config.js';

// The `/sync` path is hardcoded here, not part of the env var - see
// proxy-config.js, which is what actually reads PROXY_URL.
const SYNC_PROXY_URL = proxyPath('/sync');
const CODE_KEY = 'orbitSyncCode';
// Empty/absent means this device is a viewer; a non-empty value is the
// actual manager passcode, kept in plaintext (there's nothing else it could
// be kept as - it has to be sent back to the Worker on every write) so this
// device can re-display or re-share it later (see renderSyncPanel's manager
// passcode reveal) instead of it being a one-time-only secret the way the
// old two-code design's viewer code was.
const MANAGER_PASSCODE_KEY = 'orbitSyncManagerPasscode';
const LAST_UPDATE_TIME_KEY = 'orbitSyncLastUpdateTime';
// Left over from before this feature required the proxy Worker, when a
// device could pair against a self-typed Firebase project id - cleared
// opportunistically below so an old pairing doesn't leave a stale value
// sitting in localStorage forever.
const LEGACY_PROJECT_ID_KEY = 'orbitSyncProjectId';
// Left over from an earlier revision of this feature that split manager and
// viewer into two separate codes instead of one code plus a passcode -
// cleared opportunistically the same way, so a pairing made under that
// short-lived design doesn't leave a stale, now-meaningless role flag
// sitting in localStorage forever.
const LEGACY_ROLE_KEY = 'orbitSyncRole';
// A per-device (not per-pairing) preference - deliberately survives
// clearSyncPairing/setSyncPairing, since it's about *this device's own*
// taste in colors, not something tied to any one pairing code.
const KEEP_LOCAL_STYLE_KEY = 'orbitSyncKeepLocalStyle';
// The last style actually seen coming from the shared document - separate
// from this device's own (possibly deliberately different) applicationData
// once KEEP_LOCAL_STYLE_KEY is set. Pairing-scoped, unlike the preference
// above: it's "what this pairing's shared style is", so it's cleared
// alongside the rest of the pairing state.
const LAST_KNOWN_SHARED_STYLE_KEY = 'orbitSyncLastKnownStyle';
// A one-shot safety net for the one genuinely destructive moment in this
// whole feature: un-checking "不同步樣式顏色" immediately applies the shared
// style/presets over whatever this device had, with no other undo. Written
// right before that happens (see orbitSyncSetKeepLocalStyle), offered back
// the moment there's somewhere to offer it from again - re-checking the box
// is exactly when "did you want your own colors back, or are the shared
// ones fine now" becomes a real question, the same shape as the schedule
// backup's unlink-time prompt below. A per-device backup, like the
// preference itself, not tied to any one pairing.
const STYLE_BACKUP_KEY = 'orbitSyncStyleBackup';
// The same kind of one-shot safety net as the style backup above, but for
// the whole schedule: joining an existing sync immediately and irreversibly
// replaces this device's local schedule with whatever the shared document
// holds (see performSyncJoin) - the only warning beforehand is the
// "加入會立刻用該代碼下的課表取代..." text in orbitSyncJoin's confirm sheet,
// which is easy to click through without really registering. Backed up
// right before that replacement actually happens, offered back the moment
// there's somewhere to offer it from again - unlinking or deleting the sync
// both leave this device on its own, which is exactly when "did you want
// your old schedule back, or is the one you've been using fine" becomes a
// real question. Per-device, not tied to any one pairing, same as the style
// backup - a device could join, unlink, rejoin a different code, and unlink
// again before ever dealing with the first backup.
const SCHEDULE_BACKUP_KEY = 'orbitSyncScheduleBackup';
const MANAGER_ROLE = 'manager';
const VIEWER_ROLE = 'viewer';

function readLocal(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function writeLocal(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage unavailable (private browsing, etc.) */
  }
}
function readLocalJSON(key) {
  try {
    return JSON.parse(readLocal(key) || 'null');
  } catch {
    return null;
  }
}

function isSyncProxyConfigured() {
  return !!SYNC_PROXY_URL;
}
function getSyncCode() {
  return readLocal(CODE_KEY).trim();
}
function isSyncConfigured() {
  return !!getSyncCode();
}
function getSyncManagerPasscode() {
  return readLocal(MANAGER_PASSCODE_KEY).trim();
}
// Only ever writes the passcode itself, unlike setSyncPairing below - used
// when an already-joined viewer device unlocks manager mode later (see
// orbitSyncUpgradeToManager), which shouldn't reset the code, last-update
// time, or anything else this device already has.
function setSyncManagerPasscode(passcode) {
  writeLocal(MANAGER_PASSCODE_KEY, String(passcode || '').trim());
}
// A device is a manager purely by possessing the correct manager passcode
// locally - never a role asserted by the server or chosen once and
// remembered separately. Whether that passcode is actually still correct
// is checked wherever it's actually load-bearing (every write, every
// delete - see the Worker's handleSyncRequest), not here; this is only
// "does this device currently believe itself to be a manager."
function getSyncRole() {
  return getSyncManagerPasscode() ? MANAGER_ROLE : VIEWER_ROLE;
}
function isSyncViewer() {
  return isSyncConfigured() && getSyncRole() === VIEWER_ROLE;
}
// A receiving device's own opt-out of the shared color scheme - once set,
// pullSyncSnapshot (see below) keeps this device's own proAccent/
// proSecondary/proTertiary/styleSlots untouched no matter what a manager
// device publishes, while still applying every other synced change
// normally. Most useful for a viewer (who never publishes style changes of
// their own anyway), but not restricted to one - nothing about wanting your
// own device's colors left alone requires being read-only.
function getSyncKeepLocalStyle() {
  return readLocal(KEEP_LOCAL_STYLE_KEY) === '1';
}
function setSyncKeepLocalStyle(value) {
  writeLocal(KEEP_LOCAL_STYLE_KEY, value ? '1' : '');
}
function getLastKnownSharedStyle() {
  return readLocalJSON(LAST_KNOWN_SHARED_STYLE_KEY);
}
function setLastKnownSharedStyle(data) {
  writeLocal(LAST_KNOWN_SHARED_STYLE_KEY, JSON.stringify(styleFieldsOf(data)));
}
function getStyleBackup() {
  return readLocalJSON(STYLE_BACKUP_KEY);
}
// The four fields that make up "a style" everywhere in this file: the three
// theme colors plus the five saved presets (styleSlots). Kept as one helper
// so the backup, the shared-style cache, the equality check below and the
// restore all agree on exactly what a style is - a preset the user saved
// under the opt-out is just as much theirs to lose as the accent color is.
function styleFieldsOf(data) {
  return {
    proAccent: data?.proAccent,
    proSecondary: data?.proSecondary,
    proTertiary: data?.proTertiary,
    styleSlots: data?.styleSlots
  };
}
// "Is there actually anything to restore here" - the same question
// promptScheduleBackupRestore never has to ask (a schedule that came back
// byte-identical to the one it replaced is vanishingly unlikely), but that
// this backup does: a device that never customized anything before turning
// the opt-out off has a backup identical to the shared style it just
// received, and offering that back would be a popup whose two answers do
// exactly the same thing.
function sameStyle(a, b) {
  return JSON.stringify(styleFieldsOf(a)) === JSON.stringify(styleFieldsOf(b));
}
function backUpCurrentStyle() {
  writeLocal(STYLE_BACKUP_KEY, JSON.stringify(styleFieldsOf(state.applicationData)));
}
function clearStyleBackup() {
  writeLocal(STYLE_BACKUP_KEY, '');
}
function getScheduleBackup() {
  return readLocalJSON(SCHEDULE_BACKUP_KEY);
}
// Takes the data to back up as a parameter, rather than reading
// state.applicationData itself, because by the time performSyncJoin knows
// whether it's actually needed (pullSyncSnapshot's `applied` result), the
// join has already overwritten state.applicationData with the incoming
// data - the pre-join snapshot has to be captured before that happens and
// carried through.
function backUpLocalSchedule(data) {
  writeLocal(SCHEDULE_BACKUP_KEY, JSON.stringify(data));
}
function clearScheduleBackup() {
  writeLocal(SCHEDULE_BACKUP_KEY, '');
}
// `managerPasscode` is empty for a viewer pairing, the actual passcode for
// a manager one - see MANAGER_PASSCODE_KEY's comment on why it's kept in
// plaintext rather than hashed or one-time-only.
function setSyncPairing(code, managerPasscode = '') {
  writeLocal(
    CODE_KEY,
    String(code || '')
      .trim()
      .toUpperCase()
  );
  setSyncManagerPasscode(managerPasscode);
  writeLocal(LAST_UPDATE_TIME_KEY, '');
  writeLocal(LEGACY_PROJECT_ID_KEY, '');
  writeLocal(LEGACY_ROLE_KEY, '');
  writeLocal(LAST_KNOWN_SHARED_STYLE_KEY, '');
  lastPushedSnapshot = null;
}
function clearSyncPairing() {
  writeLocal(CODE_KEY, '');
  writeLocal(MANAGER_PASSCODE_KEY, '');
  writeLocal(LAST_UPDATE_TIME_KEY, '');
  writeLocal(LEGACY_PROJECT_ID_KEY, '');
  writeLocal(LEGACY_ROLE_KEY, '');
  writeLocal(LAST_KNOWN_SHARED_STYLE_KEY, '');
  lastPushedSnapshot = null;
}
function proxyUrl(code, extraParams = {}) {
  const params = new URLSearchParams({ code, ...extraParams });
  return `${SYNC_PROXY_URL}?${params.toString()}`;
}
// The proxy's errors (rate limit, bad code, upstream failure) come back as
// `{error:{message}}` - a 429 gets its own friendlier text here rather than
// whatever the Worker's own (already-friendly, but sync-context-less)
// message says.
async function proxyErrorMessage(response) {
  if (response.status === 429) return '請求過於頻繁，請稍後再試。';
  const errorJson = await response.json().catch(() => ({}));
  return errorJson.error?.message || response.statusText || `HTTP ${response.status}`;
}

// Reading never needs a passcode - any holder of the plain sync code can
// fetch the shared schedule, exactly like the original single-code design.
// `passcode`, when supplied, is purely a *role check*: the Worker compares
// it against this document's manager passcode and reports back `role:
// 'manager'` only if it matches (see handleSyncRequest) - used at join time
// and by orbitSyncUpgradeToManager, never by ordinary polling (which has no
// reason to ask "am I a manager" on every single check - it already knows
// from local storage).
async function fetchSyncDoc(code, passcode = '') {
  const response = await fetch(proxyUrl(code, passcode ? { passcode } : {}));
  // The Worker rejects a code that doesn't match the expected 8-character
  // shape with 400, before it ever asks Firestore about it - a real,
  // generated code always matches that shape, so from here a 400 only ever
  // means a mistyped/bogus code, never a genuine failure. Treated the same
  // as "not found" (a real code that just has nothing published under it
  // yet) so the user sees the same friendly "找不到這組配對代碼" either way,
  // instead of a raw "Invalid pairing code".
  if (response.status === 400) {
    return { ok: true, exists: false, updateTime: '', payload: '', role: null };
  }
  if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
  const data = await response.json();
  return {
    ok: true,
    exists: !!data.exists,
    updateTime: data.updateTime || '',
    payload: data.payload || '',
    // Only ever 'manager' (the supplied passcode matched) or null (no
    // passcode supplied, or it didn't match) - the Worker never reports
    // 'viewer' as such, since reading needs no passcode to begin with.
    role: data.role === MANAGER_ROLE ? MANAGER_ROLE : null
  };
}

// Mints a brand new pairing - a fresh sync code and a separate, unrelated
// manager passcode (see the Worker's handleSyncCreate) - with `payload` as
// its starting shared schedule. Unlike every other request here, this one
// carries no code at all - there's nothing to look up yet, the server is
// creating something new.
async function createSyncDoc(payload) {
  try {
    const response = await fetch(SYNC_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload })
    });
    if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
    const data = await response.json();
    return {
      ok: true,
      code: data.code,
      managerPasscode: data.managerPasscode,
      updateTime: data.updateTime || ''
    };
  } catch (error) {
    return { ok: false, error: `建立同步失敗：${error.message || error}` };
  }
}

// Writing always needs the manager passcode - see writeSyncDoc's caller,
// pushSyncSnapshot, which only ever runs on a device that has one stored
// (a viewer never reaches this; see syncTick and applyEditorSettingsData's
// own isSyncViewer() gates). The Worker re-checks it independently either
// way (see handleSyncRequest's PATCH branch) - this isn't the only thing
// standing between a viewer and a write, just the client's own half of it.
async function writeSyncDoc(code, payload, passcode) {
  const response = await fetch(proxyUrl(code), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, passcode })
  });
  if (!response.ok) {
    // A 404 here specifically means the Worker's own firestoreGet found
    // nothing under this code (see handleSyncRequest's PATCH branch) - a
    // reliable, status-code-level signal (not a string match on the error
    // message) that pushSyncSnapshot's caller can use to tell "the shared
    // document was deleted out from under this device" apart from every
    // other write failure (rate limit, wrong passcode, upstream error).
    return {
      ok: false,
      notFound: response.status === 404,
      error: await proxyErrorMessage(response)
    };
  }
  const doc = await response.json();
  return { ok: true, updateTime: doc.updateTime || '' };
}

// Wipes the shared document on the server outright - see
// orbitSyncDeleteForEveryone. Unlike writeSyncDoc/fetchSyncDoc, this isn't
// something syncTick's regular loop ever calls; it only ever runs as a
// deliberate, manager-triggered, confirmed action - and, like writeSyncDoc,
// needs the manager passcode (as a query param here, since this app never
// sends a DELETE with a body - see the Worker's own comment on why).
async function deleteSyncDoc(code, passcode) {
  const response = await fetch(proxyUrl(code, { passcode }), { method: 'DELETE' });
  if (!response.ok) return { ok: false, error: await proxyErrorMessage(response) };
  return { ok: true };
}

// The "has anything actually changed" check syncTick uses to decide whether
// to push ignores style fields entirely once this device has opted out of
// style sync - otherwise its own permanently-different local color would
// look like a pending change forever, and every activity tick would push
// again for no reason. When the opt-out is off this is just a plain
// snapshot, identical to before.
function snapshotForComparison(data) {
  if (!getSyncKeepLocalStyle()) return JSON.stringify(data);
  const rest = { ...data };
  delete rest.proAccent;
  delete rest.proSecondary;
  delete rest.proTertiary;
  delete rest.styleSlots;
  return JSON.stringify(rest);
}
// What actually gets uploaded. Once opted out, this device's own style is
// purely local and must never leak into the shared document - a manager who
// checked the opt-out and then saves *anything* (even something unrelated
// to style) still shouldn't overwrite the shared color scheme everyone else
// sees with their own kept-local one. Substitutes the last style actually
// seen from the shared document instead (see pullSyncSnapshot, which caches
// it on every real pull); falls back to this device's own style if nothing
// has ever been pulled yet (e.g. the very first push right after creating a
// brand new sync, where this device's style *is* what becomes shared).
function dataForPush() {
  if (!getSyncKeepLocalStyle()) return state.applicationData;
  const sharedStyle = getLastKnownSharedStyle();
  return sharedStyle ? { ...state.applicationData, ...sharedStyle } : state.applicationData;
}

// Uploads the currently-saved schedule as-is (never the live, possibly
// unsaved editor form) so sync can never publish a half-edited draft.
async function pushSyncSnapshot() {
  const code = getSyncCode();
  if (!isSyncProxyConfigured() || !code) return { ok: false, error: '尚未設定同步。' };
  try {
    const payload = await encodeTransferData(dataForPush());
    const result = await writeSyncDoc(code, payload, getSyncManagerPasscode());
    if (!result.ok) {
      // This device's own stored code already proved it worked at least
      // once (create/join both require the doc to exist first) - a 404 here
      // means the shared document was deleted from elsewhere (see
      // orbitSyncDeleteForEveryone), not a malformed/never-valid code.
      // Reported back as its own outcome (not thrown as a plain error) so
      // syncTick can auto-unlink instead of just showing a confusing
      // "找不到這組配對代碼" on every future tick.
      if (result.notFound) return { ok: true, pushed: false, remoteDeleted: true };
      throw new Error(result.error);
    }
    writeLocal(LAST_UPDATE_TIME_KEY, result.updateTime);
    // Owned here, not by callers - applyEditorSettingsData's own
    // immediate-push-on-save (see editor-backup.js) and syncTick's regular
    // poll both funnel through this one function, so this is the one place
    // that reliably knows "what we last actually pushed matches what's live
    // right now" regardless of which caller triggered it.
    lastPushedSnapshot = snapshotForComparison(state.applicationData);
    return { ok: true, pushed: true };
  } catch (error) {
    return { ok: false, error: `同步上傳失敗：${error.message || error}` };
  }
}

// Pulls the shared document and applies it only when it's actually newer
// than the last version this device already has, and only when the editor
// has no unsaved changes in progress (never clobber an in-progress edit).
// `exists` distinguishes "not found, nothing was ever published under this
// code" from every other outcome (found the document, whether or not there
// was anything new to apply) - performSyncJoin() needs that distinction to
// refuse joining a code nobody has actually created yet, which callers
// that only care about `applied` (syncTick's regular polling) can ignore.
//
// Accepts an already-fetched `doc` (performSyncJoin's own existence/
// passcode-check GET) instead of always issuing its own - joining would
// otherwise cost two GETs for the exact same document (one just to check,
// one to actually pull) when the first one already had everything this
// function needs.
async function pullSyncSnapshot({ force = false, doc: prefetchedDoc = null } = {}) {
  const code = getSyncCode();
  if (!isSyncProxyConfigured() || !code) return { ok: false, error: '尚未設定同步。' };
  try {
    const doc = prefetchedDoc || (await fetchSyncDoc(code));
    if (!doc.ok) throw new Error(doc.error);
    if (!doc.exists) return { ok: true, applied: false, exists: false };
    if (!doc.payload) return { ok: true, applied: false, exists: true };
    if (!force && doc.updateTime && doc.updateTime === readLocal(LAST_UPDATE_TIME_KEY)) {
      return { ok: true, applied: false, exists: true };
    }
    if (isEditorDirty()) return { ok: true, applied: false, exists: true };
    const next = normalizeSettingsData(await decodeTransferData(doc.payload), {
      requireMarker: true
    });
    // Cache the *real* shared style before any local override below
    // overwrites it on `next` - dataForPush (used by pushSyncSnapshot) needs
    // this to avoid ever pushing this device's kept-local color back out as
    // if it were the shared one.
    setLastKnownSharedStyle(next);
    if (getSyncKeepLocalStyle()) {
      next.proAccent = state.applicationData.proAccent;
      next.proSecondary = state.applicationData.proSecondary;
      next.proTertiary = state.applicationData.proTertiary;
      next.styleSlots = state.applicationData.styleSlots;
    }
    if (JSON.stringify(next) === JSON.stringify(state.applicationData)) {
      writeLocal(LAST_UPDATE_TIME_KEY, doc.updateTime);
      return { ok: true, applied: false, exists: true };
    }
    applyEditorSettingsData(next, { statusMessage: '已從其他裝置同步課表。', fromSync: true });
    writeLocal(LAST_UPDATE_TIME_KEY, doc.updateTime);
    lastPushedSnapshot = snapshotForComparison(state.applicationData);
    return { ok: true, applied: true, exists: true };
  } catch (error) {
    return { ok: false, error: `同步下載失敗：${error.message || error}` };
  }
}

let lastPushedSnapshot = null;
let syncInFlight = false;

function setSyncStatusUi(message, isError) {
  setStatusText('sync-status', message, isError);
}

// Reached from syncTick whenever a poll discovers the shared document is
// gone (a pull's exists:false, or a push's 404 - see pullSyncSnapshot and
// pushSyncSnapshot's own remoteDeleted). Every device with this code
// configured already proved it worked at least once (create/join both
// require the doc to exist first), so this can only mean
// orbitSyncDeleteForEveryone ran on another device - not a code that was
// never valid to begin with. Falls back to local-only exactly like a manual
// "解除同步" would (see orbitSyncUnlink's own confirm handler), plus the
// same backup-restore offer every other unlink path gives, so this device
// doesn't sit there re-polling a dead code forever with no explanation.
function handleRemoteSyncDeleted() {
  clearSyncPairing();
  renderSyncPanel();
  setSyncStatusUi('同步已被管理者整個刪除，這台裝置已自動解除同步（本機課表不受影響）。');
  promptScheduleBackupRestore();
}

// One check does at most one round trip: push when this device changed
// since its last push, otherwise pull to pick up any change from
// elsewhere. Never both in the same tick - there's nothing to reconcile
// since a push always means "we are already current" and a pull that
// changes anything updates lastPushedSnapshot itself.
//
// A viewer never pushes, full stop - not even as a fallback if a local
// mutation somehow slipped past the editor's UI lock (see
// src/editor-core.js's applyEditorRoleLock). It only ever pulls, so it stays
// a pure mirror of whatever a manager device published.
async function syncTick() {
  if (!isSyncConfigured() || !navigator.onLine || document.hidden || syncInFlight) return false;
  syncInFlight = true;
  try {
    if (isEditorDirty()) return false;
    if (isSyncViewer()) {
      const result = await pullSyncSnapshot();
      if (result.ok && result.exists === false) {
        handleRemoteSyncDeleted();
        return false;
      }
      if (!result.ok) setSyncStatusUi(result.error, true);
      return !!result.applied;
    }
    const currentSnapshot = snapshotForComparison(state.applicationData);
    if (currentSnapshot !== lastPushedSnapshot) {
      const result = await pushSyncSnapshot();
      if (result.ok && result.remoteDeleted) {
        handleRemoteSyncDeleted();
        return false;
      }
      if (!result.ok) setSyncStatusUi(result.error, true);
      return result.ok;
    }
    const result = await pullSyncSnapshot();
    if (result.ok && result.exists === false) {
      handleRemoteSyncDeleted();
      return false;
    }
    if (!result.ok) setSyncStatusUi(result.error, true);
    return !!result.applied;
  } finally {
    syncInFlight = false;
  }
}

// No background timer at all - a device nobody is touching has no reason to
// keep asking whether something changed. Instead, an actual interaction
// with the page triggers a check, throttled to at most once per
// ACTIVITY_SYNC_THROTTLE_MS so a burst of clicks or typing collapses into
// one check instead of one per event. The result: genuinely zero network
// requests while the app just sits open and idle, at the cost of a receiving
// device that's left completely untouched only picking up a change the
// next time someone actually interacts with it (or reopens/refocuses the
// tab - see syncOnAppActive below, which isn't subject to this throttle).
// A real local save is unaffected by any of this either way - it pushes
// immediately regardless (see editor-backup.js's applyEditorSettingsData).
const ACTIVITY_SYNC_THROTTLE_MS = 5000;
const ACTIVITY_EVENT_TYPES = ['click', 'pointerdown', 'keydown', 'touchstart'];
let lastActivitySyncAt = 0;
function onUserActivity() {
  const now = Date.now();
  if (now - lastActivitySyncAt < ACTIVITY_SYNC_THROTTLE_MS) return;
  lastActivitySyncAt = now;
  syncTick();
}
// The moment the app becomes active - first load, a reload, or the tab
// regaining focus after being backgrounded/suspended - always checks,
// bypassing the throttle above: that's exactly when stale data is most
// likely and least forgivable, not something to suppress just because some
// unrelated click happened a couple of seconds earlier. Also resets the
// throttle window so a click immediately afterward doesn't fire a second,
// redundant check.
function syncOnAppActive() {
  lastActivitySyncAt = Date.now();
  syncTick();
}
let syncLoopStarted = false;
function startSyncLoop() {
  if (syncLoopStarted) return;
  syncLoopStarted = true;
  lastPushedSnapshot = snapshotForComparison(state.applicationData);
  syncOnAppActive();
  ACTIVITY_EVENT_TYPES.forEach(type =>
    document.addEventListener(type, onUserActivity, { passive: true })
  );
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncOnAppActive();
});
window.addEventListener('pageshow', syncOnAppActive);

// Held only in memory, never localStorage - see orbitSyncCreate/
// showCreatedSyncCodes. Unlike the sync code (which stays visible in the
// active-sync box afterward) and the manager passcode (which a manager
// device can re-display later - see renderSyncPanel's reveal fold), this
// specific one-time screen is the only place *both* are shown together
// right after creation, so losing it before copying them down just means
// falling back to those two other places instead of losing anything for
// good.
let pendingCreatedCodes = null;

function showCreatedSyncCodes(code, managerPasscode) {
  pendingCreatedCodes = { code, managerPasscode };
  const codeCopyBtn = document.getElementById('sync-created-code-copy');
  const passcodeCopyBtn = document.getElementById('sync-created-passcode-copy');
  if (codeCopyBtn) codeCopyBtn.textContent = '複製';
  if (passcodeCopyBtn) passcodeCopyBtn.textContent = '複製';
  renderSyncPanel();
}
function acknowledgeSyncCreatedCodes() {
  pendingCreatedCodes = null;
  renderSyncPanel();
}
// Copies text to the clipboard and reflects the outcome the same way
// everywhere: the triggering button's label flips to "已複製！" on success,
// or the shared sync-status line reports the failure. Every copy-to-
// clipboard affordance in the sync UI - the two just-created codes, the
// manager passcode reveal, the pre-unlink code copy - shares this shape.
async function copyWithButtonFeedback(text, button) {
  try {
    await copyTransferText(text);
    if (button) button.textContent = '已複製！';
  } catch (error) {
    setSyncStatusUi(`複製失敗：${error.message || error}`, true);
  }
}
async function copySyncCreatedCode(which) {
  if (!pendingCreatedCodes) return;
  const text =
    which === 'passcode' ? pendingCreatedCodes.managerPasscode : pendingCreatedCodes.code;
  const button = document.getElementById(
    which === 'passcode' ? 'sync-created-passcode-copy' : 'sync-created-code-copy'
  );
  await copyWithButtonFeedback(text, button);
}
// The manager-passcode-reveal fold in the active-sync box (for a device
// that already has one) - unlike the viewer code in the old two-code
// design, the passcode isn't a one-time secret from this device's own
// point of view: it's sitting right there in localStorage already, so
// there's no reason not to let a manager pull it back up to share with
// another device without having to dig up wherever they first copied it.
async function copySyncManagerPasscode() {
  const passcode = getSyncManagerPasscode();
  if (!passcode) return;
  const button = document.getElementById('sync-manager-passcode-copy');
  await copyWithButtonFeedback(passcode, button);
}
function toggleSyncManagerPasscodeReveal() {
  const valueEl = document.getElementById('sync-manager-passcode-value');
  const toggleBtn = document.getElementById('sync-manager-passcode-toggle');
  if (!valueEl || !toggleBtn) return;
  const showing = valueEl.hidden;
  valueEl.hidden = !showing;
  if (showing) valueEl.textContent = getSyncManagerPasscode();
  toggleBtn.textContent = showing ? '隱藏' : '顯示';
}

function renderSyncPanel() {
  const setupBox = document.getElementById('sync-setup-box');
  const activeBox = document.getElementById('sync-active-box');
  const activeCode = document.getElementById('sync-active-code');
  const roleLabel = document.getElementById('sync-role-label');
  const keepStyleCheckbox = document.getElementById('sync-keep-local-style');
  const createdCodesBox = document.getElementById('sync-created-codes');
  const managerPasscodeBox = document.getElementById('sync-manager-passcode-box');
  const upgradeBox = document.getElementById('sync-upgrade-box');
  if (!setupBox || !activeBox) return;
  // The freshly-created code+passcode display takes over the whole panel
  // until acknowledged - showing the setup/active boxes underneath it at
  // the same time would just be confusing, and there's nothing useful to do
  // in this panel until the user has dealt with (i.e. copied down) these.
  if (createdCodesBox) createdCodesBox.hidden = !pendingCreatedCodes;
  if (pendingCreatedCodes) {
    setupBox.hidden = true;
    activeBox.hidden = true;
    const codeEl = document.getElementById('sync-created-code');
    const passcodeEl = document.getElementById('sync-created-passcode');
    if (codeEl) codeEl.textContent = pendingCreatedCodes.code;
    if (passcodeEl) passcodeEl.textContent = pendingCreatedCodes.managerPasscode;
    applyEditorRoleLock();
    return;
  }
  const configured = isSyncConfigured();
  setupBox.hidden = configured;
  activeBox.hidden = !configured;
  if (configured && activeCode) activeCode.textContent = getSyncCode();
  const viewer = isSyncViewer();
  if (configured && roleLabel) {
    roleLabel.textContent = viewer
      ? '身份：僅接收（唯讀）— 課表會自動更新，但這台裝置無法編輯。'
      : '身份：管理者 — 可以編輯課表，變更會同步到其他裝置。';
    roleLabel.classList.toggle('is-viewer', viewer);
  }
  // A manager device can always re-display its own stored passcode (see
  // copySyncManagerPasscode's comment on why that's safe/intentional) - a
  // viewer has nothing to show here, it gets the upgrade fold instead.
  if (managerPasscodeBox) managerPasscodeBox.hidden = !configured || viewer;
  const passcodeValueEl = document.getElementById('sync-manager-passcode-value');
  const passcodeToggleBtn = document.getElementById('sync-manager-passcode-toggle');
  if (viewer || !configured) {
    if (passcodeValueEl) {
      passcodeValueEl.hidden = true;
      passcodeValueEl.textContent = '';
    }
    if (passcodeToggleBtn) passcodeToggleBtn.textContent = '顯示';
  }
  // A viewer device gets the option to unlock manager mode later by typing
  // in the manager passcode - see orbitSyncUpgradeToManager. Not shown to
  // an already-manager device (nothing to upgrade) or an unpaired one
  // (nothing to upgrade *into* yet - that's what "加入同步" is for).
  if (upgradeBox) upgradeBox.hidden = !configured || !viewer;
  if (keepStyleCheckbox) keepStyleCheckbox.checked = getSyncKeepLocalStyle();
  // No standing "you still have a backed-up style" notice in this panel any
  // more: the backup is offered back at the one moment it's actually wanted
  // (re-checking the box - see promptStyleBackupRestore), the same way the
  // schedule backup is offered right after unlinking rather than sitting
  // here as a permanent fixture nobody scrolls to.
  applyEditorRoleLock();
}
// Warns before either direction of this toggle takes effect - a native
// checkbox's onchange fires *after* the browser already flipped its visual
// state, so cancelling has to explicitly flip it back, not just leave the
// confirm sheet without acting.
function orbitSyncSetKeepLocalStyle(checked) {
  const wantsKeepLocal = !!checked;
  const checkbox = document.getElementById('sync-keep-local-style');
  const revertCheckbox = () => {
    if (checkbox) checkbox.checked = !wantsKeepLocal;
  };
  setEditorConfirmContent(
    wantsKeepLocal ? '不再同步樣式顏色？' : '恢復同步樣式顏色？',
    wantsKeepLocal
      ? '會保留這台裝置目前的配色，不再套用其他裝置的樣式。'
      : '共用的配色與樣式預設會立刻套用到這台裝置。',
    wantsKeepLocal ? '課表內容仍照常同步。' : '目前的配色與樣式預設會先備份起來。',
    wantsKeepLocal ? '不再同步樣式' : '恢復同步',
    () => {
      hideEditorDiscardConfirm();
      // The one genuinely destructive direction: turning this off replaces
      // this device's colors and saved presets with the shared ones right
      // now (see applySharedStyleNow below), not "at some point during the
      // next sync". Back the old ones up first so the restore prompt on the
      // way back in has something to offer.
      if (!wantsKeepLocal) backUpCurrentStyle();
      setSyncKeepLocalStyle(wantsKeepLocal);
      // The style tool's own lock (see applyEditorRoleLock) depends on this
      // setting too, not just role - refresh it immediately so confirming
      // unlocks/locks the style button right away, no reload or re-pair
      // needed.
      applyEditorRoleLock();
      renderSyncPanel();
      if (wantsKeepLocal) {
        // Nothing was overwritten here, so there's nothing to apply - but
        // this is the moment the last kept-local style becomes wanted
        // again, so it's where the restore offer belongs.
        promptStyleBackupRestore();
      } else {
        applySharedStyleNow();
      }
      // Don't wait for the next touch-triggered check (see the
      // activity-driven sync section below) - a style-sync change is
      // exactly the kind of moment where the user wants the effect to show
      // up right away, not whenever they next happen to click something.
      syncTick();
    },
    '取消',
    {
      cancelHandler: () => {
        hideEditorDiscardConfirm();
        revertCheckbox();
      }
    }
  );
  showEditorConfirmSheet();
}
// Turning the opt-out off used to only clear the flag and let the next poll
// sort it out - which it never did: pullSyncSnapshot skips a document whose
// updateTime this device has already recorded, so the shared style sat
// there unapplied until some *other* device happened to publish a change.
// The style this device has been ignoring is already cached locally (see
// setLastKnownSharedStyle, written on every real pull), so apply that
// straight away, then force one real pull to pick up anything newer.
function applySharedStyleNow() {
  const shared = getLastKnownSharedStyle();
  if (shared && !sameStyle(shared, state.applicationData)) {
    // fromSync:true because this is the shared style being adopted, not a
    // local edit - it must not be pushed back out as if this device had
    // just authored it.
    applyEditorSettingsData(
      { ...state.applicationData, ...styleFieldsOf(shared) },
      { fromSync: true }
    );
  }
  if (!isSyncProxyConfigured() || !getSyncCode()) return;
  // force:true because the whole problem above is that this device already
  // "has" the current document - only a forced re-read re-applies it now
  // that the style fields are no longer being masked out.
  pullSyncSnapshot({ force: true }).then(result => {
    if (!result.ok) setSyncStatusUi(result.error, true);
  });
}
// The recovery half of the safety net above: reapplies whatever style was
// backed up right before this device last went back to the shared one, and
// re-enables the opt-out so it isn't just immediately overwritten again by
// the very next sync.
function orbitSyncRestoreStyleBackup() {
  const backup = getStyleBackup();
  if (!backup) return;
  // Re-enable the opt-out first - restoring the old colors only to have the
  // very next sync immediately overwrite them again would defeat the point.
  setSyncKeepLocalStyle(true);
  // fromSync:true here isn't about where the data came from - it's to get
  // the same "don't push this back out" behavior applyEditorSettingsData
  // already gives a sync-applied change, which is exactly what a pure
  // local restore also needs (setSyncKeepLocalStyle(true) above would make
  // any push substitute the shared style anyway, so this is belt-and-
  // suspenders more than strictly load-bearing).
  applyEditorSettingsData(
    { ...state.applicationData, ...styleFieldsOf(backup) },
    { fromSync: true }
  );
  clearStyleBackup();
  applyEditorRoleLock();
  renderSyncPanel();
  setSyncStatusUi('已還原保留的樣式與樣式預設。');
}
function orbitSyncDismissStyleBackup() {
  clearStyleBackup();
  renderSyncPanel();
}
// The style counterpart to promptScheduleBackupRestore below, chained
// straight out of re-checking "不同步樣式顏色": that's the point where this
// device stops following the shared colors again, so it's the point where
// the colors and presets it kept last time are worth offering back - rather
// than a standing notice in the sync panel that's easy to never scroll to.
//
// Silently drops a backup that matches what's already on screen: a device
// that never customized anything got back exactly what it gave up, and a
// popup whose two answers do the same thing is just noise.
function promptStyleBackupRestore() {
  const backup = getStyleBackup();
  if (!backup) return;
  if (sameStyle(backup, state.applicationData)) {
    clearStyleBackup();
    renderSyncPanel();
    return;
  }
  setEditorConfirmContent(
    '找回先前保留的配色？',
    '要換回上次保留的配色與樣式預設，還是繼續使用目前的？',
    '',
    '換回保留的配色',
    () => {
      hideEditorDiscardConfirm();
      orbitSyncRestoreStyleBackup();
    },
    '繼續使用目前配色',
    {
      cancelHandler: () => {
        hideEditorDiscardConfirm();
        orbitSyncDismissStyleBackup();
      }
    }
  );
  showEditorConfirmSheet();
}
// The recovery half of the schedule-backup safety net (see
// SCHEDULE_BACKUP_KEY) - reapplies whatever local schedule this device had
// right before it last joined a sync that actually overwrote it. Only ever
// offered after that pairing is already gone (unlinked or deleted), so
// there's no "don't push this back out" concern to worry about the way the
// style restore above has - isSyncConfigured() is already false by the time
// this is reachable.
function orbitSyncRestoreScheduleBackup() {
  const backup = getScheduleBackup();
  if (!backup) return;
  applyEditorSettingsData(backup);
  clearScheduleBackup();
  renderSyncPanel();
  setSyncStatusUi('已還原加入同步前的本機課表。');
}
function orbitSyncDismissScheduleBackup() {
  clearScheduleBackup();
  renderSyncPanel();
}
// The actual moment "did you want your old schedule back, or is the one
// you've been using fine" becomes a real question: right after unlinking or
// deleting leaves this device on its own again - not a standing notice
// tucked into the sync panel that's easy to never scroll back to. Chained
// straight out of the unlink/delete confirm handlers below, right after
// clearSyncPairing() actually takes effect; a no-op if there's nothing to
// offer back (either this device never joined, or the join never replaced
// anything - see backUpLocalSchedule's caller in performSyncJoin).
function promptScheduleBackupRestore() {
  const backup = getScheduleBackup();
  if (!backup) return;
  setEditorConfirmContent(
    '找回加入同步前的課表？',
    '要換回舊課表，還是繼續使用剛同步的課表？',
    '',
    '換回加入前的課表',
    () => {
      hideEditorDiscardConfirm();
      orbitSyncRestoreScheduleBackup();
    },
    '繼續使用目前課表',
    {
      cancelHandler: () => {
        hideEditorDiscardConfirm();
        orbitSyncDismissScheduleBackup();
      }
    }
  );
  showEditorConfirmSheet();
}

// Locks a viewer device out of the schedule editor entirely (its button,
// not a greyed-out shell) and out of the AI/manual import actions in the
// separate "同步 / 匯入匯出" sheet (where the unlink button that gets a
// viewer back to full local editing lives - that sheet itself always stays
// reachable). This is a UX guardrail, not a real access-control boundary on
// its own - see README's security section - so it's plain CSS
// (.is-disabled/.sync-viewer-locked, see styles.css) rather than anything
// that actually removes the underlying form controls; the real boundary is
// the Worker refusing a write/delete without the correct passcode.
function applyEditorRoleLock() {
  const viewer = isSyncViewer();
  // A viewer is never allowed into the schedule editor at all, full stop -
  // unlike the style tool below, there's no opt-out that changes this. The
  // schedule editor now holds nothing a viewer legitimately needs (sync
  // status, unlink, AI/manual import all live in the separate transfer
  // sheet instead, which stays reachable), so the button is locked outright
  // instead of letting it open into a greyed-out shell. openEditor() itself
  // also refuses for a viewer (editor-core.js) - the real check this button
  // lock is only a UI shortcut for, same belt-and-suspenders reasoning as
  // every other role lock in this file.
  const editButton = document.getElementById('btn-edit');
  if (editButton) {
    editButton.classList.toggle('is-disabled', viewer);
    editButton.title = viewer
      ? '此裝置僅接收同步，無法編輯課表。輸入管理者密碼即可取得編輯權限，或先在「同步 / 匯入匯出」解除同步。'
      : '編輯課表';
  }
  // The transfer sheet itself stays open to both roles (a viewer needs to
  // reach its sync status/unlink/upgrade-to-manager), but AI import and
  // manual import are still real ways to overwrite the local schedule, so
  // they get locked individually within it - see the matching
  // .transfer-sheet.sync-viewer-locked rule in styles.css. Manual export
  // stays enabled - reading out the currently-synced schedule isn't
  // editing it.
  const transferSheet = document.getElementById('transfer-sheet');
  if (transferSheet) transferSheet.classList.toggle('sync-viewer-locked', viewer);
  // The style tool is a separate top-bar overlay with its own opt-out-
  // dependent lock: a viewer who's still accepting synced colors (hasn't
  // checked "不同步樣式顏色") has no real use for it - any local color
  // change it made would just get overwritten by the next pulled update
  // anyway, which is confusing busywork, not a real feature. A viewer
  // who *has* opted out is exempt - that's the whole point of the opt-out
  // - and a manager is never locked out of it at all, since setting the
  // shared style in the first place is the manager's job.
  const styleButton = document.getElementById('btn-style');
  if (styleButton) {
    const locked = viewer && !getSyncKeepLocalStyle();
    styleButton.classList.toggle('is-disabled', locked);
    styleButton.title = locked
      ? '此裝置正在同步樣式，無法自行變更。若要自訂樣式，請先在同步面板勾選「不同步樣式顏色」。'
      : '樣式工具';
  }
}

// ---- UI entry points, exposed on window for index.html's onclick="..." ----

// Wipes every plain-text field this panel ever asks for a code or passcode
// in, and re-collapses the folds they live in - called whenever the
// transfer sheet closes (see editor-core.js's closeTransferSheet) so a
// typed-but-never-submitted sync code or, more importantly, a manager
// passcode never just sits around in an input on screen until the next
// time this sheet happens to open. Purely a hygiene measure, same spirit as
// clearTransferField()/resetOCRImporterUI() already doing the same for the
// manual-backup textarea and AI-import state on the same close path -
// nothing here is sensitive in the sense of needing server-side protection
// (that's the Worker's job - see README's security section), it's just
// unpleasant to leave lying around in the DOM longer than it has to be.
function clearSyncInputFields() {
  const codeInput = document.getElementById('sync-join-code');
  const joinPasscodeInput = document.getElementById('sync-join-passcode');
  const upgradePasscodeInput = document.getElementById('sync-upgrade-passcode');
  const joinFold = document.getElementById('sync-join-manager-fold');
  const upgradeFold = document.getElementById('sync-upgrade-box');
  if (codeInput) codeInput.value = '';
  if (joinPasscodeInput) joinPasscodeInput.value = '';
  if (upgradePasscodeInput) upgradePasscodeInput.value = '';
  if (joinFold) joinFold.open = false;
  if (upgradeFold) upgradeFold.open = false;
}

// Greys the triggering button out for the duration of its own async work, so
// a slow connection can't be double-clicked into firing the same
// create/join request twice. Re-enables in `finally` regardless of which
// branch the wrapped work took (success, a friendly rejection, or an error).
async function withButtonDisabled(buttonId, fn) {
  const button = document.getElementById(buttonId);
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

// Creating a sync spends a real, limited resource - the Worker's own create
// rate limit is deliberately tight (see cloudflare-worker/orbit-worker.js's
// SYNC_CREATE_RATE_LIMIT), and every create leaves behind a throwaway
// Firestore document if the code/passcode it returns never actually get
// used - so this confirms first instead of firing on click, same reasoning
// as every other real-consequence sync action in this file (加入同步、解除
// 同步、整個刪除同步) already warning before doing something that isn't
// free to undo.
function orbitSyncCreate() {
  if (!isSyncProxyConfigured()) {
    setSyncStatusUi('跨裝置同步功能尚未設定，請聯絡課表管理者。', true);
    return;
  }
  if (!navigator.onLine) {
    setSyncStatusUi('目前沒有網路連線，無法建立同步。', true);
    return;
  }
  setEditorConfirmContent(
    '建立新同步？',
    '會產生一組新的同步代碼與管理者密碼。',
    '已有代碼的話請改用「加入同步」，名額有限。',
    '建立新同步',
    () => {
      hideEditorDiscardConfirm();
      performSyncCreate();
    },
    '取消'
  );
  showEditorConfirmSheet();
}

async function performSyncCreate() {
  await withButtonDisabled('sync-create-btn', async () => {
    setSyncStatusUi('正在建立同步…');
    const payload = await encodeTransferData(state.applicationData);
    const result = await createSyncDoc(payload);
    if (!result.ok) {
      setSyncStatusUi(result.error, true);
      return;
    }
    // This device becomes the manager - it already has the schedule that
    // was just published, so there's nothing left to pull.
    setSyncPairing(result.code, result.managerPasscode);
    writeLocal(LAST_UPDATE_TIME_KEY, result.updateTime);
    lastPushedSnapshot = snapshotForComparison(state.applicationData);
    showCreatedSyncCodes(result.code, result.managerPasscode);
    renderSyncPanel();
    startSyncLoop();
  });
}

async function orbitSyncJoin() {
  if (!isSyncProxyConfigured()) {
    setSyncStatusUi('跨裝置同步功能尚未設定，請聯絡課表管理者。', true);
    return;
  }
  if (!navigator.onLine) {
    setSyncStatusUi('目前沒有網路連線，無法加入同步。', true);
    return;
  }
  const code = document.getElementById('sync-join-code')?.value.trim();
  if (!code) {
    setSyncStatusUi('請輸入配對代碼。', true);
    return;
  }
  const normalizedCode = code.toUpperCase();
  // Whether this is a manager join is decided purely by whether a passcode
  // was actually typed in - the passcode field lives inside a collapsible
  // fold (see index.html's #sync-join-manager-fold) rather than behind its
  // own separate checkbox, so there's no extra "did they mean to" state to
  // track: an empty field (fold left closed, or opened but left blank) is
  // simply a plain viewer join, no error needed either way.
  const passcode = document.getElementById('sync-join-passcode')?.value.trim() || '';
  const wantsManager = !!passcode;

  await withButtonDisabled('sync-join-btn', async () => {
    // Checks the code actually has something to join, and - if a passcode
    // was supplied - that it's actually correct, *before* ever showing the
    // overwrite warning below: a nonexistent/mistyped code has nothing to
    // overwrite with, and a wrong passcode shouldn't be discovered only
    // after clicking through a data-loss warning. Fails fast with the real
    // error instead either way.
    setSyncStatusUi('正在檢查配對代碼…');
    const check = await fetchSyncDoc(normalizedCode, passcode);
    if (!check.ok) {
      setSyncStatusUi(check.error, true);
      return;
    }
    if (!check.exists) {
      setSyncStatusUi('找不到這組配對代碼，請確認代碼是否正確，或請對方先按「建立新同步」。', true);
      return;
    }
    if (wantsManager && check.role !== MANAGER_ROLE) {
      setSyncStatusUi('管理者密碼不正確，請確認後再試一次。', true);
      return;
    }

    // Joining pulls whatever is already published under that code and
    // applies it immediately - overwriting this device's current schedule -
    // so this warns before doing anything, rather than silently replacing
    // data the user might not have backed up.
    setSyncStatusUi('');
    const roleText = wantsManager ? '管理者' : '僅接收者';
    setEditorConfirmContent(
      '加入同步？',
      `以「${roleText}」加入，會取代這台裝置目前的課表，無法復原。`,
      '其他裝置的課表不受影響。',
      '仍要加入',
      () => {
        hideEditorDiscardConfirm();
        performSyncJoin(normalizedCode, passcode);
      },
      '取消'
    );
    showEditorConfirmSheet();
  });
}

// `passcode` is empty for a plain viewer join, or the manager passcode the
// user typed in and had already verified once in orbitSyncJoin above - this
// re-verifies it (see the `role` check below) rather than trusting that
// earlier check, since this is also called directly (see performSyncJoin's
// exports, used this way by orbitSyncUpgradeToManager's own tests and by
// anything else that wants to join+authenticate in one call).
async function performSyncJoin(code, passcode = '') {
  // Captured before setSyncPairing/pullSyncSnapshot can touch anything - see
  // SCHEDULE_BACKUP_KEY's comment. Not written to storage yet: only
  // committed below once the join actually replaces local data.
  const preJoinSchedule = cloneSettingsData(state.applicationData);
  setSyncStatusUi('正在加入同步…');
  const doc = await fetchSyncDoc(code, passcode);
  if (!doc.ok) {
    setSyncStatusUi(doc.error, true);
    return;
  }
  // "加入同步" only ever joins a sync someone already created (with
  // "建立新同步", which mints its own code+passcode and immediately
  // publishes) - "not found" here means this code was mistyped or never
  // created, not "an empty sync to adopt."
  if (!doc.exists) {
    setSyncStatusUi('找不到這組配對代碼，請確認代碼是否正確，或請對方先按「建立新同步」。', true);
    return;
  }
  // A passcode was supplied but didn't verify as this document's manager
  // passcode - refuse outright rather than silently falling back to a
  // viewer join. The user explicitly asked for manager access; joining
  // them as a viewer instead without saying so would just be confusing.
  if (passcode && doc.role !== MANAGER_ROLE) {
    setSyncStatusUi('管理者密碼不正確，尚未加入同步。', true);
    return;
  }
  const managerPasscode = doc.role === MANAGER_ROLE ? passcode : '';
  setSyncPairing(code, managerPasscode);
  const result = await pullSyncSnapshot({ force: true, doc });
  if (!result.ok) {
    clearSyncPairing();
    setSyncStatusUi(result.error, true);
    return;
  }
  // Only actually replaced local data if pullSyncSnapshot applied something
  // - the shared document could turn out to already match this device's
  // schedule exactly, in which case nothing was lost and there's nothing
  // worth offering to restore later.
  if (result.applied) backUpLocalSchedule(preJoinSchedule);
  renderSyncPanel();
  setSyncStatusUi(managerPasscode ? '已以管理者身份加入同步。' : '已加入同步（僅接收）。');
  startSyncLoop();
}

// Lets an already-joined viewer device unlock manager mode later without
// having to unlink and rejoin - the manager passcode is the only thing that
// was ever missing (the sync code is identical either way), so this just
// verifies the typed passcode against the server and, if correct, adds it
// to what's already stored (see setSyncManagerPasscode - deliberately not
// setSyncPairing, which would also reset this device's last-known-update
// bookkeeping for no reason).
async function orbitSyncUpgradeToManager() {
  if (!isSyncConfigured() || !isSyncViewer()) return;
  if (!navigator.onLine) {
    setSyncStatusUi('目前沒有網路連線，無法驗證管理者密碼。', true);
    return;
  }
  const input = document.getElementById('sync-upgrade-passcode');
  const passcode = input?.value.trim();
  if (!passcode) {
    setSyncStatusUi('請輸入管理者密碼。', true);
    return;
  }
  await withButtonDisabled('sync-upgrade-btn', async () => {
    setSyncStatusUi('正在驗證管理者密碼…');
    const doc = await fetchSyncDoc(getSyncCode(), passcode);
    if (!doc.ok) {
      setSyncStatusUi(doc.error, true);
      return;
    }
    if (!doc.exists) {
      setSyncStatusUi('找不到這組配對代碼，可能已被整個刪除同步。', true);
      return;
    }
    if (doc.role !== MANAGER_ROLE) {
      setSyncStatusUi('管理者密碼不正確。', true);
      return;
    }
    setSyncManagerPasscode(passcode);
    if (input) input.value = '';
    applyEditorRoleLock();
    renderSyncPanel();
    setSyncStatusUi('已取得管理者權限，現在可以編輯課表了。');
  });
}

// Unlinking discards the only local copy of the sync code (and, for a
// manager, the manager passcode) this device has - there's no "undo", and
// no way to look either back up afterward except asking another device
// that still has them - so this warns first and offers a one-tap copy
// before committing, rather than silently discarding something that might
// be needed again to rejoin (or, for a manager, to ever write again at
// all - unlike the sync code, there's no separate "接收者代碼" any more
// that could still read things back).
//
// A manager gets a third option here instead of the copy shortcut: the
// account-wide "整個刪除同步" used to be its own always-visible danger
// button in the panel regardless of whether anyone was about to unlink -
// folded into this same dialog instead, since deleting the shared sync is
// really just the more drastic thing a manager might mean by "解除同步"
// (this device only) vs. really wanting it gone for every device. Picking
// it here hands off to orbitSyncDeleteForEveryone's own, more explicit
// warning rather than deleting straight from this dialog's confirm button.
function orbitSyncUnlink() {
  const code = getSyncCode();
  const managerPasscode = getSyncManagerPasscode();
  const isManager = !!managerPasscode;
  const copyText = isManager ? `同步代碼：${code}\n管理者密碼：${managerPasscode}` : code;
  setEditorConfirmContent(
    '解除同步？',
    isManager
      ? '這只會讓這台裝置變回本機課表，其他裝置仍會繼續同步。忘記代碼前可先複製備用：'
      : '解除後會變回本機課表，並忘記這組配對代碼；建議先複製備用：',
    copyText,
    '解除同步',
    () => {
      hideEditorDiscardConfirm();
      clearSyncPairing();
      renderSyncPanel();
      setSyncStatusUi('已解除同步（不影響本機課表）。');
      promptScheduleBackupRestore();
    },
    '取消',
    isManager
      ? {
          extraLabel: '整個刪除同步',
          extraDanger: true,
          extraHandler: () => {
            hideEditorDiscardConfirm();
            orbitSyncDeleteForEveryone();
          }
        }
      : {
          extraLabel: '複製代碼',
          // Deliberately doesn't close the sheet (unlike the default
          // extraHandler) - copying is meant to happen *before* deciding
          // whether to actually confirm the unlink, not instead of it.
          extraHandler: () =>
            copyWithButtonFeedback(copyText, document.getElementById('editor-confirm-extra-btn'))
        }
  );
  showEditorConfirmSheet();
}
// The strictly more destructive sibling of orbitSyncUnlink above: that one
// only ever forgets this device's own pairing, leaving the shared document
// (and every other device still reading it) untouched. This one reaches
// into the server and deletes the shared document itself, so every device
// reading this code loses its sync target at once - the next time any of
// them syncs, the code simply resolves to nothing any more (see
// pullSyncSnapshot's `exists: false` path). There is no undo and no way to
// warn the other devices first beyond what this device's own confirmation
// text says, so this gets its own, more explicit warning than a plain
// unlink - manager-only (surfaced only as an option inside orbitSyncUnlink's
// dialog above, never its own standalone button; the isSyncViewer() guard
// below is the real check, same reasoning as every other role lock in this
// file; the Worker itself also refuses this without the correct passcode -
// see its handleSyncRequest).
function orbitSyncDeleteForEveryone() {
  if (isSyncViewer()) return;
  const code = getSyncCode();
  const managerPasscode = getSyncManagerPasscode();
  if (!isSyncConfigured()) return;
  if (!navigator.onLine) {
    setSyncStatusUi('目前沒有網路連線，無法刪除同步。', true);
    return;
  }
  setEditorConfirmContent(
    '整個刪除這組同步？',
    '會刪除伺服器上的共用課表，此動作無法復原。',
    `代碼「${code}」與管理者密碼立即失效，所有裝置之後同步時會各自變回本機課表。`,
    '整個刪除',
    async () => {
      hideEditorDiscardConfirm();
      setSyncStatusUi('正在刪除同步…');
      const result = await deleteSyncDoc(code, managerPasscode);
      if (!result.ok) {
        setSyncStatusUi(`刪除失敗：${result.error}`, true);
        return;
      }
      clearSyncPairing();
      renderSyncPanel();
      setSyncStatusUi('已整個刪除同步，所有裝置都已斷開連結（本機課表不受影響）。');
      promptScheduleBackupRestore();
    },
    '取消'
    // No copy-code option here (unlike orbitSyncUnlink) - once this
    // succeeds the code is permanently dead for everyone, so a copy of it
    // would be useless for rejoining.
  );
  showEditorConfirmSheet();
}

window.orbitSyncCreate = orbitSyncCreate;
window.orbitSyncJoin = orbitSyncJoin;
window.orbitSyncUpgradeToManager = orbitSyncUpgradeToManager;
window.orbitSyncUnlink = orbitSyncUnlink;
window.orbitSyncDeleteForEveryone = orbitSyncDeleteForEveryone;
window.orbitSyncSetKeepLocalStyle = orbitSyncSetKeepLocalStyle;
window.copySyncCreatedCode = copySyncCreatedCode;
window.acknowledgeSyncCreatedCodes = acknowledgeSyncCreatedCodes;
window.copySyncManagerPasscode = copySyncManagerPasscode;
window.toggleSyncManagerPasscodeReveal = toggleSyncManagerPasscodeReveal;

export {
  acknowledgeSyncCreatedCodes,
  applyEditorRoleLock,
  clearSyncInputFields,
  clearSyncPairing,
  copySyncCreatedCode,
  copySyncManagerPasscode,
  getScheduleBackup,
  getStyleBackup,
  getSyncCode,
  getSyncKeepLocalStyle,
  getSyncManagerPasscode,
  getSyncRole,
  isSyncConfigured,
  isSyncProxyConfigured,
  isSyncViewer,
  orbitSyncCreate,
  orbitSyncDeleteForEveryone,
  orbitSyncDismissScheduleBackup,
  orbitSyncDismissStyleBackup,
  orbitSyncJoin,
  orbitSyncRestoreScheduleBackup,
  orbitSyncRestoreStyleBackup,
  orbitSyncSetKeepLocalStyle,
  orbitSyncUnlink,
  orbitSyncUpgradeToManager,
  performSyncCreate,
  performSyncJoin,
  pullSyncSnapshot,
  pushSyncSnapshot,
  renderSyncPanel,
  setSyncKeepLocalStyle,
  setSyncPairing,
  setSyncStatusUi,
  startSyncLoop,
  syncTick,
  toggleSyncManagerPasscodeReveal
};
