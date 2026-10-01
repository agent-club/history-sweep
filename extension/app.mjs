import { filterHistoryItems, sortByLastVisit, MAX_HISTORY_RESULTS, parseHostnames } from './history-utils.mjs';
import { readLanguage, saveLanguage, translate } from './i18n.mjs';
import { view } from './view.mjs';
import { groupHistoryItems } from './history-groups.mjs';
import { setupSuggestions, appendHighlighted } from './suggestions-ui.mjs';
import { defaultTimeFilter, resolveTimeRange, filterByTime, parseProtectedSites, isProtectedUrl } from './history-filters.mjs';
import { setupDatePicker } from './date-picker.mjs';

const compact = document.body.dataset.layout === 'popup';
const modal = document.body.dataset.presentation === 'modal';
const clientId = crypto.randomUUID();
const pageSize = compact ? 40 : 100;
const groupPreviewSize = 3;
let suggestions;
let datePicker;
let queryPlaceholder;
let completionTimer;
let completionGhosts = [];
let savingPreference = false;
let updateState = null;
let dismissedUpdate = null;
let updateApplying = false;
let updateError = false;
let updateRequest = 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function dismissCompletion() {
  clearTimeout(completionTimer);
  for (const ghost of completionGhosts) { for (const animation of ghost.getAnimations()) animation.cancel(); ghost.remove(); }
  completionGhosts = [];
  const feedback = $('completionFeedback');
  // Cancel an old fade so it cannot dismiss a newer success card.
  if (feedback) { for (const animation of feedback.getAnimations()) animation.cancel(); feedback.hidden = true; }
}
function captureRemoval(urls) {
  const retiring = new Set(urls);
  const bounds = $('resultScroll').getBoundingClientRect();
  return [...$('resultScroll').querySelectorAll('.history-row')].flatMap(row => {
    if (!retiring.has(row.querySelector('.row-select').dataset.url)) return [];
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
    const ghost = document.createElement('table'); ghost.className = 'removal-ghost';
    ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    const body = document.createElement('tbody'); const copy = row.cloneNode(true); copy.className = '';
    for (const input of copy.querySelectorAll('input')) { input.className = ''; input.removeAttribute('data-url'); input.disabled = true; }
    body.append(copy); ghost.append(body);
    Object.assign(ghost.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, clipPath: `inset(${Math.max(0, bounds.top - rect.top)}px 0 ${Math.max(0, rect.bottom - bounds.bottom)}px 0)` });
    return [ghost];
  }).slice(0, 6);
}
function showCompletion(count, retiringRows, groupPositions) {
  dismissCompletion();
  const feedback = $('completionFeedback');
  $('completionCount').textContent = num(count);
  feedback.hidden = false;
  if (!reducedMotion()) {
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
    // Keep surviving groups connected to their previous positions as the deleted group leaves.
    for (const group of $('groups').children) {
      if (!groupPositions.has(group.dataset.group)) continue;
      const offset = groupPositions.get(group.dataset.group) - group.getBoundingClientRect().top;
      if (Math.abs(offset) > .5) group.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    completionGhosts = retiringRows;
    for (const [index, ghost] of retiringRows.entries()) {
      document.body.append(ghost);
      ghost.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(18px)' }], { duration: 180, delay: index * 18, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }).finished.then(() => ghost.remove(), () => ghost.remove());
    }
  }
  completionTimer = setTimeout(() => {
    if (reducedMotion()) return dismissCompletion();
    feedback.animate([{ opacity: 1, transform: 'translate(-50%, 0) scale(1)' }, { opacity: 0, transform: 'translate(-50%, 4px) scale(.98)' }], { duration: 160, fill: 'forwards' }).finished.then(dismissCompletion, () => {});
  }, 2200);
}
const state = { lang: readLanguage(), query: '', mode: 'smart', matches: [], groups: [], urlGroups: new Map(), grouped: true, expanded: new Set(), groupShown: new Map(), groupLimit: pageSize, selected: new Set(), busy: false, scanned: false, shown: pageSize, status: ['rulesLoading', {}], pending: [], filters: defaultTimeFilter(), timeWindow: null, protectedSites: [], rulesReady: false, excluded: 0 };
const $ = (id) => document.getElementById(id);
const t = (key, args) => translate(state.lang, key, args);
const num = (n) => n.toLocaleString(state.lang);
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
    writeTimeDraft(defaultTimeFilter()); state.selected.clear();
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
  state.urlGroups = new Map(state.groups.flatMap(group => group.items.map(item => [item.url, group.key])));
  if (resetGroups) {
    state.expanded = new Set(state.groups.slice(0, 1).map(group => group.key));
    state.groupShown.clear(); state.groupLimit = pageSize; state.shown = pageSize;
  }
}

function selectGroup(group, checked) {
  // Selection includes every matching URL in the group, even when its rows are hidden.
  for (const item of group.items) checked ? state.selected.add(item.url) : state.selected.delete(item.url);
  controls();
}

function controls() {
  renderUpdate();
  // Selection belongs to the last scan, so edited criteria must not delete those older results.
  const stale = draftChanged();
  if (state.busy) suggestions?.close();
  const blocked = state.busy || !state.rulesReady || updateApplying;
  for (const id of ['query', 'mode', 'search', 'clearQuery', 'openFull', 'openFullFooter', 'timeRange', 'startDate', 'endDate', 'editProtection', 'currentSite', 'saveProtection', 'closeProtection', 'protectionInput']) if ($(id)) $(id).disabled = blocked;
  queryPlaceholder?.sync();
  $('customDates').hidden = $('timeRange').value !== 'custom';
  datePicker?.sync();
  $('query').required = $('timeRange').value === 'all';
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
  $('count').textContent = t('resultCount', { n: num(state.matches.length) });
  $('selected').textContent = `${num(state.selected.size)} ${t('selected')}`;
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
  for (const element of $('groups').children) {
    const count = selectedCounts.get(element.dataset.group) || 0;
    const total = Number(element.dataset.total);
    const check = element.querySelector('.group-select');
    check.checked = count === total;
    check.indeterminate = count > 0 && count < total;
    element.dataset.selection = count === total ? 'all' : count ? 'partial' : 'none';
    element.querySelector('.group-selected').textContent = t('siteSelected', { n: num(count) });
    for (const button of element.querySelectorAll('button')) button.disabled = state.busy;
  }
  for (const button of document.querySelectorAll('.row-delete')) button.disabled = blocked || stale;
  $('siteCount').hidden = !state.matches.length;
  $('siteCount').textContent = t('siteCount', { n: num(state.groups.length) });
  $('groupBySite').hidden = !state.matches.length; $('groupBySite').disabled = state.busy;
  $('groupBySite').setAttribute('aria-pressed', String(state.grouped));
  $('expandGroups').hidden = !state.matches.length || !state.grouped; $('expandGroups').disabled = state.busy;
  $('expandGroups').textContent = t(state.groups.every(group => state.expanded.has(group.key)) ? 'collapseAll' : 'expandAll');
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
function renderGroups() {
  const fragment = document.createDocumentFragment();
  // Bound group headers as well as each expanded group's rows for large history scans.
  for (const [index, group] of state.groups.slice(0, state.groupLimit).entries()) {
    const section = document.createElement('section'); section.className = 'website-group'; section.dataset.group = group.key; section.dataset.hostname = group.label; section.dataset.total = group.items.length;
    const header = document.createElement('div'); header.className = 'group-header';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'group-select'; checkbox.setAttribute('aria-label', t('selectSite', { site: group.label }));
    checkbox.addEventListener('change', () => selectGroup(group, checkbox.checked));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'group-toggle'; toggle.dataset.index = index;
    toggle.setAttribute('aria-label', t('toggleSite', { site: group.label })); toggle.setAttribute('aria-expanded', String(state.expanded.has(group.key))); toggle.setAttribute('aria-controls', `group-results-${index}`);
    const host = document.createElement('strong'); host.className = 'group-host'; appendHighlighted(host, group.label, state.query); host.title = group.label;
    const count = document.createElement('span'); count.className = 'group-count'; count.textContent = t('siteItems', { n: num(group.items.length) });
    const selected = document.createElement('span'); selected.className = 'group-selected';
    const chevron = document.createElement('span'); chevron.className = 'group-chevron'; chevron.textContent = '⌄'; chevron.setAttribute('aria-hidden', 'true');
    toggle.append(host, count, selected, chevron);
    toggle.addEventListener('click', () => {
      const previousHeight = section.getBoundingClientRect().height;
      state.expanded.has(group.key) ? state.expanded.delete(group.key) : state.expanded.add(group.key);
      renderRows();
      const current = $('groups').children[index];
      if (current && !reducedMotion()) {
        const height = current.getBoundingClientRect().height;
        current.animate([{ height: `${previousHeight}px` }, { height: `${height + (height - previousHeight) * .018}px`, offset: .8 }, { height: `${height}px` }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
        if (state.expanded.has(group.key)) current.querySelector('.group-results').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, delay: 35 });
      }
      current?.querySelector('.group-toggle')?.focus({ preventScroll: true });
    });
    header.append(checkbox, toggle);
    const results = document.createElement('div'); results.className = 'group-results'; results.id = `group-results-${index}`; results.hidden = !state.expanded.has(group.key);
    if (!results.hidden) {
      const table = document.createElement('table'); table.className = 'group-table'; table.setAttribute('aria-label', group.label);
      const head = $('table').tHead.cloneNode(true); const body = document.createElement('tbody');
      // A short preview keeps other website categories within reach before expanding more rows.
      const shown = state.groupShown.get(group.key) || groupPreviewSize;
      for (const item of group.items.slice(0, shown)) body.append(historyRow(item));
      table.append(head, body); results.append(table);
      if (shown < group.items.length) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet group-load-more';
        more.textContent = t('showMoreSiteItems', { n: num(Math.min(pageSize, group.items.length - shown)) });
        more.addEventListener('click', () => {
          state.groupShown.set(group.key, shown + pageSize); renderRows();
          const current = $('groups').children[index]; (current?.querySelector('.group-load-more') || current?.querySelector('.group-toggle'))?.focus({ preventScroll: true });
        });
        results.append(more);
      }
    }
    section.append(header, results); fragment.append(section);
  }
  $('groups').replaceChildren(fragment);
}
function renderRows() {
  const fragment = document.createDocumentFragment();
  if (state.grouped) renderGroups();
  else {
    $('groups').replaceChildren();
    for (const item of state.matches.slice(0, state.shown)) fragment.append(historyRow(item));
  }
  $('rows').replaceChildren(fragment);
  $('groups').hidden = !state.grouped || !state.matches.length;
  $('empty').hidden = !!state.matches.length; $('table').hidden = state.grouped || !state.matches.length;
  if (!state.matches.length && state.scanned) { $('empty').querySelector('h3').textContent = t('noneTitle'); $('empty').querySelector('p').textContent = t('noneBody'); }
  const total = state.grouped ? state.groups.length : state.matches.length;
  const shown = state.grouped ? state.groupLimit : state.shown;
  $('loadMore').hidden = shown >= total;
  $('loadMore').textContent = t(state.grouped ? 'showMoreSites' : 'loadMore');
  $('preview').hidden = total <= shown;
  $('preview').textContent = t(state.grouped ? 'groupPreview' : 'preview', { shown: num(Math.min(shown, total)), total: num(total) });
  controls();
}
async function readHistory(range = null) {
  if (!globalThis.chrome?.history?.search) throw new Error('API_UNAVAILABLE');
  return chrome.history.search({ text: '', startTime: range ? range.startTime : 0, ...(range ? { endTime: range.endTime - 1 } : {}), maxResults: MAX_HISTORY_RESULTS });
}
async function search() {
  if (state.busy || !state.rulesReady) return;
  dismissCompletion();
  const query = $('query').value.trim(); const mode = $('mode').value;
  const filters = timeDraft(); let range;
  try { range = resolveTimeRange(filters); } catch { return status('invalidTimeRange'); }
  if (!query && !range) return status('chooseQuery');
  if (query && mode.startsWith('host') && !parseHostnames(query).length) return status('invalidDomain');
  state.query = query; state.mode = mode; state.filters = filters; state.timeWindow = range;
  state.busy = true; controls(); status('scanning');
  try {
    const all = await readHistory(state.timeWindow);
    suggestions.setHistory(all);
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
  let retiringRows = [];
  let groupPositions = new Map();
  try {
    job = await request({ type: 'start-delete', urls });
    while (['deleting', 'verifying'].includes(job.phase)) {
      $('progress').value = job.completed;
      status(job.phase, { done: num(job.completed), total: num(job.total) });
      await new Promise(resolve => setTimeout(resolve, 250));
      job = await request({ type: 'delete-status', id: job.id });
    }
    if (job.phase === 'verifyFailed') return status('verifyFailed');
    const all = await readHistory(state.timeWindow);
    suggestions.setHistory(all);
    setMatches(matchesForScan(all));
    // Worker verification checks every attempted URL even when the scan hits its cap.
    // A row deletion keeps other batch choices and reselects only unverified targets.
    state.selected = new Set([...retainedSelection, ...job.remaining]);
    status(job.phase, { n: num(job.remaining.length || urls.length) });
    // Only the worker's verified success may trigger the completion effect.
    if (job.phase === 'done' && job.remaining.length === 0) {
      completedCount = urls.length;
      // Snapshot only visible rows after verification; the real results update immediately.
      if (!reducedMotion()) {
        retiringRows = captureRemoval(urls);
        groupPositions = new Map([...$('groups').children].map(group => [group.dataset.group, group.getBoundingClientRect().top]));
      }
    }
  } catch (error) { status(error.message === 'PROTECTED_URL' ? 'protectedChanged' : error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'deletionStatusFailed'); }
  finally {
    if (job && !['deleting', 'verifying'].includes(job.phase)) request({ type: 'release-delete', id: job.id }).catch(() => {});
    state.busy = false; $('progress').hidden = true; renderRows();
    if (completedCount) showCompletion(completedCount, retiringRows, groupPositions);
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
function mount() {
  dismissCompletion();
  suggestions?.destroy();
  datePicker?.destroy();
  queryPlaceholder?.destroy();
  document.documentElement.lang = state.lang; document.title = 'History Sweep';
  document.getElementById('app').innerHTML = view(t, compact, modal);
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
  writeTimeDraft(state.filters);
  datePicker = setupDatePicker({ lang: state.lang, t });
  suggestions = setupSuggestions({ input: $('query'), mode: $('mode'), panel: $('suggestionsPanel'), list: $('suggestionsList'), readHistory, onChoose: controls });
  $('query').addEventListener('input', () => { dismissCompletion(); controls(); });
  $('mode').addEventListener('change', () => { dismissCompletion(); controls(); });
  for (const id of ['timeRange', 'startDate', 'endDate']) $(id).addEventListener('change', () => { dismissCompletion(); suggestions.invalidate(); controls(); });
  for (const id of ['startDate', 'endDate']) $(id).addEventListener('input', () => { dismissCompletion(); suggestions.invalidate(); controls(); });
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
    $('query').value = ''; $('query').focus(); renderRows(); status('ready');
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
  $('groupBySite').addEventListener('click', () => { state.grouped = !state.grouped; renderRows(); });
  $('expandGroups').addEventListener('click', () => {
    state.expanded = state.groups.every(group => state.expanded.has(group.key)) ? new Set() : new Set(state.groups.map(group => group.key)); renderRows();
  });
  $('loadMore').addEventListener('click', () => { state.grouped ? state.groupLimit += pageSize : state.shown += pageSize; renderRows(); });
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
void refreshUpdate();
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'session' && Object.hasOwn(changes, 'extensionUpdate')) void refreshUpdate();
});
// Extension-local rules load before any selection or deletion becomes available.
request({ type: 'get-protection' }).then(async data => {
  state.protectedSites = data.sites; state.rulesReady = true; status(modalUnavailable ? 'modalUnavailable' : 'ready'); controls();
  if (handoffId && !compact) {
    state.busy = true; controls();
    try {
      const handoff = await request({ type: 'claim-workspace', handoffId });
      $('query').value = handoff.query; $('mode').value = handoff.mode; writeTimeDraft(handoff.filters);
      $('filters').open = handoff.filters.range !== 'all'; state.busy = false;
      if (handoff.query || handoff.filters.range !== 'all') await search(); else controls();
    } catch { state.busy = false; status('handoffFailed'); controls(); }
  }
}).catch(error => { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'rulesUnavailable'); controls(); });
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !Object.hasOwn(changes, 'protectedSites')) return;
  // Re-read and validate the authoritative rules rather than trusting an event payload.
  state.rulesReady = false; state.pending = []; state.selected.clear(); controls();
  request({ type: 'get-protection' }).then(data => {
    state.rulesReady = true; applyProtectedSites(data.sites); controls();
  }).catch(() => { status('rulesUnavailable'); controls(); });
});
