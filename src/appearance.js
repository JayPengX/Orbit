// ---- src/appearance.js ----
// Theme colors, light/dark mode, and the style panel's preview/save flow.
import { state } from './state.js';
import { closeTestPanel, setOverlayVisible } from './dashboard.js';
import { fitNowTitleText } from './dashboard-render.js';
import { DEFAULT_STYLE_PRIMARY, DEFAULT_STYLE_SECONDARY } from './constants.js';
import { applyEditorSettingsData, cloneSettingsData, isEditorDirty } from './editor-backup.js';
import {
  closeEditor,
  closeTransferSheet,
  esc,
  hasUnconsumedImportData,
  hideEditorDiscardConfirm,
  setEditorConfirmContent,
  showEditorConfirmSheet,
  showEditorDiscardConfirm,
  showTransferDiscardConfirm
} from './editor-core.js';
import { getSyncKeepLocalStyle, isSyncViewer } from './sync.js';
import { t } from './strings.js';

function normalizeHexColor(value, fallback) {
  const color = String(value || '')
    .trim()
    .toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : fallback;
}
function normalizeProAccent(value) {
  return normalizeHexColor(value, DEFAULT_STYLE_PRIMARY);
}
function normalizeProSecondary(value, fallback = DEFAULT_STYLE_SECONDARY) {
  return normalizeHexColor(value, fallback);
}
// Picks black or white text for a solid-color badge/button/pill painted in
// the user's own chosen accent color. This used to maximize WCAG 2's
// gamma-linearized contrast ratio (whichever of black/white had the higher
// ratio against the background), which is the textbook-correct approach
// but a known bad fit for exactly this job: that formula weights the red
// channel so lightly (0.2126, versus green's 0.7152) that a vivid, fully
// saturated red/pink/magenta - visually one of the *brighter*, punchier
// colors on screen - computes as "dark" and tips the ratio toward black
// text, which reads as harsh/muddy on a color that vivid. It also produces
// near-coin-flip results for plenty of ordinary mid-saturation colors,
// where the two ratios differ by only a few percent - not a stable signal
// for something that should look obviously right. Plain perceptual
// brightness (the classic YIQ-weighted average, no gamma curve) tracks how
// bright a color actually looks far more closely, and a single 128/255
// threshold (the standard cutoff for this exact black-or-white decision)
// gives consistent, unsurprising results across the whole preset palette -
// including fixing the red/pink family specifically.
function getReadableTextColor(value) {
  const color = normalizeProAccent(value).slice(1);
  const [r, g, b] = [0, 2, 4].map(index => parseInt(color.slice(index, index + 2), 16));
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness >= 128 ? '#10171A' : '#FFFFFF';
}
function getReadableSurfaceColor(value) {
  const color = normalizeProAccent(value).slice(1);
  const channels = [0, 2, 4]
    .map(index => parseInt(color.slice(index, index + 2), 16) / 255)
    .map(channel =>
      channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    );
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const surfaceLuminance = 0.008;
  const contrast =
    (Math.max(luminance, surfaceLuminance) + 0.05) / (Math.min(luminance, surfaceLuminance) + 0.05);
  return contrast >= 3 ? '#' + color : '#F4FBFF';
}
function normalizeStyleSlots(value) {
  const slots = Array.isArray(value) ? value : [];
  return Array.from({ length: 5 }, (_, index) => {
    const source = slots[index] && typeof slots[index] === 'object' ? slots[index] : {};
    const primary = normalizeProAccent(source.primary);
    return {
      name: String(source.name || '')
        .trim()
        .slice(0, 12),
      primary,
      // An explicitly stored secondary (a legacy slot synced in from before
      // the app went single-hue) is preserved as-is, never silently
      // rewritten - but an empty/unfilled slot's preview swatch now falls
      // back to a shade of ITS OWN primary instead of the old app-wide
      // default pink, so five empty slots don't show five copies of a
      // two-tone combo nothing on screen still uses.
      secondary: normalizeProSecondary(source.secondary, deriveSingleHueSecondary(primary))
    };
  });
}
// The app is single-hue now: there's one color the person picks (proAccent),
// and everywhere the UI needs a second tone for contrast/emphasis (the
// countdown card, the toolbar hub, "next up" vs "happening now", ...) that
// tone is this - the same hue, mixed 32% toward white, rather than an
// independently chosen second color. Plain per-channel mix (not an HSL
// round-trip) so it's the exact same math as the CSS `color-mix(in srgb,
// var(--pro-accent) 100%, white 32%)` shade used to preview this everywhere
// else in the design - the two never had to be re-tuned to agree with each
// other.
function deriveSingleHueSecondary(primary) {
  const color = normalizeProAccent(primary).slice(1);
  const rgb = [0, 2, 4].map(index => parseInt(color.slice(index, index + 2), 16));
  const toHex = value => Math.round(value).toString(16).padStart(2, '0').toUpperCase();
  return `#${rgb.map(channel => toHex(channel + (255 - channel) * 0.32)).join('')}`;
}
const PRO_PALETTE_PRESETS = {
  default: DEFAULT_STYLE_PRIMARY,
  rose: '#F06F61',
  ocean: '#18B7A0',
  midnight: '#263B68',
  graphite: '#A7C957',
  amber: '#E8A33D',
  ruby: '#E23D5B',
  lilac: '#9B7EDE'
};
function applyProAccent(data = state.applicationData) {
  const accent = normalizeProAccent(data.proAccent);
  // Always derived from accent, never read off data.proSecondary - see
  // deriveSingleHueSecondary's own comment. That field still exists in
  // storage/sync/import payloads for backward compatibility, but nothing
  // that actually paints the UI looks at it any more.
  const secondary = deriveSingleHueSecondary(accent);
  document.body.style.setProperty('--pro-accent', accent);
  document.body.style.setProperty('--pro-secondary', secondary);
  document.body.style.setProperty('--pro-accent-text', getReadableTextColor(accent));
  document.body.style.setProperty('--pro-secondary-text', getReadableTextColor(secondary));
  document.body.style.setProperty('--pro-accent-readable', getReadableSurfaceColor(accent));
  document.body.style.setProperty('--pro-secondary-readable', getReadableSurfaceColor(secondary));
}
// Style-panel changes are previewed first, then committed through the save pipeline.
// Switches to the Orbit Color visual skin.
function setStyleMode() {
  document.body.classList.add('pro-style');
  applyProAccent();
  renderStylePanel();
  refreshStyleModeLayout();
}
function refreshStyleModeLayout() {
  requestAnimationFrame(() => {
    const list = document.getElementById('schedule-list');
    if (list) {
      state.lastAutoScrollKey = null;
    }
    if (typeof window.update === 'function') window.update();
    requestAnimationFrame(() => {
      if (typeof fitNowTitleText === 'function') fitNowTitleText(true);
    });
  });
}
function renderStylePanel() {
  state.stylePanelDraft = {
    ...state.applicationData,
    styleSlots: normalizeStyleSlots(state.applicationData.styleSlots)
  };
  const primary = document.getElementById('style-primary-input');
  if (primary) primary.value = normalizeProAccent(state.applicationData.proAccent);
  document.getElementById('style-panel')?.classList.remove('style-draft-dirty');
  renderStyleSlots();
  setStylePanelMode('editor');
}
function getStyleDraftFromControls() {
  const primary = document.getElementById('style-primary-input');
  const proAccent = normalizeProAccent(primary?.value || state.stylePanelDraft.proAccent);
  return {
    ...state.stylePanelDraft,
    proAccent,
    proSecondary: deriveSingleHueSecondary(proAccent)
  };
}
function previewStyleSettings() {
  state.stylePanelDraft = getStyleDraftFromControls();
  applyStyleVisual(state.stylePanelDraft);
  document.getElementById('style-panel')?.classList.add('style-draft-dirty');
}
function setStylePanelMode(mode) {
  const editor = document.getElementById('style-editor-content');
  const preview = document.getElementById('style-preview-state');
  const editorActions = document.getElementById('style-editor-actions');
  const isPreview = mode === 'preview';
  if (editor) editor.hidden = isPreview;
  if (preview) preview.hidden = !isPreview;
  if (editorActions) editorActions.hidden = isPreview;
}
function enterStylePreview() {
  state.stylePanelDraft = getStyleDraftFromControls();
  applyStyleVisual(state.stylePanelDraft);
  document.getElementById('style-panel')?.classList.add('style-draft-dirty');
  setStylePanelMode('preview');
}
function exitStylePreview() {
  setStylePanelMode('editor');
}
function applyStyleVisual(style) {
  document.body.classList.add('pro-style');
  applyProAccent(style);
  if (typeof window.update === 'function') window.update();
}
// Builds the preview draft into a full settings object and saves it with the
// same settings pipeline used by the class editor.
function confirmStyleSettings() {
  state.stylePanelDraft = state.stylePanelDraft || getStyleDraftFromControls();
  const next = cloneSettingsData(state.applicationData);
  next.proAccent = normalizeProAccent(state.stylePanelDraft.proAccent);
  next.proSecondary = normalizeProSecondary(state.stylePanelDraft.proSecondary);
  next.styleSlots = normalizeStyleSlots(state.stylePanelDraft.styleSlots);
  state.pendingStyleSaveData = next;
  applyPendingStyleSave();
}
// Commits a confirmed style change through the same applyEditorSettingsData
// pipeline as saving or importing the class editor (saves, rebuilds the
// schedule, refreshes the editor baseline, and shows the save toast).
function applyPendingStyleSave() {
  if (!state.pendingStyleSaveData) {
    hideEditorDiscardConfirm();
    return;
  }
  applyEditorSettingsData(state.pendingStyleSaveData, {
    statusMessage: t('appearance.styleSaved')
  });
  setStyleMode();
  state.pendingStyleSaveData = null;
  document.getElementById('style-panel')?.classList.remove('style-draft-dirty');
  hideEditorDiscardConfirm();
  closeStylePanel();
}
function renderStyleSlots() {
  const grid = document.getElementById('style-slot-grid');
  if (!grid) return;
  const slots = normalizeStyleSlots(
    state.stylePanelDraft?.styleSlots || state.applicationData.styleSlots
  );
  grid.innerHTML = slots
    .map(
      (slot, index) =>
        `<div class="style-slot-row"><button type="button" class="style-slot ${slot.name ? 'has-style' : ''}" style="--slot-primary:${slot.primary};--slot-secondary:${slot.secondary}" onclick="loadStyleSlot(${index})" aria-label="${esc(slot.name || t('appearance.emptySlot', { number: index + 1 }))}" title="${esc(slot.name || t('appearance.emptySlot', { number: index + 1 }))}"><span class="style-slot-swatch" aria-hidden="true"></span></button><button type="button" class="style-slot-save" onclick="saveStyleSlot(${index})" aria-label="${esc(t('appearance.saveToSlot', { number: index + 1 }))}">＋</button></div>`
    )
    .join('');
}
// True when `style` is one of the built-in palette presets - i.e. a color
// the user picked off the shelf rather than one they mixed themselves.
// Losing one of these costs a single tap to get back, which is what lets
// loadStyleSlot below skip its "目前的樣式將被替換" warning: a warning about
// discarding something nobody authored is a popup with nothing behind it.
// Comparing proAccent alone is enough now that proSecondary is always a
// pure function of it - two styles can never agree on one and disagree on
// the other.
function isBuiltInPresetStyle(style) {
  const primary = normalizeProAccent(style?.proAccent);
  return Object.values(PRO_PALETTE_PRESETS).some(
    presetPrimary => normalizeProAccent(presetPrimary) === primary
  );
}
function sameSlotColors(slot, style) {
  return normalizeProAccent(slot?.primary) === normalizeProAccent(style?.proAccent);
}
// Both directions of "am I about to lose a color I mixed myself" get a
// confirmation, and neither asks when the answer is obviously no:
//   - an occupied slot warns that its saved pair is being replaced;
//   - an empty slot still confirms, but only to name which of the five
//     positions the new preset is going into - the grid's five identical
//     swatches make mis-taps easy, and a save that lands in the wrong slot
//     is otherwise indistinguishable from one that worked.
function saveStyleSlot(index) {
  state.stylePanelDraft = getStyleDraftFromControls();
  const slots = normalizeStyleSlots(state.stylePanelDraft.styleSlots);
  const slot = slots[index];
  const occupied = !!slot?.name;
  // Re-saving the exact colors a slot already holds changes nothing, so
  // there is nothing to confirm either way.
  if (occupied && sameSlotColors(slot, state.stylePanelDraft)) {
    saveStyleSlotDraft(index);
    return;
  }
  state.pendingStyleSlotSaveIndex = index;
  setEditorConfirmContent(
    occupied
      ? t('appearance.overwritePersonalStyleTitle')
      : t('appearance.saveAsStyleTitle', { number: index + 1 }),
    occupied
      ? t('appearance.overwriteSlotMessage', { name: slot.name })
      : t('appearance.saveToSlotMessage', { number: index + 1 }),
    '',
    occupied ? t('common.overwrite') : t('common.save'),
    applyPendingStyleSlotSave,
    t('common.cancel'),
    { danger: occupied }
  );
  showEditorConfirmSheet();
}
function saveStyleSlotDraft(index) {
  const slots = normalizeStyleSlots(state.stylePanelDraft.styleSlots);
  slots[index] = {
    name: slots[index].name || t('appearance.styleSlotLabel', { number: index + 1 }),
    primary: state.stylePanelDraft.proAccent,
    secondary: state.stylePanelDraft.proSecondary
  };
  state.stylePanelDraft.styleSlots = slots;
  // Saving a slot only ever touches the in-memory draft - it isn't real
  // until confirmStyleSettings()/applyPendingStyleSave() commits the whole
  // draft. Without marking dirty here, closeStylePanel() saw nothing to
  // warn about and let the panel close with no confirmation, silently
  // losing the slot save the moment renderStylePanel() next rebuilds the
  // draft fresh from the (still unchanged) applicationData - same risk
  // loadStyleSlot already avoids via previewStyleSettings().
  document.getElementById('style-panel')?.classList.add('style-draft-dirty');
  renderStyleSlots();
  setStylePanelMode('editor');
}
function applyPendingStyleSlotSave() {
  const index = state.pendingStyleSlotSaveIndex;
  state.pendingStyleSlotSaveIndex = null;
  hideEditorDiscardConfirm();
  if (index !== null) saveStyleSlotDraft(index);
}
function loadStyleSlot(index) {
  const slot = normalizeStyleSlots(
    state.stylePanelDraft?.styleSlots || state.applicationData.styleSlots
  )[index];
  if (!slot || !slot.name) return;
  state.pendingStyleSlotIndex = index;
  // Nothing of the user's own is on screen to lose - the current colors are
  // either a built-in preset, or already exactly what this slot holds - so
  // apply straight away instead of asking about a replacement that costs
  // nothing.
  const current = state.stylePanelDraft || state.applicationData;
  if (isBuiltInPresetStyle(current) || sameSlotColors(slot, current)) {
    applyPendingStyleSlot();
    return;
  }
  setEditorConfirmContent(
    t('appearance.applySavedStyleTitle'),
    t('appearance.currentStyleWillBeReplaced'),
    '',
    t('common.apply'),
    applyPendingStyleSlot,
    t('common.back')
  );
  showEditorConfirmSheet();
}
function applyPendingStyleSlot() {
  const slot = normalizeStyleSlots(
    state.stylePanelDraft?.styleSlots || state.applicationData.styleSlots
  )[state.pendingStyleSlotIndex];
  if (!slot || !slot.name) return;
  document.getElementById('style-primary-input').value = slot.primary;
  state.pendingStyleSlotIndex = null;
  hideEditorDiscardConfirm();
  previewStyleSettings();
}
async function toggleStylePanel() {
  // Belt-and-suspenders, same as saveEditor()/gemini-ocr.js's run button:
  // src/sync.js's applyEditorRoleLock already greys #btn-style out and
  // disables its pointer events for exactly this case, but that's a
  // CSS/pointer-events lock, not real access control. A viewer still
  // accepting synced colors has no real use for the style tool anyway -
  // any local change here would just get overwritten by the next pulled
  // update.
  if (isSyncViewer() && !getSyncKeepLocalStyle()) return;
  const editor = document.getElementById('editor-sheet');
  if (editor.classList.contains('show')) {
    if (isEditorDirty()) {
      state.pendingAfterEditorDiscard = 'style';
      showEditorDiscardConfirm();
      return;
    }
    closeEditor(true);
  }
  const transferSheet = document.getElementById('transfer-sheet');
  if (transferSheet && transferSheet.classList.contains('show')) {
    if (await hasUnconsumedImportData()) {
      state.pendingAfterEditorDiscard = 'style';
      showTransferDiscardConfirm();
      return;
    }
    await closeTransferSheet(true);
  }
  const panel = document.getElementById('style-panel');
  if (panel.classList.contains('show')) {
    closeStylePanel();
  } else {
    closeTestPanel();
    openStylePanel();
  }
}
// Opens Style Mode directly (used by the toolbar toggle and, after
// discarding editor changes, by discardEditorChangesAndClose).
function openStylePanel(resetDraft = true) {
  if (resetDraft || !state.stylePanelDraft) renderStylePanel();
  setOverlayVisible('style-panel-overlay', 'style-panel', true, 'style-panel-open');
}
function closeStylePanel() {
  const panel = document.getElementById('style-panel');
  if (panel.classList.contains('show') && panel.classList.contains('style-draft-dirty')) {
    showStyleDiscardConfirm();
    return;
  }
  setOverlayVisible('style-panel-overlay', 'style-panel', false, 'style-panel-open');
}
function showStyleDiscardConfirm() {
  setEditorConfirmContent(
    t('appearance.styleNotAppliedTitle'),
    t('appearance.leaveWillDiscardPreview'),
    '',
    t('appearance.discardAndLeave'),
    discardStyleChangesAndClose,
    t('common.back'),
    { danger: true }
  );
  showEditorConfirmSheet();
}
function discardStyleChangesAndClose() {
  hideEditorDiscardConfirm();
  setOverlayVisible('style-panel-overlay', 'style-panel', false, 'style-panel-open');
  setStyleMode();
  document.getElementById('style-panel')?.classList.remove('style-draft-dirty');
}
function applyStylePreset(name) {
  const presetPrimary = PRO_PALETTE_PRESETS[name];
  if (!presetPrimary) return;
  const primary = document.getElementById('style-primary-input');
  if (primary) primary.value = presetPrimary;
  previewStyleSettings();
}

// Exposed on window for inline HTML event handlers (onclick="..." in
// index.html and in generated template strings).
window.applyStylePreset = applyStylePreset;
window.closeStylePanel = closeStylePanel;
window.confirmStyleSettings = confirmStyleSettings;
window.enterStylePreview = enterStylePreview;
window.exitStylePreview = exitStylePreview;
window.loadStyleSlot = loadStyleSlot;
window.previewStyleSettings = previewStyleSettings;
window.saveStyleSlot = saveStyleSlot;
window.toggleStylePanel = toggleStylePanel;

export {
  applyProAccent,
  closeStylePanel,
  normalizeProAccent,
  normalizeProSecondary,
  normalizeStyleSlots,
  openStylePanel,
  setStyleMode
};
