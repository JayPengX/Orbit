# Orbit Class

A browser-based class-schedule dashboard that tells you what's happening right now, not just what your timetable says.

> **Live site: [https://jaypengx.github.io/Orbit/](https://jaypengx.github.io/Orbit/)** — Try it now, no install required.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Getting Started](#getting-started)
- [How Schedules Are Built](#how-schedules-are-built)
- [Odd/Even Week Detection](#oddeven-week-detection)
- [Appearance & Theming](#appearance--theming)
- [Time Simulation](#time-simulation)
- [AI Schedule-Photo Import](#ai-schedule-photo-import)
- [AI Natural-Language Schedule Editing](#ai-natural-language-schedule-editing)
- [Backup, Export & Device Transfer](#backup-export--device-transfer)
- [Cross-Device Sync](#cross-device-sync)
- [Data Storage](#data-storage)
- [Project Structure / Architecture](#project-structure--architecture)
- [The Per-Second Update Loop](#the-per-second-update-loop)
- [Responsive Design & Accessibility](#responsive-design--accessibility)
- [Privacy](#privacy)
- [Contributing / Notes for Modifying This Project](#contributing--notes-for-modifying-this-project)
- [Known Limitations](#known-limitations)
- [Current Status](#current-status)
- [Related Projects](#related-projects)

---

## Overview

Orbit Class is a class-schedule dashboard that runs entirely in the browser. It doesn't just display a timetable — it continuously computes which period is happening right now, how many minutes are left, and what's coming up next, so opening the page gives you the answer immediately instead of making you cross-reference a printed schedule yourself.

It's a purely static front-end site: no accounts, no backend database. By default, your schedule lives only in your own browser's local storage.

Three features are optional and each talks to a shared service the deployment site has already configured (a Cloudflare Workers proxy, a Firestore project), so that individual users never need to sign up for a Gemini API key or set up their own Firebase project themselves:

- **AI schedule-photo import** (OCR via Gemini)
- **AI natural-language schedule editing**
- **Cross-device sync**

All three are deliberately built on top of services whose free tier has a hard usage cap and requires no credit card. The worst case if the shared infrastructure is abused is that the quota runs out and the feature pauses until it resets — never an unexpected bill. Security details for each feature are covered in their respective sections below, and overall caveats are summarized in [Known Limitations](#known-limitations).

---

## Key Features

- **"Right now" front and center**: the top of the dashboard always shows the current class, teacher, room, and time remaining (progress bar + countdown), followed by a preview of the next period, then the full day's schedule list — tap any period for a detail card.
- **Fully automatic transitions**: period changes, day changes, and end-of-class all recompute automatically — no manual refresh or "next period" button needed.
- **Non-class periods handled properly**: lunch break, cleaning time, and similar special periods are shown by name with their own countdown on the main screen, rather than being forced into the "class" display format.

---

## Getting Started

This is a purely front-end project — no server, no database at runtime. During development, [Vite](https://vitejs.dev/) bundles the ES modules under `src/` and provides a dev server and test runner.

**Online use**: just open [jaypengx.github.io/Orbit](https://jaypengx.github.io/Orbit/) — nothing to install. Every push to `main` triggers `.github/workflows/static.yml`, which runs tests, builds, and deploys — a failing test blocks deployment.

**Local development**:

```bash
git clone https://github.com/JayPengX/Orbit.git
cd Orbit
npm install
npm run dev
```

Open the URL printed in the terminal (default `http://localhost:5173/`) — changes hot-reload on save.

**Other commands**:

```bash
npm test           # run the Vitest test suite
npm run build       # build the production bundle into dist/
npm run preview     # preview the dist/ build locally
npm run lint         # run ESLint over src/
npm run format       # run Prettier (excludes index.html and css/styles.css)
```

---

## How Schedules Are Built

Click the schedule-editor icon in the top-right tools menu to open the settings panel:

- **Teacher / course list**: each entry records a course name, teacher, and room. When building the schedule you pick from this list rather than retyping it for every period.
- **Scheduling**: a drawer-style interface — pick one day at a time and assign each period.
- **Bell times**: set the start/end time for each period; malformed times or overlaps with other periods are rejected.
- **Special periods**: lunch break, cleaning time, and similar.
- **Countdown events**: see the "Countdown events" note further down this section.

The editor remembers the last saved state. Any difference between the current form contents and that saved state counts as "unsaved changes" — closing the editor or doing an export/import in that state triggers a confirmation prompt first, to avoid accidentally overwriting your edits.

**Countdown events** are a list independent of the schedule itself: each entry records a name and a date (a single day, or a range — e.g. a three-day exam week). The dashboard shows the nearest upcoming events and the days remaining, sorted soonest-first.

---

## Odd/Even Week Detection

The app computes the ISO week number from the current date and maps even/odd to a "second week / first week" designation (a "swap odd/even" toggle is available to flip this to match how your school actually counts weeks) — no manual switching required. For a period that alternates between two different subjects on odd vs. even weeks, use a slash notation like `Chinese/Civics` to fill both subjects into one slot; the system automatically picks the correct half to display based on the currently computed week parity.

---

## Appearance & Theming

Appearance settings are stored separately from schedule data and don't affect each other. You can switch between light/dark mode, pick a preset color scheme, or choose a custom accent color (secondary and supporting colors are automatically derived to stay readable). Color changes go through a two-step "preview" then "confirm apply" flow — nothing is actually saved until you confirm. There are also several custom style save-slots you can switch between with one click.

---

## Time Simulation

This is a debugging tool, deliberately *not* a persistent button in the top toolbar. It's tucked inside a collapsed-by-default "Advanced: Time Simulation" sub-section at the bottom of the "Sync / Import-Export" panel, and only opens once you expand it and click "Open Time Simulation" — this avoids accidental activation during normal use, and keeps the toolbar limited to its fixed three buttons (Edit Schedule, Sync / Import-Export, Style Tools).

The time simulation panel lets you specify any weekday and any time directly; the entire dashboard (progress bar, countdown, next-period preview, special-period detection) recomputes and displays as if that were the real time. Leaving simulation mode restores the real clock — no need to wait for an actual point in time to test edge cases.

The automated test suite run by `npm test` uses the same simulation flags (`window.MANUALLY_TEST` / `TEST_DAY` / `TEST_TIME_SEC`) to exercise a set of boundary time points in jsdom. The time simulation panel handles interactive, manual spot-checks; the automated suite guards against regressions.

Next to the version number in the time simulation panel are two small buttons: "Update" forces a fresh fetch of the latest version (clearing the Service Worker cache), and "Reset" wipes all of this device's Orbit Class data (schedule, styles, sync settings) and returns to the initial start screen — this always prompts for confirmation first rather than clearing immediately, and does not affect any other device that's part of the same sync.

---

## AI Schedule-Photo Import

Take a photo or screenshot of a class schedule and let AI read it automatically, instead of entering every period by hand:

1. **Pick a file** → supports JPG/PNG/WebP, iPhone HEIC/HEIF, and PDF (a school-issued schedule file can be dropped in directly). Images the browser can decode are drawn onto a canvas, capped on their longest edge, and re-compressed as JPEG (to avoid sending huge files and slowing down recognition); HEIC and PDF are usually not decodable in-browser, so those are sent as-is — Gemini already understands both formats natively, so there's no need to bundle a PDF parser for every user. While recognition is in progress the "Choose File" button is locked, so switching files mid-flight can't leave an in-flight request pointless (it can't be cancelled, so switching would just waste a quota unit).
2. **Up to 6 files can be selected at once, and they are read together as one schedule** — not processed separately and stitched together afterward. This is the key part: you can give it one photo of a schedule whose columns use codes or generic subject names, then a second file — a screenshot from a course-registration system — and within the same request the model can use the second file's subject and teacher names to fill in the blanks left by the first. Order matters: later files supplement or correct earlier ones; when both files disagree about the same slot, the later file wins.
3. **Sent to Gemini** with a prompt that instructs the model to only report what it can actually see — uncertain bell times come back as an empty array rather than a guessed common schedule; teachers/rooms it can't read are left blank rather than invented (cross-referencing information between the two files doesn't count as inventing — only filling in something neither file contains does). The response format is constrained server-side by a Structured Output Schema, so the model can't return markdown fences, preambles, or any other shape — this measured about a 6% average reduction in output tokens in testing, **but had no measurable effect on latency itself** (A/B runs of the same model and photo, with and without the schema, came out essentially tied, occasionally even slightly slower with the schema). The claim that "a schema lets the model skip reasoning" didn't hold up here — the schema's real value is elsewhere: it guarantees the response is always parseable JSON, so `parseResponse()`'s fallback shell-stripping logic is no longer on the normal path, and during this change it caught a real bug that would otherwise have broken the feature outright (see "How this was measured" below). The odd/even-week toggle is entirely unaffected by AI import: a single photo can never reliably tell you whether it was taken during an odd or even week, so this setting always keeps its current value — whatever the AI recognizes never overrides it.
4. **Multiple Gemini models are tried in order — fastest first, strongest last.** Beyond connection/HTTP failures triggering a fallback to the next model, a structurally unusable result (e.g. zero classes recognized) also automatically triggers a retry with a stronger model further up the chain; only if all of them fail does the app hand the last attempt's result and error to the user for manual correction. While waiting, the UI shows a **fixed, non-counting estimated duration** (computed from file count, not a countdown — a countdown draws attention to exactly the moment it's most likely to be wrong, and hitting zero without finishing looks broken). Only once the wait significantly exceeds the estimate does the message change to "Taking a bit longer than expected, still recognizing…". A separate, smaller and dimmer "Waited N seconds" counter ticks alongside it — it answers a different question ("is this still alive?" rather than "how much longer?"), and is deliberately made less prominent than the estimate text and excluded from screen-reader announcements (`aria-hidden`), unlike the old countdown that used to announce a new number every second.
5. **Results go through the same validation/normalization pipeline as manual input**, and are shown as an editable, checkable preview.
6. **The preview screen also runs a second, content-level check** (`detectScheduleAnomalies()` in `src/gemini-ocr.js`) — the prior step only confirms the result is *structurally* valid (bell times are valid times, `weeklySchedule` has the right shape, at least one class or countdown event was recognized), not that the content actually makes sense. This second pass runs entirely locally — no additional Gemini call — and looks for cases that are structurally legal but suspicious: two bell times overlapping each other, a period whose time falls inside a special period like lunch or cleaning time yet still has a class assigned, two overlapping periods on the same day each assigned a different class (a scheduling conflict), or a class duration that's implausibly short (e.g. two minutes) or implausibly long. Each of these is only a heuristic and can produce false positives (a school might genuinely have two overlapping bell schedules), so they are always shown as a "might need attention" list in the preview and **never block or hide the import button** — blocking import is reserved for the hard validation failure in the prior step.
7. **Nothing is applied until the user confirms** (overwrite or merge into the existing schedule) — AI output never takes effect without explicit confirmation.

**Speed**: as soon as the user reaches the file picker (while they're still choosing a file), the app fires an empty warm-up request to the proxy, shifting the cost of DNS, TLS, and Worker cold-start into the seconds the user was going to spend picking a file anyway, rather than leaving it on the critical path after the user hits import. The proxy streams Gemini's response straight through rather than buffering the full response in the Worker and re-serializing it. Image encoding uses the asynchronous `canvas.toBlob` instead of `toDataURL` (which runs the entire JPEG encode synchronously on the main thread — for a large photo, that shows up as a frozen UI that looks like a crash). The browser console logs three timing segments — `GeminiEncode` / `GeminiCall:<model>` / `GeminiParse:<model>` — so a slow run can be diagnosed as an encoding, network, or front-end parsing bottleneck without guesswork.

**How this was measured**: the speed numbers above aren't guesses — a synthetic set of schedule photos plus course-registration screenshots was run directly against the real Gemini API (bypassing the not-yet-deployed Worker, using the same prompt/schema/generationConfig) for several dozen real requests. That process caught two bugs that would have broken this feature outright in production:

- The initial design used `additionalProperties` to describe `teacherDB`, an object whose keys are subject names the model itself invents. It turns out Gemini's `response_schema` (actually a subset of OpenAPI 3.0) doesn't support that keyword at all — every request was rejected with a 400 before it even reached the model. This isn't documented anywhere; it only surfaces when you make a real request with a real key. Simply removing the constraint down to a bare `type: 'object'` overcorrected: with no structural hint at all, the model just left the field empty. The fix that was both schema-legal *and* actually got populated by the model was replacing the `teacherDB`/`locationDB` maps with a `classes` array (each entry `{key, subject, teacher, location}`). `normalizeAIOutput()` in `src/gemini-ocr.js` now understands both the new array format and the old map format, for the same reason as the other `LEGACY_*` compatibility shims in that file: to guard against the window where a client and proxy version are momentarily out of sync during a rolling deploy.
- `maxOutputTokens: 8192` turned out to be too tight once schema constraints were combined with multi-file input: `gemini-3.6-flash` once stalled for 94 seconds, burned through the output cap, and returned content truncated mid-stream — not valid JSON (`finishReason: MAX_TOKENS`). Raising the cap to 24576 let the same request finish cleanly in 4 seconds, using fewer than 1000 tokens in the end — the model wasn't trying to say more, it just needed more headroom to wrap up properly; raising the cap doesn't make it talk longer. That same model later reproduced a completely different failure mode across several independent test runs (reading only 1 class instead of the expected 12), suggesting this model version is simply unstable under schema-constrained decoding — it was removed from the candidate list entirely rather than just reordered, since a fallback model that might silently hang for 94 seconds and then fail anyway is worse than no fallback at all. The same round of testing also found `gemini-2.5-flash` now returns 404 for new callers (Google has retired it) and was dropped from the list; `gemini-3.8-flash` (the newest version) returned 503 (overloaded) three times in a row even with backoff retries and isn't stable enough to use yet.

In practice (single photo, multiple runs) `gemini-3.5-flash-lite` consistently lands at 2–3 seconds; sending two photos together doesn't noticeably slow this down, and the bridging behavior between files works as intended — comfortably inside the target of "under 10 seconds, ideally under 5." That said, this is a one-time measurement against the current candidate model list, this prompt/schema, and whatever capacity Google's infrastructure happened to have at test time — not a permanent guarantee. Model availability, load, and even model behavior itself can change later.

An internet connection is required; without one, every other feature is unaffected (this is a skippable, optional feature). Opening the editor (settings) checks connectivity, and if there's no connection, the AI import and cross-device sync create/join buttons are grayed out and locked immediately, rather than letting you find out after clicking. The lock clears automatically once connectivity returns — no refresh needed. This check can only detect "no network at all" (e.g. airplane mode) — it can't detect "network present but can't reach the external service," which still only surfaces once an actual request fails.

### Where the key lives, and how secure it is

Ordinary users **never need** to obtain or enter their own Gemini API key. The deployment site already has a server-side proxy configured (`worker.js` in the separate [JayPengX/shared-proxy](https://github.com/JayPengX/shared-proxy) repo, at the `/gemini` path — the same Worker also serves the `/sync` path for cross-device sync; see [Cross-Device Sync](#cross-device-sync) below). The real key exists only as that Worker's encrypted secret and never ships in client-side code.

The proxy isn't a dumb pass-through: the client can only send `{model, files}` (file count, per-file and total size limits, and allowed MIME types are all enforced Worker-side); the actual prompt, response schema, and generation parameters sent to Gemini are hardcoded in the Worker itself. Even if someone extracts the Worker URL (it's already sitting in public front-end code) and calls it directly, all they can do is run "recognize the schedule in this image" — they cannot repurpose it as a general-purpose free AI proxy for arbitrary questions. This is deliberate, since the Worker URL was never meant to be secret.

**Hourly request limits**: when bound to a KV namespace (`RATE_LIMIT_KV`, see deployment steps below), this becomes a real counter shared across edge nodes, not a soft per-instance tally — without it, the count falls back to in-memory per-instance state, and since Cloudflare's edge runs many parallel instances, that's trivially bypassed by spreading requests across them. Whether or not KV is bound, this layer can only catch "a lot of requests from one IP in a short window" — it can't stop abuse spread across many IPs, and it isn't a cryptographic security mechanism.

The real, un-bypassable backstop is the **Cloudflare Workers free-tier daily request cap**: exceeding it simply fails until the next day's reset, requires no extra configuration, and cannot generate a bill (unless someone deliberately attaches their own Gemini key to a paid, credit-card-backed billing account — see [Known Limitations](#known-limitations)).

Without internet, recognition simply can't happen; without a deployed proxy, the whole feature is unavailable (`PROXY_URL` left empty, or the Worker never deployed) — it does not fall back to a bring-your-own-key flow. All other schedule features are unaffected.

### One-Time Deployment Setup

The Worker's source code, deployment steps, and detailed configuration (Cloudflare account setup, `GEMINI_API_KEY`, KV rate limiting, why `[placement] region` is set the way it is, GitHub Actions auto-deploy) have all moved to the separate [JayPengX/shared-proxy](https://github.com/JayPengX/shared-proxy) repo — because this one Worker has served Orbit, Orbit Vocab, and Match Find (three independent sites) from day one, and keeping it inside Orbit's own repo would make "which repo do I change the proxy in" an open question. Full steps are in that repo's README.

Once the Worker is deployed, this repo only needs one step:

1. Copy the Worker URL (`https://<worker-name>.<subdomain>.workers.dev`) — **without a path suffix**. This one Worker serves AI import (`/gemini`), AI schedule editing (`/nl-edit`, see below), and cross-device sync (`/sync`, see below) — the path is appended by the front-end code itself (see `src/proxy-config.js`); the config value only needs to be the Worker's base URL.
2. In the GitHub project's Settings → Secrets and variables → Actions → **Variables** (not Secrets — this value is meant to end up in public front-end code), add `PROXY_URL` with the value copied above. On the next push to `main`, the deployed site starts using the proxy — enabling all three features at once (whether the latter two are actually usable also depends on shared-proxy having its own required secrets configured — see that repo's README).

Gemini occasionally reports `AI recognition request failed (400): User location is not supported for the API use.` (see `src/gemini-ocr.js`). The client automatically retries the whole request when this happens (up to 2 retries; `/nl-edit` uses the same retry logic — see [AI Natural-Language Schedule Editing](#ai-natural-language-schedule-editing) below). The error message also includes a Cloudflare colo code (`X-Worker-Colo` header, e.g. "colo: IAD") to help with bug reports. Why this error actually happens, and how shared-proxy is configured to avoid it, is documented in that repo's README under `[placement]`.

---

## AI Natural-Language Schedule Editing

This is a separate feature from AI schedule-photo import (independent requests, validation, and failure handling), but shares the same `PROXY_URL`, the same deployed Worker, and the same `GEMINI_API_KEY` — once `PROXY_URL` is set, the `/gemini` and `/nl-edit` paths are enabled **together**, with no way to turn on just one (whether the Worker actually implements a given path is the real switch — see the deployment setup below).

At the top of the **Schedule** tab in the "Edit Schedule" panel (not the "Sync / Import-Export" panel — the schedule editor is where the schedule is actually changed, so this tool lives here rather than in the sync panel) there is an "AI Schedule Edit" text input. Type a sentence (or several requests at once) describing what you want changed — e.g. "change Tuesday's third period to Physics," "move Wednesday's first period to Thursday's first period," or several things at once: "change Tuesday's third period to Physics, then clear Thursday's first period." After submitting, the AI translates the sentence into one or more structured edit operations, and applying them always shows a diff preview for confirmation first — the same preview/confirm flow used for AI import (the same `describeSettingsDiff()` / `showEditorSaveConfirm` path) — there's no such thing as a submission that changes the schedule directly.

- **Not a fixed set of actions — a compact edit patch**: an earlier version only recognized four fixed actions ("change a period," "move a period," "swap two periods," "clear a period"), so requests like "add a new class," "add another period," or "add a break period" had no matching action at all. It was then changed to have the AI read every editable field and return those fields' *complete* content "after applying the instruction" — this solved the missing-action problem, but meant the AI had to copy out every untouched class and every untouched schedule slot verbatim on every request, and it would occasionally miscopy a character during that process, silently corrupting a field the instruction never mentioned — with no obvious starting point for diagnosing it. The current design is a middle ground: the AI still reads every editable field (as before), but the response contains only what it's actually adding or changing — the classes to add/update (`classUpserts`), the class keys to delete (`deletedClassKeys`), the schedule slots to change (`scheduleEdits`, one entry per slot), plus a changed/unchanged flag for each of bell times, special periods, countdown events, and odd/even-week setting, with the new full content included only when changed. Adding a class, adding/removing a bell period, adding a special period, adding a countdown event, or toggling odd/even week are all naturally covered by this same response shape — the only difference is that anything the instruction didn't mention is no longer allowed to appear in the response at all.
- **Anything the instruction doesn't mention never appears in the response, so there's nothing left to miscopy**: the server-side prompt explicitly instructs the model to "list only what is actually being added, changed, or deleted — everything else must not appear in the response." The client takes this compact patch and layers it directly onto the current data (anything not mentioned — classes, schedule slots, bell times, special periods, countdown events — stays byte-for-byte unchanged), then computes the confirmation screen's diff from the before/after state. This makes "something the AI wasn't asked to change gets changed anyway" structurally impossible, rather than something that depends on a carefully worded prompt to avoid. A single instruction covering several things at once (e.g. "change Tuesday's third period to Physics, and add a lunch break from 12:00–13:00") is still one request and one response — the AI lists all the changes together in the same reply.
- **What's sent is just this one instruction, plus the schedule's full set of editable fields** (`classes` / `weeklySchedule` / `bellTimes` / `breakTimes` / `countdownEvents` / `reverseWeek` — not styling, sync settings, or other data), giving the AI enough context to resolve references like "my Tuesday third period" or "the Physics teacher's class," and enough data to actually add something rather than being forced to guess or fail.
- **A misunderstood instruction, or a reference to something that doesn't exist, are both clean failure states, not crashes**: when the AI returns "couldn't understand this instruction," it explains why in one sentence; when it returns "the thing you're referring to doesn't exist" (e.g. the schedule has no ninth period), it explains that too. Both cases show a dismissible message dialog — no error screen, and no data changes.
- **Anything the server returns is treated as untrusted and re-validated**: the client first does a shape check (are the expected fields present, with the expected types), then feeds the result into `normalizeSettingsData()` — the same content-level validation and sanitization shared with manual save, AI import, and backup restore. Any structurally implausible content is rejected before it reaches the confirmation screen; an unreasonable AI suggestion is never shown to the user as something to confirm. If the instruction produces no actual field changes, the UI shows "no changes" instead of an empty confirmation screen.
- **Automatic retry on Gemini's "User location is not supported" error**: this error comes from Google inferring a region from the Cloudflare Worker's egress IP rather than the user's actual location, so the same user can get a different result simply because Cloudflare routed them to a different edge node. On this error, the client automatically retries the whole request (not a retry within the same node), up to 2 times, before showing an error — the user never has to manually re-click submit. This uses the same retry logic as AI import (`gemini-ocr.js`).
- **This is an optional feature and is simply unavailable when not deployed/configured**: with `PROXY_URL` empty, the input box shows "AI schedule editing is not configured yet — please contact your schedule administrator," with no fallback mode — consistent with AI import and cross-device sync. A read-only sync device can't open the schedule editor at all, so this feature is naturally unreachable for it too (the same lock as the rest of the editor — see [Manager vs. Read-Only Role](#cross-device-sync) below).

### One-Time Deployment Setup

This uses the **same** shared-proxy Worker, the **same** `GEMINI_API_KEY`, and the **same** `PROXY_URL` as AI import (see the deployment setup under [AI Schedule-Photo Import](#ai-schedule-photo-import) above) — if you've already set that up, there's nothing else to do here. The `/nl-edit` path is already implemented in that Worker's `worker.js`, and setting `PROXY_URL` enables it automatically.

If the Worker isn't deployed, or `PROXY_URL` is left empty, this feature is simply unavailable — it doesn't affect AI import, cross-device sync, or any other schedule feature.

---

## Backup, Export & Device Transfer

Data lives in a single browser only. Moving to another device/browser, or keeping an archival copy, relies on export/import: export flattens the schedule data, compresses it with raw DEFLATE, and turns it into a copy-pasteable text block. Pasting it into another device to import always shows a diff for confirmation before applying — it never silently overwrites the existing schedule. Older (uncompressed JSON) backups still import fine; new exports always use the new format.

---

## Cross-Device Sync

An optional feature that automatically syncs the schedule across multiple devices, without manual export/import each time. Clicking the "Sync / Import-Export" icon in the top-right tools menu opens a panel independent of the schedule editor — sync is the **default, first option shown**; the manual backup flow is still there too, tucked into a collapsed-by-default "Manual Backup (legacy)" sub-section in the same panel. This panel is a separate tool from the schedule editor, and it's always reachable even from a read-only device (see [Manager vs. Read-Only Role](#manager-vs-read-only-role) below).

Ordinary users **never need** to sign up for or configure anything themselves. The deployment site already has a server-side proxy configured (the `/sync` path of `worker.js` in the [JayPengX/shared-proxy](https://github.com/JayPengX/shared-proxy) repo — the same Worker that also serves AI import's `/gemini` path; see [AI Schedule-Photo Import](#ai-schedule-photo-import) above). The browser never touches Firestore directly — every read and write goes through this Worker first, which counts requests and rejects malformed payloads, and the Worker uses its own Firebase service account to access the shared Firestore project. There's no cap on the number of devices; any device with the same pairing code joins the same shared document.

Deploying without this Worker (`PROXY_URL` left empty, e.g. on a self-hosted fork) means cross-device sync is entirely unavailable — the editor shows "cross-device sync is not configured," with no fallback to a direct-Firestore flow. All other schedule features are unaffected.

**Typical use**: Device A clicks "Create New Sync" — this doesn't create anything immediately; it first shows a one-time confirmation explaining that this will create a new document on the shared server and consume some of this feature's limited creation quota, to avoid accidentally (or just out of curiosity) creating a sync that never gets used. After confirming, the device receives a "sync code" and a "manager passcode" in one shot. The sync code can be shared freely — any device with it can join and receive updates, though the code alone cannot be used to edit the schedule. The manager passcode is the sole credential for editing, and should only be given to devices you want to also be able to edit. Device B pastes the sync code and clicks "Join Sync" — by default this joins as read-only; to also allow editing, it must expand the collapsed "I have the manager passcode and want to be able to edit too" section and enter the passcode — only a server-verified correct passcode grants manager access. There's no in-between state: leaving the passcode blank or entering it wrong both simply mean read-only. Pairing/unpairing updates the screen immediately, no refresh needed. Clicking "Join Sync" first confirms the code actually exists (and that the passcode is correct, if one was entered): a mistyped code, a code nobody ever created, or a wrong passcode all show a clear error and stop there rather than reporting a false success. Only once that check passes does a warning appear — joining will immediately and irreversibly replace this device's current schedule with the one under that code (the device that created the sync is unaffected).

### Manager vs. Read-Only Role

- When a new sync is created, the system generates a random sync code and an unrelated random manager passcode — neither can be derived from the other. The manager passcode is **shown exactly once**, at creation time, and the UI requires you to confirm you've saved it before continuing; the sync code, by contrast, stays visible on the paired screen at all times. The device that created the sync can later click "Show" on the paired screen to see its own manager passcode again, to share with other devices it wants to also be able to edit — the only thing that's ever truly unrecoverable is the passcode itself; if the creating device also forgets it, the only option is to delete the sync entirely and start over.
- Whether a device is "manager" is determined purely by whether it currently holds the correct manager passcode locally — it's not something the user simply declares, and it's not fixed at the moment of joining. No passcode, or a wrong one, always means read-only; a read-only device can enter the manager passcode at any later point from the paired screen to gain edit access, without needing to unpair and rejoin. And critically, **this is now actually enforced**: without the correct passcode, even a request sent directly to the API bypassing the UI cannot write or delete (see the security section below) — it's not just a matter of a few buttons being grayed out in the interface, as it used to be.
- A read-only device's "Edit Schedule" button is simply locked and does nothing when clicked (the same style of lock used for the style tools below — not something that opens and then dims the whole page). There's nothing a read-only device would need inside the schedule editor anymore: sync status, unpairing, AI/manual import, and requesting edit access all live in the separate "Sync / Import-Export" panel, which both roles can always open. Within that panel, AI import and the manual "Import" button are individually locked (manual "Export" is unaffected); the save function itself also refuses, as a second line of defense in case the locked buttons are bypassed. The top toolbar's "Style Tools" button is likewise locked — a read-only device that's still receiving synced styling would have any local style edit overwritten on the next sync anyway; checking "Don't sync style/colors" unlocks it.
- A read-only device that wants to edit its own schedule independently just clicks "Unsync" — the local schedule is unaffected, and the device can rejoin later using the same sync code.
- "Unsync" only makes this one device forget the code it's holding (and, if it was the manager, its manager passcode too) — the shared schedule on the server and every other paired device are completely unaffected, and the code can still be used to rejoin later. The confirmation dialog offers a "Copy code" button first, to save it for later (for a manager, this copies the manager passcode alongside it). Managers additionally see "Delete Sync Entirely" — this uses the Worker to delete the shared schedule document on the server outright, immediately invalidating both the sync code and this manager passcode: every device holding that code (not just the one that clicked the button) will discover on its next sync attempt that the code no longer exists, and each reverts to whatever local schedule it last had — irreversibly (see the `DELETE /sync` note in the security section below for details). Read-only devices don't see this button at all, and even a bypassed direct API call is rejected by the Worker if the passcode is wrong — unlike the old behavior, where it would simply execute. This particular confirmation doesn't offer a "copy code" option — once deleted, the code is entirely void and copying it serves no purpose.
- The moment a device *joins* a sync (not creates one), its current local schedule is backed up before the shared schedule is applied — this is exactly the moment referenced by the warning "joining will immediately and irreversibly replace this device's current schedule." Later, the first time "Unsync" or "Delete Sync Entirely" is actually triggered — as long as that backup hasn't already been consumed — a dialog pops up asking "Restore the schedule from before you joined?" You can choose "Restore pre-join schedule" to get back the local schedule from before joining, or "Keep current schedule" to discard the backup and keep the current (formerly shared, now local) schedule. This is a pop-up that appears exactly at the moment of unsync/delete, not something left sitting in the panel waiting to be noticed. If the shared schedule at join time happened to be identical to the local one (nothing was actually overwritten), no backup is created and this dialog never appears.
- The locks on the schedule editor and style tools remain purely a UI convenience to keep users from accidentally triggering something — the real barrier against writes and deletes is the Worker's manager-passcode check (see the security section below). The UI lock isn't the only line of defense, but it isn't the whole story either: the passcode itself carries no user identity, and the risk of a leaked passcode is unchanged (see security below).
- Both places where a manager passcode is entered — "Join Existing Sync" and "Get Edit Access" — are tucked into collapsible sections (the same collapse style as "Manual Backup (legacy)" and "Advanced: Time Simulation"), collapsed by default so they don't take up space unnecessarily. Whether you close the panel with ×, switch to another tool, or refresh the page, leaving the "Sync / Import-Export" panel automatically clears any sync code / manager passcode fields you typed into it and re-collapses those sections — this is purely tidiness, to avoid leaving a typed passcode sitting on screen, and has no direct bearing on actual security (the real defense is on the Worker side — see security below).
- Any paired device (manager or read-only) can additionally check "Don't sync style/colors" — after which this device's accent/secondary color and personal styling are fully decoupled from the shared document in both directions: this device's own color choices won't be overwritten by anyone else's, and won't overwrite the shared style either (when a manager saves, the style fields uploaded are still whatever the shared style currently is — this device's own retained colors are never included in that upload); schedule content still syncs normally in both directions. Managers are already unaffected by the read-only style lock described above; for a manager, this checkbox simply means "my colors are different from everyone else's, but I don't want every save to overwrite everyone else's colors." Checking or unchecking this always shows a confirmation first — unchecking it in particular deserves caution: on the next sync, this device's currently-retained colors will be immediately and irreversibly replaced by the shared style, so both directions are confirmed before applying; declining the confirmation reverts the checkbox to its previous state rather than silently toggling. Confirming either direction triggers an immediate sync check rather than waiting for the next interaction. For the direction that actually overwrites data — unchecking (switching back to receiving the shared style) — **the shared colors and style defaults are applied the moment you confirm**, not on the next sync — the earlier behavior just flipped the toggle and left it to the next poll, but a poll that saw no document version change would simply skip applying anything, so it would silently do nothing until some other device happened to change something else first. At the same time, this device's current colors and style defaults are backed up locally — this backup is independent of pairing state and survives changing codes or unsyncing.

This backup is never surfaced as a persistent on-panel prompt (nobody scrolls back to check for those) — instead, it's only asked about **the next time "Don't sync style/colors" is re-checked** — that's exactly the moment "this device doesn't want to match everyone else again," the same pattern used for the unsync-restore prompt above. You can choose "Restore saved colors" (restoring the style defaults along with it) or "Keep current colors" (discard the backup). If the backup is identical to what's currently on screen (e.g. the colors were never actually changed before the toggle was flipped), it's silently discarded with no prompt at all — there's no point asking when both options do the exact same thing.

**First-time use**: if a browser has never stored a schedule and never configured sync, opening the app shows a one-time prompt asking whether to enter a pairing code to join an existing sync. Declining leads to a follow-up choice: "go to settings and build manually" or "use AI photo recognition." This only appears once (tracked by `orbitOnboardingSeen`), regardless of which option is chosen or if the prompt is simply dismissed.

**How sync actually works**: hitting "Save" uploads immediately — saving *is* syncing, with no delay. On the receiving side there's no background polling timer running constantly: a check for a newer remote version only happens when the device is actually touched (click, keypress, tap), and the same device won't check again within 5 seconds of its last check, to avoid firing a request for every single action during a burst of activity. A device that's completely untouched sends no check requests at all — unlike fixed-interval polling, it doesn't continuously consume read quota. A refresh, switching a background tab back to foreground, or opening the page for the first time always triggers an immediate check (ignoring the 5-second throttle), so you don't have to specifically tap the screen just to see the latest version. The trade-off: a receiving device that's genuinely untouched (e.g. just sitting there displaying the schedule, with nobody interacting) has to wait until someone actually touches it (or a refresh/tab switch) before it picks up the latest version — it isn't a passive push. While the editor has unsaved changes, sync reads/writes are paused; a backgrounded tab sends no requests at all.

**Conflict resolution**: **last-write-wins**, with no field-level merging and no branching.

- One device edits, others only display (the most common case): the manager saves and it uploads immediately; other devices pick it up once actually touched (or refreshed/foregrounded) — no conflict.
- Two devices genuinely editing at the same time: no merge happens — whichever upload lands later completely overwrites the earlier one, silently, with nothing preserved. Normal usage ("A finishes saving, then B opens") rarely hits this.
- Mid-edit, not yet saved: nothing is uploaded and no remote version is applied while you're typing — what you're working on is never overwritten mid-edit; only the moment you click "Save" is the version that participates in the comparison.

This is designed for "one person using several devices in turn," not for "multiple people simultaneously co-editing the same schedule."

### Security: The Passcode Only Gates Writes — There's Still No User Identity Verification

The sync code is the sole gate for reading; the manager passcode is the sole gate for writing/deleting. These are separate responsibilities, and the rules are actually enforced server-side:

- Anyone with the **sync code** can read that schedule indefinitely — the code itself cannot be used to write; it's purely an identifier for "which shared document to look at." Anyone with the **manager passcode** (along with the sync code) can write (`PATCH`) to, or entirely delete (`DELETE`), that schedule. Without the correct passcode, both operations are always rejected by the Worker with a 403 — this is a rule the Worker genuinely checks and genuinely enforces, not merely a UI convention like "read-only devices don't see the button." Manager status no longer lives only in the device's local `localStorage`; the server itself verifies the passcode before permitting a write (see `handleSyncRequest` in the shared-proxy repo's `worker.js`). This is the biggest difference from the earliest design: previously, anyone with the sync code could bypass the UI and send an HTTP request directly to write or delete; now, without the correct manager passcode, that's simply not possible at the server layer.
- That said, the code and passcode remain nothing more than credentials — **there is still no real user identity verification**. The server only checks the passcode itself, not who is using it, and has no way to confirm the person entering it is who they claim to be. If the manager passcode leaks, anyone holding it can tamper with the schedule indefinitely; if the sync code leaks, anyone can read the schedule indefinitely. Neither has an expiration mechanism, and neither can be individually reissued — the only recourse is deleting the sync entirely and recreating it, which invalidates both the code and the passcode together.
- The manager passcode is returned by the Worker exactly once, at creation time; the database only ever stores its SHA-256 hash (`managerPasscodeHash`) — the plaintext passcode is never persisted anywhere. Even if the Firestore data were to leak (e.g. a misconfigured project permission, a leaked backup), an attacker would only obtain the hash, which cannot be reversed back into the original passcode and therefore cannot be used to impersonate the manager and write. The document's ID is the sync code itself (reading was never meant to be gated in the first place, so there's no need to hide it) — only the manager passcode goes through a hash comparison.
- Created syncs never expire or get cleaned up automatically: a pairing that's no longer used stays in the database forever unless someone actively clicks "Delete Sync Entirely" (or sends a `DELETE` directly with the code plus manager passcode) — this is currently the only real way to remove a document from the database (see [Known Limitations](#known-limitations)).

The browser never touches Firestore directly: every request goes first through the Worker, which counts requests, rejects malformed payloads, and rejects oversized payloads — the Worker then uses its own service account to access Firestore; Firestore's own security rules are set to reject all direct access outright, closing the door that used to let anyone hit it directly. This is what makes a genuine cross-request rate limit possible at all (see the numbers in the Worker source — creation, `DELETE`, and password-verified `GET` all have their own tighter hourly limits, tracked separately from general reads/writes), and it's also the layer where the manager-passcode check genuinely happens (see the first bullet above) — but **there is still no user identity verification**: the code and passcode remain the sole credentials, and every risk listed above remains unchanged.

If this risk profile is a concern, don't enable cross-device sync; if it's acceptable, proceed to the deployment setup below.

### One-Time Deployment Setup

This uses the **same** shared-proxy Worker as AI import — the full setup for the Firebase project, service account key, `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`, KV rate limiting, and Firestore security rules is documented in the [JayPengX/shared-proxy](https://github.com/JayPengX/shared-proxy) repo's README (the "Sync features" section). If you've already deployed this Worker for AI import, follow that section directly — there's no need to stand up a second Worker.

Once that's done, this repo only needs to confirm `PROXY_URL` is set (see the deployment setup under [AI Schedule-Photo Import](#ai-schedule-photo-import) above) — `/sync` shares the same value as `/gemini` and `/nl-edit`; nothing else to do if it's already configured.

Without that setup (`PROXY_URL` left empty, e.g. on a self-hosted fork), cross-device sync is entirely unavailable — it does not fall back to a direct-Firestore mode (that mode has been removed: Firestore rules can't count requests, so a rate limit built on them alone would be meaningless).

### This Worker Also Serves Two Sibling Sites

Beyond `/sync`, `/gemini`, and `/nl-edit`, the same Worker also serves two sibling static sites — this simply reuses an already-deployed Worker (with Firebase and Gemini already configured) as shared infrastructure, instead of setting up a whole new Firebase project and a whole new Worker deployment, and re-tuning rate limits from scratch, for each additional site. Each path has its own independent Firestore collection and its own independent rate-limit counter (see the full path table in the shared-proxy repo's README) — none of them, including Orbit's own `/sync` / `/gemini` / `/nl-edit`, share or compete for quota with each other:

- **[Orbit Vocab](https://github.com/JayPengX/Orbit-Vocab)**'s cross-device learning-progress sync (`/vocab-sync`) and personalized mnemonics (`/vocab-ai`, generated on the fly based on the specific spelling mistakes that particular learner has actually made).
- **[Match Find](https://github.com/JayPengX/Match-Find)**'s "which game should I watch today" AI recommendation (`/match-recommend`, `/match-recommend-refine`) and cross-device settings sync (`/match-find-sync`).

This is a one-way dependency: Orbit works completely normally with no knowledge that these two sites exist, and none of their paths appear anywhere in Orbit's own web pages or source code. Details (each site's own pairing mechanism, payload limits, why some need two independent Gemini calls, etc.) live in the shared-proxy repo's README and in the comments next to each path in `worker.js`, rather than being duplicated here where they'd risk drifting out of sync with the actual source.

---

## Data Storage

Everything is stored under a single browser `localStorage` key, `classFocusData`. Main fields:

| Field | Contents |
| ----- | -------- |
| `teacherDB` | course → `[course name, teacher, room]` |
| `locationDB` | course → room (fast lookup table) |
| `weeklySchedule` | each weekday (`Date.getDay()` 0–6, 0 = Sunday) mapped to that day's scheduled periods |
| `bellTimes` | each period's `[start time, end time]` |
| `breakTimes` | special periods, each `{name, start, end}` |
| `countdownEvents` | countdown events, each `{name, startDate, endDate}` |
| `reverseWeek` | odd/even-week swap toggle |
| `proAccent` / `proSecondary` | appearance accent and secondary colors |
| `styleSlots` | custom style save-slots |

Every save carries an internal schema-version marker, checked on read; a mismatch triggers compatibility handling first. A corrupted save (invalid JSON, missing fields, wrong types) is discarded outright in favor of the default schedule, rather than keeping broken data around to fail again next time.

Other independent keys:

- `orbitSyncCode` / `orbitSyncManagerPasscode` / `orbitSyncLastUpdateTime` — cross-device sync pairing info; absent entirely when sync isn't enabled. An empty string for `orbitSyncManagerPasscode` means this device is read-only; a non-empty string is the manager passcode it holds (see [Manager vs. Read-Only Role](#manager-vs-read-only-role) above). Leftovers from the old direct-Firestore mode (`orbitSyncProjectId`) and an even earlier two-code design (`orbitSyncRole`) are cleared out on the next pair/unpair.
- `orbitOnboardingSeen` — whether the first-time-use prompt has been shown; the value is only ever `1` or absent.

---

## Project Structure / Architecture

The browser only ever loads static files: `index.html`, `css/styles.css`, and one built JS bundle. The original 4,500-line `js/app.js` has been split into ES modules under `src/`, using `import`/`export` to make dependencies explicit:

```text
src/data.js              Data read/write, validation, normalization, localStorage access
src/schedule.js          Assembles settings data into a "running schedule," weekday/week-parity computation
src/schedule-calc.js     Pure computation: which class/period should be shown right now
src/appearance.js        Theme color and light/dark mode
src/dashboard.js         Main-screen live-update core, including the update() state machine
src/editor-backup.js     Backup export/import, v2 transfer-format encode/decode
src/editor-core.js       Schedule editor main flow, unsaved-changes detection
src/editor-teachers.js   Teacher/course list editing
src/editor-schedule.js   Weekly scheduling interface
src/dashboard-render.js  Actual DOM rendering for the main screen
src/gemini-ocr.js        File pre-processing (image/HEIC/PDF) and Gemini proxy calls
src/editor-nl-edit.js    AI schedule editing: natural-language instruction parsing, validation, pre-apply preview
src/sync.js              Cross-device sync: reads/writes via the Worker proxy, polling
src/onboarding.js        First-time-use prompt flow
src/bootstrap.js         Startup flow: load data, build schedule, start the per-second timer
src/testsim-runtime.js   Time simulation state machine
src/state.js             Shared mutable state across modules
src/constants.js         Shared constants across modules (weekday names, default colors)
src/strings.js           UI text lookup table
src/main.js              Entry point, imports every module above in order
```

Server-side code (the `/gemini`, `/sync`, etc. paths) does not live in this repo — that Cloudflare Worker is now the independent [JayPengX/shared-proxy](https://github.com/JayPengX/shared-proxy) repo, is not part of `src/`'s dependency graph, and is naturally not bundled by Vite. Without it deployed and its environment variables configured, the corresponding feature is simply unavailable — there is no fallback mode.

Each file starts with a one-line comment describing its responsibility. A few conventions worth knowing before changing code:

- **`src/state.js` is the shared mutable-state container.** State that's shared across modules and written from multiple places belongs in the object `state.js` exports (`state.xxx = ...`) — don't create another module-level `let` for it. ES module `import` bindings are read-only, so another module can't assign to it directly.
- **`window.update()` is a deliberately dynamic call.** At runtime, `testsim-runtime.js` swaps it out for a wrapper that layers in time-simulation logic. To trigger a re-render, always call `window.update()` rather than `import { update }` — importing it directly would call the original, un-swapped version, silently breaking time simulation. The same applies to `window.openTestPanel`.
- **`update()` is split into a pure-computation layer and a rendering layer**: `computeDashboardViewModel()` in `schedule-calc.js` never touches the DOM — it only produces a plain object describing what the screen should look like; `renderDashboard()` in `dashboard.js` then writes that result into the page (diffing against the previous render so unchanged fields aren't rewritten). Changes to schedule-computation logic usually belong in `schedule-calc.js`, and can be unit-tested directly as a pure function.
- **`src/strings.js` is the text lookup table**, currently only containing `zh-TW`, accessed via `t('some.key')`. This isn't in preparation for immediate multi-language support — it's just keeping text separate from logic; new UI text should follow this same convention.
- **`src/constants.js` holds constants shared across modules, and deliberately imports nothing.** `data.js` and `appearance.js` import each other, so putting shared constants in either one would create a circular-import TDZ error. Weekday labels (`WEEKDAY_LABELS`) and the two weekday orderings (`WEEKDAYS_DISPLAY_ORDER`, Monday-first, used for display; `WEEKDAYS_INDEX_ORDER`, Sunday-first, matching `Date.getDay()` and the storage format) both live here — import them as needed rather than redefining them per file.

---

## The Per-Second Update Loop

On startup, a timer runs once per second, fully recomputing every time:

```text
get current time → derive weekday → derive odd/even week → look up today's schedule
    → determine current period (or special period) → determine next period
    → update remaining time / countdown numbers → render to screen
```

Because the whole state is recomputed from scratch every tick, rather than patched incrementally on top of the previous state, edge cases like "class just ended" or "day just changed" need no special-case handling at all.

"Recomputing" and "writing to the screen" are two separate steps: computation always runs in full every tick, but the DOM-write step diffs against the previous render and only writes fields that actually changed (countdown numbers and progress-bar width change every second by nature and are excluded from this diffing). A given class's name, for instance, typically stays the same for tens of minutes at a stretch — there's no reason to rewrite it every second and trigger unnecessary browser style recalculation.

---

## Responsive Design & Accessibility

On mobile, the layout is touch-first: larger buttons, reflowed cards, a bottom sheet menu in place of a sidebar, iOS safe-area handling, and respect for the system's "reduce motion" preference.

Tablet/desktop don't get a separate layout — they're the same mobile-first design scaled up and centered proportionally, with card width capped in stages as the viewport widens (`≥700px`, `≥1024px`), and the whole layout centered vertically when the screen is taller than the content.

"Add to Home Screen" provides a dedicated icon (`public/icons/`), rather than relying on a system-generated thumbnail.

---

## Privacy

Ordinary use — building a schedule, viewing the dashboard, backup export/import — happens entirely on-device; no data leaves the device. There are two exceptions, both enabled by default on the deployed site:

- **AI recognition**: a selected file is sent to the proxy and forwarded to Gemini (the proxy doesn't retain files, but the file's contents genuinely do leave the browser). This only happens once you select a file and click import; the warm-up request fired when the file picker opens carries no file content.
- **AI schedule editing**: the instruction text you type, along with every editable field of the current schedule (course list, scheduling, bell times, special periods, countdown events, odd/even-week setting — see [AI Natural-Language Schedule Editing](#ai-natural-language-schedule-editing)), is sent to the proxy and forwarded to Gemini. This only happens once you type something and click submit.
- **Cross-device sync**: the schedule is stored in a shared Firebase project; Firestore's own security rules have no user-identity verification (see the security section under [Cross-Device Sync](#cross-device-sync)). This only happens once you click "Create New Sync" or "Join Sync."

On a self-hosted fork without the corresponding environment variables configured, each of these features is simply unavailable — there's no fallback.

---

## Contributing / Notes for Modifying This Project

There's no framework and no backend at runtime; development uses Vite + Vitest + ESLint/Prettier.

- Don't add a front-end framework (React/Vue/etc.) — Vite here is purely a bundler/dev-server/test-runner.
- Put new features into whichever existing module is the closest semantic fit (see [Project Structure / Architecture](#project-structure--architecture)); mutable state shared across modules belongs in `state.js`.
- New `localStorage` fields should follow the pattern already used by the `normalize*`/`validate*`/`sanitize*` functions in `src/data.js`: validate before storing, and make sure old data loading in won't blow up.
- After changing schedule-computation or countdown logic, run `npm test` first; scenarios not covered by automated tests (most editor UI, the style panel, the AI import flow) should be manually spot-checked at boundary times using the time simulation panel.
- After a style change, check both dark mode and mobile width.
- After finishing a change, run `npm run build` and confirm `dist/` is a fully working site, not just something that runs fine in dev mode.

---

## Known Limitations

- Data defaults to a single browser; without sync enabled, clearing the browser's site data wipes the schedule along with it — periodic export backups are recommended.
- No account system, no real-time multi-user collaboration. Cross-device sync is not push-based: a save uploads immediately, but a receiving device only checks for updates once it's actually touched (click/key/tap, or a refresh/tab switch) — a device nobody touches never picks up a new version on its own.
- Neither cross-device sync nor the AI proxy features (photo recognition, schedule editing) have user identity verification — the pairing code / Worker URL is the sole gate. This isn't designed to protect privacy; if that matters to you, don't enable it (see the security subsection in the relevant sections above for details).
- AI schedule editing reads and rewrites the entire set of editable data at once (classes, scheduling, bell times, special periods, countdown events, odd/even-week setting); anything it doesn't understand, or that refers to something nonexistent, is never guessed at, and a diff preview must be reviewed and confirmed before anything applies. Like AI import, it requires an internet connection and shares the same hourly request limit.
- Unused sync pairing codes never expire and are never passively cleaned up — they accumulate in Firestore indefinitely until a manager actively clicks "Delete Sync Entirely" to remove that document.
- The "sync code + manager passcode" model is a data format that only exists after this Worker's redesign (see the security subsection under [Cross-Device Sync](#cross-device-sync)); any pairing created **before** that redesign (whether under the original single-code design, or the brief intermediate two-code manager/receiver design) no longer has a corresponding document on the Worker side — its code will simply come back as "pairing code not found," and a new sync must be created.
- AI recognition, AI schedule editing, and cross-device sync all run on the deployer's shared infrastructure, and quota is counted against the deployer, not the individual user; the worst case of abuse is the quota running out and the feature pausing, not a bill — unless the deployer has personally attached their Gemini key to a paid, credit-card-backed billing account.
- AI recognition accuracy depends on photo clarity and schedule layout — always review the preview before confirming an import; an internet connection is required. To keep wait times short, the fastest model is tried first, with escalation to stronger models only when the result is structurally unusable — this is much faster on average than always starting with the largest model, though occasionally a couple of extra fields may need manual correction even at the same photo quality.
- Automated tests cover schedule computation, data validation, backup format, the sync module, and the AI proxy logic, but editor UI flows, the style panel, and actual AI-recognition accuracy still rely primarily on time simulation and manual verification.

---

## Current Status

Schedule display, scheduling, odd/even-week switching, bell times, special periods, countdown events, appearance customization, time simulation, backup export/import, AI photo recognition (including content-level anomaly warnings in the import preview), AI schedule editing, and cross-device sync are all fully functional and independent of one another — the core schedule features never depend on network access or AI; AI and sync are both optional. `js/app.js` has been fully split into ES modules under `src/`, with automated tests covering schedule computation, data validation, backup format, the sync module, and the AI proxy logic (including natural-language-edit validation and anomaly detection); test coverage of the editor UI flows may be extended further going forward.

---

## Related Projects

- **[Shared-Proxy](https://github.com/JayPengX/Shared-Proxy)** — the shared Cloudflare Worker backend behind AI recognition, AI schedule editing, and cross-device sync.
- **[Orbit-Vocab](https://github.com/JayPengX/Orbit-Vocab)** — a sibling site sharing the same Worker infrastructure (vocabulary learning-progress sync and personalized mnemonics).
- **[Match-Find](https://github.com/JayPengX/Match-Find)** — a sibling site sharing the same Worker infrastructure (game recommendations and settings sync).

---

**[jaypengx.github.io/Orbit](https://jaypengx.github.io/Orbit/)** — open it in a browser and start using it.
