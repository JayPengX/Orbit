// ---- src/main.js ----
// Entry point: imports every module purely for its
// side effects, in the one order that matters - bootstrap.js must finish
// (build the schedule, start the clock) before testsim-runtime.js patches
// it. Nothing else imports either of those two, so this ordering holds.
import './data.js';
import './schedule.js';
import './appearance.js';
import './dashboard.js';
import './editor-backup.js';
import './editor-core.js';
import './editor-teachers.js';
import './editor-schedule.js';
import './dashboard-render.js';
import './gemini-ocr.js';
import './editor-nl-edit.js';
import './bootstrap.js';
import './testsim-runtime.js';
