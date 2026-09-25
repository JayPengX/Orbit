import { defineConfig } from 'vite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// .nojekyll has to ride along in the build output so GitHub Pages serves
// dist/ the same way it serves the repo root today.
function copyNojekyll() {
  return {
    name: 'copy-nojekyll',
    closeBundle() {
      copyFileSync('.nojekyll', 'dist/.nojekyll');
    }
  };
}

// The app's "version" is derived from the checked-out commit instead of a
// hand-edited constant, so cache-busting and the version tag can never drift
// out of sync with each other (or with what's actually deployed) the way a
// manually bumped string could. The short hash is what makes every value
// below actually change on every deploy; the commit date is only for the
// human-readable "版本 …" label. Falls back to a timestamp outside a git
// checkout (e.g. a source tarball) so the build never hard-fails.
function readGitVersion() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const date = execSync('git log -1 --format=%cd --date=format:%Y.%m.%d', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    if (hash && date) return { hash, date };
  } catch {
    // Not a git checkout - fall through to the timestamp fallback below.
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return {
    hash: String(now.getTime()),
    date: `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`
  };
}
const APP_VERSION = readGitVersion();

// Replaces the literal token "__APP_VERSION__" (used for cache-busting query
// strings in index.html, and for public/sw.js's own cache name) with the
// real version everywhere it appears - index.html via Vite's own HTML
// transform, and public/sw.js by patching the copy Vite already places in
// dist/ once the build has finished writing it.
function injectAppVersion() {
  return {
    name: 'inject-app-version',
    transformIndexHtml(html) {
      return html.replaceAll('__APP_VERSION__', APP_VERSION.hash);
    },
    closeBundle() {
      const swPath = 'dist/sw.js';
      const content = readFileSync(swPath, 'utf8').replaceAll('__APP_VERSION__', APP_VERSION.hash);
      writeFileSync(swPath, content);
    }
  };
}

export default defineConfig({
  // Relative, not absolute ('/'): this site deploys to
  // https://jaypengx.github.io/Orbit/ - a subpath, not domain root.
  // Vite's default base emits asset URLs like "/assets/x.js", which under a
  // subpath deploy resolve to the wrong place (domain root instead of
  // /Orbit/) and 404, leaving the page stuck on its boot spinner forever
  // since the module that would clear it never loads. base: './' emits
  // "./assets/x.js" instead, which resolves correctly under any subpath.
  base: './',
  plugins: [copyNojekyll(), injectAppVersion()],
  define: {
    // The date alone repeats across every push made the same day - the
    // hash is what keeps the displayed tag actually distinguishing one
    // deploy from the next when there are several in a day.
    __APP_VERSION_DATE__: JSON.stringify(APP_VERSION.date),
    __APP_VERSION_HASH__: JSON.stringify(APP_VERSION.hash)
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom',
    // Each test file gets its own module registry and document - required by
    // test/helpers/loadApp.js, which imports the real src/main.js module
    // graph once per file.
    isolate: true,
    setupFiles: ['./test/helpers/setupEnv.js'],
    // Nearly every file boots the whole app through loadApp(), so building
    // jsdom - not running assertions - dominated the suite. vmThreads builds
    // it once per worker instead of once per file and keeps the per-file
    // isolation above, taking the run from ~11.5s to ~5.5s.
    //
    // reset-app-data.test.js is the one file that can't use it: inside a VM
    // realm jsdom's `location` is a non-configurable accessor, so the test
    // can't stand in for the location.reload() that a factory reset ends on.
    // It runs on the default pool, where that property is still replaceable.
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          pool: 'vmThreads',
          // Vitest's default excludes are replaced, not merged, so
          // node_modules has to be restated alongside the one opt-out.
          exclude: ['**/node_modules/**', '**/dist/**', 'test/reset-app-data.test.js']
        }
      },
      { extends: true, test: { name: 'location', include: ['test/reset-app-data.test.js'] } }
    ]
  }
});
