// ---- cloudflare-worker/orbit-worker.js ----
// A single Cloudflare Worker serving Orbit Class's optional server-side
// features, plus one more app's sync feature, routed by path:
//
//   POST      /gemini     - AI schedule-photo import (see src/gemini-ocr.js).
//                            Holds the real Gemini API key server-side so
//                            end users never need one of their own.
//   GET/PATCH/DELETE /sync - Orbit's own cross-device schedule sync (see
//                            src/sync.js).
//   GET/PATCH/DELETE /vocab-sync - Orbit Vocab's cross-device
//                            progress sync (see that repo's sync.js). Not
//                            Orbit's own feature - this Worker is simply
//                            reused as shared infrastructure for a sibling
//                            static site, so its owner doesn't have to
//                            stand up and pay attention to a second Worker,
//                            a second Firebase project, or a second set of
//                            rate-limit tuning just to give that app the
//                            same kind of sync. See "==== /vocab-sync"
//                            below for how it differs from /sync.
//   POST      /vocab-ai   - Orbit Vocab's live, per-learner AI features
//                            (personalized mnemonics + memory-palace
//                            stories - see that repo's vocab-ai.js). Same
//                            reuse reasoning as /vocab-sync, but shares
//                            /gemini's GEMINI_API_KEY secret instead of
//                            /vocab-sync's Firebase ones - see "==== /vocab-ai"
//                            below.
//
// /sync and /vocab-sync both hold a Firebase service-account key
// server-side and proxy Firestore, so the pairing code isn't the only thing
// standing between the internet and that Firestore project. DELETE wipes
// the shared document outright on either path (see orbitSyncDeleteForEveryone
// and its vocab-sync equivalent).
//
// Combined into one file/one deployment purely for setup convenience - one
// Worker, one KV binding, one set of secrets to manage - not for any
// technical reason: Cloudflare's Workers Free plan daily request cap
// (100,000/day) is per-account, not per-Worker, so splitting these into
// separate Workers never bought any extra headroom in the first place. The
// same reasoning is why /vocab-sync reuses the *same* Firebase project and
// service-account credentials as /sync rather than needing its own - it
// only needs its own Firestore collection (see VOCAB_SYNC_APP below) and
// its own rate-limit counters, both cheap to add to an already-deployed
// Worker.
//
// All three routes have very different trust boundaries - /gemini only
// ever runs a fixed prompt against a submitted image, /sync holds
// credentials with full read/write access to Orbit's own shared documents,
// /vocab-sync the same but for a different app's documents - so each
// validates and rate-limits its own requests independently (see
// isRateLimited: every call passes its own `feature` key, so a burst
// against one path can never eat into another's quota) and no path touches
// another's secrets or code.
//
// Every feature is entirely optional. Not configuring GEMINI_API_KEY (see
// handleGeminiRequest) or the FIREBASE_* secrets (see handleSyncRequest,
// shared by /sync and /vocab-sync) just makes that path (or both sync
// paths at once, since they share the same Firebase secrets) return a "not
// configured" error - the other features still work normally. See README
// for the one-time setup each needs (paste this file into a new Worker in
// the Cloudflare dashboard, set whichever secrets apply, point the
// matching proxy-URL env var at this Worker's *.workers.dev URL with
// /gemini, /sync, or /vocab-sync appended).

const ALLOWED_ORIGINS = ['https://jaypengx-collab.github.io'];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin || '');
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

// ---- Shared rate limiting (Workers KV, one counter per feature+IP+hour) ----
//
// Real, cross-request rate limiting via Workers KV (env.RATE_LIMIT_KV - see
// README, an optional but recommended one-time binding), shared across
// every edge location - unlike a plain in-memory Map (kept below as
// isRateLimitedInMemory, used only as a fallback if the KV binding is
// missing or a KV call errors): Workers run many isolates in parallel
// across Cloudflare's edge, so an in-memory counter resets per isolate and
// a distributed burst of requests can blow straight through it. KV is
// still not a hard security boundary on its own (an abuser can spread
// requests across enough source IPs to dodge a per-IP counter), but it
// closes the specific gap of "just send enough requests to outrun a single
// isolate's memory." The real, unconditional backstop underneath both is
// Cloudflare's own free-plan daily request cap.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_WINDOW_SECONDS = RATE_WINDOW_MS / 1000;

// Workers KV's free-tier daily caps are wildly asymmetric - 100,000
// reads/day but only 1,000 writes/day, per account, shared by every
// namespace. The original version of this function called kv.put() on
// every single request that wasn't already over its limit - one write just
// to increment the same counter by one - so a single feature under
// ordinary traffic (SYNC_READ_RATE_LIMIT alone allows 6000 requests/hour
// per IP) could burn through the *entire account's* daily write budget in
// minutes, at which point every kv.put() anywhere in this Worker starts
// throwing and every feature silently falls back to isRateLimitedInMemory
// (see the catch in isRateLimited below) - a noisy neighbor on one path
// degrading rate-limit accuracy on all the others.
//
// The fix batches increments per isolate instead of persisting each one to
// KV individually: the authoritative count is read from KV once per window
// (a read, not a write), and further increments in this isolate accumulate
// in memory (pendingCounters) and are flushed as a single write no more
// than once every KV_FLUSH_INTERVAL_MS. The limit check below still runs
// against base+delta on every request, so enforcement stays effectively
// real-time for whichever isolate is actually handling that traffic; only
// *persisting* the count for other isolates to see is throttled, and it is
// still flushed at least once when a window rolls over so a burst's tail
// is never silently lost.
const KV_FLUSH_INTERVAL_MS = 60 * 1000;
const pendingCounters = new Map();

async function flushPendingCounter(kv, key, pending) {
  const total = pending.base + pending.delta;
  pending.base = total;
  pending.delta = 0;
  pending.lastFlushAt = Date.now();
  // expirationTtl a little past the window so a key never outlives its own
  // bucket by much, instead of accumulating in the namespace forever.
  await kv.put(key, String(total), { expirationTtl: RATE_WINDOW_SECONDS + 60 });
}

async function isRateLimitedKV(kv, bucketKey, limit) {
  const windowBucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  let pending = pendingCounters.get(bucketKey);
  if (pending && pending.windowBucket !== windowBucket) {
    // The previous window just ended - flush its final tally so other
    // isolates aren't left permanently blind to this isolate's last few
    // increments (best-effort: a failure here just means that window's
    // very last increments are invisible elsewhere, no worse than what the
    // old per-request behavior already tolerated between accounts).
    if (pending.delta > 0) {
      await flushPendingCounter(kv, `rl:${bucketKey}:${pending.windowBucket}`, pending).catch(
        () => {}
      );
    }
    pending = null;
  }
  if (!pending) {
    const stored = Number((await kv.get(`rl:${bucketKey}:${windowBucket}`)) || '0');
    pending = { windowBucket, base: stored, delta: 0, lastFlushAt: Date.now() };
    pendingCounters.set(bucketKey, pending);
  }
  if (pending.base + pending.delta >= limit) return true;
  pending.delta += 1;
  if (Date.now() - pending.lastFlushAt >= KV_FLUSH_INTERVAL_MS) {
    await flushPendingCounter(kv, `rl:${bucketKey}:${windowBucket}`, pending);
  }
  return false;
}

const requestLog = new Map();
function isRateLimitedInMemory(bucketKey, limit) {
  const now = Date.now();
  const timestamps = (requestLog.get(bucketKey) || []).filter(time => now - time < RATE_WINDOW_MS);
  const limited = timestamps.length >= limit;
  timestamps.push(now);
  requestLog.set(bucketKey, timestamps);
  return limited;
}

// `feature` keys the counter (e.g. 'gemini', 'sync:read', 'sync:write') so
// every call site's limit is tracked completely independently of every
// other's - see the top-of-file comment for why that separation matters.
// Returns { limited, backend } rather than a plain boolean so the caller
// can surface `backend` as a diagnostic response header - there's no way
// to inspect a live Worker's internal state otherwise (no log access from
// outside the Cloudflare dashboard), and "is the binding even wired up"
// has turned out to need a real, checkable answer more than once.
async function isRateLimited(env, ip, feature, limit) {
  const bucketKey = `${feature}:${ip}`;
  if (env.RATE_LIMIT_KV) {
    try {
      return { limited: await isRateLimitedKV(env.RATE_LIMIT_KV, bucketKey, limit), backend: 'kv' };
    } catch (error) {
      return {
        limited: isRateLimitedInMemory(bucketKey, limit),
        backend: `kv-error:${(error && error.message) || error}`
      };
    }
  }
  return { limited: isRateLimitedInMemory(bucketKey, limit), backend: 'memory-no-binding' };
}

// ==== /gemini - AI schedule-photo import ====================================

// Taiwan is UTC+8 with no DST, so a fixed offset gives the exact local
// calendar date - no timezone database needed for a Worker that otherwise
// runs in UTC. Used to anchor GEMINI_PROMPT's year-less-date rule to "today"
// from this app's users' own point of view, not the server's.
function todayIsoInTaipei() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Exact copy of the prompt that used to live in src/gemini-ocr.js's
// AIVisionProcessor.buildPrompt() - kept here now instead, since the whole
// point of moving it server-side is that the client no longer sends it.
//
// Single-file, and self-classifying, deliberately: an earlier version split
// this into two separate fixed prompts (a "timetable" one and a
// "registration" one) and had the CLIENT decide, purely from upload order,
// which file went to which - file 1 was always assumed to be the timetable,
// every file after it a registration record. That broke completely the
// moment someone picked the files in the other order: the registration form
// got read as if it were a timetable grid (producing garbage), and the
// actual timetable photo got read as if it were a course list (finding
// nothing to extract). There is no reliable signal in upload order - a file
// picker doesn't know or care what's in the files - so the model has to
// determine this itself instead of trusting how the files arrived. Every
// file now gets exactly this one prompt, and "documentKind" is the model's
// own answer to "what am I looking at", read back by
// src/gemini-ocr.js's recognizeAndMerge to route each file's result
// correctly regardless of what order it was uploaded in.
//
// This does cost a little more per call than the two-separate-prompts
// version did (every call now carries both rule sets, not just the one that
// turned out to matter) - a fixed, modest, worthwhile trade for a bug class
// this is not: getting the whole import right no matter what order the
// files came in, rather than getting it cheaply and only when they came in
// the order the code silently assumed.
// A function of "today" rather than a plain constant: countdownEvents below
// needs a reference date so the model can resolve a year-less calendar date
// (e.g. a poster showing only "1/22", no year) to the correct year itself,
// instead of guessing one with no anchor at all - which in practice skewed
// toward whatever year the model's training data made it default to, often
// landing the "countdown" in the past. Computed fresh per request rather
// than once at module load, since a Worker instance can stay warm across
// requests spanning a real date change.
function buildGeminiPrompt(todayIso) {
  return `Look at the attached file and decide what kind of document it is, then extract accordingly. Return a single JSON object matching this exact schema:
{
  "documentKind": "timetable",
  "bellTimes": [],
  "breakTimes": [{"name":"午休","start":"12:00","end":"13:00"}],
  "classes": [{"key":"c1","subject":"國文","teacher":"陳老師","location":"A101"}, {"key":"c2","subject":"英文","teacher":"王老師","location":"B202"}],
  "weeklySchedule": {"1": ["c1","c2",null], "2": [], "3": [], "4": [], "5": []},
  "reverseWeek": false,
  "courses": [{"subject":"多媒體音樂 I","teacher":"徐蓉莉","location":"","day":1,"periods":[3,4]}],
  "countdownEvents": [{"name":"116 學測","startDate":"2027-01-22","endDate":"2027-01-24"}]
}

First, set "documentKind" to exactly one of:
- "timetable" - the file shows a weekly class schedule grid: a table with days as one axis and periods as the other, each cell showing a subject (and often a teacher/room) for a whole week.
- "registration" - the file is a course-registration confirmation, enrollment list, or similar record: a list or table where each row names one specific course a student is actually taking, generally alongside which day and period(s) it meets. It does NOT show a full weekly grid.
- "other" - neither of the above (an unrelated photo, a notice with no course rows or grid, etc).

Then extract only the fields that match the documentKind you chose, and leave every other field at its empty default (empty array, empty object, or false) rather than guessing or leaving it inconsistent with documentKind. countdownEvents is the one exception - check for it regardless of documentKind, per its own rule below.

If documentKind is "timetable", fill in bellTimes/breakTimes/classes/weeklySchedule/reverseWeek (leave courses as an empty array):
- Read class period times from the image when available. Use 24-hour "HH:MM" strings, one entry per period in order, exactly as shown (either ["08:10","09:00"] or {"start":"08:10","end":"09:00"} is acceptable). Preserve the actual times; never invent, guess, or fall back to standard/default school times. If no class times are visible anywhere, return an empty bellTimes array.
- Identify visible subjects, teachers, classrooms, breaks, and other timetable information.
- classes: one entry per distinct subject actually visible in the photo — do not invent subjects that aren't shown. "key" is your own short identifier for that entry (e.g. "c1", "c2") — it is never shown to anyone, it only links weeklySchedule slots back to this entry, so make each one unique. "subject" is the full Chinese subject name. Use "" for teacher/location when that information is not readable.
- Every entry in classes MUST be placed at least once in weeklySchedule, at the exact day/period position where it visually appears in the grid. A subject you cannot place at a specific day and period is not a recognized class — leave it out of classes entirely rather than adding it unassigned. Do not stop at recognizing a subject's name; always also locate the cell(s) it occupies.
- weeklySchedule: keys "1" through "5" (Monday–Friday) are REQUIRED and must all be present, even as an empty array — never omit or truncate "5" (Friday) even if it is partially cut off in the photo. Add "6" (Saturday) and/or "0" (Sunday) ONLY if the photo actually shows a column for that day; otherwise omit them entirely. Keep each day's array aligned with the detected periods (one entry per bellTimes index). Use null when a slot is genuinely empty or cannot be identified — never fill a blank or unreadable cell by copying in a class from a different day or period just because a slot exists there; every non-null entry must be a "key" that exists in classes.
- If odd/even weeks contain alternatives in the same slot (shown as two stacked subject+teacher pairs, often marked 單/雙 or "odd/even"), read each alternative's subject and its own teacher as two separate pieces of text first, then combine same-role pieces with "/" — all subjects joined into one "/"-separated subject string, all teachers joined the same way into one "/"-separated teacher string, both in the same left-to-right order, as one shared classes entry for that slot. Never fold a teacher's name into the subject string, or vice versa: subject must end up containing only subject names, teacher only teacher names.
- Set reverseWeek to true only when the photo clearly indicates a reversed odd/even week orientation; otherwise false.
- Add breakTimes only for explicitly shown non-class periods such as lunch or cleaning — not empty/free periods.

If documentKind is "registration", fill in courses (leave bellTimes/breakTimes/classes/weeklySchedule empty, reverseWeek false):
- This kind of file's day/period information may be written out plainly, or packed together compactly — one shorthand seen often enough to call out explicitly: a single day character immediately followed by a run of digits with no separator, where each individual digit is its own period number (so a two-digit run like "34" means periods 3 AND 4, both occupied by that one row, never "period 34" or a "3 through 4" range). Whatever notation this file actually uses, decode it using the day-naming and period-numbering it establishes itself.
- courses: one entry per distinct course row actually shown — do not invent rows. "day" is an integer: 1 for Monday through 5 for Friday, 6 for Saturday, 0 for Sunday. "periods" is every period number that row's course occupies, as a plain array of integers in ascending order (e.g. a row spanning two consecutive periods is periods:[3,4], never a combined number like 34 or a string). Use "" for teacher/location when not given or not legible.

Regardless of documentKind:
- Add countdownEvents only for clearly visible events/exams with a readable calendar date, formatted as "YYYY-MM-DD". Set startDate and endDate to the same date for a single-day event; use the visible first and last dates for a multi-day event/exam period. Only include dates you can actually read the day and month of; otherwise return an empty array. A file can carry a countdown/exam notice with no timetable or course-list content at all (documentKind "other") - still report it.
- Today's date is ${todayIso}. If a countdown/exam date shows a day and month but no visible year, infer the year yourself so the resulting date is the nearest upcoming date on or after today: use this year unless that month/day has already passed this year, in which case use next year instead. Never infer a year that puts the event in the past. If a year is actually visible in the photo, always use that one instead, even if it looks like it's already past.
- Do not invent information. When uncertain, prefer an empty value, empty array, or null.
- Every field in the response schema you are given must be present, even when empty.
- Keep all fields internally consistent.
- Return ONLY the raw JSON object — no markdown fences, no comments, no extra text.`;
}

// Must match src/gemini-ocr.js's AIVisionProcessor.geminiModels exactly -
// this is the actual enforcement point that stops the model name from being
// an arbitrary passthrough to Gemini's API. Ordered fastest-first there and
// mirrored here; see that file for why the order flipped.
//
// gemini-2.5-flash, which used to close out this list, is gone rather than
// demoted: confirmed live against the real API (not assumed from a
// changelog) that it now 404s for every caller - "no longer available to
// new users" - so keeping it in the fallback chain would only ever waste a
// retry.
//
// gemini-3.6-flash is gone too, for a worse reason: run against this
// feature's actual prompt+schema+multi-file request shape (not just
// pinged), it reproduced two separate real failures, not a one-off - a
// single-file request that burned through 24576 output tokens over 94
// seconds before finally coming back truncated and unusable, and a
// multi-file request that came back fast but recognized just 1 of 12
// classes. Both look like the same underlying problem: this model version
// misbehaving specifically under schema-constrained decoding. A fallback
// that can silently cost 94 seconds and still fail is worse than having no
// fallback there at all, since the retry loop below waits through the full
// thing before ever trying the next model.
//
// gemini-3.8-flash, the newest release, was tried as a replacement and
// rejected for a different reason: three attempts with backoff all came
// back 503 "high demand" - it simply isn't reliably available yet, not a
// correctness problem. Worth reconsidering once it's out of that state.
//
// That leaves two, both verified correct and reasonably fast on repeated
// single- and multi-file live runs.
const GEMINI_ALLOWED_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.7-flash'];

// The exact shape src/gemini-ocr.js's normalizeAIOutput() reads back,
// handed to the model as a response schema rather than only described in
// prompt prose. Constrained decoding is the single biggest lever this proxy
// has on how long a request takes: the model can no longer spend output
// tokens on a markdown fence, a preamble, a trailing explanation or a
// differently-shaped object, so there are simply fewer tokens to generate,
// and the client's own fence-stripping/brace-hunting salvage path in
// parseResponse() stops being the normal case. It is not a substitute for
// the prompt - the prompt still says what to extract and what not to invent
// - only for the half of it that describes JSON punctuation.
//
// Deliberately loose in one place: bellTimes/breakTimes times stay plain
// strings (normalizeTime() already accepts and repairs several forms, and a
// stricter pattern would make the model drop a period it could otherwise
// half-read); weeklySchedule is a fixed set of seven arrays because a schema
// cannot express "these keys are required, the others optional".
//
// classes is an ARRAY of {key, subject, teacher, location} objects, not the
// free-form {subjectKey: [subject, teacher, location]} map an earlier
// version of this schema used. That map is impossible to describe here:
// Gemini's response_schema is the OpenAPI-3.0 subset Schema object, which -
// confirmed empirically against the real API, not just the docs - has no
// `additionalProperties`. A request that tried to schema-constrain a
// free-form map's values was rejected outright with a 400 before the model
// ever ran, for every model, every time; dropping the constraint down to a
// bare `type: 'object'` (so it was schema-legal but told the model nothing
// about what belonged inside it) made the model leave the field empty far
// more often than not - nothing about an undescribed nested object signals
// "you are still expected to fill this in". An array of fully-typed objects
// has neither problem: it is legal to describe field-by-field, and it gives
// the model exactly as much structure as the map version's prose used to.
// See src/gemini-ocr.js's normalizeAIOutput() for how "key" gets turned back
// into the app's own internal id.
const GEMINI_TIME_RANGE_SCHEMA = {
  type: 'object',
  properties: { start: { type: 'string' }, end: { type: 'string' } },
  required: ['start', 'end']
};
const GEMINI_DAY_SCHEMA = { type: 'array', items: { type: 'string', nullable: true } };
const GEMINI_COUNTDOWN_EVENTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      startDate: { type: 'string' },
      endDate: { type: 'string' }
    },
    required: ['name', 'startDate', 'endDate']
  }
};
// One shape covering everything GEMINI_PROMPT can return, discriminated by
// "documentKind" - see that prompt's own comment for why this is one prompt
// and one schema now rather than two: which fields the model actually fills
// in depends on what it decided the file was, never on which request it
// happened to receive, so there is nothing for a separate schema-per-kind to
// buy here. src/gemini-ocr.js's parseResponse reads documentKind back to
// decide which normalizer applies to the rest of the object.
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    documentKind: { type: 'string', enum: ['timetable', 'registration', 'other'] },
    bellTimes: { type: 'array', items: GEMINI_TIME_RANGE_SCHEMA },
    breakTimes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' }
        },
        required: ['name', 'start', 'end']
      }
    },
    classes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          subject: { type: 'string' },
          teacher: { type: 'string' },
          location: { type: 'string' }
        },
        required: ['key', 'subject']
      }
    },
    weeklySchedule: {
      type: 'object',
      properties: {
        0: GEMINI_DAY_SCHEMA,
        1: GEMINI_DAY_SCHEMA,
        2: GEMINI_DAY_SCHEMA,
        3: GEMINI_DAY_SCHEMA,
        4: GEMINI_DAY_SCHEMA,
        5: GEMINI_DAY_SCHEMA,
        6: GEMINI_DAY_SCHEMA
      },
      required: ['1', '2', '3', '4', '5']
    },
    reverseWeek: { type: 'boolean' },
    // "day"/"periods" as plain integers (not the source document's own
    // notation) is what lets src/gemini-ocr.js's
    // mergeRegistrationIntoCandidate match a course straight onto
    // weeklySchedule's day keys and bellTimes indices without parsing
    // anything itself.
    courses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          teacher: { type: 'string' },
          location: { type: 'string' },
          day: { type: 'integer' },
          periods: { type: 'array', items: { type: 'integer' } }
        },
        required: ['subject', 'day', 'periods']
      }
    },
    countdownEvents: GEMINI_COUNTDOWN_EVENTS_SCHEMA
  },
  required: ['documentKind', 'bellTimes', 'classes', 'weeklySchedule', 'courses', 'countdownEvents']
};

// Same reasoning as AIVisionProcessor.buildGenerationConfig() (which this
// replaces client-side) - plain structured extraction gets no benefit from
// the models' default "thinking" pass, and different model families expose
// that knob differently.
//
// maxOutputTokens is 24576, not the 8192 an earlier version of this used -
// found by running this exact prompt+schema+model list against the real
// API with a synthetic two-file request: gemini-3.6-flash hit the 8192 cap
// under schema-constrained decoding (finishReason MAX_TOKENS), burned the
// full 31 seconds doing it, and handed back JSON truncated mid-string -
// silently unusable, and the single slowest, worst failure mode this whole
// feature can produce. The same request finished in 4 seconds using well
// under 1000 tokens once the cap was raised - the model was not trying to
// say more, it just needed headroom to reach the end without being cut off
// partway through a still-valid generation. A higher ceiling costs nothing
// when it isn't needed (it bounds worst case, it doesn't change target
// length), so it stays generous for every model and file count.
// temperature is 0, not the 0.1 an earlier version of this used - this is a
// read-what's-there extraction task with a schema-constrained output, never
// a creative one, so there is nothing for sampling randomness to buy: it
// only means the same two files can come back with a different merge result
// (e.g. which slots got a placeholder replaced) between otherwise-identical
// attempts, which is exactly the "inconsistent" failure mode this feature
// most needs to avoid.
function buildGenerationConfig(model, schema) {
  return {
    response_mime_type: 'application/json',
    response_schema: schema,
    temperature: 0,
    maxOutputTokens: 24576,
    thinkingConfig: /^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' }
  };
}

// What a single submitted file may be. Images and PDFs are the two things
// Gemini actually *looks at* rather than flattening to text (see its
// document-understanding docs), and between them they cover every way a
// student realistically has a timetable on their phone: a photo, a
// screenshot, an iPhone HEIC straight out of the camera roll, or the PDF
// the school published. Anything else is refused here rather than being
// forwarded and billed for.
const GEMINI_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf'
];
// A downscaled JPEG (see src/gemini-ocr.js's encodeCanvasAsJpeg) is
// realistically a few hundred KB base64-encoded; this caps well above that
// so a legitimate photo - or a pass-through PDF the browser could not
// re-encode - is never rejected, while still bounding how much upstream
// bandwidth/tokens one request can burn.
const MAX_FILE_BASE64_LENGTH = 10_000_000;
// Gemini's own inline-data ceiling for a whole request is 20MB; this stays
// under it with room for the prompt, and is what stops "send several files
// at once" from turning into an unbounded upload.
const MAX_TOTAL_BASE64_LENGTH = 18_000_000;
const MAX_FILES_PER_REQUEST = 6;

const GEMINI_RATE_LIMIT = 20;

// Reads either the current `files: [{mime_type, data}, ...]` body or the
// older single-`image` one, so a client still running from a stale service
// worker cache keeps working after this Worker is redeployed. Returns a
// plain error string rather than throwing - every failure here is a 400
// with that message.
function readGeminiFiles(body) {
  const files = Array.isArray(body?.files) ? body.files : body?.image ? [body.image] : null;
  if (!files || !files.length) return { error: 'Missing or invalid files' };
  if (files.length > MAX_FILES_PER_REQUEST) {
    return { error: `At most ${MAX_FILES_PER_REQUEST} files per request` };
  }
  let total = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file.mime_type !== 'string' ||
      !GEMINI_ALLOWED_MIME_TYPES.includes(file.mime_type) ||
      typeof file.data !== 'string' ||
      !file.data ||
      file.data.length > MAX_FILE_BASE64_LENGTH
    ) {
      return { error: 'Missing or invalid files' };
    }
    total += file.data.length;
  }
  if (total > MAX_TOTAL_BASE64_LENGTH) return { error: 'Submitted files are too large' };
  return { files };
}

async function handleGeminiRequest(request, env, headers, ip) {
  // A warm-up ping, sent the moment the user opens the file picker (see
  // src/gemini-ocr.js's warmUpGeminiProxy) - long before there's anything
  // to actually send. It exists purely to pay the connection's setup cost
  // (DNS, TLS, and this Worker's own first-request initialization) while
  // the user is still choosing a file, instead of on the critical path
  // afterwards. Deliberately does no work, calls nothing upstream, and is
  // not rate-limited: it must stay far cheaper than the request it is
  // warming the path for, or it would be a worse denial-of-service target
  // than the real endpoint.
  if (request.method === 'GET') return json({ ok: true }, 200, headers);
  if (request.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, headers);

  const rateLimit = await isRateLimited(env, ip, 'gemini', GEMINI_RATE_LIMIT);
  // Diagnostic only - not sensitive (no IPs, no counts, just which code
  // path ran) - on every response so it can be checked with one curl
  // request instead of needing dashboard log access.
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }
  const { model } = body || {};
  if (!GEMINI_ALLOWED_MODELS.includes(model)) {
    return json({ error: { message: 'Unsupported model' } }, 400, headers);
  }
  const parsedFiles = readGeminiFiles(body);
  if (parsedFiles.error) return json({ error: { message: parsedFiles.error } }, 400, headers);
  if (!env.GEMINI_API_KEY) {
    return json({ error: { message: 'Worker 尚未設定 GEMINI_API_KEY。' } }, 500, headers);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
  // Every submitted file goes into one part list, in the order the user
  // picked them. In practice src/gemini-ocr.js now sends exactly one file
  // per request (each classified and extracted independently - see
  // recognizeAndMerge for why), but this stays capable of taking several -
  // e.g. two photos of one physical page split across the frame. The prompt
  // leads, so the instructions are in context before the first file rather
  // than after the last.
  const contents = [
    {
      parts: [
        { text: buildGeminiPrompt(todayIsoInTaipei()) },
        ...parsedFiles.files.map(file => ({
          inline_data: { mime_type: file.mime_type, data: file.data }
        }))
      ]
    }
  ];
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: buildGenerationConfig(model, GEMINI_RESPONSE_SCHEMA)
      })
    });
    // Piped straight through rather than parsed and re-serialized here: the
    // body is JSON the client parses itself either way, and buffering the
    // whole thing in the Worker first only adds the upstream's full
    // download time to every request before a single byte reaches the
    // browser.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}
// ==== /nl-edit - natural-language schedule edits ============================
//
// Same discipline as /gemini above: the client (src/editor-nl-edit.js) only
// ever sends {model, text, context} - a short instruction plus a small,
// already-typed snapshot of the caller's own current schedule. This Worker
// owns the actual prompt and response_schema, so the deployed proxy URL
// (public in the client bundle either way, same reasoning as /gemini) can
// only ever be used to run this one fixed "turn this instruction into one
// schedule edit" request, never an arbitrary free-form prompt.
//
// Reuses GEMINI_API_KEY and GEMINI_ALLOWED_MODELS rather than needing its
// own secret or its own model list - it's the same underlying Gemini access,
// just a different fixed prompt/schema pair, same reasoning as /vocab-sync
// reusing /sync's Firebase credentials instead of needing its own.

// Deliberately tight: a real instruction ("把我週二第三節改成物理") is a
// handful of words. Anything dramatically longer than that is not a
// schedule-edit instruction this feature is meant to serve - refusing it
// here keeps a misuse attempt cheap to reject instead of costing a Gemini
// call.
const MAX_NL_EDIT_TEXT_LENGTH = 200;
// The context is just the caller's own weeklySchedule/classes/bellTimes
// (see buildNlEditContext in src/editor-nl-edit.js) - a real schedule is a
// few KB of JSON at most. This stays generous above that while still
// refusing something that's clearly not this shape (a client bug, or a
// request built by hand that skipped the real client entirely) before it
// ever reaches Gemini.
const MAX_NL_EDIT_CONTEXT_LENGTH = 20000;
const NL_EDIT_RATE_LIMIT = 20;
// A generous ceiling on how many distinct edits one instruction can request
// - guidance for the model (see buildNlEditPrompt), re-enforced for real
// client-side in editor-nl-edit.js's applyNlEditOps (the Worker never
// parses the structured content itself, only proxies it - see
// handleNlEditRequest's own comment). Mentioned here mainly so the number
// only has to be kept in sync with the prompt in one place.
const MAX_NL_EDIT_OPS = 8;

// One item in the "ops" array below - the exact shape src/editor-nl-edit.js's
// applyNlEditOps() reads back for each edit. Same reasoning as
// GEMINI_RESPONSE_SCHEMA above: Gemini's response_schema has no way to
// express "this field only when that one has this value", so every field is
// always present and the unused ones sit at their nullable/empty default
// instead. `day`/`period`/`fromDay`/`fromPeriod`/`toDay`/`toPeriod` are
// nullable integers rather than a sentinel like -1, mirroring
// GEMINI_DAY_SCHEMA's own use of `nullable` for exactly this "not
// applicable" case.
const NL_EDIT_OP_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['setSlot', 'moveSlot', 'swapSlot', 'clearSlot'] },
    day: { type: 'integer', nullable: true },
    period: { type: 'integer', nullable: true },
    subject: { type: 'string' },
    teacher: { type: 'string' },
    location: { type: 'string' },
    fromDay: { type: 'integer', nullable: true },
    fromPeriod: { type: 'integer', nullable: true },
    toDay: { type: 'integer', nullable: true },
    toPeriod: { type: 'integer', nullable: true }
  },
  required: [
    'op',
    'day',
    'period',
    'subject',
    'teacher',
    'location',
    'fromDay',
    'fromPeriod',
    'toDay',
    'toPeriod'
  ]
};

// "ops" replaces the single flat op/day/period/... this schema used to have
// at the top level - one instruction can now describe several edits at
// once (see buildNlEditPrompt), applied by the client in array order. A
// single-edit instruction (still the common case) is simply an array with
// one item; "unclear"/"not_found" leave it empty.
const NL_EDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'unclear', 'not_found'] },
    reason: { type: 'string' },
    ops: { type: 'array', items: NL_EDIT_OP_SCHEMA }
  },
  required: ['status', 'reason', 'ops']
};

// The fixed, server-owned prompt - the client never sends prompt text of
// its own (see the top-of-section comment). `context` is embedded directly
// rather than sent as a separate structured turn: a single-turn
// generateContent call has nowhere else to put it, and it's already small
// (see MAX_NL_EDIT_CONTEXT_LENGTH).
function buildNlEditPrompt(text, context) {
  return `You translate one Traditional Chinese natural-language instruction about editing a weekly class schedule into a short, ordered list of structured edit operations. Return a single JSON object matching this exact schema:
{
  "status": "ok",
  "reason": "",
  "ops": [
    {
      "op": "setSlot",
      "day": 2,
      "period": 2,
      "subject": "物理",
      "teacher": "",
      "location": "",
      "fromDay": null,
      "fromPeriod": null,
      "toDay": null,
      "toPeriod": null
    }
  ]
}

The current schedule, given as read-only context (never invent a day, period, or class that isn't consistent with it):
${JSON.stringify(context)}

"classes" above is every currently defined course ({key, subject, teacher, location}). "weeklySchedule" maps a day number to an array of class keys, one per period (an empty string means that period is free that day). "bellTimes" is the list of [start, end] 24-hour times, one per period, in the same order/index as weeklySchedule's arrays.

Day numbering: 0 = 週日, 1 = 週一, 2 = 週二, 3 = 週三, 4 = 週四, 5 = 週五, 6 = 週六 (matches JavaScript's Date.getDay(), the same numbering weeklySchedule's own keys already use).
Period numbering: 0-based, matching the index into weeklySchedule's arrays and bellTimes (period 0 is 第一節, period 1 is 第二節, and so on).

The instruction to translate: "${text}"

"ops" is an ORDERED list of edits, applied one after another. Most instructions describe exactly one edit, so "ops" almost always has exactly one item - but when the instruction clearly lists several distinct edits (e.g. joined by "而且"/"然後"/"，"/"、", or a numbered/bulleted list), include one item per edit, in the same order the instruction gives them, up to at most ${MAX_NL_EDIT_OPS} items. Never split one single edit into several items, and never merge two distinct edits into one item. Each op is evaluated against the schedule AS IT WOULD STAND after every earlier op in this same list has already been applied - e.g. moving a class out of a slot and then putting a different class into that now-empty slot is two valid, ordinary ops in order, not a conflict.

Decide each op's "op":
- "setSlot": set or replace what one specific day+period contains. Fill "day", "period", and "subject" (required - the Chinese subject name). Fill "teacher"/"location" only when the instruction gives them, or when an existing entry in "classes" already names that exact subject (reuse that entry's teacher/location rather than guessing); otherwise leave "teacher"/"location" as empty strings. Leave every "from*"/"to*" field null.
- "moveSlot": move whatever currently occupies one day+period to a different (currently empty, or about to be emptied by an earlier op in this list) day+period, without changing what class it is. Fill "fromDay", "fromPeriod", "toDay", "toPeriod". Leave "subject"/"teacher"/"location" as empty strings and "day"/"period" null.
- "swapSlot": exchange whatever occupies two day+period slots with each other in one step - use this instead of two "moveSlot" ops whenever the instruction describes trading/swapping/exchanging two slots' contents for each other. Either or both slots may currently be empty (swapping with an empty slot is just a move in disguise, still valid). Fill "fromDay"/"fromPeriod" for one slot and "toDay"/"toPeriod" for the other - which one is "from" vs "to" doesn't matter, the effect is symmetric. Leave "subject"/"teacher"/"location" as empty strings and "day"/"period" null.
- "clearSlot": empty out one day+period slot entirely, removing whatever class is currently there without putting anything else in its place - use this whenever the instruction asks to cancel/clear/remove a class from a slot rather than replace it with a different one. Fill "day", "period". Leave "subject"/"teacher"/"location" as empty strings and every "from*"/"to*" field null.

Decide "status":
- "ok": every part of the instruction maps cleanly onto the operations above, using only days/periods/classes that make sense against the given context (accounting for any earlier op in the same list, as above).
- "unclear": the instruction (or any one part of it, if it lists several) is ambiguous, contradictory, does not describe a schedule edit at all, or cannot be confidently reduced to the operations above. Leave "ops" empty. Briefly explain why in "reason" (Traditional Chinese, one short sentence).
- "not_found": the instruction is clear about what kind of edit(s) it wants, but names a day, period, or existing class that does not exist in the given context at the point it's referenced (e.g. a period number beyond how many periods exist, or moving/swapping/clearing a day+period that is currently empty and wasn't just filled by an earlier op in this same list). Leave "ops" empty. Briefly explain in "reason" (Traditional Chinese, one short sentence).

Never invent a day, period, subject, teacher, or location the instruction does not give you or that "classes"/"weeklySchedule" does not already support. When any part of the instruction is in doubt, prefer "unclear" over guessing - a partially-correct multi-edit instruction should not silently drop the part that didn't make sense.
Return ONLY the raw JSON object — no markdown fences, no comments, no extra text.`;
}

// Structural shape check only (mirrors readGeminiFiles' own level of
// strictness) - src/editor-nl-edit.js's validateNlEditResult() is what
// actually re-checks the *response* against this same context once Gemini
// answers; this just makes sure what's about to be embedded in the prompt
// is the shape the prompt claims it is.
function readNlEditContext(context) {
  if (!context || typeof context !== 'object') return null;
  const { weeklySchedule, classes, bellTimes } = context;
  if (!weeklySchedule || typeof weeklySchedule !== 'object' || Array.isArray(weeklySchedule))
    return null;
  if (!Array.isArray(classes) || !Array.isArray(bellTimes)) return null;
  if (Object.values(weeklySchedule).some(day => !Array.isArray(day))) return null;
  if (
    classes.some(
      entry => !entry || typeof entry !== 'object' || typeof entry.key !== 'string' || typeof entry.subject !== 'string'
    )
  )
    return null;
  if (
    bellTimes.some(
      item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string'
    )
  )
    return null;
  return { weeklySchedule, classes, bellTimes };
}

async function handleNlEditRequest(request, env, headers, ip) {
  if (request.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, headers);

  const rateLimit = await isRateLimited(env, ip, 'nl-edit', NL_EDIT_RATE_LIMIT);
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }
  const { model } = body || {};
  if (!GEMINI_ALLOWED_MODELS.includes(model)) {
    return json({ error: { message: 'Unsupported model' } }, 400, headers);
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_NL_EDIT_TEXT_LENGTH) {
    return json({ error: { message: 'Missing or invalid text' } }, 400, headers);
  }
  const context = readNlEditContext(body?.context);
  if (!context) return json({ error: { message: 'Missing or invalid context' } }, 400, headers);
  if (JSON.stringify(context).length > MAX_NL_EDIT_CONTEXT_LENGTH) {
    return json({ error: { message: 'Context too large' } }, 400, headers);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: { message: 'Worker 尚未設定 GEMINI_API_KEY。' } }, 500, headers);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
  const contents = [{ parts: [{ text: buildNlEditPrompt(text, context) }] }];
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: buildGenerationConfig(model, NL_EDIT_RESPONSE_SCHEMA)
      })
    });
    // Piped straight through, same reasoning as handleGeminiRequest's own
    // response - the client parses this JSON itself either way.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}

// ==== /vocab-ai - Orbit Vocab's live, per-learner AI features ===============
//
// Two on-demand features from the sibling repo Orbit Vocab (see that repo's
// README/vocab-ai.js), both genuinely needing a LIVE, per-request Gemini
// call rather than that repo's offline batch script
// (scripts/generate_ai_signals.py, which pre-generates one static
// confusedWith/mnemonic/priorDifficulty per word into data/ai_signals.json
// at build time): each request here depends on THIS learner's own data -
// their actual recorded wrong-answer history for one word, or which
// specific handful of words they're reviewing right now - which a
// build-time batch job run once for every word in the vocabulary has no
// way to know.
//   - kind: "mnemonic" - one memory hook targeted at a specific word's
//     recorded wrong-answer pattern for THIS learner, not the generic
//     one-per-word hook data/ai_signals.json already ships offline.
//   - kind: "story" - one short story weaving together a handful of this
//     learner's current 答錯待複習/學習中 words as a memory-palace-style
//     group mnemonic, reviewed together instead of word-by-word.
// No passcode/identity check here (unlike /vocab-sync) - this isn't tied to
// any one learner's sync pairing, so it uses the same trust model /gemini
// already does: rate-limited by IP and gated by GEMINI_API_KEY, callable by
// anyone who knows the URL (CORS only stops a browser from a disallowed
// origin reading the response, not a direct request from reaching this
// far - see readGeminiFiles/cleanVocabAiText's own comments for why every
// field is still treated as untrusted input regardless). Its own rate-limit
// bucket ('vocab-ai', see isRateLimited's `feature` keying) means abuse here
// can never eat into /gemini's or /vocab-sync's own quota, and vice versa -
// same reasoning as every other route in this file.

// Reuses /gemini's own GEMINI_API_KEY secret (see handleGeminiRequest) -
// nothing new to configure once AI 辨識課表照片 is already set up. Not
// client-selectable (unlike /gemini's own `model` field): both features here
// are small, fixed-shape, low-stakes generation tasks with no multi-model
// fallback chain worth maintaining, so this just picks the fastest verified
// model from GEMINI_ALLOWED_MODELS above rather than exposing a second knob.
const VOCAB_AI_MODEL = 'gemini-3.5-flash-lite';
// Tighter than GEMINI_RATE_LIMIT (20/hour is for a whole schedule-photo
// import session; this is for a single learner's own occasional taps on
// "產生記憶法"/"產生故事" while reviewing) - generous for real use, still
// bounded per IP.
const VOCAB_AI_RATE_LIMIT = 30;
// Bounds on every piece of client-submitted text below - see
// cleanVocabAiText's own comment on why these are enforced here rather than
// trusted from the client.
const VOCAB_AI_MAX_WORD_LEN = 40;
const VOCAB_AI_MAX_POS_LEN = 20;
const VOCAB_AI_MAX_MEANING_LEN = 200;
const VOCAB_AI_MAX_WRONG_ANSWERS = 5;
const VOCAB_AI_MAX_WRONG_ANSWER_LEN = 40;
const VOCAB_AI_MIN_STORY_WORDS = 2;
const VOCAB_AI_MAX_STORY_WORDS = 6;

const VOCAB_MNEMONIC_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { mnemonic: { type: 'string' } },
  required: ['mnemonic']
};
const VOCAB_STORY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { story: { type: 'string' } },
  required: ['story']
};

// Bounds and normalizes one piece of client-submitted text (a word, a POS
// tag, a Chinese meaning, a past wrong answer) before it ever reaches a
// prompt. This path has no passcode gating the way /vocab-sync does (see
// that section's own comment) - a POST here is reachable by anyone who
// knows the URL, not just this app's own frontend - so every field is
// treated as untrusted input, same posture as /gemini's own
// readGeminiFiles, even though in normal use it's always this app's own
// vocab.json words and the learner's own typed spelling attempts. Returns
// null (never a silently truncated value) for anything that doesn't look
// like real short text, so the caller 400s outright rather than forwarding
// garbage into a prompt.
function cleanVocabAiText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

// Deliberately asks the model to diagnose the mistake PATTERN (a swapped
// letter pair, a dropped double letter, a missing silent letter) rather than
// just "here's a mnemonic for this word" - a hook that targets the specific
// way this learner keeps getting it wrong is the entire reason this needs a
// live per-user call instead of reusing data/ai_signals.json's one static
// mnemonic every learner already sees.
function buildVocabMnemonicPrompt(word, pos, meaning, wrongAnswers) {
  const mistakesLine = wrongAnswers.length
    ? `This learner has previously typed these WRONG spellings for this exact word: ${wrongAnswers
        .map((w) => `"${w}"`)
        .join(', ')}. Look for a real pattern across these mistakes (e.g. a swapped letter pair, a dropped double letter, a missing silent letter, a common homophone mix-up) and target the mnemonic at THAT pattern specifically.`
    : `No specific past misspelling was recorded for this word - address the most likely spelling risk in the word itself instead.`;
  return `You are helping a Taiwanese high school student remember how to correctly spell an English vocabulary word they keep getting wrong.

Word: "${word}" (${pos || 'unknown part of speech'})
Chinese meaning: ${meaning || '(none given)'}
${mistakesLine}

Write ONE short, specific mnemonic (under 30 words, in Traditional Chinese, weaving in the English word/letters where useful) that would actually help THIS learner stop making THIS mistake. Do not just restate the correct spelling - give a genuinely memorable hook tied to the mistake pattern above.`;
}

// Lists every target word explicitly (not just "5 words") and demands they
// all appear, spelled exactly as given - the client-side validation this
// feeds (see Orbit Vocab's vocab-ai.js) re-checks that demand was actually
// met rather than trusting the model's own compliance, same defensive
// posture as generate_ai_signals.py's clean_item().
function buildVocabStoryPrompt(words) {
  const rows = words.map((w) => `- "${w.word}"${w.meaning ? ` (${w.meaning})` : ''}`).join('\n');
  return `You are creating a memory-palace-style mnemonic story for a Taiwanese high school student studying English vocabulary.

Below are ${words.length} target English words with their Chinese meanings:
${rows}

Write ONE short, vivid, memorable story in Traditional Chinese (under 150 words) that uses EVERY one of these target words at least once, spelled exactly as given, in Latin letters (never translate them into Chinese, never split them up with spaces or punctuation in the middle) - the story itself is what should help the student recall all of them together as one group, not word by word.`;
}

async function callVocabAiGemini(prompt, schema, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(VOCAB_AI_MODEL)}:generateContent?key=${env.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: buildGenerationConfig(VOCAB_AI_MODEL, schema)
    })
  });
  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Gemini response missing text');
  return JSON.parse(text);
}

async function handleVocabAiRequest(request, env, headers, ip) {
  if (request.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, headers);

  const rateLimit = await isRateLimited(env, ip, 'vocab-ai', VOCAB_AI_RATE_LIMIT);
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: { message: 'Worker 尚未設定 GEMINI_API_KEY。' } }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }

  try {
    if (body?.kind === 'mnemonic') {
      const word = cleanVocabAiText(body.word, VOCAB_AI_MAX_WORD_LEN);
      if (!word) return json({ error: { message: 'Missing or invalid word' } }, 400, headers);
      const pos = typeof body.pos === 'string' ? body.pos.trim().slice(0, VOCAB_AI_MAX_POS_LEN) : '';
      const meaning = typeof body.meaning === 'string' ? body.meaning.trim().slice(0, VOCAB_AI_MAX_MEANING_LEN) : '';
      const wrongAnswers = (Array.isArray(body.wrongAnswers) ? body.wrongAnswers : [])
        .filter((w) => typeof w === 'string' && w.trim())
        .slice(0, VOCAB_AI_MAX_WRONG_ANSWERS)
        .map((w) => w.trim().slice(0, VOCAB_AI_MAX_WRONG_ANSWER_LEN));

      const result = await callVocabAiGemini(buildVocabMnemonicPrompt(word, pos, meaning, wrongAnswers), VOCAB_MNEMONIC_RESPONSE_SCHEMA, env);
      const mnemonic = typeof result.mnemonic === 'string' ? result.mnemonic.trim() : '';
      if (!mnemonic) return json({ error: { message: 'AI 沒有回傳有效的記憶法。' } }, 502, headers);
      return json({ mnemonic }, 200, headers);
    }

    if (body?.kind === 'story') {
      const words = (Array.isArray(body.words) ? body.words : [])
        .slice(0, VOCAB_AI_MAX_STORY_WORDS)
        .map((w) => ({
          word: cleanVocabAiText(w && w.word, VOCAB_AI_MAX_WORD_LEN),
          meaning: w && typeof w.meaning === 'string' ? w.meaning.trim().slice(0, VOCAB_AI_MAX_MEANING_LEN) : ''
        }))
        .filter((w) => w.word);
      if (words.length < VOCAB_AI_MIN_STORY_WORDS) {
        return json({ error: { message: `至少需要 ${VOCAB_AI_MIN_STORY_WORDS} 個單字才能產生故事` } }, 400, headers);
      }

      const result = await callVocabAiGemini(buildVocabStoryPrompt(words), VOCAB_STORY_RESPONSE_SCHEMA, env);
      const story = typeof result.story === 'string' ? result.story.trim() : '';
      if (!story) return json({ error: { message: 'AI 沒有回傳有效的故事。' } }, 502, headers);
      // Echoes back the exact word list actually sent to the model (after
      // this function's own filtering above) - not the client's original,
      // unfiltered request array - so the client's own "did it really use
      // every word" check (see Orbit Vocab's vocab-ai.js) validates against
      // what was actually sent to the model.
      return json({ story, words: words.map((w) => w.word) }, 200, headers);
    }

    return json({ error: { message: 'Missing or invalid kind' } }, 400, headers);
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}

// ==== /sync - cross-device sync proxy =======================================
//
// Requires more setup than /gemini, because closing the gap properly means
// closing Firestore's direct, ruleset-gated door entirely - otherwise an
// abuser just skips this Worker and hits Firestore directly, same as
// before. That means:
//   1. This Worker authenticates to Firestore as a Google Cloud *service
//      account* (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY below), not
//      as an anonymous client. Service-account access is treated the same
//      as the Admin SDK: it bypasses Firestore Security Rules entirely, by
//      design - the rules only ever gated unauthenticated client access.
//   2. Once this Worker is live, set the Firestore rule for
//      /orbit-schedules/{doc} to `allow read, write: if false`. That
//      closes the direct-client door completely - real, unauthenticated
//      public access - since actual devices now only ever reach this
//      Worker, and this Worker's own traffic to Firestore ignores that
//      rule anyway (see point 1). See README's cross-device sync section
//      for the exact rule text and the full one-time setup this needs.
//
// One shared sync code plus a separate manager passcode, with the passcode
// gating *only* write access - not two parallel codes:
//   - Creating a sync (POST, below) mints a plain sync code (the document's
//     own ID, same as the original single-code design) and a separate,
//     unrelated *manager passcode*, returning both to the caller once. Only
//     the passcode's SHA-256 hash is ever stored, as `managerPasscodeHash`
//     on the document, so a leak of the Firestore data itself can't be
//     turned back into a working passcode.
//   - GET (read/poll) never needs the passcode - anyone with the sync code
//     can read, exactly like the original design. Optionally supplying
//     `&passcode=` resolves whether that passcode is *this* document's
//     manager passcode (`role: 'manager'` in the response if so) - used at
//     join time and by an already-joined device unlocking manager mode
//     later, never by ordinary polling.
//   - PATCH (write) and DELETE both require the correct passcode - in the
//     JSON body for PATCH, as a query param for DELETE (which this app
//     never sends a body with). Missing or wrong passcode is a 403,
//     distinct from a nonexistent/mistyped code (its own message) - this is
//     the actual fix for what used to be true only by UI convention
//     (src/sync.js's applyEditorRoleLock): previously *any* holder of the
//     single code could PATCH or DELETE, because there was nothing else to
//     check.

// Must match the code/passcode format the client (and this Worker's own
// generateSyncCode below) produce - rejecting a malformed code here means
// it never even reaches Firestore, and the error message is the same
// either way. Passcodes reuse the exact same shape - they're just another
// random string from the same alphabet, generated the same way.
const SYNC_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{8}$/;
const SYNC_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SYNC_CODE_LENGTH = 8;

// `length` defaults to Orbit's own 8-character code/passcode shape;
// VOCAB_SYNC_APP's single-passcode design (see below) passes a longer one,
// since that one string is the ONLY secret standing between the internet
// and a learner's progress, unlike Orbit's own code+passcode pair.
function generateSyncCode(length = SYNC_CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => SYNC_CODE_ALPHABET[byte % SYNC_CODE_ALPHABET.length]).join('');
}

// Passcodes are high-entropy and randomly generated (never user-chosen), so
// a plain, fast SHA-256 - no salt, no slow KDF - is enough: there's no weak
// human-picked passphrase here for an attacker to dictionary-guess, only a
// ~40-bit random string they'd have to brute force from scratch either way.
// This exists purely so a leak of the Firestore data itself (e.g. project
// access, a misconfigured export) doesn't also hand over live write access
// - the hash can't be turned back into the passcode.
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

// /vocab-sync's single-passcode design (see VOCAB_SYNC_APP below) never uses
// a client-supplied passcode as a Firestore document id directly - that
// would put the plaintext secret in plain sight in the database itself
// (visible to anyone with Firestore/GCP console access, a backup export, or
// a misconfigured rule), the exact thing hashing a passcode is for
// elsewhere in this file. Hashing it into the lookup key instead means the
// only way to ever reach a given document is to already know the passcode
// that hashes to it - there's nothing else here to check it against, and
// nothing else needed: same "prove you know the secret" property as
// ORBIT_SYNC_APP's managerPasscodeHash comparison, just reached by using
// the hash AS the address instead of storing it alongside one.
async function docIdForPasscode(passcode) {
  return sha256Hex(passcode);
}

// Same cap as the Firestore rule (request.resource.data.payload.size() <
// 20000) - checked again here so an oversized write is rejected before ever
// spending a Firestore call on it, not because the rule can't be trusted.
const MAX_PAYLOAD_LENGTH = 20000;

// Sync's own legitimate traffic looks nothing like the AI import feature's:
// two paired devices poll every 8 seconds *for as long as the tab stays
// open*, so a single active device is ~450 requests/hour all on its own,
// and a shared IP (school Wi-Fi, one household) can easily be several
// devices at once. Reads (GET, i.e. polling) need a limit generous enough
// that this normal, legitimate traffic pattern never trips it - it's only
// meant to catch a genuine scripted flood, not "several classmates behind
// the same NAT". Writes (PATCH) are rarer in normal use (only when a
// manager device actually has unsaved changes to publish) so they get a
// much tighter cap, since a write is also the only request that can create
// throwaway Firestore documents or burn write quota.
const SYNC_READ_RATE_LIMIT = 6000;
const SYNC_WRITE_RATE_LIMIT = 300;
// A manager deleting the whole shared document (see src/sync.js's
// orbitSyncDeleteForEveryone) is rare and destructive by nature - once per
// pairing at most in any normal flow - so this gets its own tight limit,
// tighter than an ordinary write, on its own counter (kind 'delete') rather
// than sharing the write bucket.
const SYNC_DELETE_RATE_LIMIT = 20;
// Creating a brand new pairing (see src/sync.js's orbitSyncCreate) is just
// as rare/one-off as deleting one - same tight cap, own counter.
const SYNC_CREATE_RATE_LIMIT = 20;
// A GET that also carries a passcode is a credential check (join-time role
// resolution, or an existing viewer device unlocking manager mode) - unlike
// ordinary polling there's no legitimate reason to do this often, so it
// gets its own bucket at the same tight cap as an actual write rather than
// sharing the generous read bucket polling needs. (Not that brute-forcing
// an 8-character passcode is remotely feasible at any rate limit - this is
// just not the bucket meant for high-frequency legitimate traffic.)
const SYNC_VERIFY_RATE_LIMIT = 300;

// Same cap as the Firestore rule guarding this collection (see README) -
// Orbit's own schedule payload is already a compressed transfer string, so
// this stays small.
const ORBIT_MAX_PAYLOAD_LENGTH = MAX_PAYLOAD_LENGTH;

// ---- /vocab-sync's own single-passcode design -------------------------
//
// Orbit Vocab has no manager/viewer split the way Orbit's own /sync does
// (see VOCAB_SYNC_APP's singleCredential below) - every pairing belongs to
// one learner's own devices, and every operation (including a plain read)
// already needs the real secret. Rather than mint a separate public "code"
// alongside a passcode the way /sync does (which would just be one more
// string to type/copy for no security benefit here - see that app's own
// sync.js), /vocab-sync uses ONE random string as both the pairing's
// identifier and its only credential: the client sends it as `?passcode=`
// on every request, and this Worker derives the actual Firestore document
// id from it (see docIdForPasscode below) rather than ever using it, or
// anything derived from it, as a client-facing lookup key on its own.
//
// Longer than Orbit's own 8-character code/passcode (see SYNC_CODE_LENGTH)
// specifically because it's now the ONLY secret guarding a learner's
// progress, not one of two. 16 characters from the same 32-symbol alphabet
// is 80 bits of entropy (32^16) - comfortably beyond brute-force range even
// before VOCAB_SYNC_WRITE_RATE_LIMIT/VOCAB_SYNC_DELETE_RATE_LIMIT below are
// factored in.
const VOCAB_PASSCODE_LENGTH = 16;
const VOCAB_PASSCODE_PATTERN = /^[2-9A-HJ-NP-Z]{16}$/;

// ---- /vocab-sync's own rate-limit buckets ----------------------------
//
// A separate set of counters from /sync's above (see isRateLimited's
// `feature` keying) - vocab-sync's traffic shape is different enough to
// tune independently. There's no 'verify' bucket distinct from 'read' any
// more (unlike an earlier revision of this design): every read already
// carries and checks the passcode, so there's no passcode-less "just
// polling" read left to charge against a separate, cheaper bucket - this is
// simply the bucket ordinary activity-driven polling lands in (see that
// app's sync.js), generous for the same reason Orbit's own read limit is.
const VOCAB_SYNC_READ_RATE_LIMIT = 6000;
const VOCAB_SYNC_WRITE_RATE_LIMIT = 300;
const VOCAB_SYNC_DELETE_RATE_LIMIT = 20;
const VOCAB_SYNC_CREATE_RATE_LIMIT = 20;
// Firestore's own per-document cap is ~1 MiB, but this is set far below
// that on purpose: Orbit Vocab's sync.js writes progress as
// gzip-compressed, delta-timestamped, positional tuples rather than plain
// keyed JSON (see that file's "Compact wire format" comment) specifically
// to keep this small - every field that isn't read back anywhere is
// dropped before it's ever compressed, not just compressed harder. Even a
// worst case of every one of Orbit Class's 3,060 vocab words fully attempted,
// each with a maxed-out recent-mistakes history, comes in well under
// 250,000 bytes once compressed and base64-encoded; this cap stays a
// comfortable multiple above that real worst case while still refusing a
// payload that's clearly not this format at all (a client bug, or a
// request that skipped sync.js's own encoding entirely) long before it
// costs a Firestore write.
const VOCAB_MAX_PAYLOAD_LENGTH = 262144;

function base64UrlFromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlFromString(str) {
  return base64UrlFromBytes(new TextEncoder().encode(str));
}
function pemToDer(pem) {
  const b64 = pem
    .trim()
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    // Handles pasting the key straight out of the downloaded JSON's
    // `private_key` string value, literal backslash-n escapes and all,
    // instead of the JSON-decoded value with real line breaks - a common
    // copy-paste artifact since Cloudflare's secret box is a single text
    // field either way. Order matters: this must run before the generic
    // whitespace strip below, since a *real* newline is already whitespace
    // but a literal `\n` (backslash then the letter n) is two ordinary,
    // non-whitespace characters that would otherwise survive into the
    // base64 string and corrupt it.
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Cached per-isolate (module scope) so a burst of requests on the same
// isolate reuses one access token instead of round-tripping to Google's
// OAuth endpoint on every single Firestore call - the token is valid for an
// hour, refetched a little early rather than right at expiry.
let cachedFirebaseToken = null;
async function getFirebaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && cachedFirebaseToken.expiry > now + 60) {
    return cachedFirebaseToken.token;
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed: ${await response.text()}`);
  }
  const data = await response.json();
  cachedFirebaseToken = { token: data.access_token, expiry: now + (data.expires_in || 3600) };
  return cachedFirebaseToken.token;
}

// `collection` lets the same helpers below serve both /sync
// (orbit-schedules) and /vocab-sync (vocab-progress-sync) - see
// ORBIT_SYNC_APP/VOCAB_SYNC_APP - without duplicating any of this file's
// actual Firestore/JWT plumbing.
function firestoreDocUrl(env, collection, code) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${encodeURIComponent(collection)}/${encodeURIComponent(code)}`;
}
async function firestoreErrorMessage(response) {
  const errorJson = await response.json().catch(() => ({}));
  return errorJson.error?.message || response.statusText || `HTTP ${response.status}`;
}

async function firestoreGet(env, collection, code) {
  const token = await getFirebaseAccessToken(env);
  const response = await fetch(firestoreDocUrl(env, collection, code), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 404) {
    return { exists: false, updateTime: '', payload: '', managerPasscodeHash: '' };
  }
  if (!response.ok) throw new Error(await firestoreErrorMessage(response));
  const doc = await response.json();
  return {
    exists: true,
    updateTime: doc.updateTime || '',
    payload: doc.fields?.payload?.stringValue || '',
    managerPasscodeHash: doc.fields?.managerPasscodeHash?.stringValue || ''
  };
}

// Seeds both fields the document will ever have at once - `payload` and the
// passcode hash it'll be checked against for every future write. Explicitly
// listing both in updateMask (rather than the single-field mask an ordinary
// write uses - see firestorePatch below) is what makes this a real create
// instead of a same-shaped update: without it there'd be nothing here
// distinguishing "first write" from "later write", and no way to seed
// managerPasscodeHash at all through the single-field write path.
async function firestoreCreate(env, collection, code, managerPasscodeHash, payload) {
  const token = await getFirebaseAccessToken(env);
  const response = await fetch(
    `${firestoreDocUrl(env, collection, code)}?updateMask.fieldPaths=payload&updateMask.fieldPaths=managerPasscodeHash`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          payload: { stringValue: payload },
          managerPasscodeHash: { stringValue: managerPasscodeHash }
        }
      })
    }
  );
  if (!response.ok) throw new Error(await firestoreErrorMessage(response));
  const doc = await response.json();
  return { updateTime: doc.updateTime || '' };
}

// An ordinary write - the single-field mask means this can never touch
// managerPasscodeHash, however it's called, so a write is never able to
// change the passcode a document was created with.
async function firestorePatch(env, collection, code, payload) {
  const token = await getFirebaseAccessToken(env);
  const response = await fetch(
    `${firestoreDocUrl(env, collection, code)}?updateMask.fieldPaths=payload`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { payload: { stringValue: payload } } })
    }
  );
  if (!response.ok) throw new Error(await firestoreErrorMessage(response));
  const doc = await response.json();
  return { updateTime: doc.updateTime || '' };
}

// Wipes the shared document entirely - see src/sync.js's
// orbitSyncDeleteForEveryone (and its vocab-sync client-side equivalent).
// Unlike unlinking (a purely client-side, one device forgetting its own
// pairing code), this is the one operation that actually reaches into
// Firestore and removes the document every paired device reads from, so
// every device sharing this code loses its sync target at once. A 404
// (already gone, e.g. a retry after a dropped response) is treated the
// same as success - deleting something that's already deleted isn't an
// error from the caller's point of view.
async function firestoreDelete(env, collection, code) {
  const token = await getFirebaseAccessToken(env);
  const response = await fetch(firestoreDocUrl(env, collection, code), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await firestoreErrorMessage(response));
  }
}

// `appConfig` (see ORBIT_SYNC_APP/VOCAB_SYNC_APP below) is what lets this
// one pair of functions serve both /sync and /vocab-sync: which Firestore
// collection, which rate-limit counters/limits, how big a payload is
// allowed, and how a request identifies+authenticates itself.
// `appConfig.singleCredential` picks between the two designs: Orbit's own
// /sync keeps its original code+separate-manager-passcode shape (reads open
// to any code holder, only writes/deletes need the passcode); Orbit Vocab's
// /vocab-sync (see VOCAB_SYNC_APP's own comment, and docIdForPasscode
// above) uses one passcode as both identifier and credential for every
// operation, including reads. Every error message, status code, and field
// name for Orbit's own /sync traffic stays byte-for-byte identical to
// before this was generalized.
async function handleSyncCreate(request, env, headers, ip, appConfig) {
  const rateLimit = await isRateLimited(
    env,
    ip,
    `${appConfig.featurePrefix}:create`,
    appConfig.createLimit
  );
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }
  const payload = body?.payload;
  if (typeof payload !== 'string' || !payload || payload.length > appConfig.maxPayloadLength) {
    return json({ error: { message: 'Missing or invalid payload' } }, 400, headers);
  }

  try {
    if (appConfig.singleCredential) {
      // One random string is both this pairing's identifier and its only
      // credential (see VOCAB_SYNC_APP's own comment) - there's no separate
      // managerPasscodeHash field to seed the way Orbit's own /sync needs,
      // because the document id itself (derived below) only ever names a
      // document reachable by someone who supplies the correct passcode.
      // An ordinary upsert PATCH (see firestorePatch) is exactly as much
      // "create" as this design ever needs.
      const passcode = generateSyncCode(appConfig.credentialLength);
      const docId = await docIdForPasscode(passcode);
      const created = await firestorePatch(env, appConfig.collection, docId, payload);
      return json({ passcode, updateTime: created.updateTime }, 200, headers);
    }
    const code = generateSyncCode();
    const managerPasscode = generateSyncCode();
    const managerPasscodeHash = await sha256Hex(managerPasscode);
    const created = await firestoreCreate(
      env,
      appConfig.collection,
      code,
      managerPasscodeHash,
      payload
    );
    return json({ code, managerPasscode, updateTime: created.updateTime }, 200, headers);
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}

async function handleSyncRequest(request, env, headers, ip, appConfig) {
  if (
    request.method !== 'GET' &&
    request.method !== 'POST' &&
    request.method !== 'PATCH' &&
    request.method !== 'DELETE'
  ) {
    return json({ error: { message: 'GET, POST, PATCH or DELETE only' } }, 405, headers);
  }

  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return json({ error: { message: 'Worker 尚未設定 Firebase 服務帳戶。' } }, 500, headers);
  }

  // Creating a new pairing needs no identifier at all yet - it mints one -
  // so it branches off before the identifier handling every other method
  // needs.
  if (request.method === 'POST') return handleSyncCreate(request, env, headers, ip, appConfig);

  const url = new URL(request.url);
  // `suppliedPasscode` is unconditionally read here (not just under
  // singleCredential) because ORBIT_SYNC_APP's own GET/DELETE branches
  // below reuse this same query-string value for their manager-passcode
  // check - only PATCH (there, sent in the body instead) needs its own.
  const suppliedPasscode = (url.searchParams.get('passcode') || '').trim();
  // The single-credential design (see VOCAB_SYNC_APP) never takes a raw
  // client-supplied identifier as a Firestore document id - see
  // docIdForPasscode's own comment on why. Every other app keeps the
  // original design: the plain code itself, pattern-validated up front so
  // a malformed one never even reaches Firestore.
  let docId;
  if (appConfig.singleCredential) {
    if (!appConfig.credentialPattern.test(suppliedPasscode)) {
      return json({ error: { message: 'Invalid passcode' } }, 400, headers);
    }
    docId = await docIdForPasscode(suppliedPasscode);
  } else {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!SYNC_CODE_PATTERN.test(code)) {
      return json({ error: { message: 'Invalid pairing code' } }, 400, headers);
    }
    docId = code;
  }

  if (request.method === 'GET') {
    if (appConfig.singleCredential) {
      // Every GET here already supplied (and, via docId above, was just
      // checked against) the real passcode - there's nothing left to
      // distinguish a "verify" call from ordinary polling the way Orbit's
      // own /sync does below, so this is simply the one read bucket.
      const rateLimit = await isRateLimited(
        env,
        ip,
        `${appConfig.featurePrefix}:read`,
        appConfig.readLimit
      );
      headers['X-RateLimit-Backend'] = rateLimit.backend;
      if (rateLimit.limited) {
        return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
      }
      try {
        const doc = await firestoreGet(env, appConfig.collection, docId);
        // A wrong passcode and a never-created one both land here and look
        // identical to the caller - see docIdForPasscode's own comment: the
        // document only ever exists under the hash of the correct
        // passcode, so there's nothing else to check it against.
        if (!doc.exists) return json({ exists: false, updateTime: '', payload: '' }, 200, headers);
        return json(
          { exists: true, updateTime: doc.updateTime, payload: doc.payload },
          200,
          headers
        );
      } catch (error) {
        return json(
          { error: { message: error.message || 'Upstream request failed' } },
          502,
          headers
        );
      }
    }
    // ORBIT_SYNC_APP's own code+manager-passcode design, unchanged from
    // before this was generalized. A passcode riding along on GET resolves
    // whether it's *this* document's manager passcode (join-time role
    // check, or an already-joined viewer device unlocking manager mode) -
    // see the SYNC_VERIFY_RATE_LIMIT comment above for why that gets its
    // own bucket instead of sharing ordinary polling's. Orbit's /sync
    // deliberately leaves reads open to anyone holding the plain sync code
    // (a teacher broadcasting one schedule to many read-only student
    // devices), so there's no passcode-less-GET refusal here the way
    // singleCredential's branch above never needs either (it never gets a
    // passcode-less GET past the docId derivation to begin with).
    const kind = suppliedPasscode ? 'verify' : 'read';
    const limit = suppliedPasscode ? appConfig.verifyLimit : appConfig.readLimit;
    const rateLimit = await isRateLimited(env, ip, `${appConfig.featurePrefix}:${kind}`, limit);
    headers['X-RateLimit-Backend'] = rateLimit.backend;
    if (rateLimit.limited) {
      return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
    }
    try {
      const doc = await firestoreGet(env, appConfig.collection, docId);
      if (!doc.exists) return json({ exists: false, updateTime: '', payload: '' }, 200, headers);
      const result = { exists: true, updateTime: doc.updateTime, payload: doc.payload };
      if (suppliedPasscode) {
        const suppliedHash = await sha256Hex(suppliedPasscode);
        if (suppliedHash === doc.managerPasscodeHash) result.role = 'manager';
      }
      return json(result, 200, headers);
    } catch (error) {
      return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
    }
  }

  if (request.method === 'PATCH') {
    const rateLimit = await isRateLimited(
      env,
      ip,
      `${appConfig.featurePrefix}:write`,
      appConfig.writeLimit
    );
    headers['X-RateLimit-Backend'] = rateLimit.backend;
    if (rateLimit.limited) {
      return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
    }
    const payload = body?.payload;
    if (typeof payload !== 'string' || !payload || payload.length > appConfig.maxPayloadLength) {
      return json({ error: { message: 'Missing or invalid payload' } }, 400, headers);
    }
    if (appConfig.singleCredential) {
      // Nothing further to check here: docId (derived above from the
      // supplied passcode) only ever names a document a correct passcode
      // could reach in the first place - see docIdForPasscode's own
      // comment. A 404 below means either this passcode was never used to
      // create a pairing, or (functionally identical from the outside)
      // it's simply wrong.
      try {
        const doc = await firestoreGet(env, appConfig.collection, docId);
        if (!doc.exists) return json({ error: { message: '找不到這組同步密碼。' } }, 404, headers);
        const result = await firestorePatch(env, appConfig.collection, docId, payload);
        return json(result, 200, headers);
      } catch (error) {
        return json(
          { error: { message: error.message || 'Upstream request failed' } },
          502,
          headers
        );
      }
    }
    // ORBIT_SYNC_APP's own manager-passcode design, unchanged - sent in the
    // body (unlike GET/DELETE's query-string `suppliedPasscode`) since this
    // app already sends a JSON body for every PATCH anyway.
    const managerPasscode = typeof body?.passcode === 'string' ? body.passcode.trim() : '';
    try {
      const doc = await firestoreGet(env, appConfig.collection, docId);
      if (!doc.exists) return json({ error: { message: '找不到這組配對代碼。' } }, 404, headers);
      const passcodeHash = managerPasscode ? await sha256Hex(managerPasscode) : '';
      if (!managerPasscode || passcodeHash !== doc.managerPasscodeHash) {
        return json({ error: { message: '需要正確的密碼才能寫入。' } }, 403, headers);
      }
      const result = await firestorePatch(env, appConfig.collection, docId, payload);
      return json(result, 200, headers);
    } catch (error) {
      return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
    }
  }

  // DELETE - single-credential apps need nothing beyond docId itself (see
  // PATCH above); ORBIT_SYNC_APP still needs the manager passcode, taken
  // from the query string (`suppliedPasscode`, computed above) since
  // neither app ever sends a DELETE body.
  const rateLimit = await isRateLimited(
    env,
    ip,
    `${appConfig.featurePrefix}:delete`,
    appConfig.deleteLimit
  );
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: '請求過於頻繁，請稍後再試。' } }, 429, headers);
  }
  if (appConfig.singleCredential) {
    try {
      const doc = await firestoreGet(env, appConfig.collection, docId);
      // Already gone (or never existed) - not an error from the caller's
      // point of view, same as ORBIT_SYNC_APP's own 404-as-success below.
      if (!doc.exists) return json({ deleted: true }, 200, headers);
      await firestoreDelete(env, appConfig.collection, docId);
      return json({ deleted: true }, 200, headers);
    } catch (error) {
      return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
    }
  }
  try {
    const doc = await firestoreGet(env, appConfig.collection, docId);
    // Nothing to check a passcode against - already gone (or never
    // existed), same as a 404 from the old design: not an error from the
    // caller's point of view.
    if (!doc.exists) return json({ deleted: true }, 200, headers);
    const passcodeHash = suppliedPasscode ? await sha256Hex(suppliedPasscode) : '';
    if (!suppliedPasscode || passcodeHash !== doc.managerPasscodeHash) {
      return json({ error: { message: '需要正確的密碼才能刪除整個同步。' } }, 403, headers);
    }
    await firestoreDelete(env, appConfig.collection, docId);
    return json({ deleted: true }, 200, headers);
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}

// ---- Per-app configuration for the generic handlers above -----------
//
// Orbit's own /sync: unchanged behavior from before generalization - reads
// stay open to any holder of the plain sync code (the teacher/manager
// broadcasts to many read-only student/viewer devices), only writes and
// deletes need the manager passcode. `singleCredential` is left unset
// (falsy), same as always taking the code+manager-passcode branch in
// handleSyncCreate/handleSyncRequest above.
const ORBIT_SYNC_APP = {
  collection: 'orbit-schedules',
  featurePrefix: 'sync',
  maxPayloadLength: ORBIT_MAX_PAYLOAD_LENGTH,
  readLimit: SYNC_READ_RATE_LIMIT,
  verifyLimit: SYNC_VERIFY_RATE_LIMIT,
  writeLimit: SYNC_WRITE_RATE_LIMIT,
  deleteLimit: SYNC_DELETE_RATE_LIMIT,
  createLimit: SYNC_CREATE_RATE_LIMIT
};
// Orbit Vocab's /vocab-sync: every pairing belongs to one learner syncing
// their own progress across their own devices - there is no teacher/student
// broadcast use case the way Orbit has, so there is no viewer role, and
// nothing for a separate, less-sensitive "public code" to protect either
// (see VOCAB_PASSCODE_LENGTH's own comment). `singleCredential: true` is
// what sends handleSyncCreate/handleSyncRequest down the one-passcode
// branch instead of Orbit's own code+manager-passcode one.
const VOCAB_SYNC_APP = {
  collection: 'vocab-progress-sync',
  featurePrefix: 'vocab-sync',
  maxPayloadLength: VOCAB_MAX_PAYLOAD_LENGTH,
  readLimit: VOCAB_SYNC_READ_RATE_LIMIT,
  writeLimit: VOCAB_SYNC_WRITE_RATE_LIMIT,
  deleteLimit: VOCAB_SYNC_DELETE_RATE_LIMIT,
  createLimit: VOCAB_SYNC_CREATE_RATE_LIMIT,
  singleCredential: true,
  credentialLength: VOCAB_PASSCODE_LENGTH,
  credentialPattern: VOCAB_PASSCODE_PATTERN
};

// ==== Routing ================================================================

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path === '/gemini') return handleGeminiRequest(request, env, headers, ip);
    if (path === '/nl-edit') return handleNlEditRequest(request, env, headers, ip);
    if (path === '/sync') return handleSyncRequest(request, env, headers, ip, ORBIT_SYNC_APP);
    if (path === '/vocab-sync') return handleSyncRequest(request, env, headers, ip, VOCAB_SYNC_APP);
    if (path === '/vocab-ai') return handleVocabAiRequest(request, env, headers, ip);
    return json({ error: { message: 'Not found' } }, 404, headers);
  }
};
