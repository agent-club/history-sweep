import { filterHistoryItems, sortByLastVisit, MAX_HISTORY_RESULTS, parseHostnames } from './history-utils.mjs';
import { readLanguage, saveLanguage, translate } from './i18n.mjs';
import { view } from './view.mjs';

const compact = document.body.dataset.layout === 'popup';
const state = { lang: readLanguage(), query: '', mode: 'smart', matches: [], selected: new Set(), busy: false, scanned: false, shown: compact ? 40 : 100, status: ['ready', {}], pending: [] };
const $ = (id) => document.getElementById(id);
const t = (key, args) => translate(state.lang, key, args);
const num = (n) => n.toLocaleString(state.lang);
function status(key, args = {}) { state.status = [key, args]; $('status').dataset.kind = key; $('status').textContent = t(key, args); }

function controls() {
  for (const id of ['query', 'mode', 'search', 'clearQuery', 'openFull', 'openFullFooter']) if ($(id)) $(id).disabled = state.busy;
  for (const button of $('language').querySelectorAll('button')) button.disabled = state.busy;
  $('selectAll').disabled = state.busy || !state.matches.length;
  $('clear').disabled = state.busy || !state.selected.size;
  $('delete').disabled = state.busy || !state.selected.size;
  $('count').textContent = t('resultCount', { n: num(state.matches.length) });
  $('selected').textContent = `${num(state.selected.size)} ${t('selected')}`;
  $('selectAllLabel').textContent = t(compact ? 'selectAllCompact' : 'selectAll', { n: num(state.matches.length) });
  $('deleteLabel').textContent = state.selected.size ? t(compact ? 'deleteCountCompact' : 'deleteCount', { n: num(state.selected.size) }) : t('delete');
  $('clearQuery').hidden = !$('query').value;
  for (const check of document.querySelectorAll('input[type=checkbox]')) check.disabled = state.busy;
}
function renderRows() {
  const fragment = document.createDocumentFragment();
  for (const item of state.matches.slice(0, state.shown)) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(item.url); checkbox.setAttribute('aria-label', t('selectRow', { url: item.url }));
    checkbox.addEventListener('change', () => { checkbox.checked ? state.selected.add(item.url) : state.selected.delete(item.url); controls(); }); cell.append(checkbox);
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
  state.query = $('query').value.trim(); state.mode = $('mode').value;
  if (!state.query) return status('chooseQuery');
  if (state.mode.startsWith('host') && !parseHostnames(state.query).length) return status('invalidDomain');
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
async function remove(url) {
  for (let attempt = 0; attempt < 3; attempt++) { try { await chrome.history.deleteUrl({ url }); return; } catch {} }
}
async function deleteConfirmed() {
  if (state.busy || !state.pending.length) return;
  const urls = [...state.pending]; state.pending = []; state.busy = true; controls();
  $('progress').hidden = false; $('progress').max = urls.length; $('progress').value = 0;
  let cursor = 0; let completed = 0;
  status('deleting', { done: 0, total: num(urls.length) });
  await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
    while (cursor < urls.length) { const url = urls[cursor++]; await remove(url); completed++; $('progress').value = completed; status('deleting', { done: num(completed), total: num(urls.length) }); }
  }));
  status('verifying');
  try {
    const all = await readHistory();
    state.matches = sortByLastVisit(filterHistoryItems(all, state.query, state.mode)).filter(item => item.url);
    // Per-URL verification avoids falsely reporting success when the scan hits its cap.
    const remaining = new Set(); let verifyCursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
      while (verifyCursor < urls.length) { const url = urls[verifyCursor++]; if ((await chrome.history.getVisits({ url })).length) remaining.add(url); }
    }));
    state.selected = remaining;
    status(remaining.size ? 'partial' : 'done', { n: num(remaining.size || urls.length) });
  } catch { status('verifyFailed'); }
  finally { state.busy = false; $('progress').hidden = true; renderRows(); }
}
function openFull() {
  const params = new URLSearchParams({ q: $('query').value.trim(), mode: $('mode').value });
  chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?${params}`) });
}
function mount() {
  document.documentElement.lang = state.lang; document.title = 'History Sweep';
  document.getElementById('app').innerHTML = view(t, compact);
  $('query').value = state.query; $('mode').value = state.mode;
  $('query').addEventListener('input', () => { $('clearQuery').hidden = !$('query').value; });
  $('clearQuery').addEventListener('click', () => {
    state.query = ''; state.matches = []; state.selected.clear(); state.scanned = false;
    $('query').value = ''; $('query').focus(); renderRows(); status('ready');
  });
  for (const button of $('language').querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === state.lang));
    button.addEventListener('click', () => {
      if (state.busy || button.dataset.language === state.lang) return;
      const scrollTop = $('resultScroll').scrollTop;
      state.query = $('query').value; state.mode = $('mode').value;
      state.lang = button.dataset.language; saveLanguage(state.lang); mount();
      $('resultScroll').scrollTop = scrollTop;
      $('language').querySelector(`[data-language="${state.lang}"]`).focus({ preventScroll: true });
    });
  }
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('selectAll').addEventListener('click', () => { state.selected = new Set(state.matches.map(item => item.url)); renderRows(); });
  $('clear').addEventListener('click', () => { state.selected.clear(); renderRows(); });
  $('loadMore').addEventListener('click', () => { state.shown += compact ? 40 : 100; renderRows(); });
  $('delete').addEventListener('click', () => { state.pending = [...state.selected]; $('confirmBody').textContent = t('confirmBody', { n: num(state.pending.length) }); $('confirmDialog').returnValue = ''; $('confirmDialog').showModal(); });
  $('confirmDialog').addEventListener('close', () => { if ($('confirmDialog').returnValue === 'confirm') deleteConfirmed(); else state.pending = []; });
  for (const id of ['openFull', 'openFullFooter']) $(id)?.addEventListener('click', openFull);
  renderRows(); status(...state.status);
}
const params = new URLSearchParams(location.search);
state.query = params.get('q') || '';
if (['smart', 'host-subdomains', 'host-exact', 'contains'].includes(params.get('mode'))) state.mode = params.get('mode');
mount();
if (state.query) search();
