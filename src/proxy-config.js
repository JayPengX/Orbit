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
