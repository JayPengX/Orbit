import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (own module registry) so proxy-config.js's module-scope
// `import.meta.env.VITE_PROXY_URL` read - evaluated once, at import time -
// picks up this stub. Same pattern as gemini-ocr-proxy.test.js.
const BASE_URL = 'https://example-region-demo-project.cloudfunctions.net';
const PROXY_URL = `${BASE_URL}/nl-edit`;

let buildNlEditContext;
let isNlEditConfigured;
let submitNlEdit;
let state;

beforeAll(async () => {
  vi.stubEnv('VITE_PROXY_URL', BASE_URL);
  seedLocalStorage();
  await loadApp();
  ({ buildNlEditContext, isNlEditConfigured, submitNlEdit } =
    await import('../src/editor-nl-edit.js'));
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

// Sparse patch, not full-state (see NL_EDIT_RESPONSE_SCHEMA's own comment in
// worker.js) - a well-shaped "ok" result that touches nothing at all
// by default: every list empty, every *Changed flag false. `overrides`
// patches whichever fields a test actually cares about, exactly the way the
// real AI response only ever fills in what the instruction asked to change.
function okState(overrides = {}) {
  return {
    status: 'ok',
    reason: '',
    classUpserts: [],
    deletedClassKeys: [],
    scheduleEdits: [],
    bellTimesChanged: false,
    bellTimes: [],
    breakTimesChanged: false,
    breakTimes: [],
    countdownEventsChanged: false,
    countdownEvents: [],
    reverseWeekChanged: false,
    reverseWeek: false,
    ...overrides
  };
}

// okState() with no overrides touches nothing - a genuine "no change"
// result, which shows the single-button info dialog instead of the
// two-button confirm dialog (see the "reports no change" test below). Tests
// that don't care what the change actually is, only that a real one
// happened and there's a confirm sheet with a cancel/confirm pair to click,
// use this instead: sets a brand-new "new1" 物理 class into 週二第一節
// (day 2, empty in the fixture and left alone by every other test in this
// file except the ones that explicitly touch it).
function okChangedState(overrides = {}) {
  return okState({
    classUpserts: [{ key: 'new1', subject: '物理', teacher: '', location: '' }],
    scheduleEdits: [{ day: 2, period: 0, key: 'new1' }],
    ...overrides
  });
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
  it("sends only {model, text, context} - the prompt and schema are the proxy's job, not the client's", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(PROXY_URL);
      const body = JSON.parse(options.body);
      expect(body.model).toBe('gemini-3.5-flash-lite');
      expect(body.text).toBe('把我週二第一節改成物理');
      expect(body.context).toMatchObject({
        weeklySchedule: expect.any(Object),
        classes: expect.any(Array),
        bellTimes: expect.any(Array),
        breakTimes: expect.any(Array),
        countdownEvents: expect.any(Array),
        reverseWeek: expect.any(Boolean)
      });
      expect(body.contents).toBeUndefined();
      expect(body.generationConfig).toBeUndefined();
      return fakeNlEditResponse(okChangedState());
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
      return fakeNlEditResponse(okChangedState());
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

  // Google's Gemini API rejects a request based on the *proxy's* egress IP,
  // not the end user's real location - so this can surface for a user
  // whose own location is fully supported, whenever Cloudflare happens to
  // route the Worker's outbound call through a colo Google blocks. A fresh
  // pass has a real chance of landing on a different edge colo, so this is
  // retried a bounded number of times before finally giving up - same
  // mitigation as gemini-ocr.js's AIVisionProcessor.callGemini.
  it('retries a few whole passes before giving up on a persistent location block', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: { get: name => (name === 'X-Worker-Colo' ? 'IAD' : null) },
      json: async () => ({ error: { message: 'User location is not supported for the API use.' } })
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(calls.some(call => call.isError && /地區限制|稍後再試/.test(call.message))).toBe(true);
    expect(calls.some(call => /User location/.test(call.message))).toBe(false);
    // The colo that actually got blocked (X-Worker-Colo, set by
    // worker.js from request.cf.colo) - Smart Placement can stick a
    // given caller to the same colo indefinitely, so this needs to be
    // reportable, not just "somewhere, sometime".
    expect(calls.some(call => call.isError && call.message.includes('IAD'))).toBe(true);
    // One fetch call per whole pass (never more than one model tried within
    // a blocked pass), 3 passes total: the first attempt plus 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  }, 10000);

  it('recovers on a later retry once a pass lands on a colo Gemini accepts', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 3) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          headers: { get: name => (name === 'X-Worker-Colo' ? 'IAD' : null) },
          json: async () => ({
            error: { message: 'User location is not supported for the API use.' }
          })
        };
      }
      return fakeNlEditResponse(okChangedState());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clickCancel();
    vi.unstubAllGlobals();
  }, 10000);
});

describe('submitNlEdit - first-class failure states', () => {
  it('shows a dismissable info dialog, not a crash, when the AI cannot understand the instruction', async () => {
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse({ status: 'unclear', reason: '不確定你想改哪一節' })
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
      fakeNlEditResponse({ status: 'not_found', reason: '課表沒有第九節' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第九節改成物理', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(document.getElementById('editor-confirm-msg').textContent).toBe('課表沒有第九節');
    clickConfirm();
    vi.unstubAllGlobals();
  });

  it('rejects a response missing a required field instead of trusting it blindly', async () => {
    const fetchMock = vi.fn(async () => {
      const body = okState();
      delete body.scheduleEdits; // structurally incomplete
      return fakeNlEditResponse(body);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { calls, status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    expect(calls.some(call => call.isError)).toBe(true);
    expect(confirmSheetVisible()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rejects a content-level malformed result (normalizeSettingsData throws) instead of trusting it blindly', async () => {
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse(
        okState({ bellTimesChanged: true, bellTimes: [['not', 'a', 'valid', 'range']] })
      )
    );
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
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okChangedState()));
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
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okChangedState()));
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

  // A patch entry the model invents for a class/cell nobody asked about
  // would show up here as an extra line in the diff - this asserts the
  // *actually applied* result only ever reflects what the fake response
  // above included, never anything from the client's own unrelated fixture
  // data (day 1's A/B/C classes, untouched by this instruction).
  it('never lets an untouched class or cell end up changed', async () => {
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okChangedState()));
    vi.stubGlobal('fetch', fetchMock);
    const before = JSON.parse(JSON.stringify(state.applicationData.weeklySchedule[1]));
    const beforeTeacherDB = JSON.parse(JSON.stringify(state.applicationData.teacherDB));
    const { status } = statusRecorder();
    await submitNlEdit('把我週二第一節改成物理', { status });
    clickConfirm();
    expect(state.applicationData.weeklySchedule[1]).toEqual(before);
    Object.keys(beforeTeacherDB).forEach(key => {
      expect(state.applicationData.teacherDB[key]).toEqual(beforeTeacherDB[key]);
    });
    vi.unstubAllGlobals();
  });

  it('reports "no change" instead of an empty confirm sheet when the AI patch touches nothing', async () => {
    const fetchMock = vi.fn(async () => fakeNlEditResponse(okState()));
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把我週一第一節改成數學', { status });
    expect(confirmSheetVisible()).toBe(true);
    expect(document.getElementById('editor-confirm-title').textContent).toBe('沒有變更');
    clickConfirm();
    vi.unstubAllGlobals();
  });

  // Runs last in this describe block on purpose: mutates several fields at
  // once, which the "no change"/single-field tests above depend on NOT
  // having happened yet.
  it('applies several distinct changes from one multi-part instruction together, including ones the old fixed-verb design could never do', async () => {
    // "把週三第一節改成物理，加一節第四節生物課 11:10-12:00，午休改成 12:00-13:00" -
    // a new class scheduled into a brand-new bell period, plus a break time
    // edit, all in one instruction/one sparse patch. Uses day 3 (untouched
    // by the earlier tests in this block, which only ever mutate day 2) and
    // its own key names/bell time, so it can't collide with state those
    // tests already left behind in the shared, sequentially-mutated
    // state.applicationData.
    const fetchMock = vi.fn(async () =>
      fakeNlEditResponse(
        okState({
          classUpserts: [
            { key: 'mp1', subject: '物理', teacher: '', location: '' },
            { key: 'mp2', subject: '生物', teacher: '', location: '' }
          ],
          scheduleEdits: [
            { day: 3, period: 0, key: 'mp1' },
            { day: 3, period: 3, key: 'mp2' }
          ],
          bellTimesChanged: true,
          bellTimes: [...buildNlEditContext().bellTimes, ['11:10', '12:00']],
          breakTimesChanged: true,
          breakTimes: [{ name: '午休', start: '12:00', end: '13:00' }]
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = statusRecorder();
    await submitNlEdit('把週三第一節改成物理，加一節生物課，午休改成 12:00-13:00', { status });
    clickConfirm();
    expect(state.applicationData.teacherDB[state.applicationData.weeklySchedule[3][0]][0]).toBe(
      '物理'
    );
    expect(state.applicationData.teacherDB[state.applicationData.weeklySchedule[3][3]][0]).toBe(
      '生物'
    );
    expect(state.applicationData.bellTimes).toHaveLength(4);
    expect(state.applicationData.breakTimes).toEqual(
      expect.arrayContaining([{ name: '午休', start: '12:00', end: '13:00' }])
    );
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
