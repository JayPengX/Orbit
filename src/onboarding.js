// ---- src/onboarding.js ----
// First-run prompt: a brand-new browser with no saved schedule and no sync
// pairing gets asked once whether it wants to join an existing synced class
// schedule before being nudged toward building one from scratch (by hand in
// the editor, or via the AI photo-import shortcut). Shown at most once - see
// markOnboardingSeen()'s callers - so a returning user is never nagged,
// including one who saw it once and closed the app without actually
// building or joining anything yet.
import { hasSavedSchedule } from './data.js';
import { isSyncConfigured } from './sync.js';
import {
  hideEditorDiscardConfirm,
  setEditorConfirmContent,
  showEditorConfirmSheet
} from './editor-core.js';
import { t } from './strings.js';

const ONBOARDING_SEEN_KEY = 'orbitOnboardingSeen';

function hasSeenOnboarding() {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return true; // Fail closed - never nag if localStorage isn't available.
  }
}
function markOnboardingSeen() {
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  } catch {
    /* localStorage unavailable (private browsing, etc.) */
  }
}

// Sync setup and AI import both live in the standalone "同步 / 匯入匯出"
// sheet now, not inside the schedule editor - opening it directly is the
// whole thing, no fold to expand afterward.
function openSyncPanel() {
  window.openTransferSheet();
}

function focusSyncJoinField() {
  openSyncPanel();
  document.getElementById('sync-join-code')?.focus();
}

function focusAIImportSection() {
  openSyncPanel();
  document.getElementById('ocr-import-box')?.scrollIntoView({ block: 'center' });
}

// Second step, only reached after declining to enter a sync code: offer the
// two ways to actually get a schedule in without one.
function showStartChoice() {
  setEditorConfirmContent(
    t('onboarding.startChoiceTitle'),
    t('onboarding.startChoiceMessage'),
    '',
    t('onboarding.useAiPhoto'),
    () => {
      hideEditorDiscardConfirm();
      focusAIImportSection();
    },
    t('onboarding.buildManually'),
    {
      cancelHandler: () => {
        hideEditorDiscardConfirm();
        window.openEditor();
      }
    }
  );
  showEditorConfirmSheet();
}

function showOnboardingPrompt() {
  if (hasSavedSchedule() || isSyncConfigured() || hasSeenOnboarding()) return;
  markOnboardingSeen();
  setEditorConfirmContent(
    t('onboarding.welcomeTitle'),
    t('onboarding.welcomeMessage'),
    '',
    t('onboarding.enterPairingCode'),
    () => {
      hideEditorDiscardConfirm();
      focusSyncJoinField();
    },
    t('onboarding.buildOwnFirst'),
    {
      cancelHandler: () => {
        hideEditorDiscardConfirm();
        showStartChoice();
      }
    }
  );
  showEditorConfirmSheet();
}

export { showOnboardingPrompt };
