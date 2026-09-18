// ---- src/dashboard-render.js ----
// DOM rendering for the schedule list (not the live "now" card - that's
// dashboard.js) and viewport-driven layout fitting (title sizing, accordion).
import { state } from './state.js';
import { normalizeProAccent } from './appearance.js';
import { keepActiveClassVisible, openModal } from './dashboard.js';
import { openEditorFold } from './editor-core.js';
import { getNextSchoolDay, processSplitName } from './schedule.js';

// Updates the simulation play/pause button and indicator. (Simulator controls
// change the displayed clock only - never the saved schedule data.)
function syncTestPlayPauseUi() {
  const btn = document.getElementById('test-play-pause-btn');
  const indicator = document.getElementById('sim-indicator');
  const exitButton = document.getElementById('test-exit-btn');

  if (!btn || !indicator) return;

  const { text, active, indicatorVisible } = !window.MANUALLY_TEST
    ? { text: '開始', active: false, indicatorVisible: false }
    : window.IS_SIMULATING
      ? { text: '暫停', active: true, indicatorVisible: true }
      : { text: '繼續', active: false, indicatorVisible: false };

  btn.textContent = text;
  btn.classList.toggle('active', active);
  indicator.style.display = indicatorVisible ? 'inline-flex' : 'none';

  if (exitButton) {
    exitButton.disabled = false;
    exitButton.style.opacity = '1';
  }
}

// Keeps only one editor accordion section open at a time.
(function initEditorAccordion() {
  const sheet = document.getElementById('editor-sheet');

  if (!sheet) return;

  sheet.querySelectorAll('details.editor-fold').forEach(det => {
    const summary = det.querySelector('.editor-fold-summary');

    if (summary) {
      summary.addEventListener('click', event => {
        if (!sheet.classList.contains('is-layered')) return;

        // In layered mode, the active layer should stay open.
        // Prevent the native <details> close/reopen flash.
        if (det.classList.contains('active')) {
          event.preventDefault();
        }
      });
    }

    det.addEventListener('toggle', () => {
      if (sheet.classList.contains('is-layered')) {
        if (det.open && !det.classList.contains('active')) openEditorFold(det.id);
        else if (!det.open && det.classList.contains('active')) det.open = true;
        return;
      }
      if (!det.open) return;

      sheet.querySelectorAll('details.editor-fold').forEach(other => {
        if (other !== det) other.open = false;
      });
    });
  });
})();
// Marks real user input the instant it starts, not only once a 'scroll' event eventually
// fires — see the comment on keepActiveClassVisible. There is no manual-scroll correction
// here at all: the list's scrollable bounds are always the browser's own native bounds, so
// there is nothing for this code to enforce beyond what iOS/desktop scrolling already does.
(function initScheduleScrollInputTracking() {
  const list = document.getElementById('schedule-list');

  if (!list) return;

  ['pointerdown', 'touchstart', 'wheel'].forEach(type => {
    list.addEventListener(
      type,
      () => {
        state.userScrolledDuringAlign = true;
      },
      { passive: true }
    );
  });
})();

// Press feedback for the class cards: a live, held-state size change, not a
// canned one-shot animation - grows the finger's card (.is-pressed), eases
// back the instant it lifts, tracking the actual press in real time
// exactly the way the day-nav buttons' own :active does (see .nav-item in
// styles.css). A separate fixed-length "replay the tap" animation was
// tried here first (triggered on the 'click' event, i.e. necessarily after
// the finger had already lifted) and it was never going to feel immediate
// no matter how short it ran, because it always started after the physical
// gesture was already over rather than during it - a structural lag a
// shorter duration can't fix.
//
// Still JS-driven rather than a bare CSS :active rule: on iOS Safari
// specifically, :active on an element with a backdrop-filter has a history
// of failing to composite in time for a tap this quick (see .nav-item's own
// comment on the same issue) - .is-pressed, held for exactly as long as the
// finger is actually down, is the reliable version of the same state.
//
// Applying .is-pressed is NOT immediate on pointerdown, on purpose: a
// touch that's about to become a scroll starts with exactly the same
// pointerdown a tap does, and the 'scroll' event that used to be this
// code's only defense against that doesn't fire until the browser has
// already recognized real movement - a real, visible gap in which the
// card had already popped larger for a gesture that was never a tap at
// all (reported as "cards grow just from scrolling, not clicking").
// PRESS_DELAY_MS holds off actually applying the class until a touch has
// had a moment to prove it isn't the start of a scroll; MOVE_THRESHOLD_PX
// cancels it outright the instant the pointer moves enough to look like a
// drag rather than a stationary press, whether that happens before or
// after the delay elapses. A tap doesn't feel late from this: the delay is
// far under normal press duration, and a real scroll gesture (which moves
// well past the threshold within single-digit milliseconds) never shows
// the grow at all, exactly as intended.
//
// One delegated listener rather than per-row ones: renderList() rebuilds
// every card from scratch on each update, so anything bound to a row would
// have to be re-bound several times a minute.
(function initSchedulePressFeedback() {
  const list = document.getElementById('schedule-list');

  if (!list) return;

  const PRESS_DELAY_MS = 80;
  const MOVE_THRESHOLD_PX = 8;

  let pressedRow = null;
  let pendingRow = null;
  let pendingTimer = 0;
  let activePointerId = null;
  let startX = 0;
  let startY = 0;

  const release = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
    pendingRow = null;
    activePointerId = null;
    if (!pressedRow) return;
    pressedRow.classList.remove('is-pressed');
    pressedRow = null;
  };
  const commitPress = () => {
    pendingTimer = 0;
    if (!pendingRow) return;
    pressedRow = pendingRow;
    pendingRow = null;
    pressedRow.classList.add('is-pressed');
  };

  list.addEventListener(
    'pointerdown',
    event => {
      const row = event.target instanceof Element ? event.target.closest('.row') : null;
      if (!row) return;
      release();
      pendingRow = row;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      pendingTimer = setTimeout(commitPress, PRESS_DELAY_MS);
    },
    { passive: true }
  );
  // Cancels a still-pending press before its delay even elapses, or backs
  // an already-applied one back out - either way, movement past the
  // threshold means this was never a stationary tap.
  list.addEventListener(
    'pointermove',
    event => {
      if (!pendingRow && !pressedRow) return;
      if (event.pointerId !== activePointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (dx * dx + dy * dy > MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) release();
    },
    { passive: true }
  );
  // Released on anything that ends the press, including ones that never
  // reach the list itself: a finger lifted after dragging off the card, a
  // scroll turning the touch into a pan (pointercancel), or the sheet the
  // tap opened stealing the pointer.
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type =>
    window.addEventListener(type, release, { passive: true })
  );
  list.addEventListener('scroll', release, { passive: true });
})();

/* Dashboard sizing and accessible list rendering. */
// Shrinks el's font-size (assumed already single-line/nowrap with visible
// overflow) to fit within `available` px, binary-searching between minSize
// and defaultSize; leaves it at defaultSize if that already fits. Shared by
// fitNowTitleText (the "now playing" title) and dashboard.js's countdown
// event name fit.
function shrinkFontToFit(el, available, defaultSize, minSize) {
  el.style.fontSize = defaultSize + 'px';
  if (el.scrollWidth <= available + 1) return;
  let lo = minSize,
    hi = defaultSize,
    best = minSize;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollWidth <= available + 1) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  el.style.fontSize = Math.floor(best) + 'px';
}
const titleFitState = { key: '', raf: 0 };
function fitNowTitleText(force = false) {
  const title = document.getElementById('now-name');
  const stack = document.querySelector('.now-stack');
  const meta = document.querySelector('.now-meta-row');
  if (!title || !stack) return;

  const raw = (title.textContent || '').trim();
  const isStatus = stack.classList.contains('is-status');
  const hasLatin = /[A-Za-z]/.test(raw);
  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  // Floor for the current-class name's size, not the actual value used -
  // see the height-driven default computed inside the rAF callback below.
  // CSS's own .title-now font-size is dead weight the moment this function
  // runs (every render: shrinkFontToFit() below always sets an inline
  // font-size, overriding whatever the stylesheet said). The current
  // class is the one thing everything else on the dashboard is secondary
  // to, so this has to stay clearly above every other card's own largest
  // text - specifically .timer-badge's 30px ceiling and .title-next's
  // 22px ceiling (see styles.css) - or a short name here reads as smaller
  // than the "remaining time" and "next class" it's supposed to outrank.
  const minDefaultSize = vw <= 430 ? 52 : 50;
  const minSize = hasLatin ? 18 : 22;
  const stackWidth = Math.round(stack.getBoundingClientRect().width);
  const metaText = meta ? (meta.textContent || '').trim() : '';
  const metaDisplay = meta ? getComputedStyle(meta).display : '';
  const key = [
    raw,
    isStatus ? 'status' : 'class',
    stackWidth,
    metaText,
    metaDisplay,
    vw <= 430 ? 'm' : 'w'
  ].join('|');
  if (!force && titleFitState.key === key) return;
  titleFitState.key = key;
  if (titleFitState.raf) cancelAnimationFrame(titleFitState.raf);

  titleFitState.raf = requestAnimationFrame(() => {
    const styles = getComputedStyle(stack);
    const paddingX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const paddingY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const gap = parseFloat(styles.rowGap || styles.gap) || 0;
    const metaVisible = meta && getComputedStyle(meta).display !== 'none';
    // Reserve the meta row's own min-height (see .now-meta-row in
    // styles.css) even when it's hidden (.is-status), rather than 0 - a
    // no-class/break status message has nothing to put there, but sizing it
    // off the extra room that leaves would make it noticeably bigger than an
    // actual class name sitting above its teacher/room tag, for no reason
    // other than having nothing below it. Reserving the same slot either way
    // keeps status text sized to resonate with class text instead of
    // ballooning past it.
    const metaHeight = metaVisible ? Math.ceil(meta.getBoundingClientRect().height) : 20;
    // Width-wise, the meta row costs the title nothing - .now-stack stacks
    // the title and meta row as separate rows (see its own grid-template-
    // columns: a single column), not side by side, so the title always gets
    // the box's full width regardless of how wide the teacher/room chips
    // happen to be. (An earlier layout did put them side by side, which is
    // why a metaWidth subtraction briefly lived here - stale after the
    // redesign, and directly at fault for names that should wrap onto two
    // big lines instead getting squeezed into a much narrower column than
    // they actually had.)
    const available = Math.max(72, Math.floor(stack.clientWidth - paddingX));
    // The starting size used to be a flat constant, which left a title sized
    // for a short/cramped box surrounded by dead air once .now-stack had
    // more room than that guess assumed (a tall dashboard share, a short
    // name, no meta row) - .now-stack is a flex:1 absorber specifically so
    // extra height goes here, so the title needs to actually grow into it
    // instead of stopping at a number picked for the smallest case. Sized
    // off the box's real available height (minus meta row + gap) rather
    // than guessed. .78 bumps up the ratio from an earlier, more
    // conservative .6 picked back when .now-stack and .time-card still had a
    // visible gap between them - now that they sit flush as one merged panel
    // (see styles.css's own comment on that), .now-stack has more real
    // height to work with in the common case (a class or break name sitting
    // above its meta row), so the ratio was retuned against that.
    // The 70px cap, on the other hand, is deliberately NOT raised to match -
    // .now-stack's height varies far more wildly than the ratio bump was
    // meant for once a no-class/day-finished state hides .time-card
    // entirely and hands the whole dashboard over to .now-stack alone (see
    // the v3-15/16/orbit-no-school-day rules in styles.css). Left uncapped
    // (or capped generously), that state's status text (今日無課 etc.)
    // would end up visibly bigger than an actual class name ever gets,
    // reading as its own inconsistent hero size instead of "the same kind of
    // headline, just with nothing scheduled" - the cap keeps it in the same
    // ballpark a class name with its meta row actually reaches (typically
    // high-60s/low-70s), so the two resonate instead of the status text
    // ballooning just because it happened to land in a taller box. Also
    // still short of the once-tried .92/no-cap pass that read as oversized/
    // blocky in its own right. minDefaultSize (see above) is still the
    // floor, so it never drops below timer-badge/title-next's own ceilings
    // even in a short box.
    const availableHeight = Math.max(0, stack.clientHeight - paddingY - (metaHeight + gap));
    const heightDefaultSize = Math.floor(availableHeight * 0.78);
    // minDefaultSize is a floor only when the box is actually tall enough to
    // hold it. On a viewport short enough that .now-stack itself has been
    // squeezed below that (a landscape phone, a short laptop/tablet browser
    // window - see the short-viewport fallback in styles.css), forcing the
    // floor regardless of the box's real height is what used to send the
    // title past its own box entirely, overlapping the progress bar and meta
    // row underneath instead of shrinking to match. Capping by the box's own
    // height (one line, with a little slack) keeps the floor's original
    // intent - grow into a tall box, never look smaller than the other
    // cards' text just because this one has a little less room than usual -
    // without ever producing a font bigger than the box can actually hold.
    const heightCeiling = Math.max(minSize, Math.floor(availableHeight * 0.95));
    const defaultSize = Math.min(
      heightCeiling,
      Math.max(minDefaultSize, Math.min(heightDefaultSize, 70))
    );

    title.style.whiteSpace = 'nowrap';
    title.style.wordBreak = 'keep-all';
    title.style.overflowWrap = 'normal';
    title.style.textOverflow = 'clip';
    title.style.overflow = 'visible';
    title.style.display = 'block';
    title.style.webkitLineClamp = '';
    title.style.lineHeight = '.98';
    title.style.letterSpacing = hasLatin ? '-.95px' : '-.8px';
    title.style.width = available + 'px';
    title.style.maxWidth = available + 'px';
    shrinkFontToFit(title, available, defaultSize, minSize);

    // shrinkFontToFit only ever slims the name down to fit one line, even
    // when the box still has plenty of height to spare - that's the "empty
    // gap" between the current-class card and the next-class/timer card
    // below it that a long single-line name leaves unused once it's been
    // shrunk small enough to fit. If that shrink was substantial (the name
    // didn't just barely miss defaultSize) and there's enough headroom for
    // two lines, prefer wrapping onto a second line at a bigger size over
    // squeezing further onto one - it fills that space with legible text
    // instead of leaving it blank. The 15%-of-defaultSize floor here matters:
    // without it, a short fixed status string (今日無課 etc.) that only
    // barely overflows one line at the new, taller defaultSize would get
    // needlessly split across two much-too-large lines for a few px of
    // single-line savings that nobody would even notice.
    const singleLineSize = parseFloat(title.style.fontSize) || defaultSize;
    if (singleLineSize < defaultSize * 0.85 - 0.5) {
      // 0 means no size between singleLineSize and defaultSize gets the
      // *whole* name onto two lines - never settle for a bigger two-line
      // size that would need to cut the name off to fit. Bigger-but-
      // incomplete is not an improvement over smaller-but-complete.
      const wrapSize = fitTwoLineTitle(title, availableHeight, singleLineSize, defaultSize);
      if (wrapSize > singleLineSize + 1) {
        title.style.whiteSpace = 'normal';
        title.style.wordBreak = 'normal';
        title.style.display = 'block';
        title.style.overflow = 'visible';
        title.style.textOverflow = 'clip';
        title.style.textWrap = 'balance';
        title.style.fontSize = Math.floor(wrapSize) + 'px';
      } else {
        // Wrapping didn't buy enough to be worth it (or couldn't fit the
        // whole name at all) - back out the wrap styling the search below
        // applied while probing and keep the one-line fit instead.
        title.style.whiteSpace = 'nowrap';
        title.style.wordBreak = 'keep-all';
        title.style.textWrap = '';
        title.style.display = 'block';
        title.style.overflow = 'visible';
        title.style.textOverflow = 'clip';
        title.style.fontSize = Math.floor(singleLineSize) + 'px';
      }
    }
    // Neither path above is actually guaranteed complete on its own:
    // shrinkFontToFit's minSize is a legibility floor, not a fit guarantee -
    // an extreme enough name can still overflow at minSize, and since
    // .now-stack clips overflow-x, that would silently cut text off with no
    // visual cue at all (worse than an ellipsis, which at least says
    // "there's more"). If the one-line result currently in effect still
    // doesn't fit, keep applying the same shrink rule below the normal
    // floor, all the way down to 8px if it has to, rather than let that
    // happen - so the name is always fully visible, just very small in the
    // rare case it has to be.
    if (title.style.whiteSpace === 'nowrap' && title.scrollWidth > available + 1) {
      shrinkFontToFit(title, available, minSize, 8);
    }
  });
}
// Finds the font-size to use if `el` wraps onto two lines instead of the one
// shrinkFontToFit already fit it to - called only once that one-line fit has
// already had to shrink below defaultSize, meaning there's width pressure a
// second line could relieve. Two lines share out availableHeight, which
// bounds how big either line can get (`geometryMax`) regardless of how much
// text there actually is. Only ever returns a size that fits the *entire*
// name within two real lines with no truncation - checked by measuring `el`
// itself with wrapping turned on, since that's the only way to know how many
// lines a given size wraps a given name into. Returns 0 (never adopted by
// the caller) when nothing between minSize and geometryMax manages that: a
// bigger two-line rendering that has to cut the name off is never preferred
// over the smaller, already-complete one-line result the caller falls back
// to instead - there is no ellipsis fallback here on purpose.
function fitTwoLineTitle(el, availableHeight, minSize, maxSize) {
  el.style.whiteSpace = 'normal';
  el.style.wordBreak = 'normal';
  el.style.display = 'block';
  el.style.overflow = 'visible';
  el.style.textWrap = 'balance';
  const lineHeightRatio = 1.02;
  const geometryMax = availableHeight / (2 * lineHeightRatio);
  let lo = minSize,
    hi = Math.min(maxSize, geometryMax),
    best = 0;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollHeight <= mid * lineHeightRatio * 2 + 3) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}
// A single line reads better than two, so try shrinking the "10:10 · 徐蓉莉
// · 第三會議室" line to fit before ever wrapping it - only fall back to a
// real (balanced, keep-all) two-line wrap when even the smallest legible
// size still can't fit it, so long teacher/room names never get clipped or
// shrunk into illegibility.
const nextMetaFitState = { key: '', raf: 0 };
function fitNextMetaText(force = false) {
  const el = document.getElementById('next-meta-text');
  if (!el) return;
  const raw = (el.textContent || '').trim();
  if (!raw) return;
  const key = raw + '|' + Math.round(el.parentElement?.getBoundingClientRect().width || 0);
  if (!force && nextMetaFitState.key === key) return;
  nextMetaFitState.key = key;
  if (nextMetaFitState.raf) cancelAnimationFrame(nextMetaFitState.raf);

  nextMetaFitState.raf = requestAnimationFrame(() => {
    el.classList.remove('wrap-2l');
    el.style.fontSize = '';
    const defaultSize = parseFloat(getComputedStyle(el).fontSize) || 15;
    const minSize = Math.max(9, Math.round(defaultSize * 0.62));
    const available = Math.floor(el.clientWidth);
    if (!available) return;
    shrinkFontToFit(el, available, defaultSize, minSize);
    if (el.scrollWidth > available + 1) {
      el.style.fontSize = defaultSize + 'px';
      el.classList.add('wrap-2l');
    }
  });
}
// Shrink only, unlike fitNextMetaText's shrink-then-wrap - these chips sit
// in .now-meta-row, inside the same .now-stack box as the current-class
// title, so a chip that wraps onto a second line grows taller and eats into
// the title's own share of that box's height. #next-meta-text doesn't have
// that problem (it's alone in .time-card, not fighting anything else for
// room), which is exactly why it can afford to wrap. Here, ellipsis - not a
// second line - is the true last resort once even minSize doesn't fit,
// which is just what happens if shrinkFontToFit alone can't get it under
// `available`: the chip's own CSS (white-space:nowrap;text-overflow:
// ellipsis) takes over with no extra styling needed from this function.
const nowMetaFitState = { key: '', raf: 0 };
function fitNowMetaChips(force = false) {
  const chips = ['now-teacher', 'now-place']
    .map(id => document.getElementById(id))
    .filter(el => el && el.classList.contains('show'));
  if (!chips.length) return;
  const key = chips
    .map(el => el.textContent + '|' + Math.round(el.getBoundingClientRect().width))
    .join('~');
  if (!force && nowMetaFitState.key === key) return;
  nowMetaFitState.key = key;
  if (nowMetaFitState.raf) cancelAnimationFrame(nowMetaFitState.raf);

  nowMetaFitState.raf = requestAnimationFrame(() => {
    chips.forEach(el => {
      el.style.fontSize = '';
      const defaultSize = parseFloat(getComputedStyle(el).fontSize) || 11.5;
      const minSize = Math.max(9, Math.round(defaultSize * 0.62));
      // clientWidth, not the content box alone - scrollWidth (what
      // shrinkFontToFit compares it against) is measured on that same
      // padding-included basis, so the two have to match or a short name
      // that fits perfectly reads as overflowing by exactly paddingX.
      const available = Math.floor(el.clientWidth);
      if (!available) return;
      shrinkFontToFit(el, available, defaultSize, minSize);
    });
  });
}
function createMetaChip(text, cls = '') {
  const span = document.createElement('span');
  span.className = 'meta-chip ' + cls;
  span.textContent = text;
  return span;
}
function getClassColor() {
  const draftPanel = document.getElementById('style-panel');
  const activeStyle =
    state.stylePanelDraft && draftPanel?.classList.contains('style-draft-dirty')
      ? state.stylePanelDraft
      : state.applicationData;
  return normalizeProAccent(activeStyle.proAccent);
}
function renderList(week, curIdx, nxtIdx, curDay, isDayFinished) {
  const list = document.getElementById('schedule-list');
  if (!list) return;
  list.classList.remove('animate-list');
  void list.offsetWidth;
  list.classList.add('animate-list');
  const tomorrow = getNextSchoolDay(curDay);
  document.querySelectorAll('.nav-item').forEach(btn => {
    const day = parseInt(btn.dataset.day, 10);
    btn.classList.toggle('active', day === state.viewDay);
    btn.classList.toggle('is-today', day === curDay);
    btn.classList.toggle('is-tomorrow', isDayFinished && day === tomorrow);
  });

  list.innerHTML = '';
  const rows = state.runtimeSchedule[state.viewDay] || [];
  rows.forEach((c, i) => {
    const isToday = state.viewDay === (window.MANUALLY_TEST ? window.TEST_DAY : curDay);
    const info = processSplitName(c, week);
    const isNow = isToday && i === curIdx;
    const isNext = isToday && i === nxtIdx;
    const row = document.createElement('div');
    row.className = `row ${isNow ? 'is-now' : ''} ${isNext ? 'is-next' : ''}`.trim();
    row.style.setProperty('--row-i', String(i));
    row.tabIndex = 0;
    row.role = 'button';
    row.addEventListener('click', () => openModal(c));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openModal(c);
      }
    });

    const badge = document.createElement('div');
    badge.className = 'period-badge';
    badge.textContent = String(i + 1);
    const content = document.createElement('div');
    content.className = 'content';
    const name = document.createElement('div');
    name.className = 'row-name';
    const nameText = document.createElement('span');
    nameText.className = 'row-name-text';
    nameText.textContent = info.n;
    name.append(nameText);
    if (info.label) {
      const labelWrap = document.createElement('span');
      labelWrap.className = 'row-name-week-label';
      labelWrap.innerHTML = info.label;
      name.append(labelWrap);
    }
    if (isNow || isNext) {
      const tag = document.createElement('span');
      tag.className = 'status-tag';
      tag.textContent = isNow ? '進行中' : '下一節';
      name.append(tag);
    }
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.append(createMetaChip(`${c.s} – ${c.e}`, 'meta-time'));
    if (info.t) meta.append(createMetaChip(info.t, 'meta-teacher'));
    if (c.loc) meta.append(createMetaChip(c.loc, 'meta-location'));
    content.append(name, meta);
    row.append(badge, content);
    list.appendChild(row);
  });
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML =
      '<div class="period-badge">×</div><div class="content"><div class="row-name">這天沒有課</div><div class="row-meta"><span class="meta-chip">可以休息或安排自習</span></div></div>';
    list.appendChild(empty);
  }
  keepActiveClassVisible(
    list,
    isDayFinished,
    `${state.viewDay}-${curIdx}-${nxtIdx}-${isDayFinished}`
  );
}
window.addEventListener('resize', () => {
  fitNowTitleText(true);
  fitNowMetaChips(true);
  fitNextMetaText(true);
});
window.addEventListener('orientationchange', () =>
  setTimeout(() => {
    fitNowTitleText(true);
    fitNowMetaChips(true);
    fitNextMetaText(true);
  }, 120)
);
window.addEventListener('load', () => {
  fitNowTitleText(true);
  fitNowMetaChips(true);
  fitNextMetaText(true);
});

/* Test mode advances from one clock tick; the consolidated controller handles input changes. */
function mainClockTick() {
  if (window.MANUALLY_TEST && window.IS_SIMULATING) {
    window.TEST_TIME_SEC = ((window.TEST_TIME_SEC || 0) + 1) % 86400;
    const slider = document.getElementById('test-time-slider');
    if (slider) slider.value = Math.floor(window.TEST_TIME_SEC / 60);
  }
  window.update();
}

export {
  fitNextMetaText,
  fitNowMetaChips,
  fitNowTitleText,
  getClassColor,
  mainClockTick,
  renderList,
  shrinkFontToFit,
  syncTestPlayPauseUi
};
