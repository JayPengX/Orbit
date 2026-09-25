import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    ignores: ['dist/**', '**/node_modules/**']
  },
  {
    files: ['src/**/*.js'],
    ignores: ['src/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Injected at build time by vite.config.js's `define` - see
        // testsim-runtime.js's only use of them.
        __APP_VERSION_DATE__: 'readonly',
        __APP_VERSION_HASH__: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'warn',
      // src/ is all const/let ES modules now (testsim-runtime.js was the last
      // `var` holdout). These two keep it that way rather than leaving it to
      // whoever reviews the next patch.
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['src/**/*.test.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly'
      }
    }
  },
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    }
  },
  {
    // A classic (non-module) service worker script - self/caches/fetch/
    // Response/URL are its own global scope, not the page's window.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker
      }
    }
  }
  // The Cloudflare Worker that backs /gemini, /nl-edit, and /sync (see
  // README) used to live here as cloudflare-worker/**/*.js and had its own
  // override in this list - it's now the separate JayPengX/
  // shared-proxy repo, with its own lint setup, so there's nothing left in
  // this repo's src/ ES module graph for that override to match.
];
