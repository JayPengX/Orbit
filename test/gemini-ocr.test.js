import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadApp } from './helpers/loadApp.js';
import { seedLocalStorage } from './helpers/fixtureData.js';

let AIVisionProcessor;
let DataValidator;
let ImportPreview;
let isGeminiProxyConfigured;
let estimateRecognitionSeconds;
let ETA_REVEAL_DELAY_MS;
let startEtaTimer;

beforeAll(async () => {
  seedLocalStorage();
  await loadApp();
  ({
    AIVisionProcessor,
    DataValidator,
    ImportPreview,
    estimateRecognitionSeconds,
    ETA_REVEAL_DELAY_MS,
    isGeminiProxyConfigured,
    startEtaTimer
  } = await import('../src/gemini-ocr.js'));
});

function fakeFiles() {
  return [{ mime_type: 'image/jpeg', data: 'AAAA' }];
}

describe('AIVisionProcessor.recognizeSchedule without a configured proxy', () => {
  it('is not using a proxy in this build', () => {
    expect(isGeminiProxyConfigured()).toBe(false);
  });

  it('refuses to run, without making any network request', async () => {
    const processor = new AIVisionProcessor();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(processor.recognizeSchedule(fakeFiles(), () => {})).rejects.toThrow(
      /AI 匯入功能尚未設定/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// The wait estimate is shown once and left alone (the matchmaking-queue
// pattern) rather than counted down, but it still has to be derived rather
// than fixed: each extra file is separately uploaded and separately read, so
// quoting one screenshot's figure for four of them would just be wrong on
// purpose.
describe('the recognition wait estimate scales with how much was submitted', () => {
  it('quotes a single base figure for one file', () => {
    expect(estimateRecognitionSeconds(1)).toBe(5);
  });

  it('adds time per additional file', () => {
    expect(estimateRecognitionSeconds(2)).toBeGreaterThan(estimateRecognitionSeconds(1));
    expect(estimateRecognitionSeconds(4)).toBeGreaterThan(estimateRecognitionSeconds(2));
  });

  it('never quotes less than the base figure, however it is called', () => {
    expect(estimateRecognitionSeconds(0)).toBe(estimateRecognitionSeconds(1));
  });
});

function fakeGeminiTextResponse(json) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] };
}

// normalizeAIOutput()'s two input shapes: the current one (a `classes`
// array, chosen because it's the only one Gemini's response_schema can
// actually constrain - see the Worker's own comment on why a free-form
// map can't be schema-described), and the older {key: [subject, teacher,
// location]} map a not-yet-redeployed Worker could still be sending during
// a rolling deploy. Both must produce the exact same internal shape, since
// nothing downstream of this parse knows or cares which one arrived.
describe('AIVisionProcessor.parseResponse turns the AI JSON into the app-internal candidate shape', () => {
  it('reads the current classes-array shape, linking weeklySchedule slots back through "key"', () => {
    const processor = new AIVisionProcessor();
    const candidate = processor.parseResponse(
      fakeGeminiTextResponse({
        documentKind: 'timetable',
        bellTimes: [{ start: '08:10', end: '09:00' }],
        classes: [
          { key: 'c1', subject: '國文', teacher: '陳老師', location: 'A101' },
          { key: 'c2', subject: '英文', teacher: '王老師', location: 'B202' }
        ],
        weeklySchedule: { 1: ['c1', 'c2'], 2: [], 3: [], 4: [], 5: [] }
      })
    );
    const teacherEntries = Object.values(candidate.teacherDB);
    expect(teacherEntries).toContainEqual(['國文', '陳老師', 'A101']);
    expect(teacherEntries).toContainEqual(['英文', '王老師', 'B202']);
    // The AI's own "c1"/"c2" keys never leak into the app's own data - it
    // generates its own internal ids, same as the legacy map shape always
    // did.
    expect(Object.keys(candidate.teacherDB).every(key => /^oc\d+$/.test(key))).toBe(true);
    expect(candidate.recognizedBlocks).toHaveLength(2);
    expect(candidate.recognizedBlocks.map(b => b.assignment.subject).sort()).toEqual([
      '國文',
      '英文'
    ]);
  });

  it('still reads the older {key: [subject, teacher, location]} map, for a Worker not yet redeployed', () => {
    const processor = new AIVisionProcessor();
    const candidate = processor.parseResponse(
      fakeGeminiTextResponse({
        documentKind: 'timetable',
        bellTimes: [{ start: '08:10', end: '09:00' }],
        teacherDB: { A: ['國文', '陳老師', 'A101'] },
        locationDB: { A: 'A101' },
        weeklySchedule: { 1: ['A'], 2: [], 3: [], 4: [], 5: [] }
      })
    );
    expect(Object.values(candidate.teacherDB)).toContainEqual(['國文', '陳老師', 'A101']);
    expect(candidate.recognizedBlocks).toHaveLength(1);
    expect(candidate.recognizedBlocks[0].assignment.subject).toBe('國文');
  });

  it('drops a class with no subject rather than inventing one', () => {
    const processor = new AIVisionProcessor();
    const candidate = processor.parseResponse(
      fakeGeminiTextResponse({
        documentKind: 'timetable',
        bellTimes: [],
        classes: [{ key: 'c1', subject: '', teacher: '陳老師', location: '' }],
        weeklySchedule: { 1: [], 2: [], 3: [], 4: [], 5: [] }
      })
    );
    expect(Object.keys(candidate.teacherDB)).toHaveLength(0);
  });
});

// Regression coverage for a preview bug: the countdown-events fold is the
// only one of the import preview's <details> sections that starts with
// `hidden` in its template (index.html) - every other fold starts open and
// is only ever *removed* when its data is empty. That means, uniquely among
// them, it also has to be explicitly un-hidden on the populated path -
// otherwise a photo the AI correctly read a countdown event out of still
// showed no trace of it in the preview. Declared before the ETA-timer
// describe below: that block's own afterEach wipes document.body, and this
// test relies on the real <template>s loadApp() put there.
describe('ImportPreview reveals the countdown-events fold when the AI actually found one', () => {
  function buildPreviewRoot() {
    const root = document.getElementById('ocr-import-result');
    root.hidden = true;
    return root;
  }
  function baseCandidate(overrides) {
    return {
      teacherDB: {},
      bellTimes: [],
      breakTimes: [],
      weeklySchedule: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
      recognizedBlocks: [],
      countdownEvents: [],
      ...overrides
    };
  }

  it('unhides and expands the countdown fold when a countdown event was recognized', () => {
    const root = buildPreviewRoot();
    const preview = new ImportPreview(root, () => {});
    const candidate = baseCandidate({
      countdownEvents: [{ name: '期末考', startDate: '2026-01-12', endDate: '2026-01-16' }]
    });
    preview.render(candidate, new DataValidator().validate(candidate));

    const fold = root.querySelector('[data-ocr-countdown-fold]');
    expect(fold).not.toBeNull();
    expect(fold.hidden).toBe(false);
    expect(fold.open).toBe(true);
    expect(root.querySelectorAll('[data-ocr-countdown-list] .countdown-event-name')).toHaveLength(1);
    expect(root.querySelector('.countdown-event-name').value).toBe('期末考');
    // Reuses the main countdown editor's own field layout
    // (.countdown-event-fields/.countdown-date-range in editor-core.js),
    // not the generic bell-time row layout - the start/end date pair needs
    // its own full-width row for both native date inputs to stay legible
    // on a narrow phone screen. A row still built from the old .bell-inputs
    // layout was cramping the two inputs onto one line together with the
    // name field, clipping the end date on an iPhone-width viewport.
    const dateRange = root.querySelector('.countdown-date-range');
    expect(dateRange).not.toBeNull();
    expect(dateRange.querySelector('.countdown-event-start').value).toBe('2026-01-12');
    expect(dateRange.querySelector('.countdown-event-end').value).toBe('2026-01-16');
  });

  it('removes the countdown fold entirely when nothing was recognized', () => {
    const root = buildPreviewRoot();
    const preview = new ImportPreview(root, () => {});
    const candidate = baseCandidate({
      teacherDB: { oc1: ['國文', '陳老師', ''] }
    });
    preview.render(candidate, new DataValidator().validate(candidate));

    expect(root.querySelector('[data-ocr-countdown-fold]')).toBeNull();
  });
});

// The matchmaking-queue pattern in full: a fixed estimate that never
// changes, plus a separate, quieter "time in queue" clock that does. They
// answer different questions ("when will it be done" vs. "is this still
// alive") and must not be conflated back into one shifting number - that
// was the whole problem with the countdown this replaced.
describe('startEtaTimer runs a static estimate and a separate ticking elapsed clock', () => {
  function buildEtaElement() {
    const el = document.createElement('div');
    el.hidden = true;
    el.innerHTML =
      '<span id="ocr-import-eta-estimate"></span>' + '<span id="ocr-import-eta-elapsed"></span>';
    document.body.appendChild(el);
    return el;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('stays hidden and empty until the reveal delay passes - never a flash for a fast import', () => {
    const el = buildEtaElement();
    startEtaTimer(el, 1);
    expect(el.hidden).toBe(true);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toBe('');

    vi.advanceTimersByTime(ETA_REVEAL_DELAY_MS - 1);
    expect(el.hidden).toBe(true);

    vi.advanceTimersByTime(1);
    expect(el.hidden).toBe(false);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toMatch(/預估等待時間/);
  });

  it('never reveals at all when stopped before the reveal delay - the actual fix for the flash', () => {
    const el = buildEtaElement();
    const stop = startEtaTimer(el, 1);
    vi.advanceTimersByTime(ETA_REVEAL_DELAY_MS - 1);
    stop();

    // Still hidden the whole time, then stopped - never visible for even one
    // frame, rather than flashing on and immediately back off.
    expect(el.hidden).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(el.hidden).toBe(true);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toBe('');
  });

  it('starts the elapsed clock at 0 once revealed and ticks it every second, without touching the estimate', () => {
    const el = buildEtaElement();
    startEtaTimer(el, 1);
    vi.advanceTimersByTime(ETA_REVEAL_DELAY_MS);
    const estimateText = el.querySelector('#ocr-import-eta-estimate').textContent;
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('已等待 0 秒');

    vi.advanceTimersByTime(3000);
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('已等待 3 秒');
    // Well under this file count's overrun threshold - the estimate itself
    // must still read exactly as it did at the start.
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toBe(estimateText);
  });

  it('switches the estimate to the overrun message once past threshold, and the clock keeps counting through it', () => {
    const el = buildEtaElement();
    startEtaTimer(el, 1); // 5s estimate, 1.8x overrun -> 9s
    vi.advanceTimersByTime(9000);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toMatch(/比預估久一點/);
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('已等待 9 秒');

    vi.advanceTimersByTime(2000);
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('已等待 11 秒');
  });

  it('an overrun this long reveals the element even if it somehow never had before', () => {
    const el = buildEtaElement();
    startEtaTimer(el, 1);
    vi.advanceTimersByTime(9000); // past both the reveal delay and the overrun threshold
    expect(el.hidden).toBe(false);
  });

  it('stopping clears both spans, re-hides the element, and cancels every pending timer', () => {
    const el = buildEtaElement();
    const stop = startEtaTimer(el, 1);
    vi.advanceTimersByTime(2000);
    stop();

    expect(el.hidden).toBe(true);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toBe('');
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('');

    // No lingering interval/timeout re-populating either span after stop().
    vi.advanceTimersByTime(10000);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toBe('');
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('');
  });

  it('a higher file count raises the estimate, which the elapsed clock has no opinion on either way', () => {
    const el = buildEtaElement();
    startEtaTimer(el, 4);
    vi.advanceTimersByTime(ETA_REVEAL_DELAY_MS);
    expect(el.querySelector('#ocr-import-eta-estimate').textContent).toMatch(
      new RegExp(String(estimateRecognitionSeconds(4)))
    );
    expect(el.querySelector('#ocr-import-eta-elapsed').textContent).toBe('已等待 0 秒');
  });
});
