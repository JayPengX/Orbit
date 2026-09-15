import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (its own module registry, per Vitest's per-file isolation
// - see loadApp.js's comment) so sync.js's module-scope
// `import.meta.env.VITE_ORBIT_SYNC_PROXY_URL` read picks up this stub: it's
// only read once, at import time, so it must be set before loadApp() first
// pulls sync.js in via main.js -> bootstrap.js. Every push/pull/join/create
// test lives here, since none of that can run without the proxy configured
// - see sync.test.js for the "not configured" gate itself.
let sync;
let state;
const PROXY_URL = 'https://sync-proxy.example.workers.dev/sync';

beforeAll(async () => {
  vi.stubEnv('VITE_ORBIT_SYNC_PROXY_URL', PROXY_URL);
  seedLocalStorage();
  await loadApp();
  sync = await import('../src/sync.js');
  ({ state } = await import('../src/state.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sync.clearSyncPairing();
  // Deliberately NOT cleared by clearSyncPairing (it's a per-device
  // preference, not pairing state - see sync.js) so tests that touch it
  // must reset it themselves.
  sync.setSyncKeepLocalStyle(false);
  document.getElementById('sync-join-code').value = '';
  document.getElementById('sync-join-passcode').value = '';
  // In-memory-only state (see showCreatedSyncCodes in src/sync.js), not
  // cleared by clearSyncPairing - dismiss it explicitly so it doesn't leak
  // into a later test's renderSyncPanel().
  sync.acknowledgeSyncCreatedCodes();
});

describe('sync with a proxy Worker configured', () => {
  it('reports the proxy as configured', () => {
    expect(sync.isSyncProxyConfigured()).toBe(true);
  });
});

describe('a local save pushes immediately; a sync-applied pull does not push back', () => {
  it('applyEditorSettingsData (a real local save) PATCHes the proxy right away and shows the "已儲存" toast', async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    const { applyEditorSettingsData } = await import('../src/editor-backup.js');
    const fetchMock = vi.fn(async (url, options) => {
      expect(options.method).toBe('PATCH');
      return { ok: true, json: async () => ({ updateTime: 'now' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    applyEditorSettingsData(state.applicationData, { statusMessage: '' });
    // The push fires without being awaited inside applyEditorSettingsData -
    // wait for it to actually happen rather than guessing a tick count
    // (encodeTransferData's compression pipeline may take more than a
    // microtask or two to settle).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.getElementById('save-toast').textContent).toBe('已儲存');
  });

  it('a viewer applying an incoming sync pull never pushes back, and shows a different toast', async () => {
    sync.setSyncPairing('CODE1234');
    const { encodeTransferData, normalizeSettingsData } = await import('../src/editor-backup.js');
    // A key distinct from every other test in this file's fixture mutations
    // - state.applicationData is one shared singleton for the whole file,
    // so reusing another test's added-teacher key/value would make this
    // payload look identical to already-applied state by the time it runs.
    const remoteData = normalizeSettingsData({
      ...state.applicationData,
      teacherDB: { ...state.applicationData.teacherDB, Y: ['公民', '某老師', ''] }
    });
    const payload = await encodeTransferData(remoteData);
    const fetchMock = vi.fn(async (url, options) => {
      // A viewer must never PATCH under any circumstance.
      expect(options?.method).not.toBe('PATCH');
      return { ok: true, json: async () => ({ exists: true, updateTime: 'now', payload }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sync.pullSyncSnapshot();
    expect(result.applied).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the GET only, no follow-up PATCH
    expect(document.getElementById('save-toast').textContent).toBe('已從其他裝置更新');
  });
});

describe('a receiving device can opt out of syncing style/color', () => {
  it("keeps this device's own colors when the incoming payload has different ones, while still applying other changes", async () => {
    sync.setSyncPairing('CODE1234');
    sync.setSyncKeepLocalStyle(true);
    const localAccent = state.applicationData.proAccent;
    const { encodeTransferData, normalizeSettingsData } = await import('../src/editor-backup.js');
    // A real content change alongside the color change - color is never the
    // *only* difference here, so this actually exercises "apply everything
    // except style" rather than "there's nothing left to apply once style
    // is neutralized" (a color-only payload would just no-op, telling us
    // nothing about whether the opt-out itself works).
    const remoteData = normalizeSettingsData({
      ...state.applicationData,
      teacherDB: { ...state.applicationData.teacherDB, X: ['音樂', '洪老師', ''] },
      proAccent: '#123456',
      proSecondary: '#654321'
    });
    const payload = await encodeTransferData(remoteData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload })
      }))
    );

    const result = await sync.pullSyncSnapshot();
    expect(result.applied).toBe(true);
    expect(state.applicationData.teacherDB.X).toEqual(['音樂', '洪老師', '']);
    expect(state.applicationData.proAccent).toBe(localAccent);
    expect(state.applicationData.proAccent).not.toBe('#123456');
  });

  it('applies incoming colors normally when the opt-out is off', async () => {
    sync.setSyncPairing('CODE1234');
    expect(sync.getSyncKeepLocalStyle()).toBe(false);
    const { encodeTransferData, normalizeSettingsData } = await import('../src/editor-backup.js');
    const remoteData = normalizeSettingsData({
      ...state.applicationData,
      proAccent: '#123456',
      proSecondary: '#654321'
    });
    const payload = await encodeTransferData(remoteData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload })
      }))
    );

    const result = await sync.pullSyncSnapshot();
    expect(result.applied).toBe(true);
    expect(state.applicationData.proAccent).toBe('#123456');
  });

  // The bug this covers: clearing the opt-out used to only flip the flag and
  // leave it to the next poll, which never applied anything - pullSyncSnapshot
  // skips a document whose updateTime this device already recorded, so the
  // shared colors and saved presets sat there unapplied until some *other*
  // device happened to publish an unrelated change.
  it('un-checking the opt-out adopts the shared colors and presets immediately', async () => {
    sync.setSyncPairing('CODE1234');
    const { encodeTransferData, normalizeSettingsData } = await import('../src/editor-backup.js');
    const sharedData = normalizeSettingsData({
      ...state.applicationData,
      proAccent: '#ABCDEF',
      proSecondary: '#FEDCBA',
      styleSlots: [{ name: '共用', primary: '#ABCDEF', secondary: '#FEDCBA' }]
    });
    const payload = await encodeTransferData(sharedData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload })
      }))
    );
    // One normal pull caches the shared style, exactly as everyday polling does.
    await sync.pullSyncSnapshot();
    expect(state.applicationData.proAccent).toBe('#ABCDEF');

    // Opt out and drift this device's own colors away from the shared ones.
    sync.setSyncKeepLocalStyle(true);
    state.applicationData.proAccent = '#111111';
    state.applicationData.proSecondary = '#222222';
    state.applicationData.styleSlots = [{ name: '自訂', primary: '#111111', secondary: '#222222' }];

    document.getElementById('sync-keep-local-style').checked = false;
    sync.orbitSyncSetKeepLocalStyle(false);
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick();

    // Synchronously, on confirming - not "after the next tick eventually
    // notices something changed".
    expect(sync.getSyncKeepLocalStyle()).toBe(false);
    expect(state.applicationData.proAccent).toBe('#ABCDEF');
    expect(state.applicationData.proSecondary).toBe('#FEDCBA');
    expect(state.applicationData.styleSlots[0].name).toBe('共用');
    // The style this device gave up is kept for the restore offer that
    // re-checking the box makes.
    expect(sync.getStyleBackup().proAccent).toBe('#111111');
  });

  // Not a viewer-only feature: a manager who checks the opt-out also has
  // their own device's color kept out of the shared document entirely, in
  // both directions. The push side is the tricky half - without this, a
  // manager saving anything unrelated to style would silently overwrite the
  // shared color everyone else sees with their own kept-local one.
  it("a manager's own push never overwrites the shared style once the opt-out is checked", async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    const { decodeTransferData, encodeTransferData, normalizeSettingsData } =
      await import('../src/editor-backup.js');
    const sharedData = normalizeSettingsData({
      ...state.applicationData,
      proAccent: '#ABCDEF',
      proSecondary: '#FEDCBA'
    });
    const sharedPayload = await encodeTransferData(sharedData);
    // First, a normal pull picks up the shared style and caches it - this
    // manager hasn't touched the opt-out yet, so it applies like anyone else's.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload: sharedPayload })
      }))
    );
    await sync.pullSyncSnapshot();
    expect(state.applicationData.proAccent).toBe('#ABCDEF');
    vi.unstubAllGlobals();

    // Now opt out and change this device's own color locally (simulating
    // the style tool, without needing its full DOM flow here).
    sync.setSyncKeepLocalStyle(true);
    state.applicationData.proAccent = '#111111';
    state.applicationData.proSecondary = '#222222';

    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      const pushed = await decodeTransferData(body.payload);
      // The shared color from before the opt-out, not this device's own
      // #111111 - it must never leak into what gets pushed.
      expect(pushed.proAccent).toBe('#ABCDEF');
      return { ok: true, json: async () => ({ updateTime: 'now' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Locally, this device still shows its own kept color.
    expect(state.applicationData.proAccent).toBe('#111111');
  });
});

describe('pushSyncSnapshot', () => {
  it('PATCHes the proxy for the paired code with the compressed backup as payload', async () => {
    sync.setSyncPairing('CODE1234');
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(`${PROXY_URL}?code=CODE1234`);
      expect(options.method).toBe('PATCH');
      const body = JSON.parse(options.body);
      expect(body.payload.startsWith('[ORBIT]')).toBe(true);
      return { ok: true, json: async () => ({ updateTime: '2024-01-15T00:00:00.000000Z' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an error when not paired', async () => {
    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(false);
  });

  it('surfaces the proxy error message on a failed request', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: { message: 'Worker 尚未設定 Firebase 服務帳戶。' } })
      }))
    );
    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/服務帳戶/);
  });

  it('a 429 from the proxy surfaces as the same friendly rate-limit message', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: '請求過於頻繁，請稍後再試。' } })
      }))
    );
    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/請求過於頻繁/);
  });

  // The actual server-side enforcement the manager-passcode design exists
  // for (see the Worker's handleSyncRequest PATCH branch): a missing or
  // wrong passcode is refused by the Worker itself, not just hidden from by
  // the client's own UI lock - a 403 with this message is what that
  // refusal looks like over the wire, and it must surface as an ordinary
  // push failure, not a crash or a silently-swallowed error. Pairing here
  // has no passcode at all (a viewer somehow attempting to push, e.g. a bug
  // upstream of this function's own callers) - pushSyncSnapshot itself
  // never checks role, it just sends whatever passcode is stored, empty or
  // not, and trusts the Worker to be the real check.
  it('a 403 from the proxy (no manager passcode stored, somehow attempting to write) surfaces as an ordinary push failure', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: '需要正確的管理者密碼才能寫入課表。' } })
      }))
    );
    const result = await sync.pushSyncSnapshot();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/管理者密碼/);
  });
});

describe('pullSyncSnapshot', () => {
  it('treats {exists:false} from the proxy as nothing to apply yet', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }))
    );
    const result = await sync.pullSyncSnapshot();
    expect(result).toEqual({ ok: true, applied: false, exists: false });
  });

  it('also treats a 400 (the Worker rejecting a malformed code) as not found, not an error', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 400,
        ok: false,
        json: async () => ({ error: { message: 'Invalid pairing code' } })
      }))
    );
    const result = await sync.pullSyncSnapshot();
    expect(result).toEqual({ ok: true, applied: false, exists: false });
  });

  it('applies a remote payload that differs from the current schedule', async () => {
    sync.setSyncPairing('CODE1234');
    const { encodeTransferData, normalizeSettingsData } = await import('../src/editor-backup.js');
    const remoteData = normalizeSettingsData({
      ...state.applicationData,
      teacherDB: { ...state.applicationData.teacherDB, Z: ['地理', '新老師', ''] }
    });
    const payload = await encodeTransferData(remoteData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: '2024-02-01T00:00:00.000000Z', payload })
      }))
    );
    const result = await sync.pullSyncSnapshot();
    expect(result).toEqual({ ok: true, applied: true, exists: true });
    expect(state.applicationData.teacherDB.Z).toEqual(['地理', '新老師', '']);
  });

  it('does not apply when the remote updateTime matches what was already synced', async () => {
    sync.setSyncPairing('CODE1234');
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    localStorage.setItem('orbitSyncLastUpdateTime', '2024-02-01T00:00:00.000000Z');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ exists: true, updateTime: '2024-02-01T00:00:00.000000Z', payload })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sync.pullSyncSnapshot();
    expect(result).toEqual({ ok: true, applied: false, exists: true });
  });
});

// pushSyncSnapshot/pullSyncSnapshot themselves stay pure (they just report
// exists/remoteDeleted back - see the assertions above and pullSyncSnapshot's
// own {exists:false} test) - syncTick is what actually acts on that signal.
// See the "backup can be recovered" describe block below for the case where
// this also has a pre-join schedule to offer back.
describe('syncTick auto-unlinks when the shared sync document is gone', () => {
  it('a viewer whose pull comes back exists:false clears the pairing and reports why, instead of polling a dead code forever', async () => {
    sync.setSyncPairing('CODE1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }))
    );

    const result = await sync.syncTick();

    expect(result).toBe(false);
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/自動解除同步/);
  });

  it("a manager's push that comes back 404 (the doc is gone) clears the pairing the same way, not as a raw push failure", async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: '找不到這組配對代碼。' } })
      }))
    );

    const result = await sync.syncTick();

    expect(result).toBe(false);
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/自動解除同步/);
  });

  it('a non-404 push failure (e.g. a transient 500) is left as an ordinary error - it does not unlink', async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Upstream request failed' } })
      }))
    );

    const result = await sync.syncTick();

    expect(result).toBe(false);
    expect(sync.isSyncConfigured()).toBe(true);
    expect(document.getElementById('sync-status').textContent).toMatch(/同步上傳失敗/);
  });
});

// orbitSyncUnlink itself (the confirm-and-copy warning flow) is pure local
// state with no network call either way - see test/sync.test.js for that
// coverage, not duplicated here.
describe('orbitSyncCreate UI wiring', () => {
  it('POSTs with no manual input, pairs as manager with the returned code+passcode, and shows both once', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 'CODE1234', managerPasscode: 'PASSCODE1', updateTime: 'now' })
    }));
    vi.stubGlobal('fetch', fetchMock);

    // Creating spends a real, limited resource on the server, so it warns
    // before doing anything - see orbitSyncCreate's own comment.
    sync.orbitSyncCreate();
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/建立新同步/);
    expect(fetchMock).not.toHaveBeenCalled();
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 建立新同步
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(sync.isSyncConfigured()).toBe(true);
    expect(sync.getSyncCode()).toBe('CODE1234');
    expect(sync.getSyncManagerPasscode()).toBe('PASSCODE1');
    expect(sync.getSyncRole()).toBe('manager');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(PROXY_URL); // no ?code= - there's nothing to look up yet
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.payload.startsWith('[ORBIT]')).toBe(true);

    // Both boxes stay hidden until the code/passcode are acknowledged -
    // showing sync-active-box underneath them at the same time would bury
    // the passcode under other UI before it's actually been copied down.
    expect(document.getElementById('sync-active-box').hidden).toBe(true);
    expect(document.getElementById('sync-created-codes').hidden).toBe(false);
    expect(document.getElementById('sync-created-code').textContent).toBe('CODE1234');
    expect(document.getElementById('sync-created-passcode').textContent).toBe('PASSCODE1');

    sync.acknowledgeSyncCreatedCodes();
    expect(document.getElementById('sync-created-codes').hidden).toBe(true);
    expect(document.getElementById('sync-active-box').hidden).toBe(false);
    expect(document.getElementById('sync-active-code').textContent).toBe('CODE1234');
  });

  it('refuses while offline, without making any network request', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sync.orbitSyncCreate();

    expect(sync.isSyncConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById('sync-status').textContent).toMatch(/沒有網路連線/);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('cancelling the confirm makes no request and leaves the device unconfigured', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    sync.orbitSyncCreate();
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick(); // 取消

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
  });
});

describe('manager/viewer roles', () => {
  it('orbitSyncCreate always pairs this device as manager', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 'CODE1234', managerPasscode: 'PASSCODE1', updateTime: 'now' })
      }))
    );
    sync.orbitSyncCreate();
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick();
    await vi.waitFor(() => expect(sync.isSyncConfigured()).toBe(true));
    expect(sync.getSyncRole()).toBe('manager');
    expect(sync.isSyncViewer()).toBe(false);
  });

  // These exercise performSyncJoin directly - the actual pairing/pull/push
  // logic - rather than orbitSyncJoin's confirm-sheet wrapper (see the
  // "orbitSyncJoin warns before wiping local data" suite below for that).
  it('performSyncJoin refuses a code nothing has been published under yet', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      // {exists:false} must never lead to a PATCH - "加入" only ever joins
      // an existing sync; a fresh/nonexistent code is a bug report ("joining
      // a non-existent sync works"), not a valid join.
      expect(options?.method).not.toBe('PATCH');
      return { ok: true, json: async () => ({ exists: false }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await sync.performSyncJoin('EMPTY123');
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/找不到這組配對代碼/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('performSyncJoin pairs as a viewer when no passcode is supplied, manager once a correct one is', async () => {
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload })
      }))
    );

    await sync.performSyncJoin('CODE1234');
    expect(sync.isSyncConfigured()).toBe(true);
    expect(sync.isSyncViewer()).toBe(true);

    sync.clearSyncPairing();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, role: 'manager', updateTime: 'now', payload })
      }))
    );
    await sync.performSyncJoin('CODE1234', 'PASSCODE1');
    expect(sync.isSyncConfigured()).toBe(true);
    expect(sync.isSyncViewer()).toBe(false);
    expect(sync.getSyncManagerPasscode()).toBe('PASSCODE1');
  });

  // A passcode was typed in but didn't actually verify - refusing outright
  // (rather than silently joining as a viewer instead) is the whole point:
  // the user explicitly asked for manager access, so failing quietly into a
  // different role than requested would just be confusing.
  it('performSyncJoin refuses outright when a supplied passcode does not verify, rather than falling back to viewer', async () => {
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload }) // no role - passcode didn't match
      }))
    );

    await sync.performSyncJoin('CODE1234', 'WRONGPASS');
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/管理者密碼不正確/);
  });

  it('syncTick only pulls for a viewer, even when the local schedule has "changed"', async () => {
    sync.setSyncPairing('CODE1234');
    const fetchMock = vi.fn(async (url, options) => {
      expect(options?.method).not.toBe('PATCH');
      return { ok: true, json: async () => ({ exists: false }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await sync.syncTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('orbitSyncUpgradeToManager', () => {
  beforeEach(() => {
    document.getElementById('sync-upgrade-passcode').value = '';
  });

  it('does nothing when not configured or already a manager', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await sync.orbitSyncUpgradeToManager(); // not configured at all
    expect(fetchMock).not.toHaveBeenCalled();

    sync.setSyncPairing('CODE1234', 'PASSCODE1'); // already a manager
    document.getElementById('sync-upgrade-passcode').value = 'PASSCODE1';
    await sync.orbitSyncUpgradeToManager();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies the typed passcode against the server and, once correct, unlocks manager mode without resetting the pairing', async () => {
    sync.setSyncPairing('CODE1234'); // viewer
    localStorage.setItem('orbitSyncLastUpdateTime', 'already-seen');
    document.getElementById('sync-upgrade-passcode').value = 'PASSCODE1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, role: 'manager', updateTime: 'now', payload: '' })
      }))
    );

    await sync.orbitSyncUpgradeToManager();

    expect(sync.isSyncViewer()).toBe(false);
    expect(sync.getSyncManagerPasscode()).toBe('PASSCODE1');
    // Only the passcode itself changed - unlike a fresh join/setSyncPairing,
    // this shouldn't reset bookkeeping the device already had.
    expect(localStorage.getItem('orbitSyncLastUpdateTime')).toBe('already-seen');
    expect(document.getElementById('sync-status').textContent).toMatch(/已取得管理者權限/);
    expect(document.getElementById('sync-upgrade-passcode').value).toBe('');
  });

  it('leaves the device a viewer when the typed passcode is wrong', async () => {
    sync.setSyncPairing('CODE1234');
    document.getElementById('sync-upgrade-passcode').value = 'WRONGPASS';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload: '' }) // no role - didn't match
      }))
    );

    await sync.orbitSyncUpgradeToManager();

    expect(sync.isSyncViewer()).toBe(true);
    expect(document.getElementById('sync-status').textContent).toMatch(/不正確/);
  });
});

describe('a pre-join schedule backup can be recovered after unlinking or deleting', () => {
  beforeEach(() => {
    sync.orbitSyncDismissScheduleBackup();
  });
  // joinWithDifferentSchedule actually applies its payload (state.applicationData
  // is one shared singleton for the whole file - see the warning comment near
  // the 'Z' key above), so without this, the 'W' key it adds would still be
  // there for the *next* test, making that test's "different" payload look
  // identical to what's already applied and silently skip the join entirely.
  // teacherOrder needs cleaning up too - normalizeSettingsData auto-appends
  // any teacherDB key missing from it, so leaving a dangling 'W' there after
  // deleting the teacherDB entry makes the *next* decoded payload (which
  // normalizes cleanly, with no dangling entry) look spuriously different
  // from this now-inconsistent state.applicationData, applying a "no-op"
  // join for real and creating a bogus backup.
  afterEach(() => {
    delete state.applicationData.teacherDB.W;
    state.applicationData.teacherOrder = (state.applicationData.teacherOrder || []).filter(
      key => key !== 'W'
    );
  });

  // A key distinct from every other test in this file's fixture mutations -
  // see the warning comment near the 'Z' key above about shared singleton
  // state.applicationData across this whole file.
  async function joinWithDifferentSchedule(code = 'CODE1234', role = 'viewer') {
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const incoming = {
      ...state.applicationData,
      teacherDB: { ...state.applicationData.teacherDB, W: ['地科', '林老師', ''] }
    };
    const payload = await encodeTransferData(incoming);
    const passcode = role === 'manager' ? 'PASSCODE1' : '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          exists: true,
          ...(role === 'manager' ? { role: 'manager' } : {}),
          updateTime: 'now',
          payload
        })
      }))
    );
    await sync.performSyncJoin(code, passcode);
  }

  it('backs up the pre-join schedule only when the join actually replaces local data', async () => {
    expect(state.applicationData.teacherDB.W).toBeUndefined();
    await joinWithDifferentSchedule();
    expect(sync.isSyncConfigured()).toBe(true);
    expect(state.applicationData.teacherDB.W).toEqual(['地科', '林老師', '']);
    const backup = sync.getScheduleBackup();
    expect(backup).not.toBeNull();
    expect(backup.teacherDB.W).toBeUndefined();
  });

  it('does not create a backup when the code does not exist (nothing was actually joined)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }))
    );
    await sync.performSyncJoin('NOBODY99');
    expect(sync.isSyncConfigured()).toBe(false);
    expect(sync.getScheduleBackup()).toBeNull();
  });

  it('unlinking pops up the recovery prompt, and restoring brings back the pre-join schedule', async () => {
    await joinWithDifferentSchedule();
    sync.renderSyncPanel();
    sync.orbitSyncUnlink();
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 解除同步

    expect(sync.isSyncConfigured()).toBe(false);
    // The unlink confirm handler chains straight into the recovery prompt -
    // same sheet, new content - rather than leaving a notice sitting in the
    // panel for the user to notice later.
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/找回/);
    expect(state.applicationData.teacherDB.W).toEqual(['地科', '林老師', '']); // still the joined-in data

    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 換回加入前的課表
    expect(state.applicationData.teacherDB.W).toBeUndefined();
    expect(sync.getScheduleBackup()).toBeNull();
    expect(document.getElementById('sync-status').textContent).toMatch(/已還原/);
  });

  it('dismissing the prompt keeps the current (joined-in) schedule and clears the backup', async () => {
    await joinWithDifferentSchedule();
    sync.renderSyncPanel();
    sync.orbitSyncUnlink();
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 解除同步

    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick(); // 繼續使用目前課表
    expect(sync.getScheduleBackup()).toBeNull();
    expect(state.applicationData.teacherDB.W).toEqual(['地科', '林老師', '']);
  });

  it('deleting for everyone also pops up the recovery prompt', async () => {
    await joinWithDifferentSchedule('CODE1234', 'manager'); // manager, so the delete button is available
    sync.renderSyncPanel();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ deleted: true }) }))
    );
    sync.orbitSyncDeleteForEveryone();
    await document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 整個刪除

    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/找回/);
  });

  // The other device's syncTick discovering the deletion (rather than this
  // device being the one that deleted it) auto-unlinks the same way, and
  // offers the same recovery prompt - see handleRemoteSyncDeleted.
  it('a viewer that finds the shared document gone on its own next tick also pops up the recovery prompt', async () => {
    await joinWithDifferentSchedule(); // plain viewer join, replaces the local schedule
    sync.renderSyncPanel();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }))
    );

    await sync.syncTick();

    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/找回/);
  });
});

// startSyncLoop() itself only ever runs once for the whole module (guarded
// by a "started" flag) and is already triggered once at app boot via
// bootstrap.js (see loadApp()), so its activity listeners are already bound
// by the time any test here runs - no need to call it again.
describe('activity-driven sync: reads only happen when the user touches the UI', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a click triggers a check, but another click within the throttle window does not', async () => {
    sync.setSyncPairing('CODE1234');
    vi.useFakeTimers();
    // Jump well clear of whatever real-time click/boot activity earlier
    // tests (or the app's own boot) may have left lastActivitySyncAt at -
    // that's module-level state shared across every test in this file.
    vi.setSystemTime(Date.now() + 3_600_000);
    // exists:true with no payload (not exists:false) - this test is only
    // about the activity throttle, not about the remote-deletion handling
    // covered separately below; exists:false here would auto-unlink after
    // the very first tick (see handleRemoteSyncDeleted) and the device would
    // no longer be configured for the later ticks this test still expects.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ exists: true, updateTime: 'unchanged', payload: '' })
    }));
    vi.stubGlobal('fetch', fetchMock);

    document.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event('click'));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just the one - throttled

    // Past the throttle window, the next touch checks again.
    vi.setSystemTime(Date.now() + 6000);
    document.dispatchEvent(new Event('keydown'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('idle time alone - no interaction at all - never triggers a check', async () => {
    sync.setSyncPairing('CODE1234');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3_600_000);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }));
    vi.stubGlobal('fetch', fetchMock);

    await vi.advanceTimersByTimeAsync(120_000); // a full two minutes, untouched
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('orbitSyncJoin checks the code exists before ever warning about overwriting data', () => {
  it('shows the confirm sheet (and pairs nothing yet) only once the code is confirmed to exist', async () => {
    document.getElementById('sync-join-code').value = 'CODE1234';
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ exists: true, updateTime: 'now', payload })
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sync.orbitSyncJoin();

    expect(sync.isSyncConfigured()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/加入同步/);
    expect(document.getElementById('editor-confirm-msg').textContent).toMatch(/取代/);
  });

  it('joins only once the confirm button is actually clicked', async () => {
    document.getElementById('sync-join-code').value = 'CODE1234';
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ exists: true, updateTime: 'now', payload })
      }))
    );

    await sync.orbitSyncJoin();
    const confirmBtn = document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1];
    confirmBtn.onclick();
    // performSyncJoin is async and fire-and-forget from the click handler -
    // wait for its own role-check fetch (a separate GET from orbitSyncJoin's
    // pre-confirm check above) to actually settle before asserting.
    await vi.waitFor(() => expect(sync.isSyncConfigured()).toBe(true));
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
  });

  it('cancelling leaves the device unpaired', async () => {
    document.getElementById('sync-join-code').value = 'CODE1234';
    const { encodeTransferData } = await import('../src/editor-backup.js');
    const payload = await encodeTransferData(state.applicationData);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ exists: true, updateTime: 'now', payload })
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sync.orbitSyncJoin();
    const cancelBtn = document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0];
    cancelBtn.onclick();

    expect(sync.isSyncConfigured()).toBe(false);
    // Only the existence check should have fired - cancelling never pulls/pairs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
  });

  // The bug report this fold is named for: entering a code nobody created
  // used to still pop the "this will overwrite your data" confirmation,
  // which was both misleading (there was never anything to overwrite with)
  // and pointless (performSyncJoin's own check would have rejected it
  // anyway after the user clicked through the warning). Now the existence
  // check happens first, so a bad code fails immediately with a clear
  // error and the overwrite confirmation never appears at all.
  it('a nonexistent code rejects immediately with a clear error - no overwrite confirmation ever shown', async () => {
    document.getElementById('sync-join-code').value = 'NOBODY99';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sync.orbitSyncJoin();

    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/找不到這組配對代碼/);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A second bug found right after the first: a mistyped code that doesn't
  // even match the expected 8-character shape gets rejected by the Worker
  // with 400 "Invalid pairing code" - checked before it ever asks Firestore
  // - not the {exists:false} shape a genuinely nonexistent-but-well-formed
  // code gets. Both mean the same thing to the user (this code isn't a
  // real, joinable sync), so they should look the same.
  it('a malformed code (400 from the Worker, not {exists:false}) shows the same friendly "not found" error', async () => {
    document.getElementById('sync-join-code').value = 'not-a-real-code';
    const fetchMock = vi.fn(async () => ({
      status: 400,
      ok: false,
      json: async () => ({ error: { message: 'Invalid pairing code' } })
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sync.orbitSyncJoin();

    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/找不到這組配對代碼/);
    expect(document.getElementById('sync-status').textContent).not.toMatch(/Invalid pairing code/i);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
  });
});

describe('orbitSyncDeleteForEveryone', () => {
  it('is not offered to a viewer (the unlink dialog offers copy-code instead), and refuses even if called directly', async () => {
    sync.setSyncPairing('CODE1234');
    sync.renderSyncPanel();
    sync.orbitSyncUnlink();
    expect(document.getElementById('editor-confirm-extra-btn').textContent).toMatch(/複製代碼/);
    expect(document.getElementById('editor-confirm-extra-btn').classList.contains('danger')).toBe(
      false
    );
    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick(); // 取消

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sync.orbitSyncDeleteForEveryone();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
  });

  it("is reachable to a manager only as the unlink dialog's extra option, which warns before doing anything and reverts nothing on cancel", async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    sync.renderSyncPanel();
    sync.orbitSyncUnlink();
    const extraBtn = document.getElementById('editor-confirm-extra-btn');
    expect(extraBtn.textContent).toMatch(/整個刪除同步/);
    expect(extraBtn.classList.contains('danger')).toBe(true);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    extraBtn.onclick(); // 整個刪除同步 (chains from the unlink dialog into this one)
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toMatch(/整個刪除/);
    expect(document.getElementById('editor-confirm-msg').textContent).toMatch(/無法復原/);
    expect(document.getElementById('editor-import-diff').textContent).toMatch(/管理者密碼/);
    // Unlike orbitSyncUnlink's confirm sheet, this one offers no "複製代碼"
    // button - once this succeeds the code is dead for everyone, so copying
    // it would be pointless.
    expect(document.getElementById('editor-confirm-extra-btn').style.display).toBe('none');

    document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick(); // 取消
    expect(sync.isSyncConfigured()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirming sends a DELETE with the manager passcode and clears the local pairing on success', async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    sync.renderSyncPanel();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ deleted: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    sync.orbitSyncDeleteForEveryone();
    await document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick(); // 整個刪除

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY_URL}?code=CODE1234&passcode=PASSCODE1`);
    expect(options.method).toBe('DELETE');
    expect(sync.isSyncConfigured()).toBe(false);
    expect(document.getElementById('sync-status').textContent).toMatch(/已整個刪除同步/);
  });

  it('a failed DELETE surfaces an error and leaves the device still paired', async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    sync.renderSyncPanel();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Upstream request failed' } })
    }));
    vi.stubGlobal('fetch', fetchMock);

    sync.orbitSyncDeleteForEveryone();
    await document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick();

    expect(sync.isSyncConfigured()).toBe(true);
    expect(document.getElementById('sync-status').textContent).toMatch(/刪除失敗/);
  });

  it('refuses while offline, without making any network request', async () => {
    sync.setSyncPairing('CODE1234', 'PASSCODE1');
    sync.renderSyncPanel();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    sync.orbitSyncDeleteForEveryone();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sync.isSyncConfigured()).toBe(true);
    expect(document.getElementById('sync-status').textContent).toMatch(/沒有網路連線/);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(false);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});
