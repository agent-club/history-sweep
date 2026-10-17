import { filterHistoryItems, sortByLastVisit, MAX_HISTORY_RESULTS, parseHostnames } from './history-utils.mjs';
import { readLanguage, saveLanguage, translate } from './i18n.mjs';
import { view } from './view.mjs';
import { groupHistoryItems, groupHistoryByDate } from './history-groups.mjs';
import { setupSuggestions, appendHighlighted } from './suggestions-ui.mjs';
import { defaultTimeFilter, resolveTimeRange, filterByTime, parseProtectedSites, isProtectedUrl } from './history-filters.mjs';
import { setupDatePicker } from './date-picker.mjs';
import { createActivityPanel } from './activity-panel.mjs';
import { animateRowRemoval } from './row-removal.mjs';
import { animateBatchRemoval } from './batch-removal.mjs';

const compact = document.body.dataset.layout === 'popup';
const modal = document.body.dataset.presentation === 'modal';
const clientId = crypto.randomUUID();
const pageSize = compact ? 40 : 100;
const groupPreviewSize = 3;
let suggestions;
let datePicker;
let layerEvents;
let queryPlaceholder;
let searchMotion;
let historyChanged = false;
let historyRefreshTimer;
let completionTimer;
let savingPreference = false;
let updateState = null;
let dismissedUpdate = null;
let updateApplying = false;
let updateError = false;
let updateRequest = 0;
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
const state = { lang: readLanguage(), query: '', mode: 'smart', matches: [], groups: [], urlGroups: new Map(), grouping: 'date', dateGroups: [], expandedDates: new Set(), expanded: new Set(), groupShown: new Map(), groupLimit: pageSize, selected: new Set(), busy: false, scanned: false, status: ['rulesLoading', {}], pending: [], filters: { ...defaultTimeFilter(), range: '3days' }, dateExplicit: false, timeWindow: null, protectedSites: [], rulesReady: false, excluded: 0 };
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
  button.querySelector('img').src = `icons/ui/${preference === 'system' ? 'monitor' : preference === 'light' ? 'sun' : 'moon'}.svg`;
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
function status(key, args = {}) { state.status = [key, args]; $('status').dataset.kind = key; $('status').textContent = t(key, args); }
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
  const slot = $('updateSlot');
  const visible = updateState !== null && updateState.version !== dismissedUpdate;
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
  const busy = updateState.busy || state.busy || savingPreference;
  $('updateCopy').textContent = updateError ? t('updateFailed') : t('updateAvailable', { version: updateState.version });
  $('updateCopy').title = t('updateAvailable', { version: updateState.version });
  $('applyUpdate').textContent = t(updateApplying ? 'updateReloading' : busy ? 'updateWaiting' : 'updateNow');
  $('applyUpdate').disabled = busy || updateApplying;
  $('applyUpdate').title = t(busy ? 'updateBusyHint' : 'updateRestartHint');
  $('dismissUpdate').disabled = updateApplying;
  if (opening) {
    slot.dataset.motion = String(animate && !reducedMotion());
    slot.hidden = false;
    // Resolve the collapsed grid before opening, so the task content moves with the banner.
    if (animate && !reducedMotion()) void slot.offsetHeight;
    slot.dataset.open = 'true';
  }
}

async function refreshUpdate() {
  const ticket = ++updateRequest;
  try {
    const { update } = await request({ type: 'get-update-state' });
    if (ticket !== updateRequest) return;
    if (update !== null && (typeof update?.version !== 'string' || typeof update.busy !== 'boolean')) throw new Error('Invalid update state');
    updateState = update;
    renderUpdate(true);
  } catch {
    // An unavailable update notification must not block local history operations.
  }
}

async function applyUpdate() {
  if (!updateState || updateState.busy || state.busy || savingPreference || updateApplying) return;
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

function matchesForScan(items) {
  const matches = filterByTime(state.query ? filterHistoryItems(items, state.query, state.mode) : items, state.timeWindow).filter(item => item.url);
  const visible = matches.filter(item => !isProtectedUrl(item.url, state.protectedSites));
  state.excluded = matches.length - visible.length;
  return sortByLastVisit(visible);
}

function applyProtectedSites(sites) {
  if (JSON.stringify(sites) === JSON.stringify(state.protectedSites)) return;
  state.protectedSites = sites;
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
  state.matches = matches;
  state.groups = groupHistoryItems(matches);
  state.dateGroups = groupHistoryByDate(matches);
  state.urlGroups = new Map(state.groups.flatMap(group => group.items.map(item => [item.url, group.key])));
  if (resetGroups) {
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

function controls() {
  renderUpdate();
  // Selection belongs to the last scan, so edited criteria must not delete those older results.
  // Default browsing is recent; keyword searches keep their existing all-time scope until a date is explicitly chosen.
  if (!state.dateExplicit) $('timeRange').value = $('query').value.trim() ? 'all' : '3days';
  const stale = draftChanged();
  if (state.busy) suggestions?.close();
  const blocked = state.busy || !state.rulesReady || updateApplying;
  for (const id of ['query', 'mode', 'search', 'clearQuery', 'openFull', 'openFullFooter', 'timeRange', 'startDate', 'endDate', 'editProtection', 'currentSite', 'saveProtection', 'closeProtection', 'protectionInput']) if ($(id)) $(id).disabled = blocked;
  queryPlaceholder?.sync();
  $('customDates').hidden = $('timeRange').value !== 'custom';
  datePicker?.sync();
  $('query').required = false;
  $('filterSummary').textContent = $('timeRange').value === 'all' ? '' : $('timeRange').selectedOptions[0].textContent;
  const filterLabel = [t('filters'), $('filterSummary').textContent, state.protectedSites.length ? t('keptSites', { n: num(state.protectedSites.length) }) : ''].filter(Boolean).join(' · ');
  $('filterToggle').title = filterLabel;
  $('filterToggle').setAttribute('aria-label', filterLabel);
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
  $('resultScope').textContent = t(state.filters.range === '3days' ? 'recentScope' : 'dateScope');
  $('selected').textContent = `${num(state.selected.size)} ${t('selected')}`;
  $('selected').hidden = compact && !state.selected.size;
  const allSelected = allMatchesSelected();
  $('selectAllLabel').textContent = allSelected ? t('deselectAll') : t(compact ? 'selectAllCompact' : 'selectAll', { n: num(state.matches.length) });
  $('selectAll').setAttribute('aria-pressed', String(allSelected));
  $('deleteLabel').textContent = state.selected.size ? t(compact ? 'deleteCountCompact' : 'deleteCount', { n: num(state.selected.size) }) : t('delete');
  $('clearQuery').hidden = !$('query').value;
  for (const check of document.querySelectorAll('input[type=checkbox]')) {
    check.disabled = blocked || stale;
    if (check.classList.contains('row-select')) check.checked = state.selected.has(check.dataset.url);
  }
  const selectedCounts = new Map();
  for (const url of state.selected) {
    const key = state.urlGroups.get(url);
    if (key !== undefined) selectedCounts.set(key, (selectedCounts.get(key) || 0) + 1);
  }
  for (const element of $('groups').querySelectorAll('.website-group, .date-group')) {
    const count = element.historyItems.filter(item => state.selected.has(item.url)).length;
    const total = Number(element.dataset.total);
    const check = element.querySelector(':scope > .group-header .group-select, :scope > .date-header .date-select');
    check.checked = count === total;
    check.indeterminate = count > 0 && count < total;
    element.dataset.selection = count === total ? 'all' : count ? 'partial' : 'none';
    const selectedLabel = element.querySelector(':scope > .group-header .group-selected, :scope > .date-header .group-selected');
    selectedLabel.textContent = t('siteSelected', { n: num(count) });
    selectedLabel.hidden = !count;
    for (const button of element.querySelectorAll('button')) button.disabled = state.busy;
  }
  for (const button of document.querySelectorAll('.row-delete')) button.disabled = blocked || stale;
  $('siteCount').hidden = !state.matches.length;
  $('siteCount').textContent = t('siteCount', { n: num(state.groups.length) });
  for (const [id, grouping] of [['groupByDate', 'date'], ['groupBySite', 'website']]) {
    $(id).disabled = state.busy; $(id).setAttribute('aria-pressed', String(state.grouping === grouping));
  }
  $('expandGroups').hidden = !state.matches.length; $('expandGroups').disabled = state.busy;
  const allExpanded = allGroupsExpanded();
  const expandLabel = t(allExpanded ? 'collapseAll' : 'expandAll');
  $('expandGroups').querySelector('span').textContent = expandLabel;
  $('expandGroups').setAttribute('aria-label', expandLabel);
  $('expandGroups').dataset.expanded = String(allExpanded);
  $('loadMore').disabled = state.busy;
  if (!compact) {
    $('footerSelected').textContent = t('selectedCount', { n: num(state.selected.size) });
    $('selectedSites').textContent = t('selectedSites', { n: num(selectedCounts.size) });
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
  scheduleHistoryRefresh();
}
function historyRow(item) {
    const row = document.createElement('tr'); row.className = 'history-row';
    const cell = document.createElement('td');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'row-select'; checkbox.dataset.url = item.url; checkbox.checked = state.selected.has(item.url); checkbox.setAttribute('aria-label', t('selectRow', { url: item.url }));
    checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(item.url) : state.selected.delete(item.url); controls(); }); cell.append(checkbox);
    // Let users copy title or URL text without changing the row selection.
    row.addEventListener('click', event => { if (!event.target.closest('a, button, input') && !checkbox.disabled && !getSelection()?.toString()) checkbox.click(); });
    const page = document.createElement('td'); page.className = 'page-cell';
    const trail = document.createElement('span'); trail.className = 'row-hover-trail'; trail.setAttribute('aria-hidden', 'true'); page.append(trail);
    const title = document.createElement('span'); title.className = 'page-title'; if (item.title) { appendHighlighted(title, item.title, state.query); title.title = item.title; page.append(title); }
    const url = document.createElement('span'); url.className = 'page-url'; appendHighlighted(url, item.url, state.query); url.title = item.url; page.append(url);
    const date = document.createElement('td'); date.className = 'date-column';
    if (item.lastVisitTime != null) {
      const day = document.createElement('span'); day.className = 'date-day'; day.textContent = new Intl.DateTimeFormat(state.lang, { month: 'short', day: 'numeric', ...(compact ? {} : { year: 'numeric' }) }).format(item.lastVisitTime); date.append(day);
      if (compact) { const time = document.createElement('span'); time.className = 'date-time'; time.textContent = new Intl.DateTimeFormat(state.lang, { hour: 'numeric', minute: '2-digit' }).format(item.lastVisitTime); date.append(time); }
    }
    const visits = document.createElement('td'); visits.className = 'visit-column'; if (item.visitCount != null) visits.textContent = num(item.visitCount);
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
      const favicon = document.createElement('img'); favicon.className = 'group-favicon'; favicon.alt = ''; favicon.setAttribute('aria-hidden', 'true'); favicon.width = 16; favicon.height = 16; favicon.hidden = true;
      favicon.addEventListener('load', () => { favicon.hidden = false; }, { once: true });
      favicon.addEventListener('error', () => favicon.remove(), { once: true });
      const source = new URL(chrome.runtime.getURL('_favicon/')); source.searchParams.set('pageUrl', pageUrl); source.searchParams.set('size', '32');
      favicon.src = source.href; toggle.append(favicon);
    }
    const count = document.createElement('span'); count.className = 'group-count'; count.textContent = t('siteItems', { n: num(group.items.length) });
    const selected = document.createElement('span'); selected.className = 'group-selected';
    const chevron = document.createElement('span'); chevron.className = 'group-chevron'; chevron.textContent = '⌄'; chevron.setAttribute('aria-hidden', 'true');
    toggle.append(host, count, selected, chevron);
    toggle.addEventListener('click', () => {
      const previousHeight = section.getBoundingClientRect().height;
      state.expanded.has(expansionKey) ? state.expanded.delete(expansionKey) : state.expanded.add(expansionKey);
      renderRows();
      const current = document.getElementById(`group-results-${index}`)?.closest('.website-group');
      if (current && !reducedMotion()) {
        const height = current.getBoundingClientRect().height;
        current.animate([{ height: `${previousHeight}px` }, { height: `${height + (height - previousHeight) * .018}px`, offset: .8 }, { height: `${height}px` }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
        if (state.expanded.has(expansionKey)) current.querySelector('.group-results').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, delay: 35 });
      }
      current?.querySelector('.group-toggle')?.focus({ preventScroll: true });
    });
    header.append(checkbox, toggle);
    const results = document.createElement('div'); results.className = 'group-results'; results.id = `group-results-${index}`; results.hidden = !state.expanded.has(expansionKey);
    if (!results.hidden) {
      const table = document.createElement('table'); table.className = 'group-table'; table.setAttribute('aria-label', group.label);
      const head = $('table').tHead.cloneNode(true); const body = document.createElement('tbody');
      // A short preview keeps other website categories within reach before expanding more rows.
      const shown = state.groupShown.get(expansionKey) || groupPreviewSize;
      for (const item of group.items.slice(0, shown)) body.append(historyRow(item));
      table.append(head, body); results.append(table);
      if (shown < group.items.length) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet group-load-more';
        more.textContent = t('showMoreSiteItems', { n: num(Math.min(pageSize, group.items.length - shown)) });
        more.addEventListener('click', () => {
          state.groupShown.set(expansionKey, shown + pageSize); renderRows();
          const current = document.getElementById(`group-results-${index}`)?.closest('.website-group'); (current?.querySelector('.group-load-more') || current?.querySelector('.group-toggle'))?.focus({ preventScroll: true });
        });
        results.append(more);
      }
    }
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
  const fragment = document.createDocumentFragment();
  if (state.grouping === 'website') {
    state.groups.slice(0, state.groupLimit).forEach((group, index) => fragment.append(websiteGroup(group, index)));
  } else {
    for (const [index, day] of state.dateGroups.slice(0, state.groupLimit).entries()) {
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
      toggle.addEventListener('click', () => { state.expandedDates.has(day.key) ? state.expandedDates.delete(day.key) : state.expandedDates.add(day.key); renderRows(); document.querySelector(`[data-date="${day.key}"] > .date-header .date-toggle`)?.focus({ preventScroll: true }); });
      header.append(checkbox, toggle);
      const content = document.createElement('div'); content.className = 'date-results'; content.id = `date-results-${index}`; content.hidden = !state.expandedDates.has(day.key);
      if (!content.hidden) {
        const limit = state.groupShown.get(`date:${day.key}`) || pageSize;
        day.groups.slice(0, limit).forEach((group, site) => content.append(websiteGroup(group, `${index}-${site}`, day.key)));
        if (limit < day.groups.length) {
          const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet group-load-more'; more.textContent = t('showMoreSites');
          more.addEventListener('click', () => { state.groupShown.set(`date:${day.key}`, limit + pageSize); renderRows(); }); content.append(more);
        }
      }
      section.append(header, content); fragment.append(section);
    }
  }
  dateHeaderSizes.disconnect();
  $('groups').replaceChildren(fragment);
  for (const header of $('groups').querySelectorAll('.date-header')) dateHeaderSizes.observe(header, { box: 'border-box' });
}
function renderRows() {
  renderGroups(); $('rows').replaceChildren();
  $('groups').hidden = !state.matches.length;
  $('empty').hidden = !!state.matches.length; $('table').hidden = true;
  const emptyKey = state.busy ? 'loading' : state.scanned ? state.filters.range === '3days' && !state.query ? 'recentNone' : 'none' : 'empty';
  $('empty').querySelector('h3').textContent = t(`${emptyKey}Title`); $('empty').querySelector('p').textContent = t(`${emptyKey}Body`);
  const total = state.grouping === 'date' ? state.dateGroups.length : state.groups.length;
  $('loadMore').hidden = state.groupLimit >= total;
  $('loadMore').textContent = t(state.grouping === 'date' ? 'showMoreDates' : 'showMoreSites');
  $('preview').hidden = total <= state.groupLimit;
  $('preview').textContent = t(state.grouping === 'date' ? 'groupDatePreview' : 'groupPreview', { shown: num(Math.min(state.groupLimit, total)), total: num(total) });
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
  if (!historyChanged || !canRefreshHistory()) return;
  historyRefreshTimer = setTimeout(async () => {
    if (!historyChanged || !canRefreshHistory()) return;
    historyChanged = false; state.busy = true; controls();
    try {
      // A view can stay open overnight: resolve relative days again before reading new visits.
      const range = resolveTimeRange(state.filters);
      const all = await readHistory(range);
      state.timeWindow = range;
      if (range) suggestions.invalidate(); else suggestions.setHistory(all);
      setMatches(matchesForScan(all));
      status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
    } catch { status('scanFailed'); }
    finally { state.busy = false; renderRows(); }
  }, 250);
}
function markHistoryChanged() {
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
  if (!state.dateExplicit) { filters.range = query ? 'all' : '3days'; writeTimeDraft(filters); }
  let range;
  try { range = resolveTimeRange(filters); } catch { return status('invalidTimeRange'); }
  if (query && mode.startsWith('host') && !parseHostnames(query).length) return status('invalidDomain');
  state.query = query; state.mode = mode; state.filters = filters; state.timeWindow = range;
  historyChanged = false;
  state.busy = true; renderRows(); status('scanning');
  try {
    const all = await readHistory(state.timeWindow);
    if (state.timeWindow) suggestions.invalidate(); else suggestions.setHistory(all);
    setMatches(matchesForScan(all), true);
    state.selected.clear(); state.scanned = true;
    status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
  } catch (error) {
    setMatches([], true); state.selected.clear(); state.scanned = true;
    status(error.message === 'API_UNAVAILABLE' ? 'apiUnavailable' : 'scanFailed');
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
}
async function deleteConfirmed() {
  if (state.busy || !state.rulesReady || draftChanged() || !state.pending.length) { state.pending = []; return; }
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
    const activityRecorded = await activity.refreshCleanup();
    const all = await readHistory(state.timeWindow);
    if (state.timeWindow) suggestions.invalidate(); else suggestions.setHistory(all);
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
  } catch (error) { status(error.message === 'PROTECTED_URL' ? 'protectedChanged' : error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'deletionStatusFailed'); }
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
async function openPreferences() {
  const dialog = $('preferencesDialog');
  $('launchChoices').disabled = true; $('savePreferences').disabled = true;
  $('preferencesStatus').textContent = t('preferencesLoading'); dialog.showModal();
  try {
    const { launchMode } = await request({ type: 'get-launch-preference' });
    if ($('preferencesDialog') !== dialog || !dialog.open) return;
    if (!['popup', 'modal', 'fullpage'].includes(launchMode)) throw new Error('Invalid preference');
    dialog.querySelector(`input[value="${launchMode}"]`).checked = true;
    $('launchChoices').disabled = false; $('savePreferences').disabled = false;
    $('preferencesStatus').textContent = t('preferencesNextLaunch');
  } catch { if ($('preferencesDialog') === dialog && dialog.open) $('preferencesStatus').textContent = t('preferencesLoadFailed'); }
}
async function savePreferences(event) {
  event.preventDefault();
  if (savingPreference) return;
  const launchMode = $('preferencesForm').querySelector('input:checked')?.value;
  if (!launchMode) return;
  savingPreference = true; $('launchChoices').disabled = true;
  renderUpdate();
  $('savePreferences').disabled = true; $('closePreferences').disabled = true;
  $('preferencesStatus').textContent = t('preferencesSaving');
  try {
    await request({ type: 'set-launch-preference', launchMode });
    $('preferencesDialog').close();
  } catch { $('preferencesStatus').textContent = t('preferencesSaveFailed'); }
  finally {
    savingPreference = false; $('launchChoices').disabled = false;
    renderUpdate();
    $('savePreferences').disabled = false; $('closePreferences').disabled = false;
  }
}
function topLayer() {
  if (datePicker?.isOpen()) return { consume: true, contains: target => datePicker.contains(target), close: () => datePicker.close(true) };
  if ($('themeMenu')?.open) return { consume: true, contains: target => $('themeMenu').contains(target), close: () => { $('themeMenu').open = false; $('themeToggle').setAttribute('aria-expanded', 'false'); $('themeToggle').focus({ preventScroll: true }); } };
  const dialogs = [...document.querySelectorAll('dialog[open]')].filter(node => node.id !== 'datePicker');
  const dialog = dialogs.at(-1);
  if (dialog) return { consume: true, contains: (target, event) => {
    const box = dialog.getBoundingClientRect();
    return dialog.contains(target) && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  }, close: () => {
    if ((dialog.id === 'preferencesDialog' && savingPreference) || (dialog.id === 'protectionDialog' && state.busy)) return;
    dialog.returnValue = ''; dialog.close();
  } };
  const help = document.querySelector('.search-help[open]');
  if (help) return { contains: target => help.contains(target), close: () => { help.open = false; } };
  if ($('suggestionsPanel')?.dataset.open === 'true') return { contains: target => $('query').closest('.input-wrap').contains(target), close: () => suggestions.close() };
  if ($('filters')?.open) return { contains: target => $('filters').contains(target), close: () => { $('filters').open = false; } };
  return null;
}
function setupLayerDismissal() {
  layerEvents = new AbortController();
  const listen = (target, name, fn) => target.addEventListener(name, fn, { capture: true, signal: layerEvents.signal });
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
  dismissCompletion();
  suggestions?.destroy();
  datePicker?.destroy();
  layerEvents?.abort();
  queryPlaceholder?.destroy();
  searchMotion?.destroy();
  document.documentElement.lang = state.lang; document.title = 'History Sweep';
  document.getElementById('app').innerHTML = view(t, compact, modal);
  activity.mount();
  $('themeMenu').addEventListener('toggle', syncThemeControl);
  for (const choice of $('themeChoices').querySelectorAll('[data-theme-choice]')) choice.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: choice.dataset.themeChoice }));
    $('themeMenu').open = false; syncThemeControl(); $('themeToggle').focus({ preventScroll: true });
  });
  syncThemeControl();
  $('applyUpdate').addEventListener('click', applyUpdate);
  $('dismissUpdate').addEventListener('click', () => {
    dismissedUpdate = updateState.version;
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
  datePicker = setupDatePicker({ lang: state.lang, t });
  suggestions = setupSuggestions({ input: $('query'), mode: $('mode'), panel: $('suggestionsPanel'), list: $('suggestionsList'), readHistory, onChoose: controls });
  $('query').addEventListener('input', () => { dismissCompletion(); controls(); });
  $('mode').addEventListener('change', () => { dismissCompletion(); controls(); });
  for (const id of ['timeRange', 'startDate', 'endDate']) $(id).addEventListener('change', () => { state.dateExplicit = true; dismissCompletion(); suggestions.invalidate(); controls(); });
  for (const id of ['startDate', 'endDate']) $(id).addEventListener('input', () => { state.dateExplicit = true; dismissCompletion(); suggestions.invalidate(); controls(); });
  $('editProtection').addEventListener('click', () => { $('protectionInput').value = state.protectedSites.join('\n'); $('protectionStatus').textContent = ''; $('protectionDialog').showModal(); $('protectionInput').focus(); });
  $('closeProtection').addEventListener('click', () => $('protectionDialog').close());
  $('protectionForm').addEventListener('submit', saveProtection);
  $('protectionDialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  $('currentSite')?.addEventListener('click', currentSite);
  $('openPreferences').addEventListener('click', openPreferences);
  $('closePreferences').addEventListener('click', () => $('preferencesDialog').close());
  $('preferencesForm').addEventListener('submit', savePreferences);
  $('preferencesDialog').addEventListener('cancel', event => { if (savingPreference) event.preventDefault(); });
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
  $('selectAll').addEventListener('click', () => { state.selected = allMatchesSelected() ? new Set() : new Set(state.matches.map(item => item.url)); renderRows(); });
  $('clear').addEventListener('click', () => { state.selected.clear(); renderRows(); });
  for (const [id, grouping] of [['groupByDate', 'date'], ['groupBySite', 'website']]) $(id).addEventListener('click', () => {
    if (state.grouping === grouping) return;
    state.grouping = grouping; state.groupLimit = pageSize; renderRows();
    $('resultScroll').scrollTop = 0;
  });
  $('expandGroups').addEventListener('click', () => {
    const collapse = allGroupsExpanded();
    if (state.grouping === 'date') {
      state.expandedDates = collapse ? new Set() : new Set(state.dateGroups.map(day => day.key));
      for (const day of state.dateGroups) for (const group of day.groups) {
        const key = `${day.key}:${group.key}`;
        collapse ? state.expanded.delete(key) : state.expanded.add(key);
      }
    } else state.expanded = collapse ? new Set() : new Set(state.groups.map(group => group.key));
    renderRows();
  });
  $('loadMore').addEventListener('click', () => { state.groupLimit += pageSize; renderRows(); });
  $('delete').addEventListener('click', () => openDeletionConfirm([...state.selected]));
  $('confirmDialog').addEventListener('close', () => { if ($('confirmDialog').returnValue === 'confirm') deleteConfirmed(); else state.pending = []; });
  $('openFullDialog').addEventListener('close', () => { if ($('openFullDialog').returnValue === 'confirm') launchFull(); });
  for (const id of ['openFull', 'openFullFooter']) $(id)?.addEventListener('click', openFull);
  renderRows();
}
const handoffId = new URLSearchParams(location.hash.slice(1)).get('handoff');
const modalUnavailable = location.hash === '#modalUnavailable';
// A modal retains its one-use launch ID so the worker can authenticate subsequent messages.
// Top-level routing metadata is removed before Chrome can retain a restored tab URL.
if (!modal && (location.search || location.hash)) history.replaceState(null, '', location.pathname);
mount();
document.addEventListener('history-sweep:theme-changed', syncThemeControl);
void refreshUpdate();
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, 'extensionUpdate')) void refreshUpdate();
  if (area === 'local' && Object.hasOwn(changes, 'localActivity')) activity.invalidate('cleanup');
});
// Refresh idle results, but defer while the user edits, selects or confirms a deletion.
globalThis.chrome?.history?.onVisited?.addListener(markHistoryChanged);
globalThis.chrome?.history?.onVisitRemoved?.addListener(markHistoryChanged);
globalThis.chrome?.history?.onVisited?.addListener(() => activity.invalidate('browsing'));
globalThis.chrome?.history?.onVisitRemoved?.addListener(() => activity.invalidate('browsing'));
window.addEventListener('focus', markHistoryChanged);
window.addEventListener('focus', () => activity.invalidate());
document.addEventListener('visibilitychange', () => { if (!document.hidden) markHistoryChanged(); });
document.addEventListener('close', () => queueMicrotask(scheduleHistoryRefresh), true);
watchNextDay();
// Extension-local rules load before any selection or deletion becomes available.
request({ type: 'get-protection' }).then(async data => {
  state.protectedSites = data.sites; state.rulesReady = true; status(modalUnavailable ? 'modalUnavailable' : 'ready'); controls();
  if (handoffId && !compact) {
    state.busy = true; controls();
    try {
      const handoff = await request({ type: 'claim-workspace', handoffId });
      $('query').value = handoff.query; $('mode').value = handoff.mode; state.dateExplicit = true; writeTimeDraft(handoff.filters);
      $('filters').open = handoff.filters.range !== 'all'; state.busy = false;
      await search();
    } catch { state.busy = false; status('handoffFailed'); controls(); }
  } else { await search(); if (modalUnavailable) status('modalUnavailable'); }
}).catch(error => { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'rulesUnavailable'); controls(); });
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !Object.hasOwn(changes, 'protectedSites')) return;
  // Re-read and validate the authoritative rules rather than trusting an event payload.
  state.rulesReady = false; state.pending = []; state.selected.clear(); controls();
  request({ type: 'get-protection' }).then(data => {
    state.rulesReady = true; applyProtectedSites(data.sites); controls();
  }).catch(() => { status('rulesUnavailable'); controls(); });
});
