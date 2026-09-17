// ---- src/proxy-config.js ----
// Base URL of the single Cloudflare Worker (cloudflare-worker/orbit-worker.js)
// that backs every server-side feature this app has - AI photo import
// (/gemini), AI schedule edits (/nl-edit) and cross-device sync (/sync) all
// reuse the same deployed Worker, so there is one URL to configure (the
// PROXY_URL GitHub Actions variable, see README) instead of one per feature.
// Each caller below appends its own hardcoded path - the Worker itself
// dispatches on that path (see its own routing at the bottom of the file).
//
// `?.` guards against import.meta.env itself being undefined (unbuilt source
// served directly, bypassing Vite) - see gemini-ocr.js's matching note.
const PROXY_BASE_URL = (import.meta.env?.VITE_PROXY_URL || '').trim().replace(/\/+$/, '');

export function proxyPath(path) {
  return PROXY_BASE_URL ? `${PROXY_BASE_URL}${path}` : '';
}

// Optional second Worker deployment (same orbit-worker.js, deployed as
// cloudflare-worker/wrangler.toml's [env.fallback] - see that file's own
// comment) with Smart Placement left OFF, i.e. Cloudflare's plain
// nearest-to-caller routing instead of nearest-to-Google. Only meaningful
// for the location-block retry in gemini-ocr.js/editor-nl-edit.js: Smart
// Placement sticks a given caller to whichever colo it judged optimal for
// reaching Google, so if THAT colo is one Google blocks, every retry against
// the SAME Worker deployment lands on the same stuck colo and fails the same
// way - a fresh request is only actually a fresh *chance* if it can land
// somewhere Smart Placement wouldn't have sent it. Genuinely optional: with
// no PROXY_URL_FALLBACK configured, callers just retry the primary URL again
// (the old behavior, still a real mitigation, just not as strong a one).
const PROXY_FALLBACK_BASE_URL = (import.meta.env?.VITE_PROXY_URL_FALLBACK || '')
  .trim()
  .replace(/\/+$/, '');

export function proxyFallbackPath(path) {
  return PROXY_FALLBACK_BASE_URL ? `${PROXY_FALLBACK_BASE_URL}${path}` : '';
}
