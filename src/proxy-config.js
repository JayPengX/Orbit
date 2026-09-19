// ---- src/proxy-config.js ----
// Base URL of the single Cloudflare Worker (see the separate jaypengx-collab/
// shared-proxy repo's worker.js - this Worker's source no longer lives in
// this repo, see README's "跨裝置同步"/"AI 辨識課表照片" sections) that backs
// every server-side feature this app has - AI photo import (/gemini), AI
// schedule edits (/nl-edit) and cross-device sync (/sync) all reuse the same
// deployed Worker, so there is one URL to configure (the PROXY_URL GitHub
// Actions variable, see README) instead of one per feature. Each caller
// below appends its own hardcoded path - the Worker itself dispatches on
// that path (see shared-proxy's own routing at the bottom of worker.js).
//
// `?.` guards against import.meta.env itself being undefined (unbuilt source
// served directly, bypassing Vite) - see gemini-ocr.js's matching note.
const PROXY_BASE_URL = (import.meta.env?.VITE_PROXY_URL || '').trim().replace(/\/+$/, '');

export function proxyPath(path) {
  return PROXY_BASE_URL ? `${PROXY_BASE_URL}${path}` : '';
}
