import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

// A separate file (own module registry) so gemini-ocr.js's module-scope
// `import.meta.env.VITE_ORBIT_GEMINI_PROXY_URL` read - evaluated once, at
// import time - picks up this stub. See sync-default-project.test.js for
// the same pattern applied to the sync module.
const PROXY_URL = 'https://example-region-demo-project.cloudfunctions.net/geminiProxy';

let AIVisionProcessor;
let isGeminiProxyConfigured;
let warmUpGeminiProxy;

beforeAll(async () => {
  vi.stubEnv('VITE_ORBIT_GEMINI_PROXY_URL', PROXY_URL);
  seedLocalStorage();
  await loadApp();
  ({ AIVisionProcessor, isGeminiProxyConfigured, warmUpGeminiProxy } =
    await import('../src/gemini-ocr.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

// The encoded inline_data parts recognizeSchedule() takes now - the
// canvas/file preprocessing that produces them happens before this call and
// is the importer's job, not the processor's.
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

describe('AIVisionProcessor.recognizeSchedule with a configured proxy', () => {
  it('reports the proxy as configured', () => {
    expect(isGeminiProxyConfigured()).toBe(true);
  });

  // Fastest model first, most capable last - see the comment on
  // AIVisionProcessor's own model list for why that order is safe now.
  it('does not require an API key, and reaches for the quickest model first', async () => {
    const processor = new AIVisionProcessor();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeGeminiResponse({ documentKind: 'timetable', teacherDB: {}, weeklySchedule: {} })
      )
    );
    await expect(processor.recognizeSchedule(fakeFiles(), () => {})).resolves.toMatchObject({
      modelUsed: 'gemini-3.5-flash-lite'
    });
    vi.unstubAllGlobals();
  });

  it("sends only {model, files} - the prompt and generation config are the proxy's job, not the client's", async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(PROXY_URL);
      const body = JSON.parse(options.body);
      expect(body.model).toBe('gemini-3.5-flash-lite');
      expect(body.promptType).toBeUndefined();
      expect(body.files).toHaveLength(1);
      expect(body.files[0]).toMatchObject({ mime_type: 'image/jpeg' });
      expect(typeof body.files[0].data).toBe('string');
      expect(body.contents).toBeUndefined();
      expect(body.generationConfig).toBeUndefined();
      return fakeGeminiResponse({ documentKind: 'timetable', teacherDB: {}, weeklySchedule: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    await processor.recognizeSchedule(fakeFiles(), () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  // recognizeSchedule() itself still sends whatever files it's given in one
  // request (useful e.g. for stitching two photos of one physical page) -
  // it's recognizeAndMerge() that no longer calls it this way for the
  // timetable-plus-registration-document case; see the describe block below.
  it('sends every given file in a single request, in the order they were picked', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(body.files.map(file => file.data)).toEqual(['one', 'two', 'three']);
      return fakeGeminiResponse({ documentKind: 'timetable', teacherDB: {}, weeklySchedule: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    await processor.recognizeSchedule(
      ['one', 'two', 'three'].map(data => ({ mime_type: 'image/jpeg', data })),
      () => {}
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  // A structurally unusable answer is no longer the end of the road: it
  // escalates to the next, stronger model instead of being shown to the
  // user as a broken preview.
  it('escalates to the next model when the quick one returns something unusable', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async (url, options) =>
      JSON.parse(options.body).model === 'gemini-3.5-flash-lite'
        ? fakeGeminiResponse({ documentKind: 'timetable', classes: [], weeklySchedule: {} })
        : fakeGeminiResponse({
            documentKind: 'timetable',
            classes: [{ key: 'c1', subject: '國文', teacher: '陳老師', location: 'A101' }],
            weeklySchedule: { 1: ['c1'] },
            bellTimes: [{ start: '08:10', end: '09:00' }]
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await processor.recognizeSchedule(fakeFiles(), () => {}, {
      validate: candidate =>
        Object.keys(candidate.teacherDB || {}).length
          ? { valid: true }
          : { valid: false, errors: ['沒有辨識到課程或倒數日期。'] }
    });
    expect(result.modelUsed).toBe('gemini-3.7-flash');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  // ...but only so far. When no model can make sense of it, the user still
  // gets the last attempt (and its validation errors) to correct by hand,
  // rather than a bare failure.
  it('falls back to the last attempt when no model produces a usable result', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async () =>
      fakeGeminiResponse({ documentKind: 'timetable', classes: [], weeklySchedule: {} })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await processor.recognizeSchedule(fakeFiles(), () => {}, {
      validate: () => ({ valid: false, errors: ['沒有辨識到課程或倒數日期。'] })
    });
    expect(result.modelUsed).toBe('gemini-3.7-flash'); // the last one tried
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('surfaces the proxy rate-limit message immediately without retrying other models', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: '請求過於頻繁，請稍後再試。' } })
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(processor.recognizeSchedule(fakeFiles(), () => {})).rejects.toThrow(
      '請求過於頻繁，請稍後再試。'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('refuses to run while offline, without making any network request', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(processor.recognizeSchedule(fakeFiles(), () => {})).rejects.toThrow(
      /沒有網路連線/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});

// mountOCRImporter's actual entry point for a real import. Every file gets
// exactly the same request and is classified independently by its own
// content ("documentKind" - see GEMINI_PROMPT) - never by its position in
// the upload list. That's the fix for a real reported bug: an earlier
// design assumed file 1 was always the timetable and every file after it a
// registration record, which broke completely the moment someone picked
// the files in the other order. These tests tag each fake file by what it
// represents (not by index) and route the mock response off that tag, so
// upload order is free to vary from test to test - several deliberately
// upload the "wrong" order to prove it no longer matters.
describe('AIVisionProcessor.recognizeAndMerge', () => {
  function tag(name) {
    return { mime_type: 'image/jpeg', data: name };
  }

  function fakeTimetableResponse(overrides) {
    return fakeGeminiResponse({
      documentKind: 'timetable',
      classes: [],
      weeklySchedule: {},
      ...overrides
    });
  }

  function fakeRegistrationResponse(courses, countdownEvents = []) {
    return fakeGeminiResponse({ documentKind: 'registration', courses, countdownEvents });
  }

  // Routes each mocked call by which tagged file it received - `responses`
  // maps a file's tag to the response for that file's request.
  function routedFetchMock(responses) {
    return vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      const fileTag = body.files[0].data;
      if (!(fileTag in responses)) throw new Error(`Unexpected file tag: ${fileTag}`);
      return responses[fileTag];
    });
  }

  it('with one file, behaves exactly like recognizeSchedule - a single request', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '國文', teacher: '陳老師' }],
        weeklySchedule: { 1: ['c1'] },
        bellTimes: [{ start: '08:10', end: '09:00' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge([tag('timetable')], () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(candidate.weeklySchedule[1][0]).toBeTruthy();
    vi.unstubAllGlobals();
  });

  // The actual bug report this fix addresses: uploading the timetable photo
  // and the registration form in the OTHER order used to produce garbage
  // (the registration form read as a timetable grid, the timetable read as
  // a course list, both finding nothing useful). Same two files, reversed
  // order, must merge identically to the "normal" order.
  it('merges correctly regardless of upload order - the registration file first, the timetable second', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '多元選修', teacher: '' }],
        weeklySchedule: { 1: [null, null, null, null, null, 'c1', 'c1'] },
        bellTimes: Array.from({ length: 7 }, () => ({ start: '08:00', end: '08:50' }))
      }),
      registration: fakeRegistrationResponse([
        { subject: '西班牙語', teacher: '李忍堅', location: '303教室', day: 1, periods: [6, 7] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    // Registration file uploaded FIRST, timetable SECOND - the order that
    // used to break the old position-based design.
    const { candidate } = await processor.recognizeAndMerge(
      [tag('registration'), tag('timetable')],
      () => {}
    );
    const [p6, p7] = [candidate.weeklySchedule[1][5], candidate.weeklySchedule[1][6]];
    expect(p6).toBe(p7);
    expect(candidate.teacherDB[p6]).toEqual(['西班牙語', '李忍堅', '303教室']);
    vi.unstubAllGlobals();
  });

  it('sends every file as its own single-file request, whichever order they were picked in', async () => {
    const processor = new AIVisionProcessor();
    const calls = [];
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return body.files[0].data === 'timetable'
        ? fakeTimetableResponse()
        : fakeRegistrationResponse([
            { subject: '西班牙語', teacher: '李忍堅', day: 1, periods: [6, 7] }
          ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await processor.recognizeAndMerge([tag('registration'), tag('timetable')], () => {});
    expect(calls).toHaveLength(2);
    expect(calls[0].files).toEqual([tag('registration')]);
    expect(calls[1].files).toEqual([tag('timetable')]);
    // Neither call carries a promptType - there's only one prompt now, and
    // which normalizer applies is decided from documentKind in the
    // response, never from anything the client sent.
    expect(calls[0].promptType).toBeUndefined();
    expect(calls[1].promptType).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('throws a clear error when nothing at all was recognized (no timetable, no courses, no countdown)', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      other: fakeGeminiResponse({
        documentKind: 'other',
        classes: [],
        weeklySchedule: {},
        courses: []
      }),
      'other-2': fakeGeminiResponse({
        documentKind: 'other',
        classes: [],
        weeklySchedule: {},
        courses: []
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      processor.recognizeAndMerge([tag('other'), tag('other-2')], () => {})
    ).rejects.toThrow(/沒有偵測到課表/);
    vi.unstubAllGlobals();
  });

  it('builds a candidate from a registration file alone when no timetable photo was uploaded', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      registration: fakeRegistrationResponse([
        { subject: '西班牙語', teacher: '李忍堅', day: 1, periods: [6, 7] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge([tag('registration')], () => {});
    const subjects = Object.values(candidate.teacherDB).map(entry => entry[0]);
    expect(subjects).toEqual(['西班牙語']);
    vi.unstubAllGlobals();
  });

  it('builds a candidate from a single countdown-only photo with no timetable and no courses', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      other: fakeGeminiResponse({
        documentKind: 'other',
        classes: [],
        weeklySchedule: {},
        courses: [],
        countdownEvents: [{ name: '116 學測', startDate: '2027-01-22', endDate: '2027-01-24' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge([tag('other')], () => {});
    expect(candidate.countdownEvents.map(event => event.name)).toContain('116 學測');
    expect(Object.keys(candidate.teacherDB)).toEqual([]);
    vi.unstubAllGlobals();
  });

  // The whole point of the concurrency change: with 3 files, real wall-clock
  // time used to be roughly 3 sequential round trips; it should now be
  // roughly 1, because every request is in flight before any of them
  // resolve. Proven directly, not inferred from call order, since call
  // order alone can't tell a concurrent fan-out apart from a fast
  // sequential one.
  it('has every request in flight before any of them resolves, regardless of file count', async () => {
    const processor = new AIVisionProcessor();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return fakeTimetableResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    await processor.recognizeAndMerge([tag('a'), tag('b'), tag('c')], () => {});
    expect(maxInFlight).toBe(3);
    vi.unstubAllGlobals();
  });

  it('merges in file order even when a later file resolves before the timetable file', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.files[0].data === 'registration') {
        // Resolves immediately - deliberately faster than the timetable file below.
        return fakeRegistrationResponse([
          { subject: '西班牙語', teacher: '李忍堅', day: 1, periods: [1] }
        ]);
      }
      // The timetable file is the slow one this time.
      await new Promise(resolve => setTimeout(resolve, 20));
      return fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '多元選修', teacher: '' }],
        weeklySchedule: { 1: ['c1'] },
        bellTimes: [{ start: '08:00', end: '08:50' }]
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    // The registration file's course still lands in the final candidate,
    // correctly merged onto the timetable's schedule, even though its own
    // network request finished first.
    expect(candidate.teacherDB[candidate.weeklySchedule[1][0]][0]).toBe('西班牙語');
    vi.unstubAllGlobals();
  });

  it('a registration course overwrites whatever was at its day+period, even a non-generic subject', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '英語文', teacher: '楊嘉凌' }],
        weeklySchedule: { 2: [null, null, 'c1'] },
        bellTimes: Array.from({ length: 3 }, () => ({ start: '08:00', end: '08:50' }))
      }),
      registration: fakeRegistrationResponse([
        { subject: '社會經濟補給站 V', teacher: '于子芸', day: 2, periods: [3] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    const key = candidate.weeklySchedule[2][2];
    expect(candidate.teacherDB[key][0]).toBe('社會經濟補給站 V');
    vi.unstubAllGlobals();
  });

  it('merges countdownEvents from both the timetable and every registration file', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        countdownEvents: [{ name: '116 學測', startDate: '2027-01-22', endDate: '2027-01-24' }]
      }),
      registration: fakeRegistrationResponse(
        [],
        [{ name: '模擬考', startDate: '2027-03-01', endDate: '2027-03-02' }]
      )
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    expect(candidate.countdownEvents.map(event => event.name)).toEqual(
      expect.arrayContaining(['116 學測', '模擬考'])
    );
    vi.unstubAllGlobals();
  });

  it('drops a registration row with an unusable day or empty periods instead of throwing', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse(),
      registration: fakeRegistrationResponse([
        { subject: '好課程', teacher: '', day: 9, periods: [1] }, // day out of range
        { subject: '壞課程', teacher: '', day: 1, periods: [] }, // no periods
        { subject: '有效課程', teacher: '王老師', day: 3, periods: [2] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    const subjects = Object.values(candidate.teacherDB).map(entry => entry[0]);
    expect(subjects).toEqual(['有效課程']);
    vi.unstubAllGlobals();
  });

  it('drops a placeholder class from the class list once every slot it occupied is replaced', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      // "多元選修" (c1) shares both Monday period-6 and period-7 slots, the
      // same way one placeholder cell commonly spans several periods on a
      // real timetable.
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '多元選修', teacher: '' }],
        weeklySchedule: { 1: [null, null, null, null, null, 'c1', 'c1'] },
        bellTimes: Array.from({ length: 7 }, () => ({ start: '08:00', end: '08:50' }))
      }),
      registration: fakeRegistrationResponse([
        { subject: '西班牙語', teacher: '李忍堅', day: 1, periods: [6, 7] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    const subjects = Object.values(candidate.teacherDB).map(entry => entry[0]);
    expect(subjects).not.toContain('多元選修');
    expect(subjects).toEqual(['西班牙語']);
    vi.unstubAllGlobals();
  });

  it('keeps a placeholder class that still occupies an untouched slot elsewhere', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '彈性-充補', teacher: '' }],
        weeklySchedule: {
          2: [null, null, 'c1'],
          5: [null, null, null, null, null, null, 'c1']
        },
        bellTimes: Array.from({ length: 7 }, () => ({ start: '08:00', end: '08:50' }))
      }),
      // Only matches Tuesday period 3 - the Friday period 7 occurrence of
      // the same placeholder has no matching row.
      registration: fakeRegistrationResponse([
        { subject: '社會經濟補給站 V', teacher: '于子芸', day: 2, periods: [3] }
      ])
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('registration')],
      () => {}
    );
    const subjects = Object.values(candidate.teacherDB).map(entry => entry[0]);
    expect(subjects).toEqual(expect.arrayContaining(['彈性-充補', '社會經濟補給站 V']));
    // The still-unmatched Friday slot keeps pointing at the surviving placeholder.
    expect(candidate.teacherDB[candidate.weeklySchedule[5][6]][0]).toBe('彈性-充補');
    vi.unstubAllGlobals();
  });

  it('a second file that also looks like a timetable keeps its countdownEvents but is not merged as a schedule', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = routedFetchMock({
      timetable: fakeTimetableResponse({
        classes: [{ key: 'c1', subject: '國文', teacher: '陳老師' }],
        weeklySchedule: { 1: ['c1'] },
        bellTimes: [{ start: '08:00', end: '08:50' }]
      }),
      'timetable-2': fakeTimetableResponse({
        countdownEvents: [{ name: '校慶', startDate: '2027-05-01', endDate: '2027-05-01' }]
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const { candidate } = await processor.recognizeAndMerge(
      [tag('timetable'), tag('timetable-2')],
      () => {}
    );
    expect(candidate.weeklySchedule[1][0]).toBeTruthy();
    expect(candidate.countdownEvents.map(event => event.name)).toContain('校慶');
    vi.unstubAllGlobals();
  });
});

// Sent while the user is still choosing a file, so DNS/TLS/Worker startup
// are paid for out of time they were going to spend anyway rather than out
// of the wait after they press import.
describe('the proxy connection is warmed up before there is anything to send', () => {
  it('pings the proxy with a GET carrying no file content', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    warmUpGeminiProxy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(PROXY_URL);
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('does not ping again straight away, so reopening the picker is not a stream of pings', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    warmUpGeminiProxy(); // may or may not fire, depending on what ran before
    fetchMock.mockClear();
    warmUpGeminiProxy();
    warmUpGeminiProxy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('stays silent while offline, rather than failing in the background', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warmUpGeminiProxy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
});
