import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (own module registry, same reasoning as
// gemini-ocr-proxy.test.js's own comment) specifically so BOTH
// VITE_PROXY_URL and VITE_PROXY_URL_FALLBACK are stubbed before
// proxy-config.js's module-scope reads run - gemini-ocr-proxy.test.js only
// stubs the primary one, so it can't exercise this path at all.
const BASE_URL = 'https://example-region-demo-project.cloudfunctions.net';
const FALLBACK_BASE_URL = 'https://example-fallback-project.cloudfunctions.net';
const PROXY_URL = `${BASE_URL}/gemini`;
const FALLBACK_PROXY_URL = `${FALLBACK_BASE_URL}/gemini`;

let AIVisionProcessor;

beforeAll(async () => {
  vi.stubEnv('VITE_PROXY_URL', BASE_URL);
  vi.stubEnv('VITE_PROXY_URL_FALLBACK', FALLBACK_BASE_URL);
  seedLocalStorage();
  await loadApp();
  ({ AIVisionProcessor } = await import('../src/gemini-ocr.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function fakeFiles(count = 1) {
  return Array.from({ length: count }, () => ({ mime_type: 'image/jpeg', data: 'AAAA' }));
}

function fakeGeminiResponse(json) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }]
    })
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

describe('AIVisionProcessor location-block retry with a configured fallback proxy', () => {
  // Smart Placement sticks a given caller to the same colo indefinitely (see
  // wrangler.toml's own comment), so retrying the exact same Worker rarely
  // helps - this is what PROXY_URL_FALLBACK exists for: a second Worker
  // deployment with Smart Placement off, giving the retry a genuinely
  // different colo to land on instead of the one that just got blocked.
  it('retries a location block against the fallback Worker, not the same one again', async () => {
    const urlsHit = [];
    const fetchMock = vi.fn(async url => {
      urlsHit.push(url);
      if (url === PROXY_URL) return locationBlockedResponse();
      return fakeGeminiResponse({ documentKind: 'timetable', teacherDB: {}, weeklySchedule: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const processor = new AIVisionProcessor();
    const result = await processor.recognizeSchedule(fakeFiles(), () => {});
    expect(result.candidate).toBeTruthy();
    // First attempt against the primary URL, then the retry against the
    // fallback - never a second call to the primary.
    expect(urlsHit[0]).toBe(PROXY_URL);
    expect(urlsHit[1]).toBe(FALLBACK_PROXY_URL);
    expect(urlsHit.filter(url => url === PROXY_URL)).toHaveLength(1);
    vi.unstubAllGlobals();
  }, 10000);

  it('keeps retrying the fallback Worker (not bouncing back to the primary) if it is blocked too', async () => {
    const urlsHit = [];
    const fetchMock = vi.fn(async url => {
      urlsHit.push(url);
      return locationBlockedResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const processor = new AIVisionProcessor();
    let caught;
    try {
      await processor.recognizeSchedule(fakeFiles(), () => {});
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).toMatch(/地區限制|稍後再試/);
    expect(urlsHit).toEqual([PROXY_URL, FALLBACK_PROXY_URL, FALLBACK_PROXY_URL]);
    vi.unstubAllGlobals();
  }, 10000);
});
