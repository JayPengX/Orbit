import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (own module registry, same reasoning as
// editor-nl-edit-proxy.test.js's own comment) specifically so BOTH
// VITE_PROXY_URL and VITE_PROXY_URL_FALLBACK are stubbed before
// proxy-config.js's module-scope reads run - editor-nl-edit-proxy.test.js
// only stubs the primary one, so it can't exercise this path at all.
const BASE_URL = 'https://example-region-demo-project.cloudfunctions.net';
const FALLBACK_BASE_URL = 'https://example-fallback-project.cloudfunctions.net';
const PROXY_URL = `${BASE_URL}/nl-edit`;
const FALLBACK_PROXY_URL = `${FALLBACK_BASE_URL}/nl-edit`;

let buildNlEditContext;
let submitNlEdit;

beforeAll(async () => {
  vi.stubEnv('VITE_PROXY_URL', BASE_URL);
  vi.stubEnv('VITE_PROXY_URL_FALLBACK', FALLBACK_BASE_URL);
  seedLocalStorage();
  await loadApp();
  ({ buildNlEditContext, submitNlEdit } = await import('../src/editor-nl-edit.js'));
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

function okState(overrides = {}) {
  const context = buildNlEditContext();
  return {
    status: 'ok',
    reason: '',
    classes: context.classes,
    weeklySchedule: context.weeklySchedule,
    bellTimes: context.bellTimes,
    breakTimes: context.breakTimes,
    countdownEvents: context.countdownEvents,
    reverseWeek: context.reverseWeek,
    ...overrides
  };
}

function locationBlockedResponse() {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    headers: { get: name => (name === 'X-Worker-Colo' ? 'SIN' : null) },
    json: async () => ({ error: { message: 'User location is not supported for the API use.' } })
  };
}

function clickCancel() {
  document.querySelectorAll('#editor-confirm-sheet .editor-confirm-btn')[0].onclick();
}

describe('submitNlEdit location-block retry with a configured fallback proxy', () => {
  // Same reasoning as gemini-ocr-fallback-proxy.test.js: Smart Placement
  // sticks a given caller to the same colo, so the retry needs to hit a
  // genuinely different Worker deployment (PROXY_URL_FALLBACK) to have a
  // real chance of landing somewhere Google doesn't block.
  it('retries a location block against the fallback Worker, not the same one again', async () => {
    const urlsHit = [];
    const fetchMock = vi.fn(async url => {
      urlsHit.push(url);
      if (url === PROXY_URL) return locationBlockedResponse();
      const context = buildNlEditContext();
      return fakeNlEditResponse(
        okState({
          classes: [...context.classes, { key: 'fb1', subject: '物理', teacher: '', location: '' }],
          weeklySchedule: { ...context.weeklySchedule, 2: ['fb1'] }
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await submitNlEdit('把我週二第一節改成物理', { status: () => {} });
    expect(urlsHit[0]).toBe(PROXY_URL);
    expect(urlsHit[1]).toBe(FALLBACK_PROXY_URL);
    expect(urlsHit.filter(url => url === PROXY_URL)).toHaveLength(1);
    expect(document.getElementById('editor-confirm-sheet').classList.contains('show')).toBe(true);
    clickCancel();
    vi.unstubAllGlobals();
  }, 10000);

  it('keeps retrying the fallback Worker (not bouncing back to the primary) if it is blocked too', async () => {
    const urlsHit = [];
    const fetchMock = vi.fn(async url => {
      urlsHit.push(url);
      return locationBlockedResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const calls = [];
    await submitNlEdit('把我週二第一節改成物理', { status: (message, isError) => calls.push({ message, isError }) });
    expect(calls.some(call => call.isError && /地區限制|稍後再試/.test(call.message))).toBe(true);
    expect(urlsHit).toEqual([PROXY_URL, FALLBACK_PROXY_URL, FALLBACK_PROXY_URL]);
    vi.unstubAllGlobals();
  }, 10000);
});
