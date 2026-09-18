// ---- cloudflare-worker/orbit-worker.js ----
// A single Cloudflare Worker serving Orbit Class's optional server-side
// features, plus several sibling apps' sync/AI features, routed by path:
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
//   POST      /match-recommend - Match Find's daily "which fixture is worth
//                            watching" ranking (see that repo's
//                            scripts/build-data.mjs). Same reuse reasoning
//                            and same GEMINI_API_KEY as /vocab-ai, called a
//                            handful of times a day by Match Find's own
//                            scheduled build, never per visitor - see "====
//                            /match-recommend" below.
//   POST      /match-recommend-refine - a small, rare follow-up to
//                            /match-recommend for fixtures that came out
//                            genuinely contesting the same slot on the
//                            first pass - the only route in this file
//                            allowed to reach for a Pro-tier model, and
//                            only for a handful of fixtures a day, never
//                            the full list - see "==== /match-recommend"
//                            below.
//   GET/POST/PATCH   /match-find-sync - Match Find's cross-device settings
//                            sync (sport priority, enabled sports,
//                            subscribed services - see that repo's
//                            public/app.js). Same reuse reasoning as
//                            /vocab-sync, and the same one-passcode shape
//                            (no separate manager role - see
//                            MATCH_FIND_SYNC_APP's own comment), just a
//                            different Firestore collection and its own
//                            rate-limit counters.
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

// X-Worker-Colo carries the IATA code of the Cloudflare colo that actually
// executed this request (request.cf.colo) on every response, successful or
// not. Diagnostic only - this is what confirmed wrangler.toml's old
// [placement] mode = "smart" was consistently landing this Worker's traffic
// on Hong Kong (a colo Google's Gemini API refuses outright, unlike a
// merely-unlucky one - see that file's own comment on why [placement] now
// pins to an explicit region instead), and stays useful for the same reason
// going forward: ties a future "User location is not supported" report to a
// specific colo instead of leaving it a guess. Needs to be both set AND
// exposed - CORS hides all response headers from browser JS by default
// unless explicitly listed here.
function corsHeaders(origin, colo) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Worker-Colo',
    'X-Worker-Colo': colo || 'unknown',
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
// Shared by GEMINI_RESPONSE_SCHEMA (/gemini, photo import) and
// NL_EDIT_RESPONSE_SCHEMA (/nl-edit, natural-language edits) below - both
// describe the exact same weeklySchedule/breakTimes shapes
// src/editor-backup.js's normalizeSettingsData expects, so there's one
// definition of each instead of two that could quietly drift apart. classes
// is the one exception (see NL_EDIT_CLASS_SCHEMA below) - the two endpoints
// need different `required` lists for the same fields.
const GEMINI_CLASS_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    subject: { type: 'string' },
    teacher: { type: 'string' },
    location: { type: 'string' }
  },
  // teacher/location genuinely are optional here: a freshly scanned photo
  // legitimately may not show a room number or a name at all.
  required: ['key', 'subject']
};
// /nl-edit's own classes schema, deliberately NOT the same object as
// GEMINI_CLASS_SCHEMA above despite having identical properties: unlike photo
// import, /nl-edit's prompt requires the model to echo every class it isn't
// touching back byte-for-byte from the given context, and under a schema
// where teacher/location are optional, Gemini would sometimes just omit
// them for an unmodified class instead of copying the value across -
// src/editor-nl-edit.js's applyNlEditResult then reads a missing field as
// "" and silently wipes that class's teacher/room, even though nothing
// about it was ever supposed to change. Marking all four fields required
// closes that loophole: the model has to put some value there, and with the
// unmodified value already sitting right there in context, it reliably
// copies it rather than inventing one.
const NL_EDIT_CLASS_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    subject: { type: 'string' },
    teacher: { type: 'string' },
    location: { type: 'string' }
  },
  required: ['key', 'subject', 'teacher', 'location']
};
const GEMINI_BREAK_TIME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' }
  },
  required: ['name', 'start', 'end']
};
const GEMINI_WEEKLY_SCHEDULE_SCHEMA = {
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
};
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
    breakTimes: { type: 'array', items: GEMINI_BREAK_TIME_SCHEMA },
    classes: { type: 'array', items: GEMINI_CLASS_SCHEMA },
    weeklySchedule: GEMINI_WEEKLY_SCHEDULE_SCHEMA,
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

// One legitimate user action (one photo import, one NL-edit submission) can
// now cost up to 3 real requests against this same counter when it hits a
// location block - the initial attempt plus the 2 location-block retries in
// src/gemini-ocr.js/editor-nl-edit.js - so this stays roughly 3x what a
// "one request per action" budget would be, rather than leaving a run of
// bad luck (or a couple of manual retries on top of it) burn through a
// tighter limit for reasons that have nothing to do with actual abuse.
const GEMINI_RATE_LIMIT = 30;

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
// The context now includes everything editable via this feature - see
// buildNlEditContext in src/editor-nl-edit.js and NL_EDIT_RESPONSE_SCHEMA's
// own comment on why. Still just one school's own data (a few KB of JSON at
// most); this stays generous above that while still refusing something
// that's clearly not this shape (a client bug, or a request built by hand
// that skipped the real client entirely) before it ever reaches Gemini.
const MAX_NL_EDIT_CONTEXT_LENGTH = 40000;
// See GEMINI_RATE_LIMIT's own comment - same reasoning, same 3x headroom for
// the location-block retry's own worst case.
const NL_EDIT_RATE_LIMIT = 30;

// /nl-edit's own schedule-cell edit shape: one (day, period, key) triple -
// see NL_EDIT_RESPONSE_SCHEMA's own comment for why the response describes
// only the cells that actually change rather than every day's full array.
const NL_EDIT_SCHEDULE_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    day: { type: 'integer' },
    period: { type: 'integer' },
    key: { type: 'string' }
  },
  required: ['day', 'period', 'key']
};

// Sparse patch, not full-state: an earlier revision of this schema had the
// model echo back the COMPLETE new value of every editable field - classes,
// weeklySchedule day-by-day, bellTimes, breakTimes, countdownEvents -
// including everything the instruction never asked to touch, copied back
// verbatim (see git history for that version, and its own comment on why it
// replaced an even earlier fixed-verb design). That put "reproduce a few
// dozen unrelated classes/schedule cells/times byte-for-byte, every single
// request" on the model's plate as real work in its own right, on top of
// actually figuring out the edit - and an LLM asked to copy a wall of JSON
// it has no reason to even be touching is exactly the kind of task where it
// occasionally drops or mis-types something, showing up as an unrelated,
// unexplained change in the diff the user is asked to confirm. The fix
// isn't a stricter prompt asking it to copy more carefully - it's not
// asking it to copy that data at all: classUpserts/deletedClassKeys/
// scheduleEdits below only ever contain the classes and schedule cells
// actually being added, changed, or removed; everything else is taken
// straight from the client's own current data (see
// src/editor-nl-edit.js's applyNlEditResult), never retyped by the model,
// so it is structurally impossible for an untouched class or cell to come
// back different. bellTimes/breakTimes/countdownEvents/reverseWeek stay
// whole-value fields (see their own *Changed booleans below) rather than
// getting the same sparse treatment - each is one short list/value already
// sitting fully in view (a handful of periods/breaks/events at most), not
// a few dozen scattered entries, so sparse-patching them would only add
// complexity without meaningfully lowering the same copy risk; the
// *Changed flag still means an untouched one is never even asked for.
// classUpserts reuses NL_EDIT_CLASS_SCHEMA (see that schema's own comment)
// - the other shapes mirror GEMINI_BREAK_TIME_SCHEMA/
// GEMINI_COUNTDOWN_EVENTS_SCHEMA above, both of which ultimately have to
// produce something src/editor-backup.js's normalizeSettingsData accepts,
// so there is one definition of each shape, not two that could drift
// apart. That function is also the real safety net on the client side once
// a patch comes back and gets applied on top of the current data - same as
// it already is for AI photo import and manual backup import - so this
// Worker still never has to parse or judge the content itself, only
// shape-check what's about to be embedded in the prompt (see
// readNlEditContext below).
const NL_EDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'unclear', 'not_found'] },
    reason: { type: 'string' },
    classUpserts: { type: 'array', items: NL_EDIT_CLASS_SCHEMA },
    deletedClassKeys: { type: 'array', items: { type: 'string' } },
    scheduleEdits: { type: 'array', items: NL_EDIT_SCHEDULE_EDIT_SCHEMA },
    bellTimesChanged: { type: 'boolean' },
    bellTimes: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    breakTimesChanged: { type: 'boolean' },
    breakTimes: { type: 'array', items: GEMINI_BREAK_TIME_SCHEMA },
    countdownEventsChanged: { type: 'boolean' },
    countdownEvents: GEMINI_COUNTDOWN_EVENTS_SCHEMA,
    reverseWeekChanged: { type: 'boolean' },
    reverseWeek: { type: 'boolean' }
  },
  required: [
    'status',
    'reason',
    'classUpserts',
    'deletedClassKeys',
    'scheduleEdits',
    'bellTimesChanged',
    'bellTimes',
    'breakTimesChanged',
    'breakTimes',
    'countdownEventsChanged',
    'countdownEvents',
    'reverseWeekChanged',
    'reverseWeek'
  ]
};

// The fixed, server-owned prompt - the client never sends prompt text of
// its own (see the top-of-section comment). `context` is embedded directly
// rather than sent as a separate structured turn: a single-turn
// generateContent call has nowhere else to put it, and it's already small
// (see MAX_NL_EDIT_CONTEXT_LENGTH).
function buildNlEditPrompt(text, context) {
  return `You read a Traditional Chinese natural-language instruction about a weekly class schedule and return ONLY a sparse patch describing the classes/schedule cells/settings that actually change - never the whole schedule, never anything the instruction didn't ask about. Return a single JSON object matching this exact schema:
{
  "status": "ok",
  "reason": "",
  "classUpserts": [{"key": "A", "subject": "物理", "teacher": "", "location": ""}],
  "deletedClassKeys": [],
  "scheduleEdits": [{"day": 1, "period": 2, "key": "A"}],
  "bellTimesChanged": false,
  "bellTimes": [],
  "breakTimesChanged": false,
  "breakTimes": [],
  "countdownEventsChanged": false,
  "countdownEvents": [],
  "reverseWeekChanged": false,
  "reverseWeek": false
}

The current data, given as read-only context so you know what already exists and can decide what to change - do NOT copy any of it back into your result, only refer to it by key/day/period:
${JSON.stringify(context)}

THE SINGLE MOST IMPORTANT RULE: this is a PATCH, not a copy of the schedule. List a class in "classUpserts" only if you are adding it or changing one of its fields; list a key in "deletedClassKeys" only if the instruction removes that class entirely; list an entry in "scheduleEdits" only for a (day, period) cell whose class actually changes. Never include a class, cell, break time, or countdown event just because it already exists - every one the instruction doesn't touch must be left out of the result entirely, never repeated back. This is also why "bellTimesChanged"/"breakTimesChanged"/"countdownEventsChanged"/"reverseWeekChanged" exist: leave the flag false (and its matching field empty/false) whenever the instruction doesn't touch that field at all; set the flag true, and only then fill in the field, when it does. The result is shown to the user as a diff against the current data before anything is saved, so anything you include here that the instruction didn't actually ask for shows up as a confusing, unwanted line in that diff.

Field shapes and meaning:
- "classUpserts": one entry per class being added or changed, as {key, subject, teacher, location} - all four fields are required on every entry you DO include (adding or changing a class replaces that whole entry, so if only the teacher changes, still repeat that same class's existing subject/location unchanged inside this one entry - never touch any other class just to do that). "key" is an internal id, not shown to the user - reuse a class's EXISTING key (from the context above) whenever you're changing that same course, even if you rename its subject/teacher/location, so "scheduleEdits" references to it stay valid. For a genuinely NEW course, invent a short new key not already used by any class in the context (e.g. "new1", "new2", ...); leave teacher/location as "" if the instruction didn't specify them. Defining a new course is a complete, valid request entirely on its own even when the instruction never says where to schedule it (e.g. "新增一個課程叫社團活動", "幫我建一個王老師教的數學課" with no day/period mentioned) - in that case just add it to "classUpserts" with a new key and leave "scheduleEdits" empty; never invent a day/period for it just because a course needs one eventually - the user places it into a slot themselves afterward.
- "deletedClassKeys": keys (from the context above) of classes the instruction removes entirely. Also add a "scheduleEdits" entry with "key": "" for every cell in the context that still references a deleted key, so nothing is left pointing at a class that no longer exists.
- "scheduleEdits": one entry per (day, period) cell whose class actually changes, as {day, period, key} - "key": "" clears that period (makes it free that day). Only list a cell here if the class it should now hold is different from what the context above already shows there. Moving a class is two entries (clear its old cell, set its new one); swapping two classes is two entries (each cell gets the other's key).
- "bellTimes"/"breakTimes"/"countdownEvents"/"reverseWeek": each has a matching *Changed boolean (see above). When the instruction adds, removes, or edits ANY period/break/event/the odd-even split, set that one flag true and give the COMPLETE new value of that whole field, in order (not a partial patch within it) - e.g. adding one bell period still means the complete "bellTimes" array including the new one; adding one break time still means the complete "breakTimes" array including the new one, and so on. "bellTimes" is the list of [start, end] 24-hour time strings ("HH:MM"), one per period, in the same order "scheduleEdits"' period numbers use. Adding a period means appending a new [start, end] pair; removing or reordering a period shifts every later period's index - when that happens, also add "scheduleEdits" entries for whatever classes sat in those later periods, moving each to its new index (and clearing its old one), so nothing silently ends up in the wrong period. "breakTimes" is named special/break times (e.g. 午休, 打掃時間, 就寢時間) as {name, start, end} - independent of "bellTimes"/the schedule, not tied to any period index. "countdownEvents" is named date-range events (e.g. 段考, 校慶) as {name, startDate, endDate} ("YYYY-MM-DD" each, the same day for a single-day event).

單雙週分堂課 (odd/even-week split classes): ONE class entry can alternate between two different subject/teacher pairs depending on whether the real-world week is 單週 (odd) or 雙週 (even) - this is a single "classUpserts" entry (never two, and never two "scheduleEdits" cells) whose "subject" and/or "teacher" string is written as "單週內容/雙週內容", the two halves joined by a "/" (a full-width "／" means the same thing - normalize it to "/"). Example: {"subject": "國文/公民", "teacher": "李老師/陳老師"} is one slot that shows 國文 taught by 李老師 on 單週 weeks and 公民 taught by 陳老師 on 雙週 weeks; "location" is never split this way, it's the same room either week. Recognizing, creating, and editing these:
  - An existing class already has this split if its subject or teacher (in the context above) contains "/". The part before "/" is what shows on 單週, the part after is 雙週.
  - To turn an existing single-subject class into a split one (e.g. "週三第二節國文，改成單週上國文、雙週上公民" or "幫我把這堂課弄成單雙週，雙週改成地理" where only one side is named and the other should stay what it already was), add ONE "classUpserts" entry reusing that class's existing key, joining the 單週 content and 雙週 content with "/" in whichever of subject/teacher actually alternates - leave the other field its existing plain unsplit value if it doesn't alternate (e.g. same teacher both weeks).
  - To create a brand-new split class from scratch (e.g. "新增一節課，單週英文王老師、雙週美術林老師"), it works exactly like creating any new course (see "classUpserts" above), just with "/"-joined subject/teacher instead of plain ones.
  - To edit only one side of an already-split class (e.g. "雙週那半改成地理" or "單週的公民老師換成陳老師"), the "classUpserts" entry's untouched side must repeat that side's text exactly as it already was in context, only the named side actually changes - this is still "only change what's asked", just scoped to half of one field inside one entry rather than the whole field.
  - To un-split one back into a single subject/teacher for every week (e.g. "OO老師的課取消單雙週，都固定上物理"), the "classUpserts" entry replaces the whole "/"-joined string with the one value that now applies always.

Day numbering: 0 = 週日, 1 = 週一, 2 = 週二, 3 = 週三, 4 = 週四, 5 = 週五, 6 = 週六 (matches JavaScript's Date.getDay(), the same numbering the context's own weeklySchedule keys use).
Period numbering: 0-based, matching the index into a weeklySchedule day array and into bellTimes (period 0 is 第一節, period 1 is 第二節, and so on).

The instruction to translate: "${text}"

Read the instruction the way a colleague would, not a compiler: it may be indirect, colloquial, or point at its target through context instead of naming it outright - e.g. "把國文課挪到早自習後面" means move it to whichever period immediately follows whatever's named/labeled 早自習 in the given context; "這兩堂對調" without the word "交換" still means swap them; "把雙週那半改掉" implicitly means the class in question already has a 單/雙週 split (see above) and only that half changes. Work out the concrete edit a reasonable teacher would mean from the wording and the context you were given, rather than requiring the instruction to spell out mechanics literally. This reasoning is about READING the instruction, not about inventing content: still never invent a day, period, subject, teacher, location, time, or event that neither the instruction nor the given context actually supports.

Decide "status":
- "ok": the instruction maps cleanly onto a change (or several - see below) to the data above, using only days/periods/classes/times that make sense given the context (and, for a multi-part instruction, given the effect of any earlier part already applied - e.g. moving a class out of a slot and then putting a different class into that now-empty slot is a perfectly ordinary two-part instruction, not a conflict). Fill in only whichever of "classUpserts"/"deletedClassKeys"/"scheduleEdits"/the four *Changed fields the patch actually needs - leave every other field/flag empty/false.
- "unclear": after actually reasoning through the wording and context as above, the instruction (or any part of it, if it describes several changes) still has multiple equally plausible readings with nothing to prefer one over another, is contradictory, or does not describe an edit to this data at all. This is not the same as "phrased indirectly" - reserve "unclear" for genuine ambiguity, not for instructions that merely require a little inference to resolve. Leave every field/flag empty/false (i.e. no actual change). Briefly explain why in "reason" (Traditional Chinese, one short sentence).
- "not_found": the instruction is clear about what it wants, but names a day, period, class, break time, or countdown event that does not exist in the given context at the point it's referenced. Leave every field/flag empty/false. Briefly explain in "reason" (Traditional Chinese, one short sentence).

A single instruction may describe more than one distinct change (e.g. joined by "而且"/"然後"/"，"/"、", or a numbered/bulleted list) - apply all of them together in the one result you return (e.g. several "scheduleEdits" entries, or a "classUpserts" entry alongside a "scheduleEdits" entry), same as if each had been requested separately in order. If any one part is ambiguous or refers to something that doesn't exist, treat the WHOLE instruction as "unclear"/"not_found" rather than silently applying only the parts that made sense.

Return ONLY the raw JSON object — no markdown fences, no comments, no extra text.`;
}

// Structural shape check only (mirrors readGeminiFiles' own level of
// strictness) - src/editor-nl-edit.js's validateNlEditResult()/
// applyNlEditResult() are what actually re-check and normalize the
// *response* once Gemini answers; this just makes sure what's about to be
// embedded in the prompt is the shape the prompt claims it is.
function readNlEditContext(context) {
  if (!context || typeof context !== 'object') return null;
  const { weeklySchedule, classes, bellTimes, breakTimes, countdownEvents, reverseWeek } = context;
  if (!weeklySchedule || typeof weeklySchedule !== 'object' || Array.isArray(weeklySchedule))
    return null;
  if (!Array.isArray(classes) || !Array.isArray(bellTimes)) return null;
  if (!Array.isArray(breakTimes) || !Array.isArray(countdownEvents)) return null;
  if (typeof reverseWeek !== 'boolean') return null;
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
  if (breakTimes.some(entry => !entry || typeof entry !== 'object')) return null;
  if (countdownEvents.some(entry => !entry || typeof entry !== 'object')) return null;
  return { weeklySchedule, classes, bellTimes, breakTimes, countdownEvents, reverseWeek };
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

// ==== /vocab-ai - Orbit Vocab's live, per-learner AI feature ================
//
// An on-demand feature from the sibling repo Orbit Vocab (see that repo's
// README/vocab-ai.js), genuinely needing a LIVE, per-request Gemini call
// rather than that repo's offline batch script
// (scripts/generate_ai_signals.py, which pre-generates one static
// confusedWith/mnemonic/priorDifficulty per word into data/ai_signals.json
// at build time): the request here depends on THIS learner's own data -
// their actual recorded wrong-answer history for one word - which a
// build-time batch job run once for every word in the vocabulary has no
// way to know.
//   - kind: "mnemonic" - one memory hook targeted at a specific word's
//     recorded wrong-answer pattern for THIS learner, not the generic
//     one-per-word hook data/ai_signals.json already ships offline.
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
// client-selectable (unlike /gemini's own `model` field): this feature has a
// small, fixed-shape request, so there's no multi-model fallback chain worth
// maintaining, just a single pick from GEMINI_ALLOWED_MODELS above. Picks
// the other one of the two rather than the lite model /gemini and /nl-edit
// use: those routes are bulk/structured extraction, where the lite model's
// speed matters and "thinking" buys nothing (see buildGenerationConfig).
// This route is the opposite - one mnemonic, generated on a single manual
// tap, where the bottleneck users actually complained about was the writing
// being generic and repetitive, not latency - so it trades a little speed
// for the stronger model's better creative writing.
const VOCAB_AI_MODEL = 'gemini-3.7-flash';
// Tighter than GEMINI_RATE_LIMIT (20/hour is for a whole schedule-photo
// import session; this is for a single learner's own occasional taps on
// "產生記憶法" while reviewing) - generous for real use, still bounded per
// IP.
const VOCAB_AI_RATE_LIMIT = 30;
// Bounds on every piece of client-submitted text below - see
// cleanVocabAiText's own comment on why these are enforced here rather than
// trusted from the client.
const VOCAB_AI_MAX_WORD_LEN = 40;
const VOCAB_AI_MAX_POS_LEN = 20;
const VOCAB_AI_MAX_MEANING_LEN = 200;
const VOCAB_AI_MAX_WRONG_ANSWERS = 5;
const VOCAB_AI_MAX_WRONG_ANSWER_LEN = 40;

const VOCAB_MNEMONIC_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { mnemonic: { type: 'string' } },
  required: ['mnemonic']
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

// Names the exact letter-level mistake between what the learner typed and
// the correct spelling ourselves, in plain deterministic code, instead of
// making the model diagnose it from the two raw strings (an earlier version
// of this prompt did exactly that: asked the model to "diagnose the pattern
// and state it before writing the mnemonic"). That was the real source of
// two separate complaints at once - the diagnosis itself was inconsistent
// (a fast model given e.g. "wierd" vs "weird" would routinely miscount
// which letters were swapped, or invent a pattern that wasn't there), and
// because the prompt asked for the diagnosis to be stated "before writing
// the mnemonic", the model's answer always opened with a throwaway sentence
// describing the mistake instead of going straight into something useful.
// Handing over an exact, code-computed diagnosis fixes the first problem by
// construction (string comparison doesn't miscount), and lets the prompt
// below flatly forbid restating it, fixing the second.
//
// Only handles the shapes real spelling mistakes actually take - one
// substituted letter, two adjacent letters swapped, one letter missing, one
// extra letter - exactly, via plain string comparison (same length ->
// substitution or transposition; length differs by one -> first point of
// divergence is the missing/extra letter). Anything messier than that
// (several scattered differences) deliberately falls back to a description
// that doesn't claim a specific pattern, rather than guessing one - a wrong
// but confident diagnosis handed to the model would be worse than admitting
// there isn't a single clean one.
function diagnoseSpellingMistake(word, wrong) {
  if (!wrong || wrong === word) return null;
  if (wrong.length === word.length) {
    const diffIdx = [];
    for (let i = 0; i < word.length; i++) {
      if (wrong[i] !== word[i]) diffIdx.push(i);
    }
    if (diffIdx.length === 1) {
      const i = diffIdx[0];
      return `wrote "${wrong[i]}" instead of "${word[i]}" as letter #${i + 1} (of ${word.length}) in "${word}" (typed "${wrong}")`;
    }
    if (diffIdx.length === 2) {
      const [i, j] = diffIdx;
      if (wrong[i] === word[j] && wrong[j] === word[i]) {
        return `swapped letters #${i + 1} and #${j + 1} of "${word}" ("${word[i]}" and "${word[j]}"), writing "${wrong}" instead`;
      }
    }
  } else if (Math.abs(wrong.length - word.length) === 1) {
    const shorterLen = Math.min(wrong.length, word.length);
    let i = 0;
    while (i < shorterLen && wrong[i] === word[i]) i++;
    if (wrong.length < word.length) {
      return `left out letter #${i + 1} of "${word}" ("${word[i]}"), writing "${wrong}" instead`;
    }
    return `added an extra letter not in "${word}" around position #${i + 1}, writing "${wrong}" instead`;
  }
  return `misspelled "${word}" as "${wrong}" - no single clean letter-level pattern here, so just pick the most visually distinctive difference between the two spellings`;
}

// The banned-phrases list below was added after real generations kept
// landing on generic study-advice filler ("多加練習就會記住"、"多寫幾次自
// 然會拼對") that technically answered the prompt but gave the learner
// nothing to actually latch onto. The "output ONLY the mnemonic" rule and
// its own banned-openers list (see diagnoseSpellingMistake's comment for
// why this changed) were added for the same reason: a diagnosis-first
// sentence isn't a memory hook, it's just a recap of an error the learner
// already knows they made.
function buildVocabMnemonicPrompt(word, pos, meaning, wrongAnswers) {
  const diagnoses = wrongAnswers.map((w) => diagnoseSpellingMistake(word, w)).filter(Boolean);
  const mistakesLine = diagnoses.length
    ? `This learner has previously misspelled this exact word. Here is exactly what went wrong each time, already worked out by code - trust it as fact, don't re-derive or contradict it, just build the mnemonic around it:\n${diagnoses
        .map((d) => `- ${d}`)
        .join('\n')}`
    : `No specific past misspelling was recorded for this word - pick the single most error-prone part of its spelling (a silent letter, a doubled letter, an unusual letter combination) and treat that as the target pattern.`;
  return `You are helping a Taiwanese high school student remember how to correctly spell an English vocabulary word they keep getting wrong.

Word: "${word}" (${pos || 'unknown part of speech'})
Chinese meaning: ${meaning || '(none given)'}
${mistakesLine}

Write ONE mnemonic (under 40 words, in Traditional Chinese, weaving in the actual English letters/word) that uses a real memory technique - a sound-alike association, a keyword/imagery hook, or a tiny vivid story - built specifically around the exact letters named above. Name the specific letters; don't just gesture vaguely at "this part of the word".

Example of the right shape (a different word, "believe", where the learner dropped the second "e" and wrote "belive"): "『believe』中間藏著一個 lie（謊言）－ b-e-LIE-ve，你要先相信（believe）一個謊言（lie）才會被騙，所以中間是 l-i-e 兩個字母都不能少。"

Output ONLY the mnemonic itself. Do NOT open with a sentence naming or restating the mistake (e.g. "你把...拼成..."、"這個字你常把...搞混"、"正確拼法是...") - that's not a memory hook, it's just a description of an error the learner already knows about. Go straight into the technique.

Do NOT give generic study advice such as "多加練習"、"多寫幾次"、"多背幾次就會記住"、"注意拼法" or anything to that effect - if nothing else fits, invent a vivid image or sound association for the trickiest letters instead. Never restate the correct spelling on its own without a memory hook attached to it.`;
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

    return json({ error: { message: 'Missing or invalid kind' } }, 400, headers);
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, 502, headers);
  }
}

// ==== /match-recommend - Match Find's "worth watching" ranking ==============
//
// Match Find (github.com/jaypengx-collab/Match-Find) is a static site that
// recommends which upcoming fixture across several leagues is worth
// watching. Ranking "worth watching" needs real-world sports knowledge -
// current form, standings stakes, rivalry history - that no deterministic
// heuristic over raw fixture data can approximate well, so that judgment is
// what gets delegated here; everything else (fetching each league's
// fixtures from ESPN's own public API, converting to the viewer's local
// time, resolving same-time conflicts by score) happens entirely in Match
// Find's own build script with no need for this Worker at all.
//
// Called a handful of times a day by Match Find's own scheduled GitHub
// Action (which bakes the result into a static JSON file), never per page
// view - unlike /gemini and /vocab-ai, which run once per end-user action.
// That's also why this stays generous but modest at
// MATCH_RECOMMEND_RATE_LIMIT rather than needing per-IP fairness tuning:
// the caller is one scheduled job, not many browsers.
//
// Reuses GEMINI_API_KEY rather than needing its own secret - same reasoning
// as /vocab-ai reusing it instead of provisioning a second key.
//
// A list, not a single model, and tried in order - added after live testing
// found gemini-3.7-flash alone returning a genuine upstream 503 ("This
// model is currently experiencing high demand") on every one of several
// consecutive real attempts, not a one-off blip. /gemini already treats
// exactly this as expected/retryable (see its own GEMINI_ALLOWED_MODELS
// fallback chain and tryGeminiModels); this route needs the same
// resilience rather than depending on one model's availability, since a
// failed run here just means Match Find's build falls back to its own
// local heuristic for that day - a bigger loss than a few seconds' extra
// latency trying a second model first.
const MATCH_RECOMMEND_MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash-lite'];
const MATCH_RECOMMEND_RATE_LIMIT = 20;
// One day across five leagues (MLB alone can run ~15 games/day) can add up
// fast - this stays well above what a real day's fixture list needs while
// still bounding one request's prompt size and Gemini cost.
const MATCH_RECOMMEND_MAX_ITEMS = 80;
const MATCH_RECOMMEND_MAX_FIELD_LEN = 160;

// /match-recommend-refine - a SEPARATE, small-volume route Match Find only
// calls for a handful of genuinely contested fixtures a day (see that
// repo's build-data.mjs "contested cluster" detection), never the full
// day's fixture list - so it's the one place in this whole file that's
// deliberately allowed to reach for a more capable (and far more
// rate-limited) Pro-tier model instead of staying on the Flash tier
// everything else here uses. Free-tier Pro quota is commonly two orders of
// magnitude smaller than Flash's (roughly 100/day vs several hundred-to-
// thousand, and shared across EVERY feature this Worker serves, not just
// this route) - spending it on every fixture Match Find fetches would
// starve /gemini and /vocab-ai's own Pro-tier needs (if they ever have
// any) for no real benefit, since most fixtures were never a close call to
// begin with.
//
// `gemini-3.1-pro-preview` and `gemini-2.5-pro` are real, currently-listed
// model ids (confirmed against Google's own model list - an earlier
// version of this constant guessed at "gemini-3.7-pro"/"gemini-3.5-pro"
// following this file's flash-model naming pattern, neither of which
// actually exists, and every refine call was silently wasting two
// guaranteed-404 attempts - each one still a real request against the
// SAME 20-requests-per-minute Flash quota this whole file shares once the
// loop fell through to gemini-3.7-flash - before landing on the one model
// that worked). Neither Pro model has been verified live the way
// MATCH_RECOMMEND_MODELS' flash models have (no Pro-tier route existed to
// test against before this one) - both are tried, in order, before
// falling back to the one model this file already knows works, so a
// wrong guess here still degrades to "no smarter than usual" rather than
// failing the request outright.
const MATCH_RECOMMEND_REFINE_MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.7-flash'];
const MATCH_RECOMMEND_REFINE_RATE_LIMIT = 10;
// A "cluster" of fixtures genuinely contesting the same slot is small by
// nature (rarely more than 3-4 overlapping fixtures with similar scores at
// once) - this caps well below that as a hard backstop on prompt/cost size
// regardless of what the caller sends.
const MATCH_RECOMMEND_REFINE_MAX_ITEMS = 6;

const MATCH_RECOMMEND_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          competitiveness: { type: 'integer' },
          watchability: { type: 'integer' },
          reason: { type: 'string' },
          venueZh: { type: 'string' },
          whereToWatchTw: { type: 'string' }
        },
        required: ['id', 'competitiveness', 'watchability', 'reason', 'venueZh', 'whereToWatchTw']
      }
    }
  },
  required: ['picks']
};

// Bounds/shape-checks one submitted fixture before it's embedded in the
// prompt - same posture as cleanVocabAiText/readGeminiFiles: this route has
// no passcode gate either, reachable by anyone who knows the URL, so every
// field is treated as untrusted regardless of how Match Find's own build
// script actually behaves. Returns null (never a silently truncated value)
// so the caller 400s outright rather than forwarding a malformed fixture.
function cleanMatchRecommendItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim().slice(0, 64) : '';
  const sport = typeof item.sport === 'string' ? item.sport.trim().slice(0, 40) : '';
  const name =
    typeof item.name === 'string' ? item.name.trim().slice(0, MATCH_RECOMMEND_MAX_FIELD_LEN) : '';
  if (!id || !sport || !name) return null;
  const startTimeUtc = typeof item.startTimeUtc === 'string' ? item.startTimeUtc.trim().slice(0, 40) : '';
  const context =
    typeof item.context === 'string' ? item.context.trim().slice(0, MATCH_RECOMMEND_MAX_FIELD_LEN) : '';
  const venue =
    typeof item.venue === 'string' ? item.venue.trim().slice(0, MATCH_RECOMMEND_MAX_FIELD_LEN) : '';
  // ESPN's own on-record national broadcaster (e.g. "Apple TV", "TBS") -
  // optional (older callers or a fixture ESPN has no broadcaster listed
  // for both send/have ""), see buildMatchRecommendPrompt for how it's
  // used.
  const broadcast =
    typeof item.broadcast === 'string' ? item.broadcast.trim().slice(0, MATCH_RECOMMEND_MAX_FIELD_LEN) : '';
  return { id, sport, name, startTimeUtc, context, venue, broadcast };
}

// The fixed, server-owned prompt - Match Find's build script only ever sends
// {matches: [...]}, never prompt text of its own, same discipline as every
// other route in this file (see top-of-file comment). Match Find's UI is
// Traditional Chinese throughout (see that repo's public/app.js) - "reason"
// is written in Chinese too now so the one AI-generated sentence on the
// page doesn't stick out as the only English text on an otherwise Chinese
// card. venueZh/whereToWatchTw exist for the same reason "venue" alone
// wasn't enough: a Taiwanese viewer cares less about a US stadium's English
// name than about which local channel/streaming service actually carries
// this specific fixture - something ESPN's API has no concept of at all,
// so it has to come from the model's own knowledge, same as the
// competitiveness/watchability judgment itself.
function buildMatchRecommendPrompt(matches) {
  return `You are a knowledgeable sports fan helping Traditional-Chinese-speaking viewers in Taiwan decide which upcoming fixture is most worth watching. You are given a list of fixtures across several leagues/series (e.g. Premier League, MLS, MLB, NBA, F1), each with a "venue". For EACH fixture, using your own real-world knowledge of these specific teams/drivers (current form, standings position, rivalry history, star players, championship/relegation/playoff stakes) and of Taiwan sports broadcasting, return:
- "competitiveness": integer 1-10, how close/contested you expect the fixture to be.
- "watchability": integer 1-10, how entertaining or notable it is to a general sports fan regardless of closeness (rivalry, stakes, star power, drama, historical significance).
- "reason": one short sentence (under 40 Traditional Chinese characters) in Traditional Chinese explaining the two scores.
- "venueZh": the given "venue" written in Traditional Chinese - the commonly used Chinese name for that stadium/arena/circuit if you know one, otherwise a reasonable transliteration. Return "" if you have no real basis to translate it rather than guessing.
- "whereToWatchTw": your best guess at the TV channel or streaming service Taiwanese viewers would typically use to watch THIS SPECIFIC fixture live (e.g. "愛爾達體育台", "ELEVEN SPORTS", "Apple TV", "Disney+", "myVideo", "緯來體育台"), in Traditional Chinese, as short as possible - a channel/platform name, not a sentence. This is only a FALLBACK guess from memory, not a search result (a separate grounded lookup - see handleMatchRecommendRequest - takes priority when it has an answer). Each fixture may include a "broadcast" field - ESPN's own on-record NATIONAL (usually US) broadcaster for it, e.g. "Apple TV", "TBS", "Fox", "ESPN". This is NOT itself the Taiwan answer, but treat it as a strong hint FOR MLB SPECIFICALLY: if an MLB fixture's "broadcast" names a service that is a genuine GLOBAL streaming exclusive with no regional blackout (most notably MLB's Apple TV "Friday Night Baseball" package), that same service is very likely also how it's watched in Taiwan, NOT 愛爾達體育台/緯來體育台 - MLB's international broadcast deals with 愛爾達/緯來 typically do NOT include Apple TV's exclusive slate at all. An ordinary US regional cable network name in "broadcast" (Fox, TBS, ESPN, a team's own regional network, etc.) does NOT imply anything about Taiwan on its own. This "broadcast" override does NOT apply to F1: F1's US/international broadcaster is Apple TV, but F1 in Taiwan is broadcast exclusively by 愛爾達體育台 regardless of that - for F1 specifically, always answer "愛爾達體育台" and ignore "broadcast" entirely. If an MLB fixture is carried by BOTH 緯來體育台 and 愛爾達體育台 (common for an ordinary MLB game), answer "愛爾達體育台", not "緯來體育台". Return "無已知台灣轉播" if you have no real basis to know rather than guessing.

Fixtures (each already has an "id" - use it to key your answer, never invent or rely on ordering alone):
${JSON.stringify(matches)}

Rules:
- Return exactly one entry per given "id" - never add, drop, or merge fixtures.
- If you don't recognize a team/driver, or have no real basis to judge a fixture, score both fields conservatively (4-6) and say so plainly in "reason" rather than inventing form, stats, or a rivalry that isn't real.
- Never invent an injury, transfer, statistic, broadcaster, or venue translation you're not confident is real - an empty/placeholder value is always better than a guess stated as fact.
- Return ONLY the raw JSON object matching the given schema - no markdown fences, no extra text.`;
}

// A SEPARATE, ungrounded-vs-grounded split from the scoring prompt above,
// on purpose - Gemini's schema-constrained JSON mode
// (response_mime_type/response_schema, see buildGenerationConfig) and the
// google_search grounding tool are NOT reliably combinable in one request:
// depending on model/version this either gets rejected outright, or,
// worse, silently accepted with the tool quietly ignored - a request that
// LOOKS grounded but never actually searched, which is indistinguishable
// from a real grounded miss without checking (see fetchStructuredPicks vs
// fetchGroundedBroadcastInfo, which is why this stays its own call rather
// than being combined back into the scoring one). Asking for broadcast
// info alone, as free-form text with NO response_schema at all, sidesteps
// that ambiguity entirely: grounding is unambiguously well-supported for
// plain-text generation, so this pass either genuinely searches or
// visibly fails (network/quota error), never silently no-ops.
function buildBroadcastLookupPrompt(matches) {
  return `Use Google Search to find the ACTUAL, CURRENT Taiwan TV channel or streaming service for EACH of these upcoming sports fixtures. Each fixture may include a "broadcast" field - ESPN's own on-record NATIONAL (usually US) broadcaster, e.g. "Apple TV", "TBS", "Fox". This is a strong hint FOR MLB SPECIFICALLY, not the Taiwan answer itself: if an MLB fixture's "broadcast" names a genuine GLOBAL streaming exclusive with no regional blackout (most notably MLB's Apple TV "Friday Night Baseball" package), verify with search whether that same global service - not 愛爾達體育台/緯來體育台 - is also how Taiwanese viewers watch it, since MLB's international deals with 愛爾達/緯來 typically exclude Apple TV's exclusive slate entirely. An ordinary US regional network name in "broadcast" doesn't imply anything about Taiwan by itself. This override does NOT apply to F1: F1's international broadcaster is Apple TV, but F1 in Taiwan is broadcast exclusively by 愛爾達體育台 regardless - for F1, always answer "愛爾達體育台" and don't let "broadcast" override that. Broadcast rights are often team-specific or game-specific, not sport-wide, so check each fixture individually rather than assuming the sport's usual channel. If an MLB fixture is genuinely carried by BOTH 緯來體育台 and 愛爾達體育台 (common for an ordinary MLB game), answer "愛爾達體育台".

Fixtures (each already has an "id" - use it to key your answer):
${JSON.stringify(matches.map(m => ({ id: m.id, sport: m.sport, name: m.name, startTimeUtc: m.startTimeUtc, broadcast: m.broadcast })))}

Respond with ONLY a raw JSON object (no markdown fences, no extra text) mapping each given "id" to the Traditional Chinese channel/service name, as short as possible (a name, not a sentence) - e.g. {"abc123": "愛爾達體育台", "def456": "Apple TV"}. If a search leaves you with no real basis to know a fixture's broadcaster, map its id to "無已知台灣轉播" rather than guessing. Include every given id exactly once.`;
}

// Salvages a JSON object out of a plain-text model response that was NOT
// schema-constrained (see buildBroadcastLookupPrompt's own comment for
// why) - a markdown fence or a short leading/trailing sentence around the
// JSON is common even when explicitly told not to, so this strips a
// fenced block if present and otherwise just grabs the outermost {...}
// rather than trusting the whole response body to be bare JSON.
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The scoring/reason/venueZh/whereToWatchTw-guess call - schema-constrained,
// never grounded (see buildBroadcastLookupPrompt's comment for why those
// two don't mix reliably). `models` is tried in order, same resilience
// reasoning as /gemini's own tryGeminiModels - the base /match-recommend
// route passes MATCH_RECOMMEND_MODELS (verified Flash-tier), the refine
// route passes MATCH_RECOMMEND_REFINE_MODELS (an unverified Pro-tier guess
// falling back to a known-good Flash model) - same function either way,
// since "try a list of models in order, same schema, same failure
// handling" doesn't care which list it's given. Returns the parsed
// `{picks: [...]}` object, or throws {message, status} on total failure -
// this is required for the route to return anything at all, so a failure
// here is fatal to the whole request.
async function fetchStructuredPicks(matches, env, models, prompt) {
  let lastError = { message: 'No model available', status: 502 };
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: buildGenerationConfig(model, MATCH_RECOMMEND_RESPONSE_SCHEMA)
        })
      });
      if (!upstream.ok) {
        const errorJson = await upstream.json().catch(() => ({}));
        const message = errorJson.error?.message || upstream.statusText;
        lastError = { message, status: upstream.status };
        // Retryable on the next model: overloaded (503), rate-limited
        // (429), retired/unknown model (404), or a transient server error
        // (5xx) - same retryable set /gemini's tryGeminiModels uses. Any
        // other status (an invalid-key 401/403, or a real 400) would fail
        // identically on every other model, so it throws immediately
        // instead of wasting the rest of the list.
        const retryable = upstream.status === 404 || upstream.status === 429 || upstream.status >= 500;
        if (!retryable) throw lastError;
        continue;
      }
      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        lastError = { message: 'Gemini response missing text', status: 502 };
        continue;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        lastError = { message: `Gemini returned invalid JSON: ${error.message}`, status: 502 };
        continue;
      }
    } catch (error) {
      if (error && typeof error.status === 'number') throw error; // already a {message, status}
      lastError = { message: error.message || 'Upstream request failed', status: 502 };
    }
  }
  throw lastError;
}

// The grounded broadcast-only lookup - best-effort, never fatal to the
// request: any failure here (quota, no model accepts grounding, an
// unparseable response) just means whereToWatchTw falls back to
// fetchStructuredPicks' own ungrounded guess for every fixture, same as
// before this lookup existed at all. Tries every model in
// MATCH_RECOMMEND_MODELS, not just the first, since a quota/availability
// issue on one model says nothing about another.
async function fetchGroundedBroadcastInfo(matches, env) {
  const prompt = buildBroadcastLookupPrompt(matches);
  for (const model of MATCH_RECOMMEND_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`;
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
          // Deliberately no generationConfig/response_schema here - see
          // buildBroadcastLookupPrompt's comment.
        })
      });
      if (!upstream.ok) continue;
      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = extractJsonObject(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Best-effort - fall through to the next model, and eventually to
      // the caller's own fallback, on any failure.
    }
  }
  return null;
}

async function handleMatchRecommendRequest(request, env, headers, ip) {
  if (request.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, headers);

  const rateLimit = await isRateLimited(env, ip, 'match-recommend', MATCH_RECOMMEND_RATE_LIMIT);
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: 'Too many requests, please try again later.' } }, 429, headers);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: { message: 'Worker has not configured GEMINI_API_KEY.' } }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }
  const rawMatches = Array.isArray(body?.matches) ? body.matches : null;
  if (!rawMatches || !rawMatches.length) {
    return json({ error: { message: 'Missing or invalid matches' } }, 400, headers);
  }
  if (rawMatches.length > MATCH_RECOMMEND_MAX_ITEMS) {
    return json(
      { error: { message: `At most ${MATCH_RECOMMEND_MAX_ITEMS} matches per request` } },
      400,
      headers
    );
  }
  const matches = rawMatches.map(cleanMatchRecommendItem);
  if (matches.some(m => !m)) {
    return json({ error: { message: 'Missing or invalid matches' } }, 400, headers);
  }

  let picksResult;
  try {
    // Run together, not sequentially - fetchGroundedBroadcastInfo is
    // best-effort and never throws, so this only ever waits as long as the
    // slower of the two, not both added up.
    const [structured, grounded] = await Promise.all([
      fetchStructuredPicks(matches, env, MATCH_RECOMMEND_MODELS, buildMatchRecommendPrompt(matches)),
      fetchGroundedBroadcastInfo(matches, env)
    ]);
    picksResult = structured;
    if (grounded && Array.isArray(picksResult?.picks)) {
      for (const pick of picksResult.picks) {
        const groundedChannel = grounded[pick.id];
        // Only overrides with a real answer - a grounded "無已知台灣轉播"
        // doesn't get to stomp out a specific channel name the ungrounded
        // pass already guessed; it just means the search came up empty,
        // which isn't more informative than the existing guess.
        if (typeof groundedChannel === 'string' && groundedChannel.trim() && groundedChannel !== '無已知台灣轉播') {
          pick.whereToWatchTw = groundedChannel.trim().slice(0, MATCH_RECOMMEND_MAX_FIELD_LEN);
        }
      }
    }
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, error.status || 502, headers);
  }
  return json(picksResult, 200, headers);
}

// A small, comparative re-score for fixtures that already went through
// buildMatchRecommendPrompt once and came out genuinely contesting the
// same viewing slot (see Match Find's build-data.mjs "contested cluster"
// detection - this route never sees the rest of the day's fixtures, only
// ones already flagged as a close call). The base prompt scores each
// fixture in isolation, one at a time in a big batch, which is fine for
// "roughly how good is this" but weak at "which of these two SPECIFIC
// fixtures is actually the bigger deal right now" - a real answer to that
// needs the model to weigh them against each other with a bit more
// reasoning depth, which is what buying a Pro-tier model for just this
// small, rare case is for (see MATCH_RECOMMEND_REFINE_MODELS' own
// comment).
function buildMatchRefinePrompt(matches) {
  return `These ${matches.length} sports fixtures overlap in time and scored closely on an initial pass - you're being asked specifically because they need a more careful, COMPARATIVE judgment than a quick independent score can give. Using your own real-world knowledge (current standings/wild-card races, recent form, rivalry history, star players, injuries, how much real-world media/fan attention each is actually getting right now), decide which is genuinely the bigger deal and score them to reflect that clearly - don't default back to similar numbers just because the first pass did. For EACH fixture return:
- "competitiveness": integer 1-10, how close/contested you expect it to be.
- "watchability": integer 1-10, how entertaining or notable it is regardless of closeness.
- "reason": one short sentence (under 40 Traditional Chinese characters) in Traditional Chinese explaining the two scores, written as a direct comparison where it's warranted (e.g. noting why this one edges out the others in the group).
- "venueZh": the given "venue" in Traditional Chinese, or "" if you have no real basis to translate it.
- "whereToWatchTw": your best guess at the Taiwan broadcaster, or "無已知台灣轉播" if unsure - this is a fallback only, a separate grounded lookup may override it.

Fixtures (each already has an "id" - use it to key your answer, never invent or rely on ordering alone):
${JSON.stringify(matches)}

Rules:
- Return exactly one entry per given "id" - never add, drop, or merge fixtures.
- A genuine tie is a valid answer - don't manufacture a preference where the real-world stakes are actually comparable - but don't default to sameness out of caution either when one fixture is clearly the bigger story.
- Never invent an injury, transfer, statistic, broadcaster, or venue translation you're not confident is real.
- Return ONLY the raw JSON object matching the given schema - no markdown fences, no extra text.`;
}

async function handleMatchRecommendRefineRequest(request, env, headers, ip) {
  if (request.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, headers);

  const rateLimit = await isRateLimited(env, ip, 'match-recommend-refine', MATCH_RECOMMEND_REFINE_RATE_LIMIT);
  headers['X-RateLimit-Backend'] = rateLimit.backend;
  if (rateLimit.limited) {
    return json({ error: { message: 'Too many requests, please try again later.' } }, 429, headers);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: { message: 'Worker has not configured GEMINI_API_KEY.' } }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, headers);
  }
  const rawMatches = Array.isArray(body?.matches) ? body.matches : null;
  if (!rawMatches || !rawMatches.length) {
    return json({ error: { message: 'Missing or invalid matches' } }, 400, headers);
  }
  if (rawMatches.length > MATCH_RECOMMEND_REFINE_MAX_ITEMS) {
    return json(
      { error: { message: `At most ${MATCH_RECOMMEND_REFINE_MAX_ITEMS} matches per request` } },
      400,
      headers
    );
  }
  const matches = rawMatches.map(cleanMatchRecommendItem);
  if (matches.some(m => !m)) {
    return json({ error: { message: 'Missing or invalid matches' } }, 400, headers);
  }

  let picksResult;
  try {
    picksResult = await fetchStructuredPicks(
      matches,
      env,
      MATCH_RECOMMEND_REFINE_MODELS,
      buildMatchRefinePrompt(matches)
    );
  } catch (error) {
    return json({ error: { message: error.message || 'Upstream request failed' } }, error.status || 502, headers);
  }
  return json(picksResult, 200, headers);
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

// Match Find's /match-find-sync: same reuse reasoning as /vocab-sync above
// (one already-deployed Worker, one already-deployed Firebase project,
// rather than standing up a second of each for another sibling static
// site), and the same singleCredential shape as /vocab-sync rather than
// Orbit's own code+manager-passcode one - a viewer's sport-priority/
// enabled-sports/subscribed-services settings are "one person's own
// preferences synced across their own devices", the same "no
// teacher/student broadcast, no read-only viewer role" situation
// /vocab-sync's own comment describes, not "one person's schedule read by
// many". The payload itself is tiny (a handful of settings, not a whole
// week's schedule or a learner's whole progress history) - its own much
// smaller MAX_PAYLOAD_LENGTH reflects that rather than reusing Vocab's.
const MATCH_FIND_SYNC_PASSCODE_LENGTH = 16;
const MATCH_FIND_SYNC_PASSCODE_PATTERN = /^[2-9A-HJ-NP-Z]{16}$/;
const MATCH_FIND_SYNC_READ_RATE_LIMIT = 6000;
const MATCH_FIND_SYNC_WRITE_RATE_LIMIT = 300;
const MATCH_FIND_SYNC_DELETE_RATE_LIMIT = 20;
const MATCH_FIND_SYNC_CREATE_RATE_LIMIT = 20;
const MATCH_FIND_SYNC_MAX_PAYLOAD_LENGTH = 4096;
const MATCH_FIND_SYNC_APP = {
  collection: 'match-find-sync',
  featurePrefix: 'match-find-sync',
  maxPayloadLength: MATCH_FIND_SYNC_MAX_PAYLOAD_LENGTH,
  readLimit: MATCH_FIND_SYNC_READ_RATE_LIMIT,
  writeLimit: MATCH_FIND_SYNC_WRITE_RATE_LIMIT,
  deleteLimit: MATCH_FIND_SYNC_DELETE_RATE_LIMIT,
  createLimit: MATCH_FIND_SYNC_CREATE_RATE_LIMIT,
  singleCredential: true,
  credentialLength: MATCH_FIND_SYNC_PASSCODE_LENGTH,
  credentialPattern: MATCH_FIND_SYNC_PASSCODE_PATTERN
};

// ==== Routing ================================================================

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, request.cf?.colo);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path === '/gemini') return handleGeminiRequest(request, env, headers, ip);
    if (path === '/nl-edit') return handleNlEditRequest(request, env, headers, ip);
    if (path === '/sync') return handleSyncRequest(request, env, headers, ip, ORBIT_SYNC_APP);
    if (path === '/vocab-sync') return handleSyncRequest(request, env, headers, ip, VOCAB_SYNC_APP);
    if (path === '/match-find-sync') return handleSyncRequest(request, env, headers, ip, MATCH_FIND_SYNC_APP);
    if (path === '/vocab-ai') return handleVocabAiRequest(request, env, headers, ip);
    if (path === '/match-recommend') return handleMatchRecommendRequest(request, env, headers, ip);
    if (path === '/match-recommend-refine') return handleMatchRecommendRefineRequest(request, env, headers, ip);
    return json({ error: { message: 'Not found' } }, 404, headers);
  }
};
