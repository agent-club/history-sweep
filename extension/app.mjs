import { filterHistoryItems, sortByLastVisit, MAX_HISTORY_RESULTS, parseHostnames } from './history-utils.mjs';
import { readLanguage, saveLanguage, translate } from './i18n.mjs';
import { view } from './view.mjs';

const compact = document.body.dataset.layout === 'popup';
const clientId = crypto.randomUUID();
const state = { lang: readLanguage(), query: '', mode: 'smart', matches: [], selected: new Set(), busy: false, scanned: false, shown: compact ? 40 : 100, status: ['ready', {}], pending: [] };
const $ = (id) => document.getElementById(id);
const t = (key, args) => translate(state.lang, key, args);
const num = (n) => n.toLocaleString(state.lang);
function status(key, args = {}) { state.status = [key, args]; $('status').dataset.kind = key; $('status').textContent = t(key, args); }
const allMatchesSelected = () => state.matches.length > 0 && state.matches.every(item => state.selected.has(item.url));
const draftChanged = () => state.scanned && ($('query').value.trim() !== state.query || $('mode').value !== state.mode);

function controls() {
  // Selection belongs to the last scan, so edited criteria must not delete those older results.
  const stale = draftChanged();
  for (const id of ['query', 'mode', 'search', 'clearQuery', 'openFull', 'openFullFooter']) if ($(id)) $(id).disabled = state.busy;
  for (const button of $('language').querySelectorAll('button')) button.disabled = state.busy;
  $('selectAll').disabled = state.busy || stale || !state.matches.length;
  $('clear').disabled = state.busy || !state.selected.size;
  $('delete').disabled = state.busy || stale || !state.selected.size;
  $('search').querySelector('span').textContent = t(stale ? 'updateResults' : 'scan');
  $('count').textContent = t('resultCount', { n: num(state.matches.length) });
  $('selected').textContent = `${num(state.selected.size)} ${t('selected')}`;
  const allSelected = allMatchesSelected();
  $('selectAllLabel').textContent = allSelected ? t('deselectAll') : t(compact ? 'selectAllCompact' : 'selectAll', { n: num(state.matches.length) });
  $('selectAll').setAttribute('aria-pressed', String(allSelected));
  $('deleteLabel').textContent = state.selected.size ? t(compact ? 'deleteCountCompact' : 'deleteCount', { n: num(state.selected.size) }) : t('delete');
  $('clearQuery').hidden = !$('query').value;
  for (const check of document.querySelectorAll('input[type=checkbox]')) check.disabled = state.busy || stale;
  const [key, args] = stale ? [state.selected.size ? 'queryChangedSelected' : 'queryChanged', {}] : state.status;
  $('status').dataset.kind = key; $('status').textContent = t(key, args);
}
function renderRows() {
  const fragment = document.createDocumentFragment();
  for (const item of state.matches.slice(0, state.shown)) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(item.url); checkbox.setAttribute('aria-label', t('selectRow', { url: item.url }));
    checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(item.url) : state.selected.delete(item.url); controls(); }); cell.append(checkbox);
    // Let users copy title or URL text without changing the row selection.
    row.addEventListener('click', event => { if (!event.target.closest('a, button, input') && !checkbox.disabled && !getSelection()?.toString()) checkbox.click(); });
    const page = document.createElement('td'); page.className = 'page-cell';
    const title = document.createElement('span'); title.className = 'page-title'; if (item.title) { title.textContent = item.title; title.title = item.title; page.append(title); }
    const url = document.createElement('span'); url.className = 'page-url'; url.textContent = item.url; url.title = item.url; page.append(url);
    const date = document.createElement('td'); date.className = 'date-column';
    if (item.lastVisitTime != null) {
      const day = document.createElement('span'); day.className = 'date-day'; day.textContent = new Intl.DateTimeFormat(state.lang, { month: 'short', day: 'numeric', ...(compact ? {} : { year: 'numeric' }) }).format(item.lastVisitTime); date.append(day);
      if (compact) { const time = document.createElement('span'); time.className = 'date-time'; time.textContent = new Intl.DateTimeFormat(state.lang, { hour: 'numeric', minute: '2-digit' }).format(item.lastVisitTime); date.append(time); }
    }
    const visits = document.createElement('td'); visits.className = 'visit-column'; if (item.visitCount != null) visits.textContent = num(item.visitCount);
    row.append(cell, page, date, visits); fragment.append(row);
  }
  $('rows').replaceChildren(fragment);
  $('empty').hidden = !!state.matches.length; $('table').hidden = !state.matches.length;
  if (!state.matches.length && state.scanned) { $('empty').querySelector('h3').textContent = t('noneTitle'); $('empty').querySelector('p').textContent = t('noneBody'); }
  $('loadMore').hidden = state.shown >= state.matches.length;
  $('preview').hidden = state.matches.length <= state.shown;
  $('preview').textContent = t('preview', { shown: num(Math.min(state.shown, state.matches.length)), total: num(state.matches.length) });
  controls();
}
async function readHistory() {
  if (!globalThis.chrome?.history?.search) throw new Error('API_UNAVAILABLE');
  return chrome.history.search({ text: '', startTime: 0, maxResults: MAX_HISTORY_RESULTS });
}
async function search() {
  if (state.busy) return;
  const query = $('query').value.trim(); const mode = $('mode').value;
  if (!query) return status('chooseQuery');
  if (mode.startsWith('host') && !parseHostnames(query).length) return status('invalidDomain');
  state.query = query; state.mode = mode;
  state.busy = true; controls(); status('scanning');
  try {
    const all = await readHistory();
    state.matches = sortByLastVisit(filterHistoryItems(all, state.query, state.mode)).filter(item => item.url);
    state.selected.clear(); state.scanned = true; state.shown = compact ? 40 : 100;
    status(all.length >= MAX_HISTORY_RESULTS ? 'limit' : 'scanned', { n: num(all.length), m: num(state.matches.length) });
  } catch (error) {
    state.matches = []; state.selected.clear(); state.scanned = true;
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
  if (!response.ok) throw new Error('BACKGROUND_REJECTED');
  return response.data;
}
async function deleteConfirmed() {
  if (state.busy || !state.pending.length) return;
  const urls = [...state.pending]; state.pending = []; state.busy = true; controls();
  $('progress').hidden = false; $('progress').max = urls.length; $('progress').value = 0;
  status('deleting', { done: 0, total: num(urls.length) });
  let job;
  try {
    job = await request({ type: 'start-delete', urls });
    while (['deleting', 'verifying'].includes(job.phase)) {
      $('progress').value = job.completed;
      status(job.phase, { done: num(job.completed), total: num(job.total) });
      await new Promise(resolve => setTimeout(resolve, 250));
      job = await request({ type: 'delete-status', id: job.id });
    }
    if (job.phase === 'verifyFailed') return status('verifyFailed');
    const all = await readHistory();
    state.matches = sortByLastVisit(filterHistoryItems(all, state.query, state.mode)).filter(item => item.url);
    // Worker verification checks every selected URL even when the scan hits its cap.
    state.selected = new Set(job.remaining);
    status(job.phase, { n: num(state.selected.size || urls.length) });
  } catch (error) { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'deletionStatusFailed'); }
  finally {
    if (job && !['deleting', 'verifying'].includes(job.phase)) request({ type: 'release-delete', id: job.id }).catch(() => {});
    state.busy = false; $('progress').hidden = true; renderRows();
  }
}
async function launchFull() {
  if (state.busy) return;
  state.busy = true; controls();
  try { await request({ type: 'open-workspace', query: $('query').value.trim(), mode: $('mode').value }); }
  catch (error) { status(error.message === 'BACKGROUND_UNAVAILABLE' ? 'reloadExtension' : 'handoffFailed'); }
  finally { state.busy = false; controls(); }
}
function openFull() {
  // The popup cannot carry its in-memory selection into the new tab.
  if (state.selected.size) $('openFullDialog').showModal();
  else launchFull();
}
function mount() {
  document.documentElement.lang = state.lang; document.title = 'History Sweep';
  document.getElementById('app').innerHTML = view(t, compact);
  $('query').value = state.query; $('mode').value = state.mode;
  $('query').addEventListener('input', controls);
  $('mode').addEventListener('change', controls);
  $('clearQuery').addEventListener('click', () => {
    state.query = ''; state.matches = []; state.selected.clear(); state.scanned = false;
    $('query').value = ''; $('query').focus(); renderRows(); status('ready');
  });
  for (const button of $('language').querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === state.lang));
    button.addEventListener('click', () => {
      if (state.busy || button.dataset.language === state.lang) return;
      const scrollTop = $('resultScroll').scrollTop;
      const draftQuery = $('query').value; const draftMode = $('mode').value;
      state.lang = button.dataset.language; saveLanguage(state.lang); mount();
      $('query').value = draftQuery; $('mode').value = draftMode; controls();
      $('resultScroll').scrollTop = scrollTop;
      $('language').querySelector(`[data-language="${state.lang}"]`).focus({ preventScroll: true });
    });
  }
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('selectAll').addEventListener('click', () => { state.selected = allMatchesSelected() ? new Set() : new Set(state.matches.map(item => item.url)); renderRows(); });
  $('clear').addEventListener('click', () => { state.selected.clear(); renderRows(); });
  $('loadMore').addEventListener('click', () => { state.shown += compact ? 40 : 100; renderRows(); });
  $('delete').addEventListener('click', () => { state.pending = [...state.selected]; $('confirmBody').textContent = t('confirmBody', { n: num(state.pending.length) }); $('confirmDialog').returnValue = ''; $('confirmDialog').showModal(); });
  $('confirmDialog').addEventListener('close', () => { if ($('confirmDialog').returnValue === 'confirm') deleteConfirmed(); else state.pending = []; });
  $('openFullDialog').addEventListener('close', () => { if ($('openFullDialog').returnValue === 'confirm') launchFull(); });
  for (const id of ['openFull', 'openFullFooter']) $(id)?.addEventListener('click', openFull);
  renderRows();
}
const handoffId = new URLSearchParams(location.hash.slice(1)).get('handoff');
// Remove transient routing metadata before Chrome can retain a restored tab URL.
if (location.search || location.hash) history.replaceState(null, '', location.pathname);
mount();
if (handoffId && !compact) {
  state.busy = true; controls();
  request({ type: 'claim-workspace', handoffId }).then(data => {
    $('query').value = data.query; $('mode').value = data.mode;
    state.busy = false;
    if (data.query) search(); else controls();
  }).catch(() => { state.busy = false; status('handoffFailed'); controls(); });
}
