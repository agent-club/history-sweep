import { readRecommendationSettings, saveRecommendationSettings, validateRecommendationSettings, recommendationDomain, RECOMMENDATION_KEY } from './recommendation-settings.mjs';
import { cleanupRecommendations } from './cleanup-recommendations.mjs';
import { recommendationSettingsView } from './recommendation-settings-view.mjs';
import { translateRecommendationSettings } from './recommendation-copy.mjs';

export function mountRecommendationSettings(root, { lang, t, storage, request, snapshot, onSaved, onProtection, onDirty, onPage = () => {}, onPagesClosed = () => {} }) {
  const tr = (key, values) => translateRecommendationSettings(lang, key, values);
  root.classList.add('auto-cleanup-root');
  root.innerHTML = recommendationSettingsView(tr);
  const nodes = new Map([...root.querySelectorAll('[id]')].map(node=>[node.id,node]));
  const $ = name => nodes.get(`recommendation-${name}`);
  // Confirming a background tab must not depend on that page being displayed.
  const confirmationHost = root.closest('#preferencesDialog');
  if(confirmationHost) confirmationHost.append($('confirm'));
  const clone = value => structuredClone(value);
  let baseline = null;
  let draft = null;
  let page = 'list';
  let editing = null;
  const editorBaselines = new Map();
  let busy = false;
  let generation = 0;
  let disposed = false;
  let pendingDiscard = null;
  let privacyVersion = 0;
  let previewLog;
  let previewHideCleanup = true;
  let previewLoaded = false;
  let statusKey = '';
  let statusDismissed = false;
  let statusHideTimer;
  let stale = false;

  function editorValue(name = page) {
    if (name === 'site') return JSON.stringify([$('domain').value, $('subdomains').value, $('days').value, root.querySelector('input[name=recommendationCondition]:checked')?.value]);
    if (name === 'habit') return JSON.stringify([$('lookback').value, $('minimum').value]);
    return '';
  }
  const editorDirty = (name = page) => editorBaselines.has(name) && editorValue(name) !== editorBaselines.get(name);
  const hasUnsavedChanges = () => Boolean(baseline && (JSON.stringify(draft) !== JSON.stringify(baseline) || [...editorBaselines.keys()].some(name => editorDirty(name))));
  const status = key => {
    if (key !== statusKey) {
      statusKey = key || '';
      statusDismissed = false;
    }
    clearTimeout(statusHideTimer);
    $('statusMessage').textContent = key ? tr(key) : '';
    $('status').dataset.error = String(['loadFailed', 'saveFailed'].includes(key));
    $('status').hidden = !key || statusDismissed;
    if (key === 'saved') {
      statusHideTimer = setTimeout(() => {
        if (statusKey === 'saved') status('');
      }, 4000);
    }
  };
  const changed = () => { status(hasUnsavedChanges() ? 'draft' : ''); onDirty(); };
  function show(name, preserveScroll = false) {
    page = name;
    for (const section of root.querySelectorAll('.auto-page')) section.hidden = section !== $(name);
    if(!preserveScroll) $(name).querySelector('.auto-scroll').scrollTop = 0;
    $(name).querySelector('h1')?.focus({ preventScroll: true });
    onPage({ id:name === 'unavailable' ? 'list' : name, section:'recommendations', title:$(name).querySelector('h1').textContent, panelId:$(name).id });
  }
  function activatePage(name) {
    if(busy) return;
    if(name === 'list' && stale && !hasUnsavedChanges()) { void enter();return; }
    show(name === 'list' && !draft ? 'unavailable' : name,true);
  }
  function closePage(name, done) {
    if(busy) return;
    if(name === 'list') { guardUnsaved(()=>{editorBaselines.clear();done(['list','site','habit','previewPage']);}); return; }
    const discard = () => { editorBaselines.delete(name); done([name]); changed(); };
    if(editorDirty(name)) confirmDiscard(discard); else discard();
  }
  function confirmDiscard(action) {
    pendingDiscard = action;
    $('confirm').showModal(); $('keep').focus();
  }
  function guardUnsaved(action) {
    if (busy) return;
    if (!hasUnsavedChanges()) { action(); return; }
    confirmDiscard(() => { draft = clone(baseline); editorBaselines.clear(); page = 'list'; render(); status(''); onDirty(); onPagesClosed(['site','habit','previewPage']); action(); });
  }
  function back() {
    if (busy) return true;
    if (page === 'list') return false;
    const name = page;
    const action = () => { editorBaselines.delete(name); onPagesClosed([name]); show('list'); changed(); };
    if (editorDirty()) confirmDiscard(action); else action();
    return true;
  }
  const habitSummary = habit => tr('habitSummary', { minimum: habit.minimumDays, lookback: habit.lookbackDays });
  function render() {
    $('habitEnabled').checked = draft.habit.enabled;
    $('habitSummary').textContent = habitSummary(draft.habit);
    for (const type of ['extension', 'application']) $(type).checked = draft.types[type];
    $('cue').value = draft.cue;
    $('siteCount').textContent = tr('ruleCount', { n: draft.sites.length });
    $('empty').hidden = draft.sites.length > 0;
    $('sites').replaceChildren();
    draft.sites.forEach((site, index) => {
      const row = document.createElement('div'); row.className = 'recommendation-row';
      const copy = document.createElement('div'); copy.className = 'recommendation-copy';
      const domain = document.createElement('strong'); domain.textContent = site.domain;
      const summary = document.createElement('p');
      summary.textContent = `${tr(site.includeSubdomains ? 'subdomains' : 'exact')} · ${tr(site.condition === 'always' ? 'alwaysSummary' : 'inactiveSummary', { days: site.days })}`;
      copy.append(domain, summary);
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'quiet'; edit.textContent = tr('edit'); edit.setAttribute('aria-label', `${tr('edit')} ${site.domain}`);
      edit.addEventListener('click', () => openSite(index));
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.className = 'recommendation-switch'; enabled.checked = site.enabled; enabled.setAttribute('aria-label', tr('enabled', { domain: site.domain }));
      enabled.addEventListener('change', () => { draft.sites[index].enabled = enabled.checked; changed(); });
      row.append(copy, edit, enabled); $('sites').append(row);
    });
  }
  async function enter() {
    if (busy || hasUnsavedChanges()) return;
    const current = ++generation; busy = true;
    for (const section of root.querySelectorAll('.auto-page')) section.hidden = true;
    $('retry').hidden = true; status('loading');
    try {
      const value = await readRecommendationSettings(storage);
      if (disposed || current !== generation) return;
      baseline = clone(value); draft = value; stale=false; editorBaselines.clear(); onPagesClosed(['site','habit','previewPage']); render(); status(''); show('list');
    } catch { if (!disposed && current === generation) { baseline = null; draft = null; status('loadFailed'); $('retry').hidden = false; show('unavailable'); } }
    finally { if (current === generation) busy = false; }
  }
  function openSite(index = null) {
    if (!draft || busy) return;
    if (index === null && draft.sites.length >= 100) { status('siteLimit'); return; }
    if(editorDirty('site')) { show('site'); return; }
    editing = index;
    const site = index === null ? null : draft.sites[index];
    $('siteTitle').textContent = tr(site ? 'editSite' : 'addSite');
    $('domain').value = site ? site.domain : '';
    $('subdomains').value = site?.includeSubdomains ? 'subdomains' : 'exact';
    $('days').value = site?.condition === 'inactive' ? site.days : 14;
    root.querySelector(`input[name=recommendationCondition][value=${site?.condition || 'inactive'}]`).checked = true;
    $('days').disabled = site?.condition === 'always';
    $('remove').hidden = index === null; $('siteError').textContent = '';
    show('site'); editorBaselines.set('site', editorValue()); $('domain').focus();
  }
  function openHabit() {
    if(editorBaselines.has('habit')) { show('habit'); return; }
    $('lookback').value = draft.habit.lookbackDays; $('minimum').value = draft.habit.minimumDays;
    $('habitError').textContent = ''; $('habitExplanation').textContent = habitSummary(draft.habit);
    show('habit'); editorBaselines.set('habit', editorValue());
  }
  function applySite(event) {
    event.preventDefault();
    try {
      const condition = root.querySelector('input[name=recommendationCondition]:checked').value;
      const site = { domain: recommendationDomain($('domain').value), includeSubdomains: $('subdomains').value === 'subdomains', condition, days: condition === 'always' ? null : Number($('days').value), enabled: editing === null ? true : draft.sites[editing].enabled };
      const next = clone(draft);
      if (editing === null) next.sites.push(site); else next.sites[editing] = site;
      draft = validateRecommendationSettings(next); editorBaselines.delete('site'); onPagesClosed(['site','previewPage']); render(); show('list'); changed();
    } catch { $('siteError').textContent = tr('invalidSite'); }
  }
  function applyHabit(event) {
    event.preventDefault();
    try {
      draft = validateRecommendationSettings({ ...draft, habit: { enabled: draft.habit.enabled, lookbackDays: Number($('lookback').value), minimumDays: Number($('minimum').value) } });
      editorBaselines.delete('habit'); onPagesClosed(['habit','previewPage']); render(); show('list'); changed();
    } catch { $('habitError').textContent = tr('invalidHabit'); }
  }
  async function save() {
    if (busy || !draft) return;
    busy = true; status('saving');
    const controls = [...root.querySelectorAll('button,input,select')].map(node => [node, node.disabled]);
    for (const [node] of controls) node.disabled = true;
    try {
      const clean = await saveRecommendationSettings(storage, draft);
      baseline = clone(clean); draft = clean;
      await onSaved(); status('saved'); onDirty();
    } catch { status('saveFailed'); }
    finally { busy = false; for (const [node, disabled] of controls) node.disabled = disabled; }
  }
  function renderPreview() {
    $('previewRows').replaceChildren(); $('previewMore').textContent = ''; $('previewNotice').textContent = '';
    if (!previewLoaded) return;
    const current = snapshot();
    if (!current.scanned || current.stale) { $('previewCount').textContent = tr('searchFirst'); return; }
    if (previewHideCleanup || !previewLog) $('previewNotice').textContent = tr('previewPartial');
    const matches = cleanupRecommendations(current.matches, { log: previewLog, hideCleanup: previewHideCleanup, settings: draft, protectedSites: current.protectedSites });
    $('previewCount').textContent = matches.size ? tr('previewCount', { n: matches.size }) : tr('noMatches');
    const items = current.matches.filter(item => matches.has(item.url));
    for (const item of items.slice(0, 20)) {
      const row = document.createElement('article'); row.className = 'recommendation-preview-row';
      if (item.title) { const title = document.createElement('strong'); title.textContent = item.title; row.append(title); }
      const url = document.createElement('p'); url.textContent = item.url; row.append(url);
      for (const reason of matches.get(item.url)) {
        const badge = document.createElement('span'); badge.className = 'cleanup-reason';
        badge.textContent = t(`cleanupReason_${reason.type}`, { days: reason.days, lookback: reason.lookback }); row.append(badge);
      }
      $('previewRows').append(row);
    }
    if (items.length > 20) $('previewMore').textContent = tr('previewMore', { shown: 20, total: items.length });
  }
  async function preview() {
    if (busy || !draft) return;
    busy = true; previewLoaded = false; previewLog = undefined; previewHideCleanup = true;
    const privacyAtStart = privacyVersion;
    show('previewPage'); $('previewCount').textContent = tr('loading'); renderPreview();
    try {
      const [activity, privacy] = await Promise.allSettled([request({ type: 'get-activity' }), storage.get('softPrivacy')]);
      if (disposed) return;
      // A newer storage event owns visibility, even when this initial read resolves later.
      if (privacyAtStart === privacyVersion) previewHideCleanup = privacy.status !== 'fulfilled' || (privacy.value.softPrivacy !== undefined && privacy.value.softPrivacy !== false);
      previewLog = activity.status === 'fulfilled' ? activity.value.log : undefined;
      previewLoaded = true;
      renderPreview();
    } finally { busy = false; }
  }
  $('retry').hidden = true;
  $('dismissStatus').addEventListener('click', () => { statusDismissed = true; $('status').hidden = true; });
  $('retry').addEventListener('click', enter);
  $('add').addEventListener('click', () => openSite());
  $('editHabit').addEventListener('click', openHabit);
  $('siteForm').addEventListener('submit', applySite); $('habitForm').addEventListener('submit', applyHabit);
  $('habitEnabled').addEventListener('change', () => { draft.habit.enabled = $('habitEnabled').checked; changed(); });
  for (const type of ['extension', 'application']) $(type).addEventListener('change', () => { draft.types[type] = $(type).checked; changed(); });
  $('cue').addEventListener('change', () => { draft.cue = $('cue').value; changed(); });
  $('siteForm').addEventListener('input', () => { $('siteError').textContent = ''; $('days').disabled = root.querySelector('input[name=recommendationCondition]:checked').value === 'always'; changed(); });
  $('habitForm').addEventListener('input', () => { $('habitError').textContent = ''; $('minimum').max = $('lookback').value; $('habitExplanation').textContent = habitSummary({ lookbackDays: $('lookback').value, minimumDays: $('minimum').value }); changed(); });
  $('remove').addEventListener('click', () => { draft.sites.splice(editing, 1); editorBaselines.delete('site'); onPagesClosed(['site','previewPage']); render(); show('list'); changed(); });
  for (const node of [...root.querySelectorAll('[data-rec-back]'), $('cancelSite'), $('cancelHabit'), $('backPreview')]) node.addEventListener('click', back);
  $('save').addEventListener('click', save); $('preview').addEventListener('click', preview);
  $('protection').addEventListener('click', () => onProtection());
  $('keep').addEventListener('click', () => $('confirm').close());
  $('discard').addEventListener('click', () => { const action = pendingDiscard; $('confirm').close(); action?.(); });
  $('confirm').addEventListener('close', () => { pendingDiscard = null; if (!root.hidden) $(page).querySelector('h1')?.focus({ preventScroll: true }); });
  const beforeUnload = event => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  const storageChanged = (changes, area) => {
    if (area !== 'local') return;
    if (Object.hasOwn(changes, 'softPrivacy')) {
      privacyVersion++;
      const value = changes.softPrivacy.newValue;
      previewHideCleanup = value !== undefined && value !== false;
      if (page === 'previewPage') renderPreview();
    }
    if (Object.hasOwn(changes, RECOMMENDATION_KEY)) {
      stale=true;
      if(!root.hidden && page === 'list' && !busy && !hasUnsavedChanges()) void enter();
    }
  };
  chrome.storage.onChanged.addListener(storageChanged);
  return { enter, activatePage, closePage, back, guardUnsaved, hasUnsavedChanges, isBusy: () => busy,
    destroy() { disposed = true; generation++; clearTimeout(statusHideTimer); if(confirmationHost)$('confirm').remove(); chrome.storage.onChanged.removeListener(storageChanged); window.removeEventListener('beforeunload', beforeUnload); },
  };
}
