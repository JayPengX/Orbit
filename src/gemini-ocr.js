// ---- src/gemini-ocr.js ----
// Photo -> canvas preprocessing and the Gemini API call/response parsing
// for the optional AI schedule-photo import.
import { WEEKDAYS_INDEX_ORDER, WEEKDAY_LABELS } from './constants.js';
import { state } from './state.js';
import { normalizeCountdownEvents } from './data.js';
import {
  beginEditorImport,
  normalizeSettingsData,
  settingsDataForExport
} from './editor-backup.js';
import { editorTimeToMinutes, formatClassLabel } from './editor-core.js';
import { updateTeacherCardAvatar } from './editor-teachers.js';
import { isSyncViewer } from './sync.js';

// ---- js/gemini-ocr.js ----
// What one submitted file may be. The three "decodable" image types are the
// ones every browser can draw into a canvas, which is what lets them be
// downscaled and re-encoded before upload (see encodeCanvasAsJpeg) - by far
// the biggest lever on how long the request takes, since the upload is
// often the slowest single leg of it on a phone.
//
// HEIC/HEIF and PDF are accepted too but deliberately never decoded here:
// only Safari can put a HEIC in a canvas at all, and rasterizing a PDF would
// mean shipping a PDF renderer to every user for a feature most of them use
// once. Gemini reads both formats natively, so those are forwarded as-is,
// size-capped instead of downscaled.
const DECODABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PASSTHROUGH_TYPES = ['image/heic', 'image/heif', 'application/pdf'];
// Mirrors the Worker's own MAX_FILE_BASE64_LENGTH, checked here first so an
// over-large file is refused before it is uploaded rather than after.
// base64 is 4 bytes per 3, hence the ratio.
const MAX_PASSTHROUGH_BYTES = Math.floor((10_000_000 * 3) / 4);
const MAX_FILES = 6;

function fileKind(file) {
  const type = (file?.type || '').toLowerCase();
  if (DECODABLE_IMAGE_TYPES.includes(type)) return 'decodable';
  if (PASSTHROUGH_TYPES.includes(type)) return 'passthrough';
  // An iPhone share sheet and a few Android file pickers hand over a HEIC
  // with an empty or generic MIME type, so fall back to the extension
  // before rejecting something Gemini would have read perfectly well.
  if (/\.(heic|heif)$/i.test(file?.name || '')) return 'passthrough';
  if (/\.pdf$/i.test(file?.name || '')) return 'passthrough';
  return '';
}
function passthroughMimeType(file) {
  const type = (file?.type || '').toLowerCase();
  if (PASSTHROUGH_TYPES.includes(type)) return type;
  if (/\.pdf$/i.test(file?.name || '')) return 'application/pdf';
  return 'image/heic';
}

// Loads a chosen photo into a plain canvas at its native colour (no destructive filtering),
// then hands back the source itself for anything the browser can't decode.
class FilePreprocessor {
  async process(file) {
    if (!(file instanceof Blob)) throw new Error('請選擇一個檔案。');
    const kind = fileKind(file);
    if (!kind)
      throw new Error(
        `不支援的檔案格式：${file.name || '未命名檔案'}（可用 JPG／PNG／HEIC／PDF）。`
      );
    if (kind === 'passthrough') {
      if (file.size > MAX_PASSTHROUGH_BYTES)
        throw new Error(`檔案太大：${file.name || '未命名檔案'}，請改用較小的檔案。`);
      return { kind, file, name: file.name || '', mimeType: passthroughMimeType(file) };
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('圖片載入失敗，請換一張再試。'));
        element.src = url;
      });
      if (image.naturalWidth < 240 || image.naturalHeight < 160)
        throw new Error('圖片解析度過低，請換一張更清楚的照片。');
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return { kind, file, name: file.name || '', canvas, mimeType: 'image/jpeg' };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Downscales a canvas in place so the JPEG payload sent to the AI stays small; a no-op if
// the canvas is already within bounds.
function capCanvasDimension(canvas, maxDimension = UPLOAD_MAX_DIMENSION) {
  const scale = Math.min(1, maxDimension / Math.max(canvas.width, canvas.height));
  if (scale >= 1) return canvas;
  const scaled = document.createElement('canvas');
  scaled.width = Math.max(1, Math.round(canvas.width * scale));
  scaled.height = Math.max(1, Math.round(canvas.height * scale));
  scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled;
}

// 1280px at quality 0.72, down from 1600px at 0.9. A timetable's text is
// still comfortably legible at this size (it is a grid of large-ish
// characters, not fine print), and the file it produces is roughly a third
// of the size - which comes straight off the upload, the leg of this
// request that most often dominates on a phone. Sending several files at
// once makes that saving matter several times over.
const UPLOAD_MAX_DIMENSION = 1280;
const UPLOAD_JPEG_QUALITY = 0.72;

// canvas.toBlob + FileReader rather than canvas.toDataURL. toDataURL runs
// the JPEG encoder synchronously on the main thread and hands back a string
// the whole document has to hold at once; on a large photo that is a
// visible freeze right at the moment the user pressed the button, which
// reads as the app having hung rather than as work in progress. Both steps
// here are asynchronous, so the UI keeps painting its status line
// throughout.
function encodeCanvasAsJpeg(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      // jsdom and very old browsers - fall back to the synchronous path
      // rather than failing outright.
      resolve(canvas.toDataURL('image/jpeg', UPLOAD_JPEG_QUALITY).replace(/^data:[^,]*,/, ''));
      return;
    }
    canvas.toBlob(
      blob => {
        if (!blob) {
          reject(new Error('圖片編碼失敗，請換一張再試。'));
          return;
        }
        resolve(blobToBase64(blob));
      },
      'image/jpeg',
      UPLOAD_JPEG_QUALITY
    );
  });
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('檔案讀取失敗，請再試一次。'));
    reader.readAsDataURL(blob);
  });
}
// One submitted file -> one Gemini inline_data part.
async function encodeSourceForUpload(source) {
  if (source.kind === 'passthrough') {
    return { mime_type: source.mimeType, data: await blobToBase64(source.file) };
  }
  return {
    mime_type: 'image/jpeg',
    data: await encodeCanvasAsJpeg(capCanvasDimension(source.canvas))
  };
}

// True while a Gemini OCR request is in flight; the editor sheet checks this to block
// closing mid-recognition (closing would abandon the in-progress import silently).

// AI import always goes through this server-side proxy (build-time env var, see
// README) - the proxy holds the real Gemini key (Secret Manager, never shipped to
// the client) and forwards the request, so users never need a Gemini key of their
// own. A fork built from source without the proxy deployed just leaves the feature
// unavailable (see isGeminiProxyConfigured's callers) rather than asking for a key.
// `?.` matters here: import.meta.env only exists once Vite has processed this
// module - if these unbuilt source files ever get served directly (e.g. a
// Pages misconfiguration bypassing the build), a plain `.env.X` throws at
// module-evaluation time and silently aborts the whole boot chain before it
// reaches the code that clears the boot spinner.
const GEMINI_PROXY_URL = (import.meta.env?.VITE_ORBIT_GEMINI_PROXY_URL || '').trim();
function isGeminiProxyConfigured() {
  return !!GEMINI_PROXY_URL;
}

// Gives each AIVisionProcessor.callGemini invocation its own console.time
// label suffix - see that method for why concurrent calls need it.
let nextGeminiCallId = 0;

// Fired the moment the user reaches for the file picker, long before there
// is anything to send: it pays the DNS lookup, TLS handshake and the
// Worker's own first-request initialization while the user is still
// choosing a file, instead of on the critical path afterwards. The Worker
// answers a GET here with a bare {ok:true} and charges nothing against the
// rate limit (see handleGeminiRequest).
//
// Best-effort in every direction - a failure means the real request simply
// pays those costs itself, which is exactly what used to happen every time,
// so there is nothing to report and nothing to retry. Rate-limited to one
// per minute so repeatedly opening and cancelling the picker can't turn
// into a stream of pings.
const WARM_UP_INTERVAL_MS = 60_000;
let lastWarmUpAt = 0;
function warmUpGeminiProxy() {
  if (!GEMINI_PROXY_URL || !navigator.onLine) return;
  const now = Date.now();
  if (now - lastWarmUpAt < WARM_UP_INTERVAL_MS) return;
  lastWarmUpAt = now;
  fetch(GEMINI_PROXY_URL, { method: 'GET', cache: 'no-store', keepalive: true }).catch(() => {
    // Never surfaced: this is an optimization, not a precondition.
  });
}

// Shifts a YYYY-MM-DD date forward by whole years, the way a plain
// {year, month, day} +N-years bump would - used only to correct an
// already-elapsed AI-recognized date, so there's no real-world "the 29th of
// February N years from now" case worth handling more carefully than
// JS Date's own end-of-month rollover.
function shiftDateYears(dateStr, deltaYears) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const shifted = new Date(year + deltaYears, month - 1, day);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}
function todayIsoLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
// GEMINI_PROMPT (see the Worker) asks the model to infer a sensible year for
// a date shown without one, using "today" as an anchor - but that's still a
// model guess, not a guarantee, and a wrong guess reliably lands one or more
// whole years short rather than off by a few days. Belt-and-suspenders: an
// event that has already fully ended by today almost certainly means the
// year was mis-guessed (nobody photographs a school poster to import an
// already-over exam as their next countdown), so roll it forward to the
// nearest year that makes it current or upcoming instead of leaving a
// "countdown" pointed at the past. A genuinely already-over event a user
// deliberately keeps around (typed in by hand, or restored from a backup)
// never passes through this - it's only ever applied to freshly AI-parsed
// dates, both here and in normalizeRegistrationOutput.
function rollCountdownEventsToFuture(events, todayIso = todayIsoLocal()) {
  return events.map(event => {
    let { startDate, endDate } = event;
    let delta = 0;
    // Bounded rather than an unconditional while(true): a malformed date
    // (already guarded against upstream by normalizeCountdownEvent, but
    // cheap insurance) must never spin this forever.
    while (endDate < todayIso && delta < 50) {
      delta += 1;
      startDate = shiftDateYears(event.startDate, delta);
      endDate = shiftDateYears(event.endDate, delta);
    }
    return delta ? { ...event, startDate, endDate } : event;
  });
}
// AI import's own default order (see updateExamCountdown, which otherwise
// just shows whichever event happens to be first in the stored array): the
// soonest event first. Deliberately scoped to freshly-recognized events
// only, not the shared data.js normalizeCountdownEvents used for manual
// edits and backups - describeSettingsDiff relies on that one preserving
// whatever order the caller gave it to detect a pure reorder (see
// editor-backup-diff.test.js), which a global sort would silently defeat.
function sortCountdownEventsByDate(events) {
  return [...events].sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
  );
}
function finalizeAiCountdownEvents(rawEvents) {
  return sortCountdownEventsByDate(
    rollCountdownEventsToFuture(normalizeCountdownEvents(rawEvents))
  );
}

// Shared by normalizeAIOutput and mergeRegistrationIntoCandidate - both end
// up with a final {weeklySchedule, teacherDB} pair that recognizedBlocks
// (the shape the preview UI reads) needs rebuilt from scratch afterward.
function computeRecognizedBlocks(weeklySchedule, teacherDB) {
  const recognizedBlocks = [];
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    const daySchedule = weeklySchedule[day] || [];
    daySchedule.forEach((code, period) => {
      if (code && teacherDB[code]) {
        recognizedBlocks.push({
          id: `${period}:${day}`,
          day,
          period,
          assignment: { key: code, subject: teacherDB[code][0], teacher: teacherDB[code][1] },
          assignmentStatus: 'assigned',
          confidence: 99
        });
      }
    });
  });
  return recognizedBlocks;
}

class AIVisionProcessor {
  constructor() {
    // Fastest first, most capable last - the reverse of how this list used
    // to be ordered. The old order optimized purely for accuracy on the
    // first attempt, and the flash-lite model at the end was only ever
    // reached if every model above it was returning HTTP errors, which
    // essentially never happens; in practice every user paid the largest
    // model's latency on every import.
    //
    // The order is safe to flip because the fallback below is no longer
    // driven by transport errors alone: a response that comes back
    // structurally unusable (see the `validate` option) also escalates to
    // the next model. So the common case - a clear, ordinary timetable - is
    // answered by the quickest model, and a photo the quick model can't
    // make sense of still ends up in front of the strongest one, at the
    // cost of one extra round trip in exactly the cases that need it.
    //
    // gemini-2.5-flash, which used to close out this list, is gone rather
    // than demoted: confirmed live against the real API that it now 404s
    // for every caller ("no longer available to new users"), so it would
    // only ever waste a retry.
    //
    // gemini-3.6-flash is gone too, for a worse reason: run against this
    // feature's real prompt+schema+multi-file shape, it reproduced two
    // separate failures rather than a one-off - a single-file request that
    // burned 94 seconds before coming back truncated (MAX_TOKENS) and
    // unusable, and a multi-file request that came back fast but only
    // recognized 1 of 12 classes. A fallback that can silently cost 94
    // seconds and still fail is worse than no fallback there at all.
    //
    // gemini-3.8-flash was tried as a replacement and rejected for a
    // different reason: three attempts with backoff all came back 503
    // "high demand" - not a correctness problem, just not reliably
    // available yet.
    //
    // Must match GEMINI_ALLOWED_MODELS in cloudflare-worker/orbit-worker.js
    // exactly. Fastest-first is safe for every call this class makes now:
    // each one is single-file and single-purpose (see callGemini) after the
    // combined "read both documents and cross-reference them" request was
    // dropped - the cheap model tested fine on that narrower kind of task
    // even when it badly scrambled the old combined one (see
    // recognizeAndMerge/mergeRegistrationIntoCandidate for what replaced it).
    this.geminiModels = ['gemini-3.5-flash-lite', 'gemini-3.7-flash'];
  }

  // Low-level call shared by every request this class makes: the one fixed
  // server-side prompt (cloudflare-worker/orbit-worker.js's GEMINI_PROMPT)
  // against exactly the files given. That prompt is self-classifying now -
  // every file gets the same request regardless of what it turns out to
  // contain (see recognizeAndMerge for why upload order can no longer be
  // trusted to mean anything). `validate` is optional and, when given,
  // decides whether a parsed response is good enough to stop at or worth
  // escalating to the next model for.
  async callGemini(files, onProgress, { validate } = {}) {
    // recognizeAndMerge runs several callGemini calls concurrently (see its
    // own comment) - which can easily mean two calls sharing the same model
    // at once (e.g. two files both trying the cheap model first).
    // console.time/timeEnd key on the label alone, so without a
    // per-invocation id here, concurrent calls would stomp on each other's
    // timers instead of each reporting its own duration.
    const callId = nextGeminiCallId++;
    const report = message => {
      try {
        onProgress?.(message);
      } catch {
        /* ignore progress callback errors */
      }
    };
    if (!GEMINI_PROXY_URL) throw new Error('AI 匯入功能尚未設定，請聯絡課表管理者。');
    if (!navigator.onLine) throw new Error('目前沒有網路連線，AI 匯入暫時無法使用。');
    const parts = Array.isArray(files) ? files : [files];
    if (!parts.length) throw new Error('請先選擇檔案。');

    // The prompt text and generation config are NOT sent from here - the
    // proxy (cloudflare-worker/orbit-worker.js's /gemini path) owns both and
    // builds the full Gemini request itself from just {model, files}. That's
    // deliberate: it means the proxy can only ever be used to run this app's
    // own fixed, hardcoded prompt against submitted files, never as a
    // generic pass-through for arbitrary prompts - see README's security
    // notes on the AI proxy.
    let lastError = null;
    let lastRejected = null;
    for (const model of this.geminiModels) {
      report(`正在請求 AI 模型（${model}）分析課表…`);
      const requestBody = JSON.stringify({ model, files: parts });
      let response;
      // Split into three marks rather than one so a slow import can be
      // attributed instead of guessed at: if GeminiCall is quick and
      // GeminiParse is slow, the page is stalling on this file's own
      // parsing, not on the network.
      const callLabel = `GeminiCall:${callId}:${model}`;
      console.time(callLabel);
      try {
        response = await fetch(GEMINI_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody
        });
      } catch (networkError) {
        lastError = new Error(`無法連線至 AI 服務：${networkError.message}`);
        report(`連線失敗，準備改用下一個模型…`);
        continue;
      } finally {
        console.timeEnd(callLabel);
      }
      if (response.ok) {
        report(`AI 已回應（使用模型：${model}），正在解析辨識結果…`);
        const parseLabel = `GeminiParse:${callId}:${model}`;
        console.time(parseLabel);
        let candidate;
        try {
          candidate = this.parseResponse(await response.json());
        } finally {
          console.timeEnd(parseLabel);
        }
        const verdict = validate ? validate(candidate) : { valid: true };
        if (verdict.valid) return { candidate, modelUsed: model };
        // Structurally unusable rather than merely imperfect - worth one
        // more round trip against a stronger model, but the result is kept
        // so the last model's attempt is still what the user sees (with its
        // own validation errors) if every model comes back the same way.
        lastRejected = { candidate, modelUsed: model };
        report(`模型（${model}）的結果不完整，改用更強的模型再試一次…`);
        continue;
      }

      const errorJson = await response.json().catch(() => ({}));
      const message = errorJson.error?.message || response.statusText;
      if (response.status === 400 && /API_KEY_INVALID/.test(message)) {
        throw new Error('AI 服務目前無法使用，請稍後再試。');
      }
      // Google's Gemini API rejects the request based on the calling IP's
      // geolocation - here, the Cloudflare Worker's own egress IP, not the
      // end user's. Cloudflare can route the Worker's outbound call through
      // any of its edge colos, and some of those colos geolocate to a
      // country Google blocks outright, so this can surface even for a user
      // whose real location is fully supported. Every model in the fallback
      // list shares that same outbound path, so escalating to the next one
      // would just fail the same way - this throws immediately instead of
      // burning through the whole list first.
      if (response.status === 400 && /User location is not supported/i.test(message)) {
        throw new Error(
          'AI 服務暫時因伺服器所在地區限制而無法使用，這通常只是暫時性的網路路由問題，請稍後再試一次。'
        );
      }
      if (response.status === 429 && /請求過於頻繁/.test(message)) {
        throw new Error(message);
      }
      // Retryable on the next model: retired/unknown model (404), overloaded (503), rate-limited (429), or transient server errors (5xx).
      lastError = new Error(`AI 辨識請求失敗（${response.status}）：${message}`);
      const retryableStatus =
        response.status === 404 ||
        response.status === 429 ||
        response.status === 503 ||
        response.status >= 500;
      if (!retryableStatus) throw lastError;
      report(`模型（${model}）暫時無法使用（${response.status}：${message}），準備改用下一個模型…`);
    }

    if (lastRejected) return lastRejected;
    throw lastError || new Error('AI 辨識請求失敗：沒有可用的模型。');
  }

  // `files` is the encoded {mime_type, data} part list (see
  // encodeSourceForUpload) - kept as its own method (rather than inlining
  // callGemini at every call site) since it's still the entire flow for a
  // single-file import.
  recognizeSchedule(files, onProgress, opts) {
    return this.callGemini(files, onProgress, opts);
  }

  parseResponse(responseData) {
    const rawText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 沒有回傳任何課表內容，請換一張更清楚的照片再試。');
    // Ignore any surrounding features unrelated to the JSON itself (markdown fences, stray
    // commentary before/after) — isolate just the outermost {...} object and read that.
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
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      throw new Error(`AI 回傳的內容不是有效的 JSON：${error.message}`, { cause: error });
    }
    // "documentKind" is the model's own answer to "what is this file" (see
    // GEMINI_PROMPT) - read back here to pick the matching normalizer, and
    // carried onto the result so recognizeAndMerge can route each file's
    // outcome correctly without re-inspecting the raw response. Anything
    // that isn't exactly "timetable" (including "other", and any unexpected
    // value a model might emit despite the schema's enum) goes through the
    // registration-shaped normalizer, which handles an empty courses array
    // as the ordinary, correct outcome for a non-course file.
    const isTimetable = parsed?.documentKind === 'timetable';
    const candidate = isTimetable
      ? this.normalizeAIOutput(parsed)
      : this.normalizeRegistrationOutput(parsed);
    candidate.documentKind = isTimetable ? 'timetable' : (parsed?.documentKind ?? 'other');
    return candidate;
  }

  // Normalizes the "registration" (or "other") half of GEMINI_PROMPT's
  // output into a small, self contained shape - never the app's internal
  // teacherDB/weeklySchedule shape, since these rows don't know anything
  // about the primary timetable's existing classes or slots.
  // mergeRegistrationIntoCandidate is what actually folds this into a real
  // candidate.
  normalizeRegistrationOutput(aiResult) {
    const courses = Array.isArray(aiResult?.courses)
      ? aiResult.courses
          .map(entry => {
            if (!entry || typeof entry !== 'object') return null;
            const subject = String(entry.subject || '').trim();
            const day = Number(entry.day);
            const periods = Array.isArray(entry.periods)
              ? [...new Set(entry.periods.map(Number).filter(p => Number.isInteger(p) && p > 0))]
              : [];
            if (!subject || !Number.isInteger(day) || day < 0 || day > 6 || !periods.length) {
              return null;
            }
            return {
              subject,
              teacher: String(entry.teacher || '').trim(),
              location: String(entry.location || '').trim(),
              day,
              periods
            };
          })
          .filter(Boolean)
      : [];
    return {
      courses,
      countdownEvents: Array.isArray(aiResult?.countdownEvents)
        ? finalizeAiCountdownEvents(aiResult.countdownEvents)
        : []
    };
  }

  normalizeAIOutput(aiResult) {
    const normalizeTime = value => {
      const match = String(value || '')
        .trim()
        .replace(/[：。．]/g, ':')
        .match(/^(\d{1,2})\s*:\s*(\d{2})$/);
      if (!match) return '';
      const hours = Number(match[1]),
        minutes = Number(match[2]);
      return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
        ? `${String(hours).padStart(2, '0')}:${match[2]}`
        : '';
    };
    const bellTimes = [];
    if (Array.isArray(aiResult.bellTimes)) {
      aiResult.bellTimes.forEach(item => {
        if ((Array.isArray(item) && item.length >= 2) || (item && typeof item === 'object')) {
          const s = normalizeTime(Array.isArray(item) ? item[0] : item.start);
          const e = normalizeTime(Array.isArray(item) ? item[1] : item.end);
          if (s && e) bellTimes.push([s, e]);
        }
      });
    }

    const breakTimes = [];
    if (Array.isArray(aiResult.breakTimes)) {
      aiResult.breakTimes.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const name = String(item.name || '').trim() || '午休';
        const start = normalizeTime(item.start);
        const end = normalizeTime(item.end);
        if (start && end) breakTimes.push({ name, start, end });
      });
    }

    // Keep the AI parser aligned to the current schema: direct property access only.
    // The AI's own keys are only used to cross-reference weeklySchedule entries
    // during this parse - the app never shows or edits a class's key, so the
    // internal id generated here doesn't need to be human-readable.
    //
    // `classes` (an array of {key, subject, teacher, location}) is the current
    // shape, chosen specifically so it can be described in the Worker's
    // response_schema: Gemini's response_schema is the OpenAPI-3.0 subset
    // Schema object, which has no `additionalProperties` - confirmed against
    // the real API, not just the docs, a request that tried to schema-constrain
    // a free-form {key: [subject, teacher, location]} map (the older shape,
    // still accepted below) was rejected outright with a 400, and dropping the
    // constraint to a bare `type: 'object'` made the model leave it empty far
    // too often (nothing in an unconstrained nested object tells the model
    // it's still expected to fill it in). An array of fully-typed objects has
    // no such problem and is what the Worker's prompt now actually asks for;
    // the older map shape is still read here only so a client running ahead
    // of a not-yet-redeployed Worker (or vice versa, during a rolling deploy)
    // degrades to parsing correctly instead of silently landing an empty
    // course list.
    const teacherDB = {};
    const locationDB = {};
    const keyMap = {};
    // Keyed by subject+teacher - the model is asked for one classes
    // entry per distinct subject, but sometimes still emits the same
    // subject+teacher twice under two different keys (seen most often for
    // a day column read in a separate pass, e.g. one whose Friday session
    // got recognized apart from the rest of the week). Reusing the first
    // entry's key for a later duplicate keeps that from landing as a
    // visible second "same subject" row in the imported class list.
    const classKeyByIdentity = new Map();
    let courseCounter = 1;
    // Does NOT fall subject back to dbKey itself - that would have been
    // reasonable for the legacy map shape (its key is typically the
    // subject's own Chinese name already, e.g. teacherDB's "國文"), but
    // would be wrong for the classes-array shape, where "key" is an opaque
    // id like "c1" the model invented purely to link a weeklySchedule slot
    // back to this entry (see the Worker's prompt) - never a real subject
    // name. Callers that want the old fallback pass it in explicitly.
    const addClass = (dbKey, subject, teacher, location) => {
      subject = String(subject || '').trim();
      if (!subject) return;
      teacher = String(teacher || '')
        .trim()
        .replace(/／/g, '/');
      location = String(location || '')
        .trim()
        .replace(/／/g, '/');
      subject = subject.replace(/／/g, '/');
      const cleanDbKey = String(dbKey || '')
        .trim()
        .replace(/／/g, '/');
      const identity = `${subject}::${teacher}`;
      const existingKey = classKeyByIdentity.get(identity);
      if (existingKey) {
        keyMap[cleanDbKey] = existingKey;
        if (location && !locationDB[existingKey]) locationDB[existingKey] = location;
        return;
      }
      const key = `oc${courseCounter++}`;
      keyMap[cleanDbKey] = key;
      teacherDB[key] = [subject, teacher, location];
      locationDB[key] = location;
      classKeyByIdentity.set(identity, key);
    };
    if (Array.isArray(aiResult.classes)) {
      aiResult.classes.forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        addClass(entry.key, entry.subject, entry.teacher, entry.location);
      });
    } else if (aiResult.teacherDB && typeof aiResult.teacherDB === 'object') {
      Object.entries(aiResult.teacherDB).forEach(([dbKey, val]) => {
        if (Array.isArray(val)) addClass(dbKey, val[0] || dbKey, val[1], val[2]);
        else if (val && typeof val === 'object')
          addClass(dbKey, val.subject || dbKey, val.teacher, val.location);
        else addClass(dbKey, val || dbKey, '', '');
      });
      if (aiResult.locationDB && typeof aiResult.locationDB === 'object') {
        Object.entries(aiResult.locationDB).forEach(([dbKey, value]) => {
          const key =
            keyMap[
              String(dbKey || '')
                .trim()
                .replace(/／/g, '/')
            ];
          if (key) locationDB[key] = String(value || '').trim();
        });
      }
    }

    const weeklySchedule = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    const rawWeekly = aiResult.weeklySchedule ?? {};
    WEEKDAYS_INDEX_ORDER.forEach(dayKey => {
      const dayArr = rawWeekly[dayKey] ?? rawWeekly[String(dayKey)];
      if (!Array.isArray(dayArr)) return;
      weeklySchedule[dayKey] = dayArr.map(item => {
        if (!item) return '';
        const rawItemKey = (
          typeof item === 'string' ? item.trim() : String(item.key || '').trim()
        ).replace(/／/g, '/');
        return keyMap[rawItemKey] || '';
      });
    });

    const candidate = {
      teacherDB,
      teacherOrder: Object.keys(teacherDB),
      locationDB,
      weeklySchedule,
      bellTimes,
      breakTimes,
      reverseWeek: aiResult.reverseWeek === true,
      recognizedBlocks: computeRecognizedBlocks(weeklySchedule, teacherDB)
    };
    candidate.countdownEvents = Array.isArray(aiResult.countdownEvents)
      ? finalizeAiCountdownEvents(aiResult.countdownEvents)
      : [];
    return candidate;
  }

  // Folds one normalizeRegistrationOutput() result into an already-normalized
  // timetable candidate: each course row overwrites whatever was at its
  // exact day+period, whether that was a generic placeholder or nothing at
  // all - a registration record is authoritative about what a student is
  // actually enrolled in for that slot, so there's no reason to second-guess
  // it the way the old combined-request prompt had to (it couldn't tell a
  // genuinely-decoded row from a misread one, so it hedged by only ever
  // touching cells that already looked generic). This is pure data
  // rearrangement - no model call, no room for the cross-file scrambling
  // that motivated splitting these into two requests in the first place.
  mergeRegistrationIntoCandidate(candidate, registration) {
    const teacherDB = { ...candidate.teacherDB };
    const locationDB = { ...candidate.locationDB };
    const weeklySchedule = {};
    WEEKDAYS_INDEX_ORDER.forEach(day => {
      weeklySchedule[day] = [...(candidate.weeklySchedule[day] || [])];
    });
    let counter = 1;
    // "rc" (registration class), never "oc" - normalizeAIOutput's own
    // per-parse counter starts back at 1 too, and these two candidates are
    // merged together, so distinct prefixes are the only thing stopping a
    // silent key collision that would overwrite an unrelated class.
    //
    // A registration document often lists one row per day a course meets
    // (e.g. separate Monday/Wednesday/Friday rows for the same course)
    // rather than one row naming every period at once - reuse the same key
    // for every row that shares a subject+teacher instead of giving each
    // day its own class entry, or the course would show up as several
    // duplicate-looking "same subject" rows in the imported class list.
    const keyByIdentity = new Map();
    registration.courses.forEach(course => {
      const identity = `${course.subject}::${course.teacher}`;
      let key = keyByIdentity.get(identity);
      if (!key) {
        key = `rc${counter++}`;
        keyByIdentity.set(identity, key);
        teacherDB[key] = [course.subject, course.teacher, course.location];
        locationDB[key] = course.location;
      } else if (course.location && !locationDB[key]) {
        locationDB[key] = course.location;
      }
      const dayArr = weeklySchedule[course.day] || (weeklySchedule[course.day] = []);
      course.periods.forEach(period => {
        const index = period - 1;
        while (dayArr.length <= index) dayArr.push('');
        dayArr[index] = key;
      });
    });

    // A placeholder this merge just replaced in every period it occupied
    // (e.g. "多元選修" shared across two slots, both now overwritten) would
    // otherwise survive as a dangling, unused entry in the class list - the
    // whole point of replacing it was to remove it, not just to stop
    // pointing at it. Keep only classes still referenced somewhere in the
    // final weeklySchedule; a placeholder still occupying an untouched slot
    // elsewhere (no registration row matched it) correctly survives.
    const referencedKeys = new Set();
    WEEKDAYS_INDEX_ORDER.forEach(day => {
      (weeklySchedule[day] || []).forEach(key => {
        if (key) referencedKeys.add(key);
      });
    });
    const prunedTeacherDB = {};
    const prunedLocationDB = {};
    referencedKeys.forEach(key => {
      if (teacherDB[key]) prunedTeacherDB[key] = teacherDB[key];
      if (key in locationDB) prunedLocationDB[key] = locationDB[key];
    });

    return {
      ...candidate,
      teacherDB: prunedTeacherDB,
      teacherOrder: Object.keys(prunedTeacherDB),
      locationDB: prunedLocationDB,
      weeklySchedule,
      // Both sides already went through finalizeAiCountdownEvents on their
      // own, so this only needs to re-sort the combined list back into
      // closest-first order - concatenating two already-sorted lists isn't
      // itself sorted.
      countdownEvents: sortCountdownEventsByDate(
        normalizeCountdownEvents([
          ...(candidate.countdownEvents || []),
          ...(registration.countdownEvents || [])
        ])
      ),
      recognizedBlocks: computeRecognizedBlocks(weeklySchedule, prunedTeacherDB)
    };
  }

  // The entry point mountOCRImporter actually calls. A single file is just
  // recognizeSchedule - unchanged, one request, cheapest model first. Two or
  // more is the timetable-plus-registration-document case this whole split
  // exists for: the primary file alone (never combined with the others - see
  // GEMINI_PROMPT's comment for what that combined request used to cost, in
  // both quota and correctness), then every remaining file as its own
  // registration request, merged in one at a time so a later file's rows can
  // still override an earlier one's at the same slot, same "later file wins"
  // rule the old prompt used, just applied deterministically now instead of
  // by asking a model to arbitrate it.
  async recognizeAndMerge(files, onProgress, opts = {}) {
    const parts = Array.isArray(files) ? files : [files];
    if (!parts.length) throw new Error('請先選擇檔案。');
    // Every file is classified and extracted independently, all requests
    // concurrent (see callGemini's own comment on why concurrency matters
    // for the ETA timer). Which file is actually the timetable can no
    // longer come from position - it used to be "file 1 is always the
    // timetable, everything after it a registration record", which broke
    // completely the moment someone picked the files in the other order
    // (the registration form got read as a timetable grid, finding
    // nothing; the real timetable photo got read as a course list, also
    // finding nothing). A file picker has no idea what's inside the files
    // it returns, so this has to come from what each file's own result
    // reports about itself - "documentKind" (see GEMINI_PROMPT) - not from
    // upload order.
    const scoped = index =>
      onProgress &&
      (message => onProgress(parts.length > 1 ? `檔案 ${index + 1}：${message}` : message));
    const results = await Promise.all(
      parts.map((file, index) => this.recognizeSchedule([file], scoped(index), opts))
    );

    const timetableIndex = results.findIndex(
      result => result.candidate.documentKind === 'timetable'
    );
    // No weekly-grid photo at all is only a hard failure if there's also
    // nothing else worth importing - a file can be a pure countdown/exam
    // notice (documentKind "other") or a registration record with no
    // accompanying timetable photo, and both are legitimate single-file
    // imports on their own (see GEMINI_PROMPT's countdownEvents rule).
    // Falling through to an empty timetable shell below lets that data
    // still reach the merge/preview step instead of being rejected outright.
    const hasOtherContent = results.some(
      result =>
        (result.candidate.countdownEvents || []).length || (result.candidate.courses || []).length
    );
    if (timetableIndex === -1 && !hasOtherContent) {
      throw new Error(
        '沒有偵測到課表圖片或倒數活動，請確認上傳的檔案中至少有一張完整的每週課表照片、選課紀錄，或含有日期的倒數活動通知。'
      );
    }
    let candidate =
      timetableIndex === -1 ? this.normalizeAIOutput({}) : results[timetableIndex].candidate;
    const modelsUsed = timetableIndex === -1 ? [] : [results[timetableIndex].modelUsed];

    // Promise.all preserves input order in its results regardless of which
    // request actually resolved first, so this stays in file order - "a
    // later file wins over an earlier one at the same slot" needs that to
    // be deterministic, not a race between however fast each request ran.
    results.forEach((result, index) => {
      if (index === timetableIndex) return;
      modelsUsed.push(result.modelUsed);
      if (result.candidate.documentKind === 'timetable') {
        // A second file that also looks like a full timetable grid (e.g.
        // two photos of one physical page) - merging two independently
        // extracted grids isn't attempted, but its countdownEvents are
        // still worth keeping.
        candidate = {
          ...candidate,
          countdownEvents: sortCountdownEventsByDate(
            normalizeCountdownEvents([
              ...(candidate.countdownEvents || []),
              ...(result.candidate.countdownEvents || [])
            ])
          )
        };
        return;
      }
      candidate = this.mergeRegistrationIntoCandidate(candidate, result.candidate);
    });

    return { candidate, modelUsed: modelsUsed.join(' + ') };
  }
}

class DataValidator {
  // Used for per-file escalation in recognizeAndMerge, where a candidate can
  // be either shape parseResponse produces (see its own comment). validate()
  // below assumes a timetable-shaped candidate, and an empty courses array
  // on a registration/other-shaped one is very often the correct answer (a
  // file with no enrollment rows, or a genuinely irrelevant photo) rather
  // than a failure - there's no reliable way to tell those apart from the
  // output alone, so this never escalates on emptiness for that shape,
  // unlike the timetable one where "found nothing at all" is treated as
  // worth a retry with a stronger model.
  validateDetected(candidate) {
    return candidate?.documentKind === 'timetable'
      ? this.validate(candidate)
      : { valid: true, errors: [] };
  }

  validate(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== 'object') {
      errors.push('AI 沒有回傳有效的課表資料。');
      return { valid: false, errors };
    }
    const hasCountdown =
      Array.isArray(candidate.countdownEvents) && candidate.countdownEvents.length > 0;
    const hasClasses = Object.keys(candidate.teacherDB || {}).length > 0;
    if (!hasClasses && !hasCountdown) errors.push('沒有辨識到課程或倒數日期。');
    if (!Array.isArray(candidate.bellTimes)) errors.push('節次時間資料格式不正確。');
    if (
      candidate.bellTimes?.some(
        time =>
          !Array.isArray(time) ||
          time.length !== 2 ||
          !/^\d{2}:\d{2}$/.test(time[0]) ||
          !/^\d{2}:\d{2}$/.test(time[1]) ||
          time[0] >= time[1]
      )
    )
      errors.push('部分節次時間格式不正確。');
    if (
      !candidate.weeklySchedule ||
      Object.values(candidate.weeklySchedule).some(day => !Array.isArray(day))
    )
      errors.push('課表資料格式不正確。');
    return { valid: errors.length === 0, errors };
  }
}

// ---- Second-pass anomaly detection ----
// DataValidator.validate() above only checks structural validity (a
// well-formed shape - valid time strings, a weeklySchedule object, at
// least one class or countdown event) - it says nothing about whether the
// content makes sense. This is a second pass over an already
// structurally-valid candidate, looking for content a human would find
// suspicious even though nothing about it breaks the schema. Pure, cheap,
// client-side comparisons only - no extra Gemini call, no added latency or
// quota cost - since every check here is a heuristic that CAN be wrong
// (e.g. a school that genuinely runs two overlapping bell tracks for
// different grades), these are always surfaced as warnings in
// ImportPreview, never as something that blocks or hides the import
// button - see DataValidator.validate for the actual hard-block checks.
function timeRangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}
function detectScheduleAnomalies(candidate) {
  const warnings = [];
  const bellTimes = Array.isArray(candidate?.bellTimes) ? candidate.bellTimes : [];
  const breakTimes = Array.isArray(candidate?.breakTimes) ? candidate.breakTimes : [];
  const weeklySchedule = candidate?.weeklySchedule || {};
  const teacherDB = candidate?.teacherDB || {};
  // null for any period whose start/end couldn't be read as a time at all -
  // every check below simply skips it rather than comparing against a
  // meaningless range.
  const bellRanges = bellTimes.map(time => {
    const start = Array.isArray(time) ? time[0] : time?.start;
    const end = Array.isArray(time) ? time[1] : time?.end;
    return start && end ? [editorTimeToMinutes(start), editorTimeToMinutes(end)] : null;
  });

  // 1. Two bell periods whose own time ranges overlap - independent of
  // whether either period actually has a class assigned anywhere, this
  // alone means the recognized bell schedule itself is inconsistent.
  bellRanges.forEach((rangeA, indexA) => {
    if (!rangeA) return;
    bellRanges.forEach((rangeB, indexB) => {
      if (!rangeB || indexB <= indexA) return;
      if (timeRangesOverlap(rangeA[0], rangeA[1], rangeB[0], rangeB[1])) {
        warnings.push(`第 ${indexA + 1} 節與第 ${indexB + 1} 節的時間重疊，請確認鐘聲時間是否正確。`);
      }
    });
  });

  // 2. A period whose time range falls inside a recognized break (lunch,
  // cleaning...) but still has a class assigned on some day - often means
  // the OCR misread a break row as an ordinary class row, or attached the
  // wrong period index to a class.
  breakTimes.forEach(item => {
    if (!item?.start || !item?.end) return;
    const breakRange = [editorTimeToMinutes(item.start), editorTimeToMinutes(item.end)];
    bellRanges.forEach((range, period) => {
      if (!range || !timeRangesOverlap(range[0], range[1], breakRange[0], breakRange[1])) return;
      WEEKDAYS_INDEX_ORDER.forEach(day => {
        const key = (weeklySchedule[day] || [])[period];
        if (!key) return;
        const subject = teacherDB[key]?.[0] || '未命名';
        warnings.push(
          `${WEEKDAY_LABELS[day]}第 ${period + 1} 節與「${item.name}」時段重疊，但仍排了課程「${subject}」，請確認是否誤植。`
        );
      });
    });
  });

  // 3. Two periods on the same day whose bell-time ranges overlap and both
  // have a class assigned - a genuine scheduling clash (衝堂), distinct
  // from check 1 above (which fires on the bell schedule alone, regardless
  // of whether anything is actually assigned to either period).
  WEEKDAYS_INDEX_ORDER.forEach(day => {
    const dayRow = weeklySchedule[day] || [];
    bellRanges.forEach((rangeA, periodA) => {
      if (!rangeA || !dayRow[periodA]) return;
      bellRanges.forEach((rangeB, periodB) => {
        if (!rangeB || periodB <= periodA || !dayRow[periodB]) return;
        if (!timeRangesOverlap(rangeA[0], rangeA[1], rangeB[0], rangeB[1])) return;
        const subjectA = teacherDB[dayRow[periodA]]?.[0] || '未命名';
        const subjectB = teacherDB[dayRow[periodB]]?.[0] || '未命名';
        warnings.push(
          `${WEEKDAY_LABELS[day]}第 ${periodA + 1} 節「${subjectA}」與第 ${periodB + 1} 節「${subjectB}」時間重疊，可能是衝堂。`
        );
      });
    });
  });

  // 4. A period whose duration is implausibly short or long for a real
  // class - not itself a conflict, but the same "the bell schedule
  // probably got misread" signal as check 1.
  bellRanges.forEach((range, index) => {
    if (!range) return;
    const minutes = range[1] - range[0];
    if (minutes <= 0) {
      warnings.push(`第 ${index + 1} 節的結束時間不晚於開始時間，請確認鐘聲時間是否正確。`);
    } else if (minutes < 5) {
      warnings.push(`第 ${index + 1} 節只有 ${minutes} 分鐘，可能是鐘聲時間辨識錯誤。`);
    } else if (minutes > 240) {
      warnings.push(`第 ${index + 1} 節長達 ${(minutes / 60).toFixed(1)} 小時，可能是鐘聲時間辨識錯誤。`);
    }
  });

  return warnings;
}

class ImportPreview {
  constructor(root, onImport) {
    this.root = root;
    this.onImport = onImport;
  }

  render(candidate, validation) {
    this.root.hidden = false;
    const teacherDB = candidate.teacherDB || {};
    const bellTimes = Array.isArray(candidate.bellTimes) ? candidate.bellTimes : [];
    const breakTimes = Array.isArray(candidate.breakTimes) ? candidate.breakTimes : [];
    const classRecords = Object.entries(teacherDB);
    const recognizedBlocks = candidate.recognizedBlocks || [];
    const assignmentBySlot = new Map(
      recognizedBlocks.map(block => [`${block.day}:${block.period}`, block.assignment?.key || ''])
    );

    const previewTemplate = document.getElementById('ocr-preview-template');
    this.root.replaceChildren(previewTemplate.content.cloneNode(true));
    this.root.querySelector('[data-ocr-preview-meta]').textContent =
      '請確認並視需要修改下方內容，再按下方按鈕匯入。';

    const warningsBox = this.root.querySelector('[data-ocr-warnings]');
    const warnings = detectScheduleAnomalies(candidate);
    if (warningsBox) {
      warningsBox.hidden = !warnings.length;
      if (warnings.length) {
        warningsBox
          .querySelector('[data-ocr-warnings-list]')
          .replaceChildren(
            ...warnings.map(text => {
              const item = document.createElement('li');
              item.textContent = text;
              return item;
            })
          );
      }
    }

    const bellList = this.root.querySelector('[data-ocr-bell-list]');
    bellTimes.forEach((time, index) => {
      const row = document.getElementById('ocr-bell-row-template').content.cloneNode(true);
      row.querySelector('.bell-num').textContent = index + 1;
      row.querySelector('[data-field="bell-start"]').value = time[0] || '';
      row.querySelector('[data-field="bell-end"]').value = time[1] || '';
      bellList.appendChild(row);
    });

    const breakList = this.root.querySelector('[data-ocr-break-list]');
    const breakFold = this.root.querySelector('[data-ocr-break-fold]');
    if (breakFold && !breakTimes.length) breakFold.remove();
    breakTimes.forEach(item => {
      const row = document.getElementById('ocr-break-row-template').content.cloneNode(true);
      row.querySelector('.break-name').value = item.name || '午休';
      row.querySelector('.break-start').value = item.start || '';
      row.querySelector('.break-end').value = item.end || '';
      breakList.appendChild(row);
    });
    const bellFold = this.root.querySelector('[data-ocr-bell-fold]');
    if (bellFold && !bellTimes.length) bellFold.remove();

    const classList = this.root.querySelector('[data-ocr-class-list]');
    const subjectCounts = {};
    classRecords.forEach(([, value]) => {
      subjectCounts[value[0]] = (subjectCounts[value[0]] || 0) + 1;
    });
    classRecords.forEach(([key, value]) => {
      const row = document.getElementById('ocr-class-row-template').content.cloneNode(true);
      const card = row.querySelector('.ocr-import-class-card');
      card.dataset.origKey = key;
      row.querySelector('[data-field="class-subject"]').value = value[0] || '';
      row.querySelector('.tc-teacher').value = value[1] || '';
      row.querySelector('.tc-location').value = candidate.locationDB?.[key] || '';
      updateTeacherCardAvatar(card);
      classList.appendChild(row);
    });
    const classFold = this.root.querySelector('[data-ocr-class-fold]');
    if (classFold && !classRecords.length) classFold.remove();

    const weeklySchedule = candidate.weeklySchedule || {};
    const extraDays = [6, 0].filter(day => (weeklySchedule[day] || []).some(Boolean));
    const days = [1, 2, 3, 4, 5, ...extraDays];
    const assignmentGrid = this.root.querySelector('[data-ocr-assignment-grid]');
    days.forEach(day => {
      const row = document.getElementById('ocr-day-row-template').content.cloneNode(true);
      row.querySelector('.schedule-day-row').dataset.day = day;
      row.querySelector('.schedule-day-label').textContent = WEEKDAY_LABELS[day];
      const periods = row.querySelector('.schedule-periods');
      bellTimes.forEach((time, period) => {
        const select = document.createElement('select');
        select.className = 'period-select';
        select.dataset.assignmentDay = day;
        select.dataset.assignmentPeriod = period;
        select.title = time.join('–');
        select.appendChild(new Option('-', ''));
        classRecords.forEach(([key, value]) =>
          select.appendChild(
            new Option(formatClassLabel(value[0], value[1], subjectCounts[value[0]] > 1), key)
          )
        );
        select.value = assignmentBySlot.get(`${day}:${period}`) || '';
        periods.appendChild(select);
      });
      assignmentGrid.appendChild(row);
    });
    const assignmentFold = this.root.querySelector('[data-ocr-assignment-fold]');
    if (assignmentFold && (!bellTimes.length || !classRecords.length)) assignmentFold.remove();

    const countdownEvents = Array.isArray(candidate.countdownEvents)
      ? candidate.countdownEvents
      : [];
    const countdownFold = this.root.querySelector('[data-ocr-countdown-fold]');
    if (countdownEvents.length) {
      // Unlike the other folds above, this one starts with `hidden` in the
      // template (see index.html) since a timetable photo usually has no
      // countdown event at all - the default has to be "absent", not
      // "present but collapsed" like the others get from just being left
      // alone. That means, uniquely among these folds, it has to be
      // un-hidden here on the populated path instead of only ever removed
      // on the empty one.
      countdownFold.hidden = false;
      countdownFold.open = true;
      const countdownList = this.root.querySelector('[data-ocr-countdown-list]');
      countdownEvents.forEach(item => {
        const row = document.getElementById('ocr-countdown-row-template').content.cloneNode(true);
        row.querySelector('.countdown-event-name').value = item.name || '';
        const startInput = row.querySelector('.countdown-event-start');
        const endInput = row.querySelector('.countdown-event-end');
        startInput.value = item.startDate || item.date || '';
        endInput.value = item.endDate || item.date || '';
        startInput.addEventListener('change', () => {
          if (!endInput.value || endInput.value < startInput.value)
            endInput.value = startInput.value;
        });
        countdownList.appendChild(row);
      });
    } else if (countdownFold) {
      countdownFold.remove();
    }

    this.root.querySelector('[data-ocr-preview-note]').textContent = validation.valid
      ? '請確認以上內容無誤，再按下方按鈕匯入。'
      : validation.errors.join('');
    this.root.querySelector('[data-ocr-submit]').hidden = !validation.valid;

    const refreshAssignmentOptions = () => {
      const cards = Array.from(this.root.querySelectorAll('.ocr-import-class-card'));
      const rows = cards
        .map(card => ({
          key: card.dataset.origKey || '',
          subject: (card.querySelector('[data-field="class-subject"]')?.value || '').trim(),
          teacher: (card.querySelector('.tc-teacher')?.value || '').trim()
        }))
        .filter(row => row.key && row.subject);
      const liveSubjectCounts = {};
      rows.forEach(row => {
        liveSubjectCounts[row.subject] = (liveSubjectCounts[row.subject] || 0) + 1;
      });
      const options = rows.map(row => ({
        key: row.key,
        label: formatClassLabel(row.subject, row.teacher, liveSubjectCounts[row.subject] > 1)
      }));
      this.root.querySelectorAll('[data-assignment-day]').forEach(select => {
        const current = select.value;
        select.replaceChildren(new Option('-', ''));
        options.forEach(option => select.appendChild(new Option(option.label, option.key)));
        select.value = options.some(option => option.key === current) ? current : '';
      });
    };
    this.root.querySelectorAll('.ocr-import-class-card input').forEach(input =>
      input.addEventListener('input', () => {
        const card = input.closest('.ocr-import-class-card');
        if (card) updateTeacherCardAvatar(card);
        refreshAssignmentOptions();
      })
    );

    this.root.querySelector('[data-ocr-submit]')?.addEventListener('click', () => {
      const edited = {
        bellTimes: [],
        breakTimes: [],
        teacherDB: {},
        locationDB: {},
        teacherOrder: [],
        weeklySchedule: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
        reverseWeek: candidate.reverseWeek === true
      };

      this.root.querySelectorAll('[data-ocr-bell-list] .bell-row').forEach(item => {
        const start = (item.querySelector('[data-field="bell-start"]')?.value || '').trim();
        const end = (item.querySelector('[data-field="bell-end"]')?.value || '').trim();
        if (start && end) edited.bellTimes.push([start, end]);
      });

      this.root.querySelectorAll('[data-ocr-break-list] .break-row').forEach(item => {
        const name = (item.querySelector('.break-name')?.value || '').trim() || '午休';
        const start = (item.querySelector('.break-start')?.value || '').trim();
        const end = (item.querySelector('.break-end')?.value || '').trim();
        if (start && end) edited.breakTimes.push({ name, start, end });
      });

      this.root.querySelectorAll('.ocr-import-class-card').forEach(card => {
        const key = (card.dataset.origKey || '').trim();
        const subject = (card.querySelector('[data-field="class-subject"]')?.value || '').trim();
        if (!key || !subject) return;
        const teacher = (card.querySelector('.tc-teacher')?.value || '').trim();
        const location = (card.querySelector('.tc-location')?.value || '').trim();
        edited.teacherDB[key] = [subject, teacher, location];
        edited.locationDB[key] = location;
        edited.teacherOrder.push(key);
      });

      this.root.querySelectorAll('[data-assignment-day]').forEach(select => {
        const day = Number(select.dataset.assignmentDay);
        const period = Number(select.dataset.assignmentPeriod);
        const key = select.value.trim();
        if (key && edited.teacherDB[key]) edited.weeklySchedule[day][period] = key;
      });

      const countdownEvents = [];
      this.root.querySelectorAll('[data-ocr-countdown-list] .bell-row').forEach(item => {
        const name = (item.querySelector('.countdown-event-name')?.value || '').trim();
        const startDate = (item.querySelector('.countdown-event-start')?.value || '').trim();
        const endDate = (item.querySelector('.countdown-event-end')?.value || '').trim();
        if (name && startDate)
          countdownEvents.push({ name, startDate, endDate: endDate || startDate });
      });
      edited.countdownEvents = countdownEvents;

      this.onImport?.(edited);
    });
  }
}

// A static estimate, shown once and left alone - the matchmaking-queue
// pattern, not a countdown. The countdown this replaces re-rendered a
// shrinking number every second, which turned an unavoidable few-second wait
// into something to watch, drew the eye to precisely the moment the estimate
// was most likely to be wrong, and (when it hit zero and the request had not
// finished) made the app look broken rather than busy. One unchanging
// sentence sets the expectation and then stops competing for attention.
//
// A static line alone has a real gap though: it gives no signal that the
// request is actually still running, as opposed to just stuck. So there's a
// second, deliberately quieter element next to it - #ocr-import-eta-elapsed,
// a small ticking "已等待 N 秒" clock - answering a different question
// ("is this alive") from the one the estimate answers ("when will it be
// done"). It's the matchmaking-queue pattern in full: a fixed "estimated
// wait" plus a separate, visually secondary "time in queue" that keeps
// counting - not a revival of the old shrinking-number countdown, which
// tried to make one number do both jobs and did neither well. See the CSS
// for why it's aria-hidden: getting read aloud every second would be the
// same "watched pot" problem the countdown had, just moved into a screen
// reader.
//
// The estimate itself is derived rather than fixed: more files still
// genuinely changes how long this takes, so quoting the same figure for a
// single screenshot and for four would be wrong on purpose. The per-file
// add-on is small, though - see recognizeAndMerge: every additional file's
// request runs concurrently with the primary one now, not after it, so the
// total wall-clock time is close to whichever single request is slowest,
// not the sum of all of them. A bigger per-file constant here is left over
// from when that fan-out was still sequential and each extra file really
// did stack its own full round trip on top of the last; keeping that old
// value after the fan-out was parallelized would make this estimate run
// increasingly far under the (now much larger) real time for more files,
// not over it - the opposite of the pessimism this is supposed to have.
// Still hand-picked rather than measured, since this app has no telemetry;
// deliberately a little pessimistic, because an import that beats its
// estimate costs nothing and one that overruns it is the case this whole
// element exists to avoid.
const ETA_BASE_SECONDS = 5;
const ETA_PER_EXTRA_FILE_SECONDS = 1;
// How far past the estimate to run before admitting it - generous enough
// that an ordinary bit of variance never trips it, tight enough that a
// genuinely stuck request doesn't sit under a confident-looking estimate
// forever. A model fallback (see recognizeSchedule) is the usual reason.
// The elapsed clock keeps ticking either side of this threshold - it isn't
// an estimate that can be "wrong", so there's nothing about crossing it
// that needs to change how the clock itself behaves.
const ETA_OVERRUN_FACTOR = 1.8;
function estimateRecognitionSeconds(fileCount) {
  return ETA_BASE_SECONDS + Math.max(0, fileCount - 1) * ETA_PER_EXTRA_FILE_SECONDS;
}
// A loading indicator that pops in and back out within a fraction of a
// second reads as flicker, not information - and since recognizeAndMerge's
// requests now run concurrently (see its own comment), a fast import can
// finish quickly enough that this element used to flash on and immediately
// back off. That flash is exactly what made the running "已等待 N 秒" clock
// look like it "wasn't showing" some of the time: catching it required
// noticing a specific frame that could be on screen for well under a
// second. Delaying the reveal fixes it the standard way something like a
// button spinner would: don't show a loading indicator at all for
// something that finishes before a person would consciously register it,
// and show it - with its ticking clock, every time - for anything that
// actually takes a moment. Both halves of that are "consistent"; an
// occasional flash is not.
const ETA_REVEAL_DELAY_MS = 400;
function startEtaTimer(etaElement, fileCount = 1) {
  if (!etaElement) return () => {};
  const estimateSpan = etaElement.querySelector('#ocr-import-eta-estimate') || etaElement;
  const elapsedSpan = etaElement.querySelector('#ocr-import-eta-elapsed');
  const estimate = estimateRecognitionSeconds(fileCount);
  const startedAt = Date.now();
  let revealed = false;
  // A no-op until revealed, rather than only starting once revealed - kept
  // running on its own schedule from t=0 so an elapsed reading taken right
  // at, say, the overrun threshold reads as an exact whole number of
  // seconds from the true start, not shifted by however long the reveal
  // delay happened to add before this began writing to the DOM.
  const tickElapsed = () => {
    if (!revealed || !elapsedSpan) return;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    elapsedSpan.textContent = `已等待 ${elapsedSeconds} 秒`;
  };
  // Idempotent and called from two places (the reveal delay, and - as a
  // safety net - the overrun timer) since an overrun this long must never
  // be hidden regardless of what happened to the reveal timer.
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    etaElement.hidden = false;
    estimateSpan.textContent = `預估等待時間 約 ${estimate} 秒`;
    tickElapsed();
  };
  const revealTimer = setTimeout(reveal, ETA_REVEAL_DELAY_MS);
  const elapsedInterval = setInterval(tickElapsed, 1000);
  const overrunTimer = setTimeout(
    () => {
      reveal();
      estimateSpan.textContent = '比預估久一點，仍在辨識中…';
    },
    Math.round(estimate * ETA_OVERRUN_FACTOR * 1000)
  );
  return () => {
    clearTimeout(revealTimer);
    clearInterval(elapsedInterval);
    clearTimeout(overrunTimer);
    etaElement.hidden = true;
    estimateSpan.textContent = '';
    if (elapsedSpan) elapsedSpan.textContent = '';
  };
}

function describeSelection(sources) {
  if (!sources.length) return '尚未選擇檔案';
  if (sources.length === 1) return sources[0].name || '已選擇 1 個檔案';
  return `已選擇 ${sources.length} 個檔案：${sources.map(source => source.name || '未命名').join('、')}`;
}

function mountOCRImporter({
  runButton,
  imageInput,
  imageLabel,
  etaElement,
  imagePreview,
  filenameElement,
  status,
  result,
  onImport
}) {
  const preprocessor = new FilePreprocessor();
  const validator = new DataValidator();
  const aiProcessor = new AIVisionProcessor();
  const preview = new ImportPreview(result, onImport);
  let sources = [];
  // Object URLs for the thumbnails - revoked on the next selection rather
  // than on the same tick, since the <img> elements are still using them.
  let previewUrls = [];

  function renderPreviews() {
    const wrap = imagePreview?.parentElement;
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    previewUrls = [];
    if (!wrap) return;
    // The single <img> from the markup is the template for the first
    // thumbnail; any extras are cloned from it so they inherit its styling.
    wrap.querySelectorAll('.ocr-import-image-preview').forEach((node, index) => {
      if (index > 0) node.remove();
    });
    const thumbnails = sources.filter(source => source.kind === 'decodable');
    wrap.classList.toggle('has-image', thumbnails.length > 0);
    imagePreview.hidden = thumbnails.length === 0;
    thumbnails.forEach((source, index) => {
      const url = URL.createObjectURL(source.file);
      previewUrls.push(url);
      const node = index === 0 ? imagePreview : imagePreview.cloneNode(false);
      node.hidden = false;
      node.src = url;
      if (index > 0) wrap.appendChild(node);
    });
  }

  async function loadFiles(fileList) {
    const chosen = Array.from(fileList || []);
    sources = [];
    if (!chosen.length) {
      renderPreviews();
      if (filenameElement) filenameElement.textContent = describeSelection(sources);
      runButton.disabled = true;
      return;
    }
    if (chosen.length > MAX_FILES) {
      status(`一次最多 ${MAX_FILES} 個檔案，請減少後再試。`, true);
      runButton.disabled = true;
      return;
    }
    try {
      // Sequential, not Promise.all: decoding several full-resolution
      // photos at once is the one thing here that can genuinely exhaust
      // memory on an older phone, and the files are small enough
      // individually that there is nothing to win by overlapping them.
      for (const file of chosen) sources.push(await preprocessor.process(file));
      renderPreviews();
      if (filenameElement) filenameElement.textContent = describeSelection(sources);
      runButton.disabled = false;
      status(
        sources.length > 1
          ? `已載入 ${sources.length} 個檔案，AI 會自動判斷每個檔案的內容（課表或選課資料），順序不影響結果。`
          : '已載入檔案，點擊匯入讓 AI 自動判讀課表。'
      );
    } catch (error) {
      sources = [];
      renderPreviews();
      if (filenameElement) filenameElement.textContent = describeSelection(sources);
      runButton.disabled = true;
      status(error.message, true);
    }
  }

  runButton.addEventListener('click', async () => {
    if (!sources.length) return;
    // Belt-and-suspenders, same as saveEditor()/requestTransferAction(): the
    // editor UI already disables this button for a viewer device (see
    // styles.css's .sync-viewer-locked), but that's a CSS/pointer-events
    // lock, not real access control.
    if (isSyncViewer()) {
      status('此裝置為僅接收模式，無法使用 AI 匯入。如要自行編輯，請先解除同步。', true);
      return;
    }
    if (!navigator.onLine) {
      status('目前沒有網路連線，AI 匯入暫時無法使用。', true);
      return;
    }
    if (!isGeminiProxyConfigured()) {
      status('AI 匯入功能尚未設定，請聯絡課表管理者。', true);
      return;
    }
    runButton.disabled = true;
    // Also locks the "選擇檔案" control itself - picking different files
    // mid-recognition would abandon the in-flight request with no way to
    // cancel it, and the file input's disabled state is what actually stops
    // its <label> from opening the file picker (a disabled control's label
    // is a no-op by spec) - imageLabel just needs the matching visual style.
    if (imageInput) imageInput.disabled = true;
    imageLabel?.classList.add('is-disabled');
    state.isOcrProcessing = true;
    const stopEta = startEtaTimer(etaElement, sources.length);
    try {
      status(sources.length > 1 ? `準備 ${sources.length} 個檔案中…` : '準備檔案中…');
      console.time('GeminiEncode');
      let files;
      try {
        files = await Promise.all(sources.map(encodeSourceForUpload));
      } finally {
        console.timeEnd('GeminiEncode');
      }

      const { candidate, modelUsed } = await aiProcessor.recognizeAndMerge(
        files,
        message => status(message),
        // Lets a structurally unusable timetable-shaped answer escalate to a
        // stronger model instead of being merged in as-is. Every file gets
        // the same check now (see validateDetected) since any of them could
        // turn out to be the timetable - it never escalates purely on an
        // empty result for a non-timetable file, since that's often just
        // the correct answer for one.
        { validate: input => validator.validateDetected(input) }
      );
      status('正在驗證課表資料…');
      const validation = validator.validate(candidate);

      status(
        validation.valid
          ? `課表辨識完成（模型：${modelUsed}），請確認下方內容後進行匯入。`
          : validation.errors.join('') || 'AI 辨識結果不完整，請手動修正後再匯入。'
      );
      preview.render(candidate, validation);
    } catch (error) {
      status(error.message, true);
    } finally {
      stopEta();
      runButton.disabled = false;
      if (imageInput) imageInput.disabled = false;
      imageLabel?.classList.remove('is-disabled');
      state.isOcrProcessing = false;
    }
  });

  return { loadFiles };
}

// Load the importer only when the file-import control is first used.
let ocrImporterPromise;
let ocrImporterController;
function activateOCRImporter() {
  if (ocrImporterPromise) return ocrImporterPromise;
  const input = document.getElementById('ocr-import-image');
  const imageLabel = document.getElementById('ocr-import-image-label');
  const runButton = document.getElementById('ocr-import-detect');
  const etaElement = document.getElementById('ocr-import-eta');
  const imagePreview = document.getElementById('ocr-import-image-preview');
  const statusElement = document.getElementById('ocr-import-status');
  const result = document.getElementById('ocr-import-result');
  if (!input || !runButton || !imagePreview || !statusElement || !result) return Promise.resolve();
  ocrImporterPromise = new Promise((resolve, reject) => {
    const config = {
      runButton,
      imageInput: input,
      imageLabel,
      etaElement,
      imagePreview,
      filenameElement: document.getElementById('ocr-import-filename'),
      result,
      onImport: data => {
        try {
          const current = settingsDataForExport();
          const imported = normalizeSettingsData({
            ...data,
            // AI recognition has no knowledge of the app's visual theme or
            // existing named breaks; retain those editor settings on import.
            breakTimes:
              Array.isArray(data.breakTimes) && data.breakTimes.length
                ? data.breakTimes
                : current.breakTimes,
            // Odd/even week orientation isn't something a single photo can
            // reliably signal either way (nothing in a timetable photo
            // marks which physical week it was taken in) - AI import never
            // touches this setting, recognized classes or not.
            reverseWeek: current.reverseWeek,
            proAccent: current.proAccent,
            proSecondary: current.proSecondary,
            proTertiary: current.proTertiary,
            styleSlots: current.styleSlots
          });
          beginEditorImport(current, imported, { preserveStyle: true });
        } catch (error) {
          statusElement.textContent = `匯入預覽失敗：${error.message || error}`;
          statusElement.classList.add('error');
        }
      },
      status: (message, error = false) => {
        statusElement.textContent = message;
        statusElement.classList.toggle('error', error);
      }
    };
    if (typeof mountOCRImporter !== 'function') {
      reject(new Error('OCR importer did not initialize.'));
      return;
    }
    resolve(mountOCRImporter(config));
  }).then(controller => {
    ocrImporterController = controller;
    return controller;
  });
  return ocrImporterPromise;
}
const ocrImageInput = document.getElementById('ocr-import-image');
// Reaching for the picker is the earliest honest signal that a request is
// coming, and the gap between it and the request is exactly the free time a
// connection warm-up needs (see warmUpGeminiProxy). Not `once`, unlike the
// importer's own lazy load: a user who opens the picker, cancels, and comes
// back a few minutes later needs the connection warmed again, and the
// function rate-limits itself.
ocrImageInput?.addEventListener('pointerdown', () => {
  activateOCRImporter();
  warmUpGeminiProxy();
});
ocrImageInput?.addEventListener('change', async event => {
  const controller = ocrImporterController || (await activateOCRImporter());
  await controller?.loadFiles(event.target.files);
});

export {
  AIVisionProcessor,
  DataValidator,
  detectScheduleAnomalies,
  estimateRecognitionSeconds,
  ETA_REVEAL_DELAY_MS,
  ImportPreview,
  isGeminiProxyConfigured,
  startEtaTimer,
  warmUpGeminiProxy
};
