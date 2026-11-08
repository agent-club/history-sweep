import { cleanupRecommendations } from './cleanup-recommendations.mjs';
import { addPreferenceHelp, closePreferenceHelp } from './preference-help.mjs';
import { readRecommendationSettings, RECOMMENDATION_CUE_KEY, recommendationCueDue } from './recommendation-settings.mjs';

export function createCleanupHint({ request, storage, snapshot, t, onSelect, onDelete, onSuccessFeedbackDismissed }) {
  let log;
  let hideCleanup = true;
  let settings = null;
  let version = 0;
  let privacyVersion = 0;
  let expanded = false;
  let choosing = false;
  let operation = null;
  let feedback = null;
  let failure = null;
  let feedbackTimer;
  let reasons = new Map();
  let derived;
  let remainingVersion = 0;
  let signature = '';
  let residualCount = 0;
  let sourceTypes = [];
  let explanation, explanationList;
  let explanationSignature = null;
  const remaining = new Set();
  const noticed = new Set();
  const exits = new Set();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = id => document.getElementById(id);
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const reasonText = reason => t(`cleanupReason_${reason.type}`, { days: reason.days, lookback: reason.lookback });
  const stopMotion = () => {
    for (const element of document.querySelectorAll('#cleanupHintCount, .cleanup-reason')) {
      for (const animation of element.getAnimations()) animation.cancel();
    }
    for (const animation of exits) animation.cancel();
  };
  motion.addEventListener('change', () => { if (motion.matches) stopMotion(); });

  function cue(bar, key) {
    if (!settings || motion.matches || settings.cue === 'never' || noticed.has(key)) return;
    noticed.add(key);
    const expectedSignature = signature;
    const policy = settings.cue;
    const animate = () => {
      if (motion.matches || bar.hidden || signature !== expectedSignature || settings?.cue !== policy) return;
      $('cleanupHintCount').animate([
        { opacity: .25, transform: 'perspective(180px) rotateX(-75deg)' },
        { opacity: 1, transform: 'perspective(180px) rotateX(0deg)' },
      ], { duration: 240, easing: 'cubic-bezier(.23,1,.32,1)' });
    };
    if (settings.cue === 'new') { animate(); return; }
    // Extension views share a Web Lock so two windows cannot consume the same
    // daily/weekly allowance concurrently. Only a timestamp is persisted.
    void navigator.locks.request('history-sweep-cleanup-cue', async () => {
      const saved = await storage.get(RECOMMENDATION_CUE_KEY);
      if (bar.hidden || signature !== expectedSignature || settings?.cue !== policy || motion.matches || !recommendationCueDue(policy, saved[RECOMMENDATION_CUE_KEY]?.lastAt)) return;
      await storage.set({ [RECOMMENDATION_CUE_KEY]: { lastAt: Date.now() } });
      animate();
    }).catch(() => {});
  }

  function clearFeedback() {
    clearTimeout(feedbackTimer);
    feedback = null;
    stopMotion();
  }

  async function dismissSuccess() {
    feedback = null;
    const slot = $('cleanupHintSlot');
    const success = $('cleanupHintSuccess');
    if (slot.contains(document.activeElement)) $('resultScroll').focus({ preventScroll: true });
    if (motion.matches) { slot.hidden = true; success.hidden = true; return; }
    const scroll = $('resultScroll');
    const rect = success.getBoundingClientRect();
    const parent = scroll.getBoundingClientRect();
    const followers = [$('groups'), $('table'), $('loadMore')].filter(element => !element.hidden);
    const before = followers.map(element => element.getBoundingClientRect().top);
    const ghost = success.cloneNode(true);
    ghost.removeAttribute('id'); ghost.removeAttribute('role');
    ghost.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    ghost.classList.add('cleanup-success-ghost'); ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { top: `${rect.top - parent.top + scroll.scrollTop}px`, left: `${rect.left - parent.left}px`, width: `${rect.width}px` });
    // Release the space now; the list travels across the gap while the old notice fades.
    scroll.append(ghost); slot.hidden = true; success.hidden = true;
    const options = { duration: 220, easing: 'cubic-bezier(.23,1,.32,1)' };
    const animations = [ghost.animate([{ opacity: 1 }, { opacity: 0 }], options)];
    for (let index = 0; index < followers.length; index++) {
      const distance = before[index] - followers[index].getBoundingClientRect().top;
      if (distance) animations.push(followers[index].animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], options));
    }
    animations.forEach(animation => exits.add(animation));
    // Enabling reduced motion or starting a new search may cancel a running exit.
    await Promise.allSettled(animations.map(animation => animation.finished));
    ghost.remove(); animations.forEach(animation => exits.delete(animation));
  }

  function selectionControls(state) {
    const blocked = state.busy || state.stale || Boolean(operation);
    const count = [...reasons.keys()].filter(url => state.selected.has(url)).length;
    const all = $('cleanupHintSelectAll');
    all.checked = reasons.size > 0 && count === reasons.size;
    all.indeterminate = count > 0 && count < reasons.size;
    all.disabled = blocked;
    text($('cleanupHintSelectionCount'), t('cleanupSelectionCount', { n: count, total: reasons.size }));
    $('cleanupHintBack').disabled = blocked;
    for (const checkbox of explanation.querySelectorAll('.cleanup-candidate')) {
      checkbox.checked = state.selected.has(checkbox.dataset.url);
      checkbox.disabled = blocked;
    }
    return count;
  }

  function decorate(element, items, group = false) {
    const candidates = items.filter(item => reasons.has(item.url));
    let badge = element.querySelector(':scope > .cleanup-reason');
    if (!candidates.length) { badge?.remove(); if (group) element.removeAttribute('aria-description'); return; }
    if (!badge) {
      badge = document.createElement('span'); badge.className = 'cleanup-reason';
      // Reading a reason must not toggle the existing row-selection handler.
      if (!group) badge.addEventListener('click', event => event.stopPropagation());
      element.append(badge);
    }
    const labels = [...new Set(candidates.flatMap(item => reasons.get(item.url).map(reasonText)))];
    text(badge, `${group ? `${t('cleanupGroupCount', { n: candidates.length })} · ` : ''}${labels.join(' · ')}`);
    badge.dataset.remaining = String(candidates.some(item => remaining.has(item.url)));
    if (group) {
      if (expanded) element.setAttribute('aria-description', badge.textContent);
      else element.removeAttribute('aria-description');
    }
  }

  function explain(state, visible) {
    if (!explanation) return;
    explanation.hidden = !visible || !expanded;
    if (explanation.hidden) {
      closePreferenceHelp(explanation);
      return;
    }
    for (const button of explanationList.querySelectorAll('button')) button.disabled = state.busy || Boolean(operation);
    if (explanationSignature === signature) return;
    const groups = new Map();
    for (const item of state.matches) {
      for (const type of new Set((reasons.get(item.url) || []).map(reason => reason.type))) {
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(item);
      }
    }
    const fragment = document.createDocumentFragment();
    // Reasons must remain reachable even when their history groups are not rendered yet.
    for (const [type, items] of groups) {
      const group = document.createElement('details'); group.className = 'cleanup-preview-group'; group.dataset.reason = type;
      // Keep all category headings reachable when a single category has many matches.
      group.open = groups.size === 1 || type === 'remaining';
      const heading = document.createElement('summary');
      const label = ['frequent', 'inactive'].includes(type) ? t(`cleanupPreview_${type}`) : type === 'site' ? t('cleanupSourceSites') : reasonText({ type });
      const name = document.createElement('strong'); name.textContent = label;
      const count = document.createElement('span'); count.textContent = t('cleanupGroupCount', { n: items.length });
      const arrow = document.createElement('img'); arrow.src = 'icons/ui/caret-right.svg'; arrow.alt = ''; arrow.className = 'cleanup-preview-chevron';
      heading.append(name, count, arrow); group.append(heading);
      const list = document.createElement('ul'); group.append(list);
      const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet cleanup-hint-more'; more.textContent = t('loadMore'); more.disabled = state.busy;
      let shown = 0;
      const append = () => {
        for (const item of items.slice(shown, shown + 20)) {
          const entry = document.createElement('li'); entry.className = 'cleanup-hint-item';
          const label = document.createElement('label'); label.className = 'cleanup-hint-row';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'cleanup-candidate'; checkbox.dataset.url = item.url;
          checkbox.setAttribute('aria-label', t('selectRow', { url: item.url }));
          checkbox.addEventListener('change', () => { onSelect([item.url], checkbox.checked); });
          const copy = document.createElement('span'); copy.className = 'cleanup-hint-item-copy';
          if (item.title) {
            const title = document.createElement('strong'); title.className = 'cleanup-hint-title'; title.textContent = item.title; copy.append(title);
          }
          const url = document.createElement('span'); url.className = 'cleanup-hint-url'; url.textContent = item.url; copy.append(url);
          const reason = document.createElement('span'); reason.className = 'cleanup-reason';
          reason.textContent = reasons.get(item.url).filter(reason => reason.type === type).map(reasonText).join(' · ');
          reason.dataset.remaining = String(remaining.has(item.url)); label.append(checkbox, copy, reason); entry.append(label); list.append(entry);
        }
        shown += 20; more.hidden = items.length <= shown;
        if (more.hidden && document.activeElement === more) heading.focus({ preventScroll: true });
        selectionControls(snapshot());
      };
      more.addEventListener('click', append); append(); group.append(more); fragment.append(group);
    }
    explanationList.replaceChildren(fragment);
    explanationSignature = signature;
  }

  function sync() {
    const bar = $('cleanupHint');
    if (!bar) return;
    const state = snapshot();
    const date = new Date().toDateString();
    // Selection changes reuse the same results; do not reparse up to 100,000 URLs on each click.
    if (!derived || derived.items !== state.matches || derived.protectedUrls !== state.protectedUrls || derived.log !== log || derived.hideCleanup !== hideCleanup || derived.settings !== settings || derived.protectedSites !== state.protectedSites || derived.remainingVersion !== remainingVersion || derived.date !== date) {
      const eligible = state.matches.filter(item => !state.protectedUrls.has(item.url));
      reasons = settings ? cleanupRecommendations(eligible, { log, hideCleanup, remaining, settings, protectedSites: state.protectedSites }) : new Map(eligible.filter(item => remaining.has(item.url)).map(item => [item.url, [{ type: 'remaining' }]]));
      residualCount = [...reasons.keys()].filter(url => remaining.has(url)).length;
      sourceTypes = [...new Set([...reasons.values()].flat().map(reason => reason.type))];
      signature = JSON.stringify([...reasons].sort(([a], [b]) => a.localeCompare(b)));
      derived = { items: state.matches, protectedUrls: state.protectedUrls, log, hideCleanup, settings, protectedSites: state.protectedSites, remainingVersion, date };
    }
    const residuals = residualCount;
    const complete = feedback?.kind === 'complete';
    const visible = state.scanned && !state.stale && (reasons.size > 0 || operation?.phase === 'deleting' || complete);
    if (!visible) {
      if (bar.contains(document.activeElement)) $('resultScroll').focus({ preventScroll: true });
      expanded = false; stopMotion();
    }
    $('cleanupHintSlot').hidden = !visible;
    bar.hidden = !visible || complete;
    $('cleanupHintSuccess').hidden = !visible || !complete;
    if (complete) text($('cleanupHintSuccessText'), t('cleanupCompleted', { n: feedback.removed }));
    bar.dataset.remaining = String(residuals > 0 || Boolean(failure));
    const count = operation?.phase === 'deleting' ? operation.count : reasons.size;
    text($('cleanupHintCount'), String(count));
    const summary = residuals === reasons.size && residuals > 0 ? 'cleanupRemainingCount' : 'cleanupHintCount';
    text($('cleanupHintSummary'), operation?.phase === 'deleting' ? t('cleanupCleaning') : feedback?.kind === 'partial' ? t('cleanupPartial', { n: feedback.removed, total: reasons.size }) : t(summary, { n: reasons.size }));
    const sources = [...new Set(sourceTypes.map(type => type === 'frequent' ? t('cleanupSourceLocal') : ['site', 'inactive'].includes(type) ? t('cleanupSourceSites') : reasonText({ type })))];
    text($('cleanupHintDetail'), residuals === reasons.size && residuals > 0 ? t('cleanupRemainingHint') : sources.join(' · '));
    const toggle = $('cleanupHintToggle');
    toggle.disabled = state.busy || state.stale || Boolean(operation);
    toggle.setAttribute('aria-expanded', String(expanded));
    text($('cleanupHintAction'), t(expanded ? 'cleanupHideSelection' : 'cleanupShowSelection'));
    toggle.setAttribute('aria-label', `${$('cleanupHintSummary').textContent} · ${$('cleanupHintAction').textContent}`);
    document.querySelector('.results-panel').dataset.cleanupExpanded = String(expanded);
    explain(state, visible);
    const selected = selectionControls(state);
    if (choosing && !expanded) text($('cleanupHintDetail'), t('cleanupSelectionCount', { n: selected, total: reasons.size }));
    const scope = operation ? operation.urls.length : choosing ? selected : reasons.size;
    text($('cleanupHintCleanLabel'), t(operation?.phase === 'deleting' ? 'cleanupCleaning' : choosing ? 'cleanupSelected' : 'cleanupAll'));
    text($('cleanupHintCleanCount'), t('cleanupItemCount', { n: scope }));
    $('cleanupHintClean').disabled = state.busy || state.stale || Boolean(operation) || scope === 0;
    $('cleanupHintClean').setAttribute('aria-label', t(choosing ? 'cleanupSelectedLabel' : 'cleanupAllLabel', { n: scope }));
    const note = $('cleanupHintNotice'); note.hidden = !failure;
    if (failure) text(note, t(failure.unknown ? 'cleanupUnverified' : 'cleanupFailed', { n: failure.count }));
    for (const row of $('resultScroll').querySelectorAll('.history-row')) {
      decorate(row.querySelector('.page-heading'), [{ url: row.querySelector('.row-select').dataset.url }]);
    }
    for (const group of $('resultScroll').querySelectorAll('.website-group')) decorate(group.querySelector('.group-toggle'), group.historyItems, true);
    if (!visible || state.busy || complete || operation) return;
    cue(bar, `${signature}\n${settings?.cue === 'new' ? '' : date}`);
  }

  function setSoftPrivacy(value) {
    privacyVersion++;
    // Missing preferences retain the existing default; malformed values hide cleanup details.
    hideCleanup = value !== undefined && value !== false;
    sync();
  }

  async function refresh() {
    const current = ++version;
    const privacyAtStart = ++privacyVersion;
    // Privacy must apply without waiting for optional activity or recommendation reads.
    void storage.get('softPrivacy').then(value => {
      if (privacyAtStart === privacyVersion) setSoftPrivacy(value.softPrivacy);
    }, () => { if (privacyAtStart === privacyVersion) setSoftPrivacy(null); });
    const [activity, preference] = await Promise.allSettled([request({ type: 'get-activity' }), readRecommendationSettings(storage)]);
    if (current !== version) return;
    log = activity.status === 'fulfilled' ? activity.value.log : undefined;
    const next = preference.status === 'fulfilled' ? preference.value : null;
    if (JSON.stringify(settings) !== JSON.stringify(next)) { settings = next; if (settings?.cue === 'never') stopMotion(); }
    sync();
  }

  function mount() {
    clearFeedback();
    const toggle = $('cleanupHintToggle');
    explanationSignature = null;
    explanation = document.createElement('div'); explanation.id = 'cleanupHintReasons'; explanation.className = 'cleanup-hint-reasons'; explanation.hidden = true;
    explanation.setAttribute('role', 'region'); explanation.setAttribute('aria-labelledby', 'cleanupHintSummary');
    const selection = document.createElement('div'); selection.className = 'cleanup-selection-controls';
    const label = document.createElement('label');
    const all = document.createElement('input'); all.type = 'checkbox'; all.id = 'cleanupHintSelectAll';
    const allText = document.createElement('span'); allText.textContent = t('cleanupSelectAll'); label.append(all, allText);
    const count = document.createElement('span'); count.id = 'cleanupHintSelectionCount';
    const back = document.createElement('button'); back.id = 'cleanupHintBack'; back.type = 'button'; back.textContent = t('cleanupBack');
    selection.append(label, count, back); explanation.append(selection);
    addPreferenceHelp(count, document.documentElement.lang, t('cleanupRecommendations'), t('cleanupSelectionHint'));
    all.addEventListener('change', () => onSelect([...reasons.keys()], all.checked));
    back.addEventListener('click', () => { choosing = false; expanded = false; sync(); toggle.focus({ preventScroll: true }); });
    explanationList = document.createElement('div'); explanation.append(explanationList); $('cleanupHint').append(explanation);
    toggle.setAttribute('aria-controls', explanation.id);
    toggle.addEventListener('click', () => {
      expanded = !expanded; choosing = true; stopMotion(); sync();
    });
    $('cleanupHintClean').addEventListener('click', () => {
      const state = snapshot();
      if (state.busy || state.stale || operation) return;
      const urls = [...reasons.keys()].filter(url => !choosing || state.selected.has(url));
      if (!urls.length) return;
      clearFeedback(); failure = null;
      // One intent owns confirmation and execution; cancellation releases this lock.
      operation = { phase: 'confirm', urls, count: reasons.size };
      try { if (!onDelete(urls)) operation = null; }
      catch (error) { operation = null; throw error; }
      finally { sync(); }
    });
    $('cleanupHint').addEventListener('keydown', event => {
      if (event.key === 'Escape' && expanded) {
        expanded = false; stopMotion(); sync(); toggle.focus({ preventScroll: true }); event.preventDefault(); event.stopPropagation();
      }
    });
    sync();
  }
  return {
    mount, sync, refresh, decorate, setSoftPrivacy,
    newSearch() { clearFeedback(); failure = null; operation = null; choosing = false; remaining.clear(); remainingVersion++; expanded = false; explanationSignature = null; },
    clearRemaining() { failure = null; if (remaining.size) { remaining.clear(); remainingVersion++; sync(); } },
    verified(urls) { for (const url of urls) remaining.add(url); remainingVersion++; },
    cancelDelete() {
      if (operation?.phase !== 'confirm') return;
      operation = null; sync();
      const target = $('cleanupHintClean');
      (target.hidden || target.disabled || $('cleanupHint').hidden ? $('resultScroll') : target).focus({ preventScroll: true });
    },
    deletionStarted(urls) {
      clearFeedback();
      const expected = new Set(operation?.urls);
      if (!operation || urls.length !== expected.size || !urls.every(url => expected.has(url))) return false;
      operation.phase = 'deleting'; expanded = false; return true;
    },
    deletionFinished(result) {
      operation = null; sync();
      failure = result.verified ? result.remaining.length ? { count: result.remaining.length } : null : { unknown: true };
      if (failure) { choosing = true; expanded = true; }
      if (result.removed > 0) feedback = { kind: failure || reasons.size ? 'partial' : 'complete', removed: result.removed };
      sync();
      if (feedback) feedbackTimer = setTimeout(async () => {
        if (feedback.kind === 'complete') await dismissSuccess();
        else { feedback = null; sync(); }
        // Remaining suggestions may be unselected. Only the worker's remaining URLs indicate a failed deletion.
        if (result.verified && !result.remaining.length) onSuccessFeedbackDismissed?.();
      }, 800);
    },
  };
}
