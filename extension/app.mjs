import { mountAutoCleanup } from './auto-cleanup-page.mjs';
import { mountSyncSettings } from './sync-page.mjs';
import { createHistoryMatcher, filterHistoryItems, sortByLastVisit, MAX_HISTORY_RESULTS, parseHostnames } from './history-utils.mjs';
import { readLanguage, saveLanguage, translate } from './i18n.mjs';
import { view } from './view.mjs';
import { mountNameplate } from './nameplate.mjs';
import { setupSettingsSelects } from './settings-select.mjs';
import { groupHistoryItems, groupHistoryByDate } from './history-groups.mjs';
import { setupSuggestions, appendHighlighted } from './suggestions-ui.mjs';
import { defaultTimeFilter, resolveTimeRange, filterByTime, parseProtectedSites, isProtectedUrl } from './history-filters.mjs';
import { setupDatePicker } from './date-picker.mjs';
import { createActivityPanel } from './activity-panel.mjs';
import { animateRowRemoval } from './row-removal.mjs';
import { animateBatchRemoval } from './batch-removal.mjs';
import { readFrequencyHistory } from './history-frequency.mjs';
import { browsingDefaults, readBrowsingPreferences, saveBrowsingPreferences } from './browsing-preferences.mjs';
import { createUpdateChecker } from './update-check.mjs';

const compact = document.body.dataset.layout === 'popup';
const modal = document.body.dataset.presentation === 'modal';
const clientId = crypto.randomUUID();
const pageSize = compact ? 40 : 100;
const groupPreviewSize = 5;
let suggestions;
let datePicker;
let settingsSelects;
let nameplateSurface;
let cleanupSurface;
let syncSurface;
let settingsSection = 'general';
let layerEvents;
let queryPlaceholder;
let searchMotion;
let backToTop;
let scopeSizes;
let historyChanged = false;
let historyRefreshTimer;
let historyRefreshing = false;
let historyDay;
let completionTimer;
let savingPreference = false;
let preferenceBaseline = null;
let preferenceLoad = 0;
let defaultBrowsing = browsingDefaults();
let updateState = null;
let dismissedUpdate = null;
let updateApplying = false;
let updateError = false;
let updateRequest = 0;
let updateCheck = null;
let updateChecking = false;
let updateReadFailed = false;
const checkUpdateInView = createUpdateChecker(chrome);
let groupRender;
let rowRender;
let rowFormats;
let mountFrame;
const scanCache = new Map();
let scanMatches = new WeakMap();
const groupViews = new Map();
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function dismissCompletion() {
  clearTimeout(completionTimer);
  const feedback = $('completionFeedback');
  // Cancel an old fade so it cannot dismiss a newer success card.
  if (feedback) { for (const animation of feedback.getAnimations()) animation.cancel(); feedback.hidden = true; }
}
function showCompletion(count) {
  dismissCompletion();
  const feedback = $('completionFeedback');
  $('completionCount').textContent = num(count);
  feedback.hidden = false;
  if (!reducedMotion()) {
    if (count > 1) {
      feedback.animate([{ opacity: 0, transform: 'translate(-50%, 10px) scale(.97)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
    } else {
      const origin = $('delete').getBoundingClientRect(); const target = feedback.getBoundingClientRect();
      const dx = origin.left + origin.width / 2 - target.left - target.width / 2;
      const dy = origin.top + origin.height / 2 - target.top - target.height / 2;
      // A sampled damped spring keeps the feedback connected to the button that caused it.
      const frames = Array.from({ length: 25 }, (_, index) => {
        const time = index / 24;
        const progress = time === 1 ? 1 : 1 - Math.exp(-10 * time) * (Math.cos(9 * time) + 10 / 9 * Math.sin(9 * time));
        return { offset: time, opacity: Math.min(1, time * 8), transform: `translate(calc(-50% + ${dx * (1 - progress)}px), ${dy * (1 - progress)}px) scale(${.2 + .8 * progress})` };
      });
      feedback.animate(frames, { duration: 340 });
    }
  }
  completionTimer = setTimeout(() => {
    if (reducedMotion()) return dismissCompletion();
    feedback.animate([{ opacity: 1, transform: 'translate(-50%, 0) scale(1)' }, { opacity: 0, transform: 'translate(-50%, 4px) scale(.98)' }], { duration: 160, fill: 'forwards' }).finished.then(dismissCompletion, () => {});
  }, 2200);
}
const state = { lang: readLanguage(), query: '', mode: 'smart', matches: [], groups: [], urlGroups: new Map(), grouping: 'website', dateGroups: [], expandedDates: new Set(), expanded: new Set(), groupShown: new Map(), groupLimit: pageSize, selected: new Set(), busy: false, scanned: false, status: ['rulesLoading', {}], pending: [], filters: { ...defaultTimeFilter(), range: '7days' }, dateExplicit: false, timeWindow: null, protectedSites: [], rulesReady: false, excluded: 0 };
const $ = (id) => document.getElementById(id);
const t = (key, args) => translate(state.lang, key, args);
const num = (n) => n.toLocaleString(state.lang);
const activity = createActivityPanel({ compact, request, readHistory, t, language: () => state.lang });
const dateHeaderSizes = new ResizeObserver(entries => {
  for (const entry of entries) {
    entry.target.parentElement.style.setProperty('--date-header-height', `${entry.borderBoxSize[0].blockSize}px`);
  }
});
function syncThemeControl() {
  const button = $('themeToggle'); if (!button) return;
  const preference = document.documentElement.dataset.themePreference || 'system';
  const label = t('themeCurrent', { mode: t(`theme_${preference}`) });
  button.title = label; button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String($('themeMenu').open));
  for (const choice of $('themeChoices').querySelectorAll('[data-theme-choice]')) choice.setAttribute('aria-pressed', String(choice.dataset.themeChoice === preference));
}
function setupQueryPlaceholder(input) {
  const text = input.placeholder;
  const characters = Array.from(text);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let timer; let running = false; let composing = false; let pageActive = true;
  let length = 1; let deleting = false;
  function step() {
    length += deleting ? -1 : 1;
    input.placeholder = characters.slice(0, length).join('');
    let delay = deleting ? 35 : 90;
    if (length === characters.length) { deleting = true; delay = 2200; }
    else if (length === 0) { deleting = false; delay = 450; }
    timer = setTimeout(step, delay);
  }
  function sync() {
    // Change only the hint: typed text and IME composition must never become animation frames.
    const animate = !input.value && !input.disabled && !composing && !motion.matches && !document.hidden && pageActive;
    if (!animate) {
      clearTimeout(timer); running = false; input.placeholder = text;
    } else if (!running) {
      running = true; length = 1; deleting = false;
      input.placeholder = characters[0]; timer = setTimeout(step, 650);
    }
  }
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: events.signal });
  listen(input, 'input', sync);
  listen(input, 'compositionstart', () => { composing = true; sync(); });
  listen(input, 'compositionend', () => { composing = false; sync(); });
  listen(motion, 'change', sync);
  listen(document, 'visibilitychange', sync);
  listen(window, 'pagehide', () => { pageActive = false; sync(); });
  listen(window, 'pageshow', () => { pageActive = true; sync(); });
  return { sync, destroy() { clearTimeout(timer); events.abort(); } };
}
function setupBackToTop() {
  const scroll = $('resultScroll');
  const button = $('backToTop');
  const events = new AbortController();
  let visible = false;
  function sync() {
    const next = scroll.scrollTop > Math.min(240, scroll.clientHeight / 2);
    if (next === visible) return;
    visible = next;
    if (!visible && document.activeElement === button) scroll.focus({ preventScroll: true });
    button.inert = !visible;
    button.dataset.visible = String(visible);
  }
  // The browser animates scrolling; the passive handler only changes UI at the threshold.
  scroll.addEventListener('scroll', sync, { passive: true, signal: events.signal });
  button.addEventListener('click', () => {
    scroll.scrollTo({ top: 0, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }, { signal: events.signal });
  const sizes = new ResizeObserver(sync);
  for (const node of [scroll, $('groups'), $('table')]) sizes.observe(node);
  return { destroy() { events.abort(); sizes.disconnect(); } };
}
function setupScopeSize() {
  const scope = $('resultScope');
  let width = 0;
  const sizes = new ResizeObserver(() => {
    const next = scope.getBoundingClientRect().width;
    if (!next || next === width) return;
    width = next;
    // Reserve the tallest translated explanation at this width. Frequency's
    // longer scope must not push the entire list down on narrow windows.
    const measure = scope.cloneNode(false); measure.removeAttribute('id');
    measure.setAttribute('aria-hidden', 'true');
    Object.assign(measure.style, { position: 'absolute', visibility: 'hidden', width: `${width}px`, minHeight: '0', pointerEvents: 'none' });
    scope.parentElement.append(measure);
    let height = 0;
    for (const key of ['weekScope', 'recentScope', 'dateScope', 'frequencyScope', 'frequencyAllScope']) {
      measure.textContent = t(key); height = Math.max(height, measure.getBoundingClientRect().height);
    }
    measure.remove(); scope.style.minHeight = `${height}px`;
  });
  sizes.observe(scope);
  return sizes;
}
function status(key, args = {}) {
  state.status = [key, args];
  const output = $('status'); const text = t(key, args);
  if (output.dataset.kind !== key) output.dataset.kind = key;
  if (output.textContent !== text) output.textContent = text;
}
function setupSearchMotion(button) {
  const events = new AbortController();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let pageActive = true;
  const clear = () => {
    for (const ripple of button.querySelectorAll('.search-ripple')) {
      ripple.getAnimations().forEach(animation => animation.cancel()); ripple.remove();
    }
  };
  function sync() {
    const active = pageActive && !document.hidden && !motion.matches;
    button.dataset.motionActive = String(active);
    if (!active) clear();
  }
  function ripple(point) {
    if (button.disabled || button.dataset.motionActive !== 'true') return;
    clear();
    const box = button.getBoundingClientRect();
    const x = point ? point.clientX - box.left : box.width / 2;
    const y = point ? point.clientY - box.top : box.height / 2;
    const radius = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y)) / 6;
    const surface = document.createElement('span'); surface.className = 'search-ripple'; surface.setAttribute('aria-hidden', 'true');
    surface.style.left = `${x}px`; surface.style.top = `${y}px`; button.append(surface);
    // Feedback runs independently: a search starts immediately, without waiting for this effect.
    const animation = surface.animate([
      { transform: 'translate(-50%, -50%) scale(0)', opacity: .26 },
      { opacity: .16, offset: .5 },
      { transform: `translate(-50%, -50%) scale(${radius})`, opacity: 0 },
    ], { duration: 520, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    animation.finished.then(() => surface.remove(), () => surface.remove());
  }
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: events.signal });
  listen(button, 'pointerdown', event => { if (event.button === 0) ripple(event); });
  listen(button, 'click', event => { if (event.detail === 0) ripple(); });
  listen(document, 'visibilitychange', sync);
  listen(motion, 'change', sync);
  listen(window, 'pagehide', () => { pageActive = false; sync(); });
  listen(window, 'pageshow', () => { pageActive = true; sync(); });
  sync();
  return { destroy() { events.abort(); clear(); } };
}
const allMatchesSelected = () => state.matches.length > 0 && state.matches.every(item => state.selected.has(item.url));
const timeDraft = () => ({ range: $('timeRange').value, startDate: $('startDate').value, endDate: $('endDate').value });
const draftChanged = () => state.scanned && ($('query').value.trim() !== state.query || $('mode').value !== state.mode || JSON.stringify(timeDraft()) !== JSON.stringify(state.filters));

function renderUpdate(animate = false) {
  renderUpdateDetails();
  const slot = $('updateSlot');
  const version = updateState?.version || updateCheck?.version;
  const visible = Boolean(version && version !== dismissedUpdate);
  const opening = visible && slot.dataset.open !== 'true';
  slot.inert = !visible;
  if (!visible) {
    if (slot.dataset.open === 'true') {
      slot.dataset.motion = String(animate && !reducedMotion());
      slot.dataset.open = 'false';
      if (!animate || reducedMotion()) slot.hidden = true;
    }
    return;
  }
  const busy = updateState?.busy || state.busy || savingPreference;
  $('updateCopy').textContent = updateError ? t('updateFailed') : t(updateState ? 'updateReadyBanner' : 'updateAvailable', { version });
  $('updateCopy').title = $('updateCopy').textContent;
  $('applyUpdate').textContent = t(!updateState ? 'updateDetails' : updateApplying ? 'updateReloading' : busy ? 'updateWaiting' : 'updateNow');
  $('applyUpdate').disabled = Boolean(updateState && (busy || updateApplying));
  $('applyUpdate').title = t(!updateState ? 'updatePublishedHint' : busy ? 'updateBusyHint' : 'updateRestartHint');
  $('dismissUpdate').disabled = updateApplying;
  if (opening) {
    slot.dataset.motion = String(animate && !reducedMotion());
    slot.hidden = false;
    // Resolve the collapsed grid before opening, so the task content moves with the banner.
    if (animate && !reducedMotion()) void slot.offsetHeight;
    slot.dataset.open = 'true';
  }
}

async function requestUpdateFeedback(message) {
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const result = await request(message);
        // Unpacked page files can change while Chrome keeps the previous worker running.
        // Its response has update but no check; run the current checker using this
        // extension's own APIs. Applying a download still goes through the worker.
        if (result && Object.hasOwn(result, 'update') && !Object.hasOwn(result, 'check')) {
          let { extensionUpdateCheck } = await chrome.storage.local.get('extensionUpdateCheck');
          const hasCheck = extensionUpdateCheck?.installedVersion === chrome.runtime.getManifest().version &&
            ['development', 'managed', 'store', 'other', 'unknown'].includes(extensionUpdateCheck.channel) &&
            ['checking', 'current', 'published', 'ready', 'throttled', 'error', 'manual'].includes(extensionUpdateCheck.status);
          // Storage notifications also refresh this view; complete metadata needs no new check.
          if (message.type === 'check-for-update' || !hasCheck) {
            await checkUpdateInView({ manual: message.manual === true });
            ({ extensionUpdateCheck } = await chrome.storage.local.get('extensionUpdateCheck'));
          }
          return { ...result, check: extensionUpdateCheck?.installedVersion === chrome.runtime.getManifest().version ? extensionUpdateCheck : null };
        }
        return result;
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('UPDATE_CHECK_TIMEOUT')), 15000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

async function refreshUpdate() {
  const ticket = ++updateRequest;
  try {
    const { update, check } = await requestUpdateFeedback({ type: 'get-update-state' });
    if (ticket !== updateRequest) return;
    if (update !== null && (typeof update?.version !== 'string' || typeof update.busy !== 'boolean')) throw new Error('Invalid update state');
    // An older worker can answer without check metadata; that is not an unchecked success.
    if (check !== null && !['checking', 'current', 'published', 'ready', 'throttled', 'error', 'manual'].includes(check?.status)) throw new Error('Invalid update check');
    updateState = update;
    updateCheck = check;
    updateReadFailed = false;
    renderUpdate(true);
  } catch {
    if (ticket !== updateRequest) return;
    updateReadFailed = true;
    renderUpdateDetails();
    // An unavailable update notification must not block local history operations.
  }
}

function renderUpdateDetails() {
  if (!$('updateDialog')) return;
  const version = chrome.runtime.getManifest().version;
  const channel = updateCheck?.channel || 'unknown';
  const checking = updateChecking || (!updateReadFailed && updateCheck?.status === 'checking');
  const kind = updateState ? 'ready' : updateChecking ? 'checking' : updateReadFailed ? 'error' : checking ? 'checking' :
    updateCheck?.status === 'ready' ? 'published' :
    ['current', 'published', 'throttled', 'error', 'manual'].includes(updateCheck?.status) ? updateCheck.status : 'idle';
  const dirty = $('preferencesDialog').open && preferenceBaseline && Object.keys(preferenceBaseline)
    .some(key => JSON.stringify(preferenceDraft()[key]) !== JSON.stringify(preferenceBaseline[key]));
  const busy = updateState?.busy || state.busy || savingPreference;
  $('updateDialog').dataset.state = kind;
  $('checkUpdate').setAttribute('aria-busy', String(checking));
  $('installedVersion').textContent = `v${version}`;
  $('updateChannel').textContent = t(`updateChannel_${channel}`);
  $('updateEntryVersion').textContent = `v${version} · ${t(`updateStatus_${kind}`)}`;
  if ($('openVersion')) $('openVersion').textContent = `v${version}`;
  $('updateStatusTitle').textContent = updateError ? t('updateFailed') : t(`updateStatus_${kind}`);
  $('updateStatusBody').textContent = updateError ? t('updateRestartHint') : t(kind === 'manual' ? `updateManual_${channel}` : `updateBody_${kind}`, { version: updateState?.version || updateCheck?.version });
  const checkedAt = updateCheck?.checkedAt;
  $('updateCheckedAt').hidden = !Number.isFinite(checkedAt) || kind === 'manual' || kind === 'checking';
  if (Number.isFinite(checkedAt)) $('updateCheckedAt').textContent = t('updateLastAttempt', { time: new Intl.DateTimeFormat(state.lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(checkedAt) });
  $('checkUpdate').hidden = kind === 'manual' || Boolean(updateState);
  $('checkUpdate').disabled = checking || updateApplying;
  $('checkUpdate').textContent = t(checking ? 'updateChecking' : kind === 'error' ? 'updateRetry' : 'updateCheckNow');
  $('reloadUpdate').hidden = !updateState;
  $('reloadUpdate').disabled = busy || dirty || updateApplying;
  $('reloadUpdate').textContent = t(updateApplying ? 'updateReloading' : 'updateRestart');
  $('updateReloadHint').hidden = !updateState;
  $('updateReloadHint').textContent = t(dirty ? 'updateUnsavedHint' : busy ? 'updateBusyHint' : 'updateRestartHint');
}

function openUpdateDetails() {
  renderUpdateDetails();
  if (!$('updateDialog').open) {
    $('updateDialog').showModal();
    if (modal) window.parent.postMessage({ type: 'history-sweep:update-details', open: true }, '*');
    $('closeUpdateDetails').focus({ preventScroll: true });
  }
  void refreshUpdate();
}

async function checkUpdateNow() {
  if (updateChecking) return;
  updateChecking = true; updateReadFailed = false; updateError = false; renderUpdateDetails();
  // Keep fast, cached or failed checks perceptible before showing the final result.
  const feedback = new Promise(resolve => setTimeout(resolve, 600));
  let failed = false;
  try {
    await requestUpdateFeedback({ type: 'check-for-update', manual: true });
    await refreshUpdate();
    if (!updateState && (!updateCheck || updateCheck.status === 'checking')) failed = true;
  }
  catch { failed = true; }
  finally {
    await feedback;
    updateChecking = false;
    if (failed) updateReadFailed = true;
    renderUpdateDetails();
  }
}

async function applyUpdate() {
  if (!updateState || updateState.busy || state.busy || savingPreference || updateApplying) return;
  if ($('preferencesDialog').open && preferenceBaseline && Object.keys(preferenceBaseline)
    .some(key => JSON.stringify(preferenceDraft()[key]) !== JSON.stringify(preferenceBaseline[key]))) return;
  updateApplying = true; updateError = false; controls();
  try { await request({ type: 'apply-update' }); }
  catch (error) {
    updateApplying = false;
    if (error.message !== 'UPDATE_BUSY') updateError = true;
    await refreshUpdate(); controls();
  }
}

function writeTimeDraft(filters) {
  $('timeRange').value = filters.range; $('startDate').value = filters.startDate; $('endDate').value = filters.endDate;
}

function positionTimeMenu() {
  if (!$('filters')?.open) return;
  const body = $('filters').querySelector('.filters-body');
  const anchor = $('filterToggle').getBoundingClientRect();
  const width = Math.min(288, innerWidth - 24);
  body.style.width = `${width}px`;
  body.style.left = `${Math.max(12, Math.min(anchor.right - width, innerWidth - width - 12))}px`;
  const below = innerHeight - anchor.bottom - 12;
  const above = anchor.top - 12;
  const upward = below < 300 && above > below;
  body.style.top = upward ? 'auto' : `${anchor.bottom + 8}px`;
  body.style.bottom = upward ? `${innerHeight - anchor.top + 8}px` : '';
  body.style.maxHeight = `${Math.max(80, Math.min(390, (upward ? above : below) - 7))}px`;
}

function matchesForScan(items) {
  const cached = scanMatches.get(items);
  if (cached) { state.excluded = cached.excluded; return cached.matches; }
  // Frequency candidates have already passed the same query before getVisits.
  const queried = state.query && state.grouping !== 'frequency' ? filterHistoryItems(items, state.query, state.mode) : items;
  const matches = (state.grouping === 'frequency' ? queried : filterByTime(queried, state.timeWindow)).filter(item => item.url);
  const visible = matches.filter(item => !isProtectedUrl(item.url, state.protectedSites));
  state.excluded = matches.length - visible.length;
  const ordered = state.grouping === 'frequency' ? visible : sortByLastVisit(visible);
  scanMatches.set(items, { matches: ordered, excluded: state.excluded });
  return ordered;
}

function invalidateViewScans() {
  scanCache.clear(); scanMatches = new WeakMap();
}

async function readScan(range, { background = false, grouping = state.grouping, reuse = false } = {}) {
  const frequency = grouping === 'frequency';
  const { query, mode } = state;
  const key = JSON.stringify([frequency, query, mode, range]);
  if (reuse && scanCache.has(key)) return scanCache.get(key);
  // Share in-flight reads with intent prefetches, but searches and deletion
  // verification always read Chrome again. Only the current criteria are cached.
  const pending = frequency ? readFrequencyHistory(globalThis.chrome?.history, {
    range,
    include: query ? createHistoryMatcher(query, mode) : () => true,
    onProgress: (done, total) => {
      if (!background && (done === 0 || done === total || done % 50 === 0)) status('countingVisits', { done: num(done), total: num(total) });
    },
  }) : readHistory(range);
  scanCache.set(key, pending);
  try { return await pending; }
  catch (error) {
    if (scanCache.get(key) === pending) scanCache.delete(key);
    throw error;
  }
}

const scanError = error => error.message === 'API_UNAVAILABLE' ? 'apiUnavailable' : error.message === 'FREQUENCY_LIMIT' ? 'frequencyLimit' : state.grouping === 'frequency' ? 'frequencyFailed' : 'scanFailed';

async function changeGrouping(grouping) {
  if (state.busy || state.grouping === grouping) return;
  const needsVisits = grouping === 'frequency' || state.grouping === 'frequency';
  if (needsVisits && state.scanned) {
    state.busy = true;
    // Keep the current view and its labels together until the destination is
    // ready, then commit once. A loading empty state would collapse the toolbar.
    const selected = new Set(state.selected);
    controls();
    try {
      const all = await readScan(state.timeWindow, { grouping, reuse: true });
      state.grouping = grouping;
      setMatches(matchesForScan(all), true);
      state.selected = new Set(state.matches.filter(item => selected.has(item.url)).map(item => item.url));
      status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
    } catch (error) {
      state.grouping = grouping; setMatches([], true);
      state.selected.clear(); status(scanError(error));
    } finally { state.busy = false; }
  } else { state.grouping = grouping; state.groupLimit = pageSize; }
  renderRows(); $('resultScroll').scrollTop = 0;
}

function applyProtectedSites(sites) {
  if (JSON.stringify(sites) === JSON.stringify(state.protectedSites)) return;
  state.protectedSites = sites;
  invalidateViewScans();
  // Rules belong to the deletion boundary, including open confirmation snapshots in another window.
  state.pending = []; state.selected.clear(); state.scanned = false; state.excluded = 0;
  if ($('confirmDialog').open) { $('confirmDialog').returnValue = ''; $('confirmDialog').close(); }
  setMatches([], true); renderRows(); status('rulesUpdated');
}

async function saveProtection(event) {
  event.preventDefault();
  if (state.busy || !state.rulesReady) return;
  try { parseProtectedSites($('protectionInput').value); }
  catch { $('protectionStatus').textContent = t('invalidProtectedSites'); return; }
  state.busy = true; controls(); $('protectionStatus').textContent = '';
  try {
    const data = await request({ type: 'save-protection', input: $('protectionInput').value });
    applyProtectedSites(data.sites); $('protectionDialog').close();
  } catch (error) {
    $('protectionStatus').textContent = t(error.message === 'RULES_BUSY' ? 'rulesBusy' : 'protectionSaveFailed');
  } finally { state.busy = false; controls(); }
}

async function currentSite() {
  if (state.busy || !state.rulesReady) return;
  state.busy = true; controls();
  try {
    const data = await request({ type: 'current-site' });
    // The current website starts an exact-host search; it never selects or deletes automatically.
    $('query').value = data.hostname; $('mode').value = 'host-exact';
    state.dateExplicit = false; writeTimeDraft(defaultTimeFilter()); state.selected.clear();
    state.busy = false; await search();
  } catch (error) { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'currentSiteUnavailable'); }
  finally { state.busy = false; controls(); }
}

function renderDeletionPreview() {
  const selected = new Set(state.pending);
  const groups = groupHistoryItems(state.matches.filter(item => selected.has(item.url)));
  $('previewSummary').textContent = t('previewSummary', { n: num(state.pending.length), sites: num(groups.length) });
  $('previewTimeWarning').hidden = !state.timeWindow;
  const container = $('deletePreview'); container.replaceChildren();
  let shown = 0;
  const appendGroups = () => {
    const next = groups.slice(shown, shown + 20); shown += next.length;
    for (const group of next) {
      const details = document.createElement('details'); details.className = 'preview-site';
      const summary = document.createElement('summary');
      const name = document.createElement('strong'); name.textContent = group.label;
      const count = document.createElement('span'); count.textContent = t('siteItems', { n: num(group.items.length) });
      summary.append(name, count); details.append(summary);
      const list = document.createElement('ul'); details.append(list);
      let pageCount = 0;
      const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet preview-more';
      const appendPages = () => {
        for (const item of group.items.slice(pageCount, pageCount + 20)) {
          const row = document.createElement('li');
          if (item.title) { const title = document.createElement('span'); title.textContent = item.title; row.append(title); }
          const url = document.createElement('small'); url.textContent = item.url; row.append(url); list.append(row);
        }
        pageCount = Math.min(pageCount + 20, group.items.length);
        more.hidden = pageCount === group.items.length;
        more.textContent = t('previewMore', { n: num(Math.min(20, group.items.length - pageCount)) });
      };
      more.addEventListener('click', appendPages); details.append(more);
      details.addEventListener('toggle', () => { if (details.open && pageCount === 0) appendPages(); });
      container.append(details);
    }
    moreSites.hidden = shown === groups.length;
    container.append(moreSites);
  };
  const moreSites = document.createElement('button'); moreSites.type = 'button'; moreSites.className = 'quiet preview-more'; moreSites.textContent = t('previewMoreSites');
  moreSites.addEventListener('click', appendGroups); appendGroups();
}

function setMatches(matches, resetGroups = false) {
  historyDay = new Date().toDateString();
  state.matches = matches;
  state.groups = groupHistoryItems(matches);
  state.dateGroups = groupHistoryByDate(matches);
  state.urlGroups = new Map(state.groups.flatMap(group => group.items.map(item => [item.url, group.key])));
  if (resetGroups) {
    groupViews.clear(); groupRender = null; dateHeaderSizes.disconnect();
    state.expanded = new Set(state.groups.slice(0, 1).map(group => group.key));
    state.expandedDates = new Set(state.dateGroups.slice(0, 1).map(day => day.key));
    for (const day of state.dateGroups.slice(0, 1)) if (day.groups[0]) state.expanded.add(`${day.key}:${day.groups[0].key}`);
    state.groupShown.clear(); state.groupLimit = pageSize;
  }
}

function selectGroup(group, checked) {
  // Selection includes every matching URL in the group, even when its rows are hidden.
  for (const item of group.items) checked ? state.selected.add(item.url) : state.selected.delete(item.url);
  controls();
}
function allGroupsExpanded() {
  return state.grouping === 'date'
    ? state.dateGroups.every(day => state.expandedDates.has(day.key) && day.groups.every(group => state.expanded.has(`${day.key}:${group.key}`)))
    : state.groups.every(group => state.expanded.has(group.key));
}

function expansionControl() {
  const button = $('expandGroups');
  const expanded = String(allGroupsExpanded());
  if (button.dataset.expanded === expanded) return;
  const label = t(expanded === 'true' ? 'collapseAll' : 'expandAll');
  button.querySelector('span').textContent = label;
  button.setAttribute('aria-label', label);
  button.dataset.expanded = expanded;
}

function resultControls(root) {
  const blocked = state.busy || !state.rulesReady || updateApplying || draftChanged();
  for (const check of root.querySelectorAll('input[type=checkbox]')) {
    check.disabled = blocked;
    if (check.classList.contains('row-select')) check.checked = state.selected.has(check.dataset.url);
  }
  const groups = [...root.querySelectorAll('.website-group, .date-group')];
  if (root.matches?.('.website-group, .date-group')) groups.unshift(root);
  for (const element of groups) {
    const count = element.historyItems.filter(item => state.selected.has(item.url)).length;
    const total = Number(element.dataset.total);
    const check = element.querySelector(':scope > .group-header .group-select, :scope > .date-header .date-select');
    check.checked = count === total;
    check.indeterminate = count > 0 && count < total;
    const selection = count === total ? 'all' : count ? 'partial' : 'none';
    if (element.dataset.selection !== selection) element.dataset.selection = selection;
    const selectedLabel = element.querySelector(':scope > .group-header .group-selected, :scope > .date-header .group-selected');
    const label = t('siteSelected', { n: num(count) });
    if (selectedLabel.textContent !== label) selectedLabel.textContent = label;
    selectedLabel.hidden = !count;
    for (const button of element.querySelectorAll('button')) button.disabled = state.busy;
  }
  for (const button of root.querySelectorAll('.row-delete')) button.disabled = blocked;
}

function autoSearchRule() {
  if (!state.scanned || $('query').value.trim() !== state.query || $('mode').value !== state.mode || state.mode === 'contains') return null;
  try {
    const domains = parseProtectedSites(state.query);
    if (domains.length === 1 && domains[0].includes('.')) return { domain: domains[0], includeSubdomains: state.mode !== 'host-exact' };
  } catch {}
  return null;
}
async function openAutoCleanup(rule) {
  try { await openPreferences('tasks', rule); }
  catch { $('preferencesStatus').textContent = t('autoCleanupOpenFailed'); status('autoCleanupOpenFailed'); }
}
function controls() {
  $('autoCleanupSearch').hidden = !autoSearchRule();
  $('autoFromSearch').disabled = state.busy;
  renderUpdate();
  // Selection belongs to the last scan, so edited criteria must not delete those older results.
  // Default browsing is recent; keyword searches keep their existing all-time scope until a date is explicitly chosen.
  if (!state.dateExplicit) $('timeRange').value = $('query').value.trim() ? 'all' : defaultBrowsing.range;
  const stale = draftChanged();
  if (state.busy) suggestions?.close();
  const blocked = state.busy || !state.rulesReady || updateApplying;
  for (const id of ['query', 'mode', 'search', 'clearQuery', 'openFull', 'openFullFooter', 'timeRange', 'startDate', 'endDate', 'editProtection', 'currentSite', 'saveProtection', 'closeProtection', 'protectionInput']) if ($(id)) $(id).disabled = blocked;
  queryPlaceholder?.sync();
  $('customDates').hidden = $('timeRange').value !== 'custom';
  for (const choice of document.querySelectorAll('.time-range-radio')) { choice.checked = choice.value === $('timeRange').value; choice.disabled = blocked; }
  datePicker?.sync();
  $('query').required = false;
  $('filterSummary').textContent = $('timeRange').selectedOptions[0].textContent;
  const filterLabel = [t('filters'), $('filterSummary').textContent, state.protectedSites.length ? t('keptSites', { n: num(state.protectedSites.length) }) : ''].filter(Boolean).join(' · ');
  $('filterToggle').title = filterLabel;
  $('filterToggle').setAttribute('aria-label', filterLabel);
  $('filterToggle').setAttribute('aria-expanded', String($('filters').open));
  $('filterToggle').dataset.active = String($('timeRange').value !== 'all' || state.protectedSites.length > 0);
  $('editProtection').textContent = t('keptSites', { n: num(state.protectedSites.length) });
  $('protectedCount').hidden = !state.excluded;
  $('protectedCount').textContent = t('protectedCount', { n: num(state.excluded) });
  for (const button of $('language').querySelectorAll('button')) button.disabled = state.busy || updateApplying;
  $('selectAll').disabled = blocked || stale || !state.matches.length;
  $('clear').disabled = state.busy || !state.selected.size;
  $('delete').disabled = blocked || stale || !state.selected.size;
  $('search').querySelector('span').textContent = t(stale ? 'updateResults' : 'scan');
  $('count').textContent = state.busy && !state.scanned ? t('loadingTitle') : state.scanned ? t('resultCount', { n: num(state.matches.length) }) : t('results');
  $('resultScope').hidden = !state.scanned;
  $('resultScope').textContent = state.grouping === 'frequency' ? t(state.timeWindow ? 'frequencyScope' : 'frequencyAllScope') : t(state.filters.range === '7days' ? 'weekScope' : state.filters.range === '3days' ? 'recentScope' : 'dateScope');
  $('selected').textContent = `${num(state.selected.size)} ${t('selected')}`;
  $('selected').hidden = compact && !state.selected.size;
  const allSelected = allMatchesSelected();
  $('selectAllLabel').textContent = allSelected ? t('deselectAll') : t(compact ? 'selectAllCompact' : 'selectAll', { n: num(state.matches.length) });
  $('selectAll').setAttribute('aria-pressed', String(allSelected));
  $('deleteLabel').textContent = state.selected.size ? t(compact ? 'deleteCountCompact' : 'deleteCount', { n: num(state.selected.size) }) : t('delete');
  $('clearQuery').hidden = !$('query').value;
  resultControls(document);
  const selectedCounts = new Map();
  for (const url of state.selected) {
    const key = state.urlGroups.get(url);
    if (key !== undefined) selectedCounts.set(key, (selectedCounts.get(key) || 0) + 1);
  }
  $('siteCount').hidden = !state.matches.length;
  $('siteCount').textContent = t('siteCount', { n: num(state.groups.length) });
  for (const [id, grouping] of [['groupByDate', 'date'], ['groupBySite', 'website'], ['groupByFrequency', 'frequency']]) {
    $(id).disabled = state.busy; $(id).setAttribute('aria-pressed', String(state.grouping === grouping));
  }
  $('expandGroups').hidden = state.grouping === 'frequency' || !state.matches.length; $('expandGroups').disabled = state.busy;
  expansionControl();
  $('loadMore').disabled = state.busy;
  if (!compact) {
    $('footerSelected').textContent = t('selectedCount', { n: num(state.selected.size) });
    const chips = document.createDocumentFragment();
    for (const group of state.groups.filter(group => selectedCounts.has(group.key)).slice(0, 3)) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'selected-site-chip';
      chip.textContent = `${group.label} · ${num(selectedCounts.get(group.key))} ×`;
      chip.setAttribute('aria-label', t('clearSite', { site: group.label })); chip.disabled = state.busy;
      chip.addEventListener('click', () => selectGroup(group, false)); chips.append(chip);
    }
    $('selectedSiteChips').replaceChildren(chips);
  }
  const [key, args] = stale ? [state.selected.size ? 'queryChangedSelected' : 'queryChanged', {}] : state.status;
  $('status').dataset.kind = key; $('status').textContent = t(key, args);
  // Counts, notices and wrapped labels can move the trigger without a scroll or resize.
  positionTimeMenu();
  scheduleHistoryRefresh();
}
function historyRow(item) {
    // Intl formatters are expensive to construct; share them across one language's rows.
    if (rowFormats?.lang !== state.lang) rowFormats = {
      lang: state.lang,
      day: new Intl.DateTimeFormat(state.lang, { month: 'short', day: 'numeric', ...(compact ? {} : { year: 'numeric' }) }),
      time: compact ? new Intl.DateTimeFormat(state.lang, { hour: 'numeric', minute: '2-digit' }) : null,
    };
    const row = document.createElement('tr'); row.className = 'history-row';
    const cell = document.createElement('td');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'row-select'; checkbox.dataset.url = item.url; checkbox.checked = state.selected.has(item.url); checkbox.setAttribute('aria-label', t('selectRow', { url: item.url }));
    checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(item.url) : state.selected.delete(item.url); controls(); }); cell.append(checkbox);
    // Let users copy title or URL text without changing the row selection.
    row.addEventListener('click', event => { if (!event.target.closest('a, button, input') && !checkbox.disabled && !getSelection()?.toString()) checkbox.click(); });
    const page = document.createElement('td'); page.className = 'page-cell';
    const trail = document.createElement('span'); trail.className = 'row-hover-trail'; trail.setAttribute('aria-hidden', 'true'); page.append(trail);
    const title = document.createElement('span'); title.className = 'page-title'; if (item.title) { appendHighlighted(title, item.title, state.query); title.title = item.title; page.append(title); }
    const url = document.createElement('span'); url.className = 'page-url'; appendHighlighted(url, item.url, state.query); url.title = item.url;
    const address = document.createElement('span'); address.className = 'page-address';
    let protocol;
    try { protocol = new URL(item.url).protocol; } catch { /* Malformed URLs have no protocol label. */ }
    if (protocol && protocol !== 'https:') {
      const badge = document.createElement('span'); badge.className = 'protocol-badge';
      const name = protocol.slice(0, -1).toUpperCase();
      badge.textContent = protocol === 'http:' ? `HTTP · ${t('linkHighRisk')}` : protocol === 'chrome-extension:' ? 'EXTENSION' : name;
      badge.title = protocol === 'http:' ? t('linkHttpRiskHint') : t('linkProtocol', { protocol: name });
      if (protocol === 'http:') badge.classList.add('protocol-badge-risk');
      address.append(badge);
    }
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'row-copy'; copy.setAttribute('aria-label', t('copyUrlLabel', { url: item.url }));
    const copyIcon = document.createElement('img'); copyIcon.className = 'ui-icon'; copyIcon.src = 'icons/ui/copy.svg'; copyIcon.alt = ''; copyIcon.setAttribute('aria-hidden', 'true');
    const copyHint = document.createElement('span'); copyHint.className = 'row-copy-hint'; copyHint.textContent = t('copyUrl'); copyHint.setAttribute('aria-hidden', 'true');
    copy.append(copyIcon, copyHint);
    let copyTimer;
    let copying = false;
    copy.addEventListener('click', async () => {
      if (copying) return;
      copying = true; clearTimeout(copyTimer); $('copyStatus').textContent = '';
      try {
        // Copy the original value, never the highlighted/truncated presentation or protocol label.
        await navigator.clipboard.writeText(item.url);
        if (!copy.isConnected) return;
        copy.dataset.state = 'success'; copyIcon.src = 'icons/ui/check.svg'; copyHint.textContent = t('copiedUrl');
        $('copyStatus').textContent = t('copiedUrl');
      } catch {
        if (!copy.isConnected) return;
        copy.dataset.state = 'error'; copyHint.textContent = t('copyFailed'); $('copyStatus').textContent = t('copyFailed');
        const manual = $('copyUrlValue'); manual.value = item.url;
        if (!$('copyDialog').open) $('copyDialog').showModal();
        manual.focus(); manual.select();
      } finally {
        copying = false;
        copyTimer = setTimeout(() => {
          if (!copy.isConnected) return;
          delete copy.dataset.state; copyIcon.src = 'icons/ui/copy.svg'; copyHint.textContent = t('copyUrl');
        }, 2000);
      }
    });
    address.append(url, copy); page.append(address);
    const date = document.createElement('td'); date.className = 'date-column';
    const visitedAt = state.grouping === 'frequency' ? item.periodLastVisitTime : item.lastVisitTime;
    if (visitedAt != null) {
      const day = document.createElement('span'); day.className = 'date-day'; day.textContent = rowFormats.day.format(visitedAt); date.append(day);
      if (compact) { const time = document.createElement('span'); time.className = 'date-time'; time.textContent = rowFormats.time.format(visitedAt); date.append(time); }
    }
    const visits = document.createElement('td'); visits.className = 'visit-column';
    const visitCount = state.grouping === 'frequency' ? item.periodVisitCount : item.visitCount;
    if (visitCount != null) { visits.textContent = num(visitCount); visits.setAttribute('aria-label', t(state.grouping === 'frequency' ? 'periodVisitsLabel' : 'visitsLabel', { n: num(visitCount) })); }
    const actions = document.createElement('td'); actions.className = 'row-actions';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'row-delete'; remove.title = t('deleteRow'); remove.setAttribute('aria-label', t('deleteRowLabel', { url: item.url }));
    const trash = document.createElement('img'); trash.className = 'ui-icon'; trash.src = 'icons/ui/trash.svg'; trash.alt = ''; trash.setAttribute('aria-hidden', 'true'); remove.append(trash);
    // Single-row actions must not replace or submit the existing batch selection.
    remove.addEventListener('click', () => openDeletionConfirm([item.url])); actions.append(remove);
    row.append(cell, page, date, visits, actions); return row;
}
function websiteGroup(group, index, dayKey = '') {
    const expansionKey = dayKey ? `${dayKey}:${group.key}` : group.key;
    const section = document.createElement('section'); section.className = 'website-group'; section.dataset.group = group.key; section.dataset.hostname = group.label; section.dataset.total = group.items.length; section.historyItems = group.items;
    const header = document.createElement('div'); header.className = 'group-header';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'group-select'; checkbox.setAttribute('aria-label', t('selectSite', { site: group.label }));
    checkbox.addEventListener('change', () => selectGroup(group, checkbox.checked));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'group-toggle'; toggle.dataset.index = index;
    toggle.setAttribute('aria-label', t('toggleSite', { site: group.label })); toggle.setAttribute('aria-expanded', String(state.expanded.has(expansionKey))); toggle.setAttribute('aria-controls', `group-results-${index}`);
    const host = document.createElement('strong'); host.className = 'group-host'; appendHighlighted(host, group.label, state.query); host.title = group.label;
    // Read Chrome's own favicon resource, never a third-party service or a website's /favicon.ico.
    const pageUrl = group.items.find(item => /^https?:\/\//i.test(item.url))?.url;
    if (pageUrl) {
      const favicon = document.createElement('img'); favicon.className = 'group-favicon'; favicon.alt = ''; favicon.setAttribute('aria-hidden', 'true'); favicon.width = 16; favicon.height = 16; favicon.style.visibility = 'hidden';
      // Reserve the icon slot on both success and failure so labels never shift
      // when Chrome resolves a favicon after the group has already appeared.
      favicon.addEventListener('load', () => { favicon.style.visibility = ''; }, { once: true });
      favicon.addEventListener('error', () => { favicon.style.visibility = 'hidden'; }, { once: true });
      const source = new URL(chrome.runtime.getURL('_favicon/')); source.searchParams.set('pageUrl', pageUrl); source.searchParams.set('size', '32');
      favicon.src = source.href; toggle.append(favicon);
    }
    const count = document.createElement('span'); count.className = 'group-count'; count.textContent = t('siteItems', { n: num(group.items.length) });
    const selected = document.createElement('span'); selected.className = 'group-selected';
    const chevron = document.createElement('span'); chevron.className = 'group-chevron'; chevron.textContent = '⌄'; chevron.setAttribute('aria-hidden', 'true');
    toggle.append(host, count, selected, chevron);
    toggle.addEventListener('click', () => {
      state.expanded.has(expansionKey) ? state.expanded.delete(expansionKey) : state.expanded.add(expansionKey);
      // Expansion changes this group's rows, not the search or selection summary.
      // Replacing those unchanged text nodes can visibly flash on the first paint.
      section.syncExpanded(); resultControls(section); expansionControl();
    });
    header.append(checkbox, toggle);
    if (pageUrl) {
      const automatic = document.createElement('button'); automatic.type = 'button'; automatic.className = 'quiet group-auto-cleanup';
      automatic.textContent = t('autoCleanupSet'); automatic.setAttribute('aria-label', `${t('autoCleanupSet')} · ${group.label}`);
      automatic.addEventListener('click', () => { void openAutoCleanup({ domain: group.label, includeSubdomains: false }); });
      header.append(automatic);
    }
    const results = document.createElement('div'); results.className = 'group-results'; results.id = `group-results-${index}`; results.hidden = !state.expanded.has(expansionKey);
    const populate = () => {
      const table = document.createElement('table'); table.className = 'group-table'; table.setAttribute('aria-label', group.label);
      const head = $('table').tHead.cloneNode(true); const body = document.createElement('tbody');
      // A short preview keeps other website categories within reach before expanding more rows.
      let shown = state.groupShown.get(expansionKey) || groupPreviewSize;
      const appendRows = (start, end) => {
        const fragment = document.createDocumentFragment();
        for (const item of group.items.slice(start, end)) fragment.append(historyRow(item));
        body.append(fragment);
      };
      appendRows(0, shown);
      table.append(head, body); results.append(table);
      if (shown < group.items.length) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet group-load-more';
        more.textContent = t('showMoreSiteItems', { n: num(Math.min(pageSize, group.items.length - shown)) });
        more.addEventListener('click', () => {
          const next = Math.min(shown + pageSize, group.items.length);
          appendRows(shown, next); shown = next; state.groupShown.set(expansionKey, shown);
          if (shown === group.items.length) { more.remove(); toggle.focus({ preventScroll: true }); }
          else more.textContent = t('showMoreSiteItems', { n: num(Math.min(pageSize, group.items.length - shown)) });
          resultControls(section);
        });
        results.append(more);
      }
    };
    // Keep the header and unrelated groups mounted. A height spring would reflow
    // the entire scroll area every frame and fight browser scroll anchoring.
    section.syncExpanded = () => {
      const open = state.expanded.has(expansionKey);
      toggle.setAttribute('aria-expanded', String(open)); results.hidden = !open;
      if (open && !results.firstChild) populate();
      else if (!open) results.replaceChildren();
    };
    section.syncExpanded();
    section.append(header, results); return section;
}
function dateLabel(day) {
  if (!day.date) return t('unknownDate');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const key of ['dayToday', 'dayYesterday', 'dayBefore']) {
    if (day.date.getTime() === today.getTime()) return t(key);
    today.setDate(today.getDate() - 1);
  }
  return new Intl.DateTimeFormat(state.lang, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(day.date);
}
function renderGroups() {
  if (state.grouping === 'frequency') return;
  const container = $('groups');
  const reuse = groupRender?.container === container && groupRender.matches === state.matches && groupRender.grouping === state.grouping && groupRender.lang === state.lang;
  if (!reuse) {
    dateHeaderSizes.disconnect();
    if (groupRender?.container === container) {
      groupRender.fragment = document.createDocumentFragment();
      while (container.firstChild) groupRender.fragment.append(container.firstChild);
      groupViews.set(groupRender.grouping, groupRender);
    } else container.replaceChildren();
    const cached = groupViews.get(state.grouping);
    if (cached?.container === container && cached.matches === state.matches && cached.lang === state.lang) {
      container.append(cached.fragment); groupRender = cached; state.groupLimit = cached.limit;
      for (const day of container.querySelectorAll('.date-group')) day.syncExpanded();
      for (const group of container.querySelectorAll('.website-group')) group.syncExpanded();
      for (const header of container.querySelectorAll('.date-header')) dateHeaderSizes.observe(header, { box: 'border-box' });
    } else groupRender = { container, matches: state.matches, grouping: state.grouping, lang: state.lang };
  }
  const start = container.childElementCount;
  const fragment = document.createDocumentFragment();
  if (state.grouping === 'website') {
    state.groups.slice(start, state.groupLimit).forEach((group, index) => fragment.append(websiteGroup(group, start + index)));
  } else {
    for (const [offset, day] of state.dateGroups.slice(start, state.groupLimit).entries()) {
      const index = start + offset;
      const section = document.createElement('section'); section.className = 'date-group'; section.dataset.date = day.key; section.dataset.total = day.items.length; section.historyItems = day.items;
      const header = document.createElement('div'); header.className = 'date-header';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'date-select'; checkbox.setAttribute('aria-label', t('selectDay', { day: dateLabel(day) }));
      checkbox.addEventListener('change', () => selectGroup(day, checkbox.checked));
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'date-toggle'; toggle.setAttribute('aria-expanded', String(state.expandedDates.has(day.key))); toggle.setAttribute('aria-controls', `date-results-${index}`);
      const label = document.createElement('strong'); label.textContent = dateLabel(day);
      const count = document.createElement('span'); count.className = 'date-summary'; count.textContent = t('daySummary', { pages: num(day.items.length), sites: num(day.groups.length) });
      const selected = document.createElement('span'); selected.className = 'group-selected';
      const chevron = document.createElement('span'); chevron.className = 'group-chevron'; chevron.textContent = '⌄'; chevron.setAttribute('aria-hidden', 'true');
      toggle.append(label, count, selected, chevron);
      toggle.addEventListener('click', () => { state.expandedDates.has(day.key) ? state.expandedDates.delete(day.key) : state.expandedDates.add(day.key); section.syncExpanded(); resultControls(section); expansionControl(); });
      header.append(checkbox, toggle);
      const content = document.createElement('div'); content.className = 'date-results'; content.id = `date-results-${index}`; content.hidden = !state.expandedDates.has(day.key);
      const populate = () => {
        let limit = state.groupShown.get(`date:${day.key}`) || pageSize;
        const appendSites = (start, end) => {
          const fragment = document.createDocumentFragment();
          day.groups.slice(start, end).forEach((group, site) => fragment.append(websiteGroup(group, `${index}-${start + site}`, day.key)));
          content.append(fragment);
        };
        appendSites(0, limit);
        if (limit < day.groups.length) {
          const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet group-load-more'; more.textContent = t('showMoreSites');
          more.addEventListener('click', () => {
            const next = Math.min(limit + pageSize, day.groups.length);
            more.remove(); appendSites(limit, next); limit = next; state.groupShown.set(`date:${day.key}`, limit);
            if (limit < day.groups.length) { content.append(more); more.focus({ preventScroll: true }); }
            else toggle.focus({ preventScroll: true });
            resultControls(section);
          }); content.append(more);
        }
      };
      section.syncExpanded = () => {
        const open = state.expandedDates.has(day.key);
        toggle.setAttribute('aria-expanded', String(open)); content.hidden = !open;
        if (open && !content.firstChild) populate();
        else if (!open) content.replaceChildren();
      };
      section.syncExpanded();
      section.append(header, content); fragment.append(section);
      dateHeaderSizes.observe(header, { box: 'border-box' });
    }
  }
  container.append(fragment);
  groupRender.limit = state.groupLimit;
}
function renderRows() {
  const frequency = state.grouping === 'frequency';
  document.querySelector('.results-panel').dataset.view = state.grouping;
  $('table').querySelector('[data-result-date-label]').textContent = t(frequency ? 'periodLastVisit' : 'lastVisit');
  $('table').querySelector('[data-result-visit-label]').textContent = t(frequency ? 'periodVisits' : 'visits');
  renderGroups();
  const rows = $('rows');
  if (frequency && (rowRender?.container !== rows || rowRender.matches !== state.matches || rowRender.lang !== state.lang)) {
    rows.replaceChildren(); rowRender = { container: rows, matches: state.matches, grouping: state.grouping, lang: state.lang };
  }
  if (frequency) {
    state.groupLimit = Math.max(state.groupLimit, rows.childElementCount);
    const fragment = document.createDocumentFragment();
    for (const item of state.matches.slice(rows.childElementCount, state.groupLimit)) fragment.append(historyRow(item));
    rows.append(fragment);
  }
  $('groups').hidden = frequency || !state.matches.length;
  $('empty').hidden = !!state.matches.length; $('table').hidden = !frequency || !state.matches.length;
  const emptyKey = state.busy ? 'loading' : frequency && ['frequencyFailed', 'frequencyLimit'].includes(state.status[0]) ? 'frequencyError' : state.scanned ? !state.query && state.filters.range === '7days' ? 'weekNone' : state.filters.range === '3days' && !state.query ? 'recentNone' : 'none' : 'empty';
  $('empty').querySelector('h3').textContent = t(`${emptyKey}Title`); $('empty').querySelector('p').textContent = t(`${emptyKey}Body`);
  const total = frequency ? state.matches.length : state.grouping === 'date' ? state.dateGroups.length : state.groups.length;
  $('loadMore').hidden = state.groupLimit >= total;
  $('loadMore').textContent = t(frequency ? 'loadMore' : state.grouping === 'date' ? 'showMoreDates' : 'showMoreSites');
  $('preview').hidden = total <= state.groupLimit;
  $('preview').textContent = t(frequency ? 'preview' : state.grouping === 'date' ? 'groupDatePreview' : 'groupPreview', { shown: num(Math.min(state.groupLimit, total)), total: num(total) });
  controls();
}
async function readHistory(range = null) {
  if (!globalThis.chrome?.history?.search) throw new Error('API_UNAVAILABLE');
  return chrome.history.search({ text: '', startTime: range ? range.startTime : 0, ...(range ? { endTime: range.endTime - 1 } : {}), maxResults: MAX_HISTORY_RESULTS });
}
function canRefreshHistory() {
  return state.scanned && state.rulesReady && !state.busy && !updateApplying && !document.hidden && !state.selected.size && !state.pending.length && !draftChanged() && !document.querySelector('dialog[open]:not(.date-picker)');
}
function scheduleHistoryRefresh() {
  clearTimeout(historyRefreshTimer);
  if (!historyChanged || historyRefreshing || !canRefreshHistory()) return;
  historyRefreshTimer = setTimeout(async () => {
    if (!historyChanged || historyRefreshing || !canRefreshHistory()) return;
    historyChanged = false; historyRefreshing = true;
    const { matches, grouping, filters, protectedSites, excluded } = state;
    const current = () => state.matches === matches && state.grouping === grouping && state.filters === filters && state.protectedSites === protectedSites;
    let applied = false;
    try {
      // A view can stay open overnight: resolve relative days again before reading new visits.
      const range = resolveTimeRange(state.filters);
      const all = await readScan(range, { background: true });
      // An idle refresh must not disable controls or overwrite work started while reading.
      if (!current() || !canRefreshHistory()) return;
      state.timeWindow = range;
      if (range || state.grouping === 'frequency') suggestions.invalidate(); else suggestions.setHistory(all);
      const next = matchesForScan(all);
      // Lifetime metadata is not rendered in a frequency ranking. Changes outside
      // its period must not discard the current rows and decoded favicons.
      const fields = grouping === 'frequency'
        ? ['url', 'title', 'periodVisitCount', 'periodLastVisitTime']
        : ['url', 'title', 'lastVisitTime', 'visitCount'];
      const changed = historyDay !== new Date().toDateString() || next.length !== matches.length || next.some((item, index) => fields.some(field => item[field] !== matches[index][field]));
      if (changed) setMatches(next);
      status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
      applied = true;
      // A foreground check with identical results must also retain summary and
      // action text nodes; rewriting controls still repaints an unchanged view.
      if (changed) renderRows(); else if (state.excluded !== excluded) controls();
    } catch (error) {
      if (!current() || !canRefreshHistory()) return;
      if (state.grouping === 'frequency') { setMatches([], true); state.selected.clear(); }
      status(scanError(error)); applied = true; renderRows();
    } finally {
      historyRefreshing = false;
      if (!applied && current()) historyChanged = true;
      scheduleHistoryRefresh();
    }
  }, 250);
}
function markHistoryChanged() {
  invalidateViewScans();
  historyChanged = true;
  scheduleHistoryRefresh();
}
function watchNextDay() {
  const now = new Date(); const next = new Date(now); next.setHours(24, 0, 0, 50);
  setTimeout(() => { markHistoryChanged(); activity.invalidate(); watchNextDay(); }, next.getTime() - now.getTime());
}
async function search() {
  if (state.busy || !state.rulesReady) return;
  dismissCompletion();
  const query = $('query').value.trim(); const mode = $('mode').value;
  const filters = timeDraft();
  // An unbounded empty query means recent browsing; explicit date filters stay authoritative.
  if (!state.dateExplicit) { filters.range = query ? 'all' : defaultBrowsing.range; writeTimeDraft(filters); }
  let range;
  try { range = resolveTimeRange(filters); } catch { return status('invalidTimeRange'); }
  if (query && mode.startsWith('host') && !parseHostnames(query).length) return status('invalidDomain');
  state.query = query; state.mode = mode; state.filters = filters; state.timeWindow = range;
  invalidateViewScans();
  historyChanged = false;
  state.busy = true; renderRows(); status('scanning');
  try {
    const all = await readScan(state.timeWindow);
    if (state.timeWindow || state.grouping === 'frequency') suggestions.invalidate(); else suggestions.setHistory(all);
    setMatches(matchesForScan(all), true);
    state.selected.clear(); state.scanned = true;
    status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
  } catch (error) {
    setMatches([], true); state.selected.clear(); state.scanned = true;
    status(scanError(error));
  } finally { state.busy = false; renderRows(); }
}
async function request(message) {
  let response;
  try { response = await chrome.runtime.sendMessage({ ...message, clientId }); }
  catch (error) {
    // Updated page files can run before Chrome reloads the new worker manifest.
    if (/Receiving end does not exist|Extension context invalidated/i.test(error.message)) throw new Error('BACKGROUND_UNAVAILABLE');
    throw error;
  }
  if (response == null) throw new Error('BACKGROUND_UNAVAILABLE');
  if (!response.ok) throw new Error(response.code || 'BACKGROUND_REJECTED');
  return response.data;
}
function openDeletionConfirm(urls) {
  if (state.busy || !state.rulesReady || updateApplying || draftChanged() || !urls.length) return;
  dismissCompletion(); state.pending = [...urls];
  $('confirmBody').textContent = t('confirmBody', { n: num(state.pending.length) });
  renderDeletionPreview(); $('confirmDialog').returnValue = ''; $('confirmDialog').showModal();
  // The modal frame omits autofocus; keep initial focus off the preview summaries.
  if (modal) $('confirmDialog').querySelector('[value="cancel"]').focus({ preventScroll: true });
}
async function deleteConfirmed() {
  if (state.busy || !state.rulesReady || draftChanged() || !state.pending.length) { state.pending = []; return; }
  invalidateViewScans();
  suggestions.invalidate();
  const urls = [...state.pending]; state.pending = []; state.busy = true; controls();
  const attempted = new Set(urls);
  const retainedSelection = [...state.selected].filter(url => !attempted.has(url));
  $('progress').hidden = false; $('progress').max = urls.length; $('progress').value = 0;
  status('deleting', { done: 0, total: num(urls.length) });
  let job;
  let completedCount = 0;
  try {
    const details = state.matches.filter(item => attempted.has(item.url)).map(({ url, title, lastVisitTime }) => ({ url, title, lastVisitTime }));
    job = await request({ type: 'start-delete', urls, details });
    while (['deleting', 'verifying'].includes(job.phase)) {
      $('progress').value = job.completed;
      status(job.phase, { done: num(job.completed), total: num(job.total) });
      await new Promise(resolve => setTimeout(resolve, 250));
      job = await request({ type: 'delete-status', id: job.id });
    }
    if (job.phase === 'verifyFailed') return status('verifyFailed');
    const activityRecorded = job.privateCleanup || await activity.refreshCleanup();
    if (job.privateCleanup) activity.invalidate('browsing');
    const all = await readScan(state.timeWindow);
    if (state.timeWindow || state.grouping === 'frequency') suggestions.invalidate(); else suggestions.setHistory(all);
    const previousGroups = state.groups;
    const previousDates = state.dateGroups;
    setMatches(matchesForScan(all));
    // Each removed run hands off to its next surviving sibling, without toggling open groups.
    const expandSuccessors = (previous, current, expand) => {
      const surviving = new Map(current.map(group => [group.key, group]));
      let next;
      for (let index = previous.length - 1; index >= 0; index--) {
        const group = surviving.get(previous[index].key);
        if (group) next = group;
        else if (next) expand(next);
      }
    };
    if (state.grouping === 'website') {
      expandSuccessors(previousGroups, state.groups, group => state.expanded.add(group.key));
    } else {
      const previousByDate = new Map(previousDates.map(day => [day.key, day]));
      for (const day of state.dateGroups) {
        expandSuccessors(previousByDate.get(day.key)?.groups || [], day.groups,
          group => state.expanded.add(`${day.key}:${group.key}`));
      }
      expandSuccessors(previousDates, state.dateGroups, day => {
        if (state.expandedDates.has(day.key)) return;
        state.expandedDates.add(day.key);
        if (day.groups[0]) state.expanded.add(`${day.key}:${day.groups[0].key}`);
      });
    }
    // Worker verification checks every attempted URL even when the scan hits its cap.
    // A row deletion keeps other batch choices and reselects only unverified targets.
    state.selected = new Set([...retainedSelection, ...job.remaining]);
    const completionStatus = activityRecorded ? job.phase : job.phase === 'done' ? 'doneActivityUnavailable' : 'partialActivityUnavailable';
    // Only the worker's verified success may trigger the completion effect.
    if (job.phase === 'done' && job.remaining.length === 0) {
      completedCount = urls.length;
      const visibleRow = urls.length === 1 && [...$('resultScroll').querySelectorAll('.history-row')].some(row => row.querySelector('.row-select').dataset.url === urls[0]);
      if (visibleRow) {
        await animateRowRemoval($('resultScroll'), urls[0], renderRows);
      } else await animateBatchRemoval($('resultScroll'), urls, renderRows);
    }
    status(completionStatus, { n: num(job.remaining.length || urls.length) });
  } catch (error) {
    if (state.grouping === 'frequency' && job && !['deleting', 'verifying'].includes(job.phase)) { setMatches([], true); state.selected.clear(); }
    status(error.message === 'PROTECTED_URL' ? 'protectedChanged' : error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'deletionStatusFailed');
  }
  finally {
    if (job && !['deleting', 'verifying'].includes(job.phase)) request({ type: 'release-delete', id: job.id }).catch(() => {});
    state.busy = false; $('progress').hidden = true; renderRows();
    if (completedCount) showCompletion(completedCount);
  }
}
async function launchFull() {
  if (state.busy) return;
  state.busy = true; controls();
  try { await request({ type: 'open-workspace', query: $('query').value.trim(), mode: $('mode').value, filters: timeDraft() }); }
  catch (error) { status(error.message === 'INVALID_TIME_RANGE' ? 'invalidTimeRange' : error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'handoffFailed'); }
  finally { state.busy = false; controls(); }
}
function openFull() {
  // The popup cannot carry its in-memory selection into the new tab.
  if (state.selected.size) $('openFullDialog').showModal();
  else launchFull();
}
async function refreshShortcut() {
  const dialog = $('preferencesDialog');
  const output = $('launchShortcut');
  if (!dialog?.open) return;
  try {
    const commands = await chrome.commands.getAll();
    if ($('launchShortcut') !== output || !dialog.open) return;
    const command = commands.find(item => item.name === '_execute_action');
    output.textContent = command?.shortcut || t('shortcutUnassigned');
    output.dataset.state = command?.shortcut ? 'assigned' : 'unassigned';
  } catch {
    if ($('launchShortcut') === output && dialog.open) { output.textContent = t('shortcutUnavailable'); output.dataset.state = 'unavailable'; }
  }
}
async function configureShortcut(event) {
  event.preventDefault();
  const status = $('shortcutSettingsStatus');
  status.hidden = true;
  try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); }
  catch {
    if ($('shortcutSettingsStatus') === status) { status.textContent = t('shortcutSettingsFailed'); status.hidden = false; }
  }
}
function applyViewPreferences() {
  const buttons = { date: $('groupByDate'), website: $('groupBySite'), frequency: $('groupByFrequency') };
  for (const view of defaultBrowsing.viewOrder) {
    buttons[view].hidden = defaultBrowsing.hiddenViews.includes(view);
    buttons[view].parentElement.append(buttons[view]);
  }
}
function syncPreferenceViews() {
  const rows = [...$('viewChoices').children];
  const visible = rows.filter(row => row.querySelector('input').checked);
  for (const [index, row] of rows.entries()) {
    const input = row.querySelector('input');
    input.disabled = input.checked && visible.length === 1;
    row.querySelector('[data-view-move=up]').disabled = index === 0;
    row.querySelector('[data-view-move=down]').disabled = index === rows.length - 1;
  }
  if (!visible.some(row => row.dataset.viewChoice === $('defaultView').value)) $('defaultView').value = visible[0].dataset.viewChoice;
  settingsSelects.sync();
}
function setSettingsSection(section) {
  settingsSection=section;
  const general=section==='general'||section==='privacy';
  $('preferencesForm').hidden=!general;
  $('cleanupSettingsContent').hidden=section!=='tasks'&&section!=='protection';
  $('syncSettingsContent').hidden=section!=='sync';
  if(section==='sync') {
    if(!syncSurface) syncSurface=mountSyncSettings($('syncSettingsContent'),{lang:state.lang});
    $('syncSettingsContent').querySelector('h1').focus({preventScroll:true});
  }
  document.querySelectorAll('[data-preference-page]').forEach(page=>{page.hidden=page.dataset.preferencePage!==section;});
  document.querySelectorAll('[data-settings-section]').forEach(button=>button.setAttribute('aria-current',button.dataset.settingsSection===section?'page':'false'));
  settingsSelects.close();
}
function navigateSettings(section, rule) {
  if(syncSurface?.isBusy()) return;
  if(!cleanupSurface) cleanupSurface=mountAutoCleanup($('cleanupSettingsContent'),{lang:state.lang,send:message=>chrome.runtime.sendMessage({...message,clientId}),onSection:setSettingsSection});
  cleanupSurface.navigate(section,rule);
}
async function openPreferences(section='general', rule) {
  const dialog = $('preferencesDialog');
  const load = ++preferenceLoad;
  preferenceBaseline = null;
  settingsSelects.close();
  $('launchChoices').disabled = true; $('browsingDefaultChoices').disabled = true; $('cleanupPrivacyChoices').disabled = true; $('savePreferences').disabled = true;
  $('preferencesStatus').textContent = t('preferencesLoading'); if(!dialog.open) dialog.showModal();
  navigateSettings(section,rule);
  if (modal) window.parent.postMessage({ type: 'history-sweep:preferences', open: true }, '*');
  $('launchShortcut').textContent = t('shortcutLoading'); $('launchShortcut').dataset.state = 'loading';
  $('shortcutSettingsStatus').hidden = true;
  void refreshShortcut();
  try {
    const [{ launchMode }, browsing, { privateCleanup = false }, { softPrivacy = false }] = await Promise.all([request({ type: 'get-launch-preference' }), readBrowsingPreferences(chrome.storage.local), chrome.storage.local.get('privateCleanup'), chrome.storage.local.get('softPrivacy')]);
    if ($('preferencesDialog') !== dialog || !dialog.open || load !== preferenceLoad) return;
    if (typeof privateCleanup !== 'boolean' || typeof softPrivacy !== 'boolean' || !['popup', 'modal', 'fullpage'].includes(launchMode)) throw new Error('Invalid preference');
    dialog.querySelector(`input[value="${launchMode}"]`).checked = true;
    $('privateCleanup').checked = privateCleanup;
    $('softPrivacy').checked = softPrivacy;
    $('defaultView').value = browsing.view; $('defaultRange').value = browsing.range; settingsSelects.sync();
    for (const view of browsing.viewOrder) {
      const row = $('viewChoices').querySelector(`[data-view-choice="${view}"]`);
      row.querySelector('input').checked = !browsing.hiddenViews.includes(view);
      $('viewChoices').append(row);
    }
    syncPreferenceViews();
    preferenceBaseline = preferenceDraft();
    $('launchChoices').disabled = false; $('browsingDefaultChoices').disabled = false; $('cleanupPrivacyChoices').disabled = false; $('savePreferences').disabled = false;
    $('preferencesStatus').textContent = t('preferencesNextLaunch');
  } catch { if ($('preferencesDialog') === dialog && dialog.open && load === preferenceLoad) $('preferencesStatus').textContent = t('preferencesLoadFailed'); }
}
function preferenceDraft() {
  return {
    launchMode: $('preferencesForm').querySelector('input[name=launchMode]:checked')?.value,
    view: $('defaultView').value, range: $('defaultRange').value,
    viewOrder: [...$('viewChoices').children].map(row => row.dataset.viewChoice),
    hiddenViews: [...$('viewChoices').children].filter(row => !row.querySelector('input').checked).map(row => row.dataset.viewChoice),
    privateCleanup: $('privateCleanup').checked, softPrivacy: $('softPrivacy').checked,
  };
}
function requestClosePreferences() {
  if (savingPreference || syncSurface?.isBusy()) return;
  if(cleanupSurface?.hasUnsavedChanges()) { cleanupSurface.guardUnsaved(requestClosePreferences); return; }
  const draft = preferenceDraft();
  if (!preferenceBaseline || Object.keys(preferenceBaseline).every(key => JSON.stringify(draft[key]) === JSON.stringify(preferenceBaseline[key]))) {
    $('preferencesDialog').close();
    return;
  }
  const confirmation = $('unsavedPreferencesDialog');
  if (confirmation.open) return;
  $('unsavedPreferencesStatus').hidden = true;
  $('preferencesDialog').dataset.confirming = '';
  confirmation.showModal();
}
async function savePreferences(event) {
  event.preventDefault();
  if (savingPreference) return;
  // Capture one draft before asynchronous writes; both save entry points use it.
  const draft = preferenceDraft();
  if (!draft.launchMode || !preferenceBaseline) return;
  const confirmation = $('unsavedPreferencesDialog');
  savingPreference = true; $('launchChoices').disabled = true; $('browsingDefaultChoices').disabled = true; $('cleanupPrivacyChoices').disabled = true;
  renderUpdate();
  $('savePreferences').disabled = true; $('closePreferences').disabled = true; $('dismissPreferences').disabled = true;
  for (const id of ['keepEditingPreferences', 'discardPreferences', 'saveUnsavedPreferences']) $(id).disabled = true;
  $('preferencesStatus').textContent = t('preferencesSaving');
  if (confirmation.open) { $('unsavedPreferencesStatus').textContent = t('preferencesSaving'); $('unsavedPreferencesStatus').hidden = false; }
  try {
    await request({ type: 'set-launch-preference', launchMode: draft.launchMode });
    await saveBrowsingPreferences(chrome.storage.local, { view: draft.view, range: draft.range, viewOrder: draft.viewOrder, hiddenViews: draft.hiddenViews });
    await chrome.storage.local.set({ privateCleanup: draft.privateCleanup, softPrivacy: draft.softPrivacy });
    activity.setSoftPrivacy(draft.softPrivacy);
    preferenceBaseline = draft;
    // Defaults take effect on reopening; preserve the current query, view and time range.
    if (confirmation.open) confirmation.close();
    $('preferencesDialog').close();
  } catch {
    $('preferencesStatus').textContent = t('preferencesSaveFailed');
    if (confirmation.open) { $('unsavedPreferencesStatus').textContent = t('preferencesSaveFailed'); $('unsavedPreferencesStatus').hidden = false; }
  }
  finally {
    savingPreference = false; $('launchChoices').disabled = false; $('browsingDefaultChoices').disabled = false; $('cleanupPrivacyChoices').disabled = false;
    renderUpdate();
    $('savePreferences').disabled = false; $('closePreferences').disabled = false; $('dismissPreferences').disabled = false;
    for (const id of ['keepEditingPreferences', 'discardPreferences', 'saveUnsavedPreferences']) $(id).disabled = false;
  }
}

function topLayer() {
  if (settingsSelects?.isOpen()) return { consume: true, contains: target => settingsSelects.contains(target), close: () => settingsSelects.close(true) };
  if (datePicker?.isOpen()) return { consume: true, contains: target => datePicker.contains(target), close: () => datePicker.close(true) };
  if ($('themeMenu')?.open) return { consume: true, contains: target => $('themeMenu').contains(target), close: () => { $('themeMenu').open = false; $('themeToggle').setAttribute('aria-expanded', 'false'); $('themeToggle').focus({ preventScroll: true }); } };
  const dialogs = [...document.querySelectorAll('dialog[open]')].filter(node => node.id !== 'datePicker');
  const dialog = dialogs.at(-1);
  if (dialog) return { consume: true, contains: (target, event) => {
    const box = dialog.getBoundingClientRect();
    return dialog.contains(target) && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  }, close: () => {
    if (dialog.classList.contains('auto-confirm-dialog')) { cleanupSurface?.dismiss(); return; }
    if (dialog.id === 'preferencesDialog') { if(['tasks','protection'].includes(settingsSection) && cleanupSurface?.back()) return; if(settingsSection==='protection')navigateSettings('tasks');else requestClosePreferences(); return; }
    if ((dialog.id === 'unsavedPreferencesDialog' && savingPreference) || (dialog.id === 'protectionDialog' && state.busy)) return;
    dialog.returnValue = ''; dialog.close();
  } };
  const help = document.querySelector('.search-help[open]');
  if (help) return { contains: target => help.contains(target), close: () => {
    const restoreFocus = help.contains(document.activeElement);
    help.open = false;
    if (restoreFocus) $('searchHelpToggle').focus({ preventScroll: true });
  } };
  if ($('suggestionsPanel')?.dataset.open === 'true') return { contains: target => $('query').closest('.input-wrap').contains(target), close: () => suggestions.close() };
  if ($('filters')?.open) return { contains: target => $('filters').contains(target), close: () => { $('filters').open = false; $('filterToggle').focus({ preventScroll: true }); } };
  return null;
}
function setupLayerDismissal() {
  layerEvents = new AbortController();
  const listen = (target, name, fn) => target.addEventListener(name, fn, { capture: true, signal: layerEvents.signal });
  listen(window, 'resize', positionTimeMenu);
  listen(document, 'scroll', positionTimeMenu);
  let dismissedPointer = false;
  listen(document, 'pointerdown', event => {
    dismissedPointer = false;
    const layer = topLayer();
    if (!layer || layer.contains(event.target, event)) return;
    // Consume this gesture so an outside click cannot close or activate a parent layer too.
    layer.close();
    if (layer.consume) { dismissedPointer = true; event.preventDefault(); event.stopImmediatePropagation(); }
  });
  listen(document, 'click', event => { if (dismissedPointer) { dismissedPointer = false; event.preventDefault(); event.stopImmediatePropagation(); } });
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (CSS.supports('selector(select:open)') && document.querySelector('select:open')) return;
    const layer = topLayer(); if (!layer) return;
    layer.close(); event.preventDefault(); event.stopImmediatePropagation();
  });
  listen(window, 'message', event => {
    if (!modal || event.source !== window.parent || event.data?.type !== 'history-sweep:dismiss-layer') return;
    const layer = topLayer(); layer?.close();
    window.parent.postMessage({ type: 'history-sweep:layer-dismissed', requestId: event.data.requestId, handled: !!layer }, event.origin);
  });
}
function mount() {
  cancelAnimationFrame(mountFrame);
  groupViews.clear();
  dismissCompletion();
  suggestions?.destroy();
  datePicker?.destroy();
  settingsSelects?.destroy();
  nameplateSurface?.destroy();
  layerEvents?.abort();
  queryPlaceholder?.destroy();
  searchMotion?.destroy();
  backToTop?.destroy();
  scopeSizes?.disconnect();
  document.documentElement.lang = state.lang; document.title = 'History Sweep';
  $('app').dataset.mounting = 'true';
  document.getElementById('app').innerHTML = view(t, compact, modal);
  scopeSizes = setupScopeSize();
  applyViewPreferences();
  activity.mount();
  backToTop = setupBackToTop();
  $('themeMenu').addEventListener('toggle', syncThemeControl);
  for (const choice of $('themeChoices').querySelectorAll('[data-theme-choice]')) choice.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: choice.dataset.themeChoice }));
    $('themeMenu').open = false; syncThemeControl(); $('themeToggle').focus({ preventScroll: true });
  });
  syncThemeControl();
  $('applyUpdate').addEventListener('click', () => updateState ? applyUpdate() : openUpdateDetails());
  $('openUpdateSettings').addEventListener('click', openUpdateDetails);
  nameplateSurface = mountNameplate($('nameplateDialog'), { t, read: () => request({ type: 'get-nameplate' }).then(data => data.nameplate) });
  $('openNameplate').addEventListener('click', () => nameplateSurface.open());
  $('openNameplateHeader').addEventListener('click', () => nameplateSurface.open());
  $('openVersion')?.addEventListener('click', openUpdateDetails);
  $('closeUpdateDetails').addEventListener('click', () => $('updateDialog').close());
  $('updateDialog').addEventListener('close', event => {
    if (modal && !event.target.open) window.parent.postMessage({ type: 'history-sweep:update-details', open: false }, '*');
  });
  let guideReturnFocus;
  const dismissGuideHint = () => {
    $('quickStartHint').hidden = true;
    try { localStorage.setItem('quickStartDismissed', 'true'); } catch {}
  };
  try { $('quickStartHint').hidden = localStorage.getItem('quickStartDismissed') === 'true'; } catch { $('quickStartHint').hidden = false; }
  const openGuide = event => {
    guideReturnFocus = event.currentTarget.id === 'openQuickStartHint' ? $('query') : event.currentTarget;
    dismissGuideHint();
    $('quickStartDialog').showModal();
    $('quickStartDialog').scrollTop = 0;
    $('closeQuickStart').focus({ preventScroll: true });
  };
  for (const id of ['openQuickStartHint', 'openQuickStartSearch', 'openQuickStartSettings']) $(id).addEventListener('click', openGuide);
  $('dismissQuickStartHint').addEventListener('click', () => { dismissGuideHint(); $('query').focus({ preventScroll: true }); });
  for (const id of ['closeQuickStart', 'finishQuickStart']) $(id).addEventListener('click', () => $('quickStartDialog').close());
  $('quickStartDialog').addEventListener('close', () => { if (guideReturnFocus?.isConnected) guideReturnFocus.focus({ preventScroll: true }); });
  for (const dialog of [$('updateDialog'), $('quickStartDialog')]) dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const stops = [...dialog.querySelectorAll('button:not(:disabled), a[href], summary')].filter(node => node.checkVisibility());
    const first = stops[0], last = stops.at(-1);
    if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  });
  $('checkUpdate').addEventListener('click', checkUpdateNow);
  $('reloadUpdate').addEventListener('click', applyUpdate);
  $('preferencesForm').addEventListener('change', renderUpdateDetails);
  $('dismissUpdate').addEventListener('click', () => {
    dismissedUpdate = updateState?.version || updateCheck?.version;
    renderUpdate(true);
    $('query').focus({ preventScroll: true });
  });
  $('updateSlot').addEventListener('transitionend', event => {
    if (event.target === $('updateSlot') && $('updateSlot').dataset.open === 'false') $('updateSlot').hidden = true;
  });
  $('query').value = state.query; $('mode').value = state.mode;
  queryPlaceholder = setupQueryPlaceholder($('query'));
  searchMotion = setupSearchMotion($('search'));
  writeTimeDraft(state.filters);
  setupLayerDismissal();
  $('searchHelp').addEventListener('toggle', () => { if ($('searchHelp').open) suggestions.close(); });
  $('searchHelpClose').addEventListener('click', () => {
    $('searchHelp').open = false;
    $('searchHelpToggle').focus({ preventScroll: true });
  });
  settingsSelects = setupSettingsSelects($('preferencesDialog'));
  $('viewChoices').addEventListener('change', syncPreferenceViews);
  const viewChoices = $('viewChoices');
  let draggedView = null;
  const clearViewDrop = () => {
    for (const row of viewChoices.children) delete row.dataset.dropPosition;
  };
  const endViewDrag = () => {
    draggedView?.classList.remove('is-dragging');
    draggedView = null;
    clearViewDrop();
  };
  viewChoices.addEventListener('dragstart', event => {
    const handle = event.target.closest('[data-view-drag]');
    if (!handle || $('browsingDefaultChoices').disabled || savingPreference) {
      event.preventDefault();
      return;
    }
    draggedView = handle.closest('[data-view-choice]');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedView.dataset.viewChoice);
    event.dataTransfer.setDragImage(draggedView, 20, draggedView.offsetHeight / 2);
    draggedView.classList.add('is-dragging');
  });
  viewChoices.addEventListener('dragover', event => {
    clearViewDrop();
    if (!draggedView || $('browsingDefaultChoices').disabled || savingPreference) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const row = event.target.closest('[data-view-choice]');
    if (!row || row === draggedView) return;
    const bounds = row.getBoundingClientRect();
    row.dataset.dropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
  });
  viewChoices.addEventListener('dragleave', event => {
    if (!viewChoices.contains(event.relatedTarget)) clearViewDrop();
  });
  viewChoices.addEventListener('drop', event => {
    if (!draggedView) return;
    event.preventDefault();
    const row = viewChoices.querySelector('[data-drop-position]');
    // Commit only on a valid drop so Escape and dropping outside leave the draft unchanged.
    if (row && !$('browsingDefaultChoices').disabled && !savingPreference) {
      if (row.dataset.dropPosition === 'before') row.before(draggedView);
      else row.after(draggedView);
      syncPreferenceViews();
    }
    endViewDrag();
  });
  viewChoices.addEventListener('dragend', endViewDrag);
  $('preferencesDialog').addEventListener('close', endViewDrag);
  $('defaultView').addEventListener('change', () => {
    $('viewChoices').querySelector(`[data-view-visible="${$('defaultView').value}"]`).checked = true;
    syncPreferenceViews();
  });
  $('viewChoices').addEventListener('click', event => {
    const button = event.target.closest('[data-view-move]');
    if (!button || button.disabled || $('browsingDefaultChoices').disabled) return;
    const row = button.closest('[data-view-choice]');
    if (button.dataset.viewMove === 'up') row.previousElementSibling.before(row);
    else row.nextElementSibling.after(row);
    syncPreferenceViews();
    // Moving a focused DOM node can clear focus; keep keyboard reordering usable at either boundary.
    (button.disabled ? row.querySelector('[data-view-move]:not(:disabled)') : button).focus({ preventScroll: true });
  });
  datePicker = setupDatePicker({ lang: state.lang, t });
  suggestions = setupSuggestions({ input: $('query'), mode: $('mode'), panel: $('suggestionsPanel'), list: $('suggestionsList'), readHistory, onChoose: controls });
  for (const choice of document.querySelectorAll('.time-range-radio')) choice.addEventListener('click', () => {
    if (!choice.checked) return;
    $('timeRange').value = choice.value;
    $('timeRange').dispatchEvent(new Event('change', { bubbles: true }));
    if (choice.value !== 'custom') {
      $('filters').open = false;
      $('filterToggle').focus({ preventScroll: true });
      void search();
    }
  });
  $('query').addEventListener('input', () => { dismissCompletion(); controls(); });
  $('mode').addEventListener('change', () => { dismissCompletion(); controls(); });
  for (const id of ['timeRange', 'startDate', 'endDate']) $(id).addEventListener('change', () => { state.dateExplicit = true; dismissCompletion(); suggestions.invalidate(); controls(); });
  for (const id of ['startDate', 'endDate']) $(id).addEventListener('input', () => { state.dateExplicit = true; dismissCompletion(); suggestions.invalidate(); controls(); });
  for (const id of ['startDate', 'endDate']) $(id).addEventListener('change', () => {
    if ($('timeRange').value !== 'custom') return;
    try { resolveTimeRange(timeDraft()); } catch { return; }
    void search();
  });
  $('editProtection').addEventListener('click', () => { $('filters').open = false; $('protectionInput').value = state.protectedSites.join('\n'); $('protectionStatus').textContent = ''; $('protectionDialog').showModal(); $('protectionInput').focus(); });
  $('closeProtection').addEventListener('click', () => $('protectionDialog').close());
  $('protectionForm').addEventListener('submit', saveProtection);
  $('protectionDialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  $('currentSite')?.addEventListener('click', currentSite);
  cleanupSurface?.destroy(); cleanupSurface=null; syncSurface=null;
  $('openPreferences').addEventListener('click', ()=>openPreferences());
  document.querySelectorAll('[data-settings-section]').forEach(button=>button.addEventListener('click',()=>navigateSettings(button.dataset.settingsSection)));

  $('autoFromSearch').addEventListener('click', () => { const rule = autoSearchRule(); if (rule) void openAutoCleanup(rule); });
  for (const id of ['closePreferences', 'dismissPreferences','backPreferences']) $(id).addEventListener('click', requestClosePreferences);
  $('keepEditingPreferences').addEventListener('click', () => $('unsavedPreferencesDialog').close());
  $('discardPreferences').addEventListener('click', () => { $('unsavedPreferencesDialog').close(); $('preferencesDialog').close(); });
  $('saveUnsavedPreferences').addEventListener('click', savePreferences);
  $('unsavedPreferencesDialog').addEventListener('cancel', event => { if (savingPreference) event.preventDefault(); });
  $('unsavedPreferencesDialog').addEventListener('close', () => {
    delete $('preferencesDialog').dataset.confirming;
  });
  $('preferencesForm').addEventListener('submit', savePreferences);
  $('configureShortcut').addEventListener('click', configureShortcut);
  $('preferencesDialog').addEventListener('cancel', event => { event.preventDefault(); requestClosePreferences(); });
  $('preferencesDialog').addEventListener('close', async event => {
    settingsSelects.close();
    if (!modal) return;
    const dialog = event.target;
    // Keep the outer window close control hidden until this drawer has slid out.
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished));
    if (!dialog.open) window.parent.postMessage({ type: 'history-sweep:preferences', open: false }, '*');
  });
  $('filters').addEventListener('toggle', () => { $('filterToggle').setAttribute('aria-expanded', String($('filters').open)); positionTimeMenu(); });
  $('clearQuery').addEventListener('click', () => {
    dismissCompletion(); suggestions.close();
    state.query = ''; setMatches([], true); state.selected.clear(); state.scanned = false; state.excluded = 0;
    $('query').value = ''; $('query').focus(); renderRows(); void search();
  });
  for (const button of $('language').querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === state.lang));
    button.addEventListener('click', () => {
      if (state.busy || button.dataset.language === state.lang) return;
      const scrollTop = $('resultScroll').scrollTop;
      const draftQuery = $('query').value; const draftMode = $('mode').value;
      const draftFilters = timeDraft(); const filtersOpen = $('filters').open;
      state.lang = button.dataset.language; saveLanguage(state.lang); mount();
      $('query').value = draftQuery; $('mode').value = draftMode; writeTimeDraft(draftFilters); $('filters').open = filtersOpen; controls();
      $('resultScroll').scrollTop = scrollTop;
      $('language').querySelector(`[data-language="${state.lang}"]`).focus({ preventScroll: true });
    });
  }
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('selectAll').addEventListener('click', () => { state.selected = allMatchesSelected() ? new Set() : new Set(state.matches.map(item => item.url)); controls(); });
  $('clear').addEventListener('click', () => { state.selected.clear(); controls(); });
  for (const [id, grouping] of [['groupByDate', 'date'], ['groupBySite', 'website'], ['groupByFrequency', 'frequency']]) {
    $(id).addEventListener('click', () => { void changeGrouping(grouping); });
    const prepare = () => {
      if (state.busy || !state.scanned || draftChanged() || state.grouping === grouping) return;
      // Intent prefetch avoids reading every URL's visits on initial page load.
      // Failures remain retryable and are surfaced only if that view is opened.
      void readScan(state.timeWindow, { grouping, background: true, reuse: true }).catch(() => {});
    };
    $(id).addEventListener('pointerenter', prepare);
    $(id).addEventListener('focus', prepare);
  }
  $('expandGroups').addEventListener('click', () => {
    const collapse = allGroupsExpanded();
    if (state.grouping === 'date') {
      state.expandedDates = collapse ? new Set() : new Set(state.dateGroups.map(day => day.key));
      for (const day of state.dateGroups) for (const group of day.groups) {
        const key = `${day.key}:${group.key}`;
        collapse ? state.expanded.delete(key) : state.expanded.add(key);
      }
    } else state.expanded = collapse ? new Set() : new Set(state.groups.map(group => group.key));
    for (const day of $('groups').querySelectorAll('.date-group')) day.syncExpanded();
    for (const group of $('groups').querySelectorAll('.website-group')) group.syncExpanded();
    resultControls($('groups')); expansionControl();
  });
  $('loadMore').addEventListener('click', () => { state.groupLimit += pageSize; renderRows(); });
  $('delete').addEventListener('click', () => openDeletionConfirm([...state.selected]));
  $('confirmDialog').addEventListener('close', () => { if ($('confirmDialog').returnValue === 'confirm') deleteConfirmed(); else state.pending = []; });
  $('openFullDialog').addEventListener('close', () => { if ($('openFullDialog').returnValue === 'confirm') launchFull(); });
  for (const id of ['openFull', 'openFullFooter']) $(id)?.addEventListener('click', openFull);
  renderRows();
  mountFrame = requestAnimationFrame(() => {
    // Let restored state and pointer hit testing settle before enabling transitions.
    void $('app').offsetHeight;
    mountFrame = requestAnimationFrame(() => { delete $('app').dataset.mounting; });
  });
}
const initialSettings=new URLSearchParams(location.hash.slice(1)).get('settings');
const handoffId = new URLSearchParams(location.hash.slice(1)).get('handoff');
const modalUnavailable = location.hash === '#modalUnavailable';
// A modal retains its one-use launch ID so the worker can authenticate subsequent messages.
// Top-level routing metadata is removed before Chrome can retain a restored tab URL.
if (!modal && (location.search || location.hash)) history.replaceState(null, '', location.pathname);
mount();
document.addEventListener('history-sweep:theme-changed', syncThemeControl);
void refreshUpdate();
// Check once per opened view; storage keeps all views informed without repeating network checks.
void requestUpdateFeedback({ type: 'check-for-update' }).then(refreshUpdate).catch(() => {
  updateReadFailed = true;
  renderUpdateDetails();
});
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, 'extensionUpdate')) void refreshUpdate();
  if (area === 'local' && Object.hasOwn(changes, 'extensionUpdateCheck')) void refreshUpdate();
  if (area === 'local' && Object.hasOwn(changes, 'localActivity')) activity.invalidate('cleanup');
  if (area === 'local' && Object.hasOwn(changes, 'softPrivacy')) activity.setSoftPrivacy(changes.softPrivacy.newValue === undefined ? false : changes.softPrivacy.newValue);
});
// Refresh idle results, but defer while the user edits, selects or confirms a deletion.
globalThis.chrome?.history?.onVisited?.addListener(markHistoryChanged);
globalThis.chrome?.history?.onVisitRemoved?.addListener(markHistoryChanged);
globalThis.chrome?.history?.onVisited?.addListener(() => activity.invalidate('browsing'));
globalThis.chrome?.history?.onVisitRemoved?.addListener(() => activity.invalidate('browsing'));
window.addEventListener('focus', markHistoryChanged);
window.addEventListener('focus', () => activity.invalidate());
window.addEventListener('focus', refreshShortcut);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshShortcut(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) markHistoryChanged(); });
document.addEventListener('close', () => queueMicrotask(scheduleHistoryRefresh), true);
watchNextDay();
// Extension-local rules load before any selection or deletion becomes available.
const initialNameplate = request({ type: 'claim-nameplate-reveal' }).then(data => data.nameplate).catch(() => null);
request({ type: 'get-protection' }).then(async data => {
  state.protectedSites = data.sites;
  try { defaultBrowsing = await readBrowsingPreferences(chrome.storage.local); }
  catch { status('preferencesLoadFailed'); controls(); return; }
  state.grouping = defaultBrowsing.view; state.filters.range = defaultBrowsing.range;
  applyViewPreferences();
  writeTimeDraft(state.filters);
  state.rulesReady = true; status(modalUnavailable ? 'modalUnavailable' : 'ready'); controls();
  if (handoffId && !compact) {
    state.busy = true; controls();
    try {
      const handoff = await request({ type: 'claim-workspace', handoffId });
      $('query').value = handoff.query; $('mode').value = handoff.mode; state.dateExplicit = true; writeTimeDraft(handoff.filters);
      $('filters').open = handoff.filters.range !== 'all'; state.busy = false;
      await search();
    } catch { state.busy = false; status('handoffFailed'); controls(); }
  } else { await search(); if (modalUnavailable) status('modalUnavailable'); }
}).catch(error => { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'rulesUnavailable'); controls(); })
  .finally(async () => {
    const card = await initialNameplate;
    document.dispatchEvent(new CustomEvent('history-sweep:startup-ready', { detail: {
      beforeReveal: card ? () => nameplateSurface.open({ card, first: true }) : undefined,
    } }));
  });
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !Object.hasOwn(changes, 'protectedSites')) return;
  // Re-read and validate the authoritative rules rather than trusting an event payload.
  state.rulesReady = false; state.pending = []; state.selected.clear(); controls();
  request({ type: 'get-protection' }).then(data => {
    state.rulesReady = true; applyProtectedSites(data.sites); controls();
  }).catch(() => { status('rulesUnavailable'); controls(); });
});

if(['general','privacy'].includes(initialSettings)) void openPreferences(initialSettings);
