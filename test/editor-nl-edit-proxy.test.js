import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (own module registry) so editor-nl-edit.js's module-scope
// `import.meta.env.VITE_ORBIT_NL_EDIT_PROXY_URL` read - evaluated once, at
// import time - picks up this stub. Same pattern as gemini-ocr-proxy.test.js.
const PROXY_URL = 'https://example-region-demo-project.cloudfunctions.net/nlEditProxy';

let isNlEditConfigured;
let submitNlEdit;
let state;

beforeAll(async () => {
  vi.stubEnv('VITE_ORBIT_NL_EDIT_PROXY_URL', PROXY_URL);
  seedLocalStorage();
  await loadApp();
  ({ isNlEditConfigured, submitNlEdit } = await import('../src/editor-nl-edit.js'));
  ({ state } = await import('../src/state.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function fakeNlEditResponse(json) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }]
    })
  };
}

function okSetSlot(overrides = {}) {
  return {
    status: 'ok',
    reason: '',
    op: 'setSlot',
    day: 2,
    period: 0,
    subject: '物理',
    teacher: '',
    location: '',
    fromDay: null,
    fromPeriod: null,
    toDay: null,
    toPeriod: null,
    ...overrides
  };
}

function statusRecorder() {
  const calls = [];
  const status = (message, isError = false) => calls.push({ message, isError });
  return { calls, status };
}

function confirmSheetVisible() {
  return document.getElementById('editor-confirm-sheet').classList.contains('show');
}
function clickConfirm() {
  document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[1].onclick();
}
function clickCancel() {
  document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick();
}

describe('isNlEditConfigured with a configured proxy', () => {
  it('reports the proxy as configured', () => {
    expect(isNlEditConfigured()).toBe(true);
  });
});

describe('submitNlEdit - request shape', () => {
  it('sends only {model, text, context} - the prompt and schema are the proxy\'s job, not the client\'s', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(PROXY_URL);
      const body = JSON.parse(options.body);
      expect(body.model).toBe('gemini-3.5-flash-lite');
      expect(body.text).toBe('把我週二第一節改成物理');
      expect(body.context).toMatchObject({
        weeklySchedule: expect.any(Object),
        classes: expect.any(Array),
        bellTimes: expect.any(Array)
      });
      expect(body.contents).toBeUndefined();
      expect(body.generationConfig).toBeUndefined();
      return fakeNlEditResponse(okSetSlot());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clickCancel();
    vi.unstubAllGlobals();
  });

  it('escalates to the stronger model when the fast one is overloaded', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.model === 'gemini-3.5-flash-lite') {
        return { ok: false, status: 503, statusText: 'Overloaded', json: async () => ({}) };
      }
      expect(body.model).toBe('gemini-3.7-flash');
      return fakeNlEditResponse(okSetSlot());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clickCancel();
    vi.unstubAllGlobals();
  });

  it('surfaces the proxy rate-limit message immediately without trying the next model', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: '請求過於頻繁，請稍後再試。' } })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.some(call => call.isError && /請求過於頻繁/.test(call.message))).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('submitNlEdit - first-class failure states', () => {
  it('shows a dismissable info dialog, not a crash, when the AI cannot understand the instruction', async () => {
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse({
        status: 'unclear',
        reason: '不確定你想改哪一節',
        op: 'none',
        day: null,
        period: null,
        subject: '',
        teacher: '',
        location: '',
        fromDay: null,
        fromPeriod: null,
        toDay: null,
        toPeriod: null
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('隨便說點什麼', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(document.getElementById('editor-confirm-msg').textContent).toBe('不確定你想改哪一節');
    // Single-button info dialog - dismissing it just closes it, no data changes.
    clickConfirm();
    expect(confirmSheetVisible()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows a dismissable info dialog when the instruction names something that does not exist', async () => {
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse({
        status: 'not_found',
        reason: '課表沒有第九節',
        op: 'none',
        day: null,
        period: null,
        subject: '',
        teacher: '',
        location: '',
        fromDay: null,
        fromPeriod: null,
        toDay: null,
        toPeriod: null
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第九節改成物理', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(document.getElementById('editor-confirm-msg').textContent).toBe('課表沒有第九節');
    clickConfirm();
    vi.unstubAllGlobals();
  });

  it('rejects a structurally-fine but out-of-range op instead of trusting it blindly', async () => {
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okSetSlot({ day: 9 })));
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(calls.some(call => call.isError)).toBe(true);
    expect(confirmSheetVisible()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('submitNlEdit - confirm-before-apply', () => {
  it('never applies the change until the confirm sheet is accepted', async () => {
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okSetSlot()));
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(confirmSheetVisible()).toBe(true);
    // Not yet applied to the real app data.
    expect(state.applicationData.weeklySchedule[2][0]).toBeFalsy();
    clickCancel();
    expect(confirmSheetVisible()).toBe(false);
    expect(state.applicationData.weeklySchedule[2][0]).toBeFalsy();
    vi.unstubAllGlobals();
  });

  it('applies the proposed edit once confirmed', async () => {
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okSetSlot()));
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    clickConfirm();
    expect(confirmSheetVisible()).toBe(false);
    const key = state.applicationData.weeklySchedule[2][0];
    expect(key).toBeTruthy();
    expect(state.applicationData.teacherDB[key][0]).toBe('物理');
    vi.unstubAllGlobals();
  });

  it('reports "no change" instead of an empty confirm sheet when the proposed edit matches what is already there', async () => {
    // Day 1 period 0 in the fixture is already class "A" (數學/王老師) -
    // asking to set it to the exact same class is a no-op.
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse(okSetSlot({ day: 1, period: 0, subject: '數學', teacher: '王老師' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週一第一節改成數學', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toBe('沒有變更');
    clickConfirm();
    vi.unstubAllGlobals();
  });
});

describe('submitNlEdit - offline', () => {
  it('refuses to run while offline, without making any network request', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some(call => call.isError && /沒有網路連線/.test(call.message))).toBe(true);
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});

describe('submitNlEdit - empty input', () => {
  it('refuses an empty instruction without making any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('   ', { status });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some(call => call.isError)).toBe(true);
    vi.unstubAllGlobals();
  });
});
