import { cleanupRecommendations } from './cleanup-recommendations.mjs';
import { readRecommendationSettings, RECOMMENDATION_CUE_KEY, recommendationCueDue } from './recommendation-settings.mjs';

export function createCleanupHint({ request, storage, snapshot, t }) {
  let log;
  let hideCleanup = true;
  let settings = null;
  let version = 0;
  let privacyVersion = 0;
  let expanded = false;
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
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = id => document.getElementById(id);
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const reasonText = reason => t(`cleanupReason_${reason.type}`, { days: reason.days, lookback: reason.lookback });
  const stopMotion = () => {
    for (const element of document.querySelectorAll('#cleanupHint, .cleanup-reason')) {
      for (const animation of element.getAnimations()) animation.cancel();
    }
  };
  motion.addEventListener('change', () => { if (motion.matches) stopMotion(); });

  function cue(bar, key) {
    if (!settings || motion.matches || settings.cue === 'never' || noticed.has(key)) return;
    noticed.add(key);
    const expectedSignature = signature;
    const policy = settings.cue;
    const animate = () => {
      if (motion.matches || bar.hidden || signature !== expectedSignature || settings?.cue !== policy) return;
      bar.animate([
        { opacity: .55, transform: 'translateY(-3px)', boxShadow: 'inset 0 0 0 1px var(--cleanup-cue)' },
        { opacity: 1, transform: 'none', boxShadow: 'inset 0 0 0 1px transparent' },
      ], { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)' });
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
    if (explanation.hidden) return;
    for (const button of explanationList.querySelectorAll('button')) button.disabled = state.busy;
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
      group.open = groups.size === 1;
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
          if (item.title) {
            const title = document.createElement('strong'); title.className = 'cleanup-hint-title'; title.textContent = item.title; entry.append(title);
          }
          const url = document.createElement('span'); url.className = 'cleanup-hint-url'; url.textContent = item.url; entry.append(url);
          const reason = document.createElement('span'); reason.className = 'cleanup-reason';
          reason.textContent = reasons.get(item.url).filter(reason => reason.type === type).map(reasonText).join(' · ');
          reason.dataset.remaining = String(remaining.has(item.url)); entry.append(reason); list.append(entry);
        }
        shown += 20; more.hidden = items.length <= shown;
        if (more.hidden && document.activeElement === more) heading.focus({ preventScroll: true });
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
    if (!derived || derived.items !== state.matches || derived.log !== log || derived.hideCleanup !== hideCleanup || derived.settings !== settings || derived.protectedSites !== state.protectedSites || derived.remainingVersion !== remainingVersion || derived.date !== date) {
      reasons = settings ? cleanupRecommendations(state.matches, { log, hideCleanup, remaining, settings, protectedSites: state.protectedSites }) : new Map(state.matches.filter(item => remaining.has(item.url)).map(item => [item.url, [{ type: 'remaining' }]]));
      if ([...reasons.keys()].some(url => remaining.has(url))) reasons = new Map([...reasons].filter(([url]) => remaining.has(url)));
      residualCount = [...reasons.keys()].filter(url => remaining.has(url)).length;
      sourceTypes = [...new Set([...reasons.values()].flat().map(reason => reason.type))];
      signature = JSON.stringify([...reasons].sort(([a], [b]) => a.localeCompare(b)));
      derived = { items: state.matches, log, hideCleanup, settings, protectedSites: state.protectedSites, remainingVersion, date };
    }
    const residuals = residualCount;
    const visible = state.scanned && !state.stale && reasons.size > 0;
    if (!visible) {
      if (bar.contains(document.activeElement)) $('resultScroll').focus({ preventScroll: true });
      expanded = false; stopMotion();
    }
    bar.hidden = !visible;
    bar.dataset.remaining = String(residuals > 0);
    text($('cleanupHintCount'), String(reasons.size));
    const summary = residuals ? 'cleanupRemainingCount' : 'cleanupHintCount';
    text($('cleanupHintSummary'), t(summary, { n: residuals || reasons.size }));
    const sources = [...new Set(sourceTypes.map(type => type === 'frequent' ? t('cleanupSourceLocal') : ['site', 'inactive'].includes(type) ? t('cleanupSourceSites') : reasonText({ type })))];
    text($('cleanupHintDetail'), residuals ? t('cleanupRemainingHint') : sources.join(' · '));
    const toggle = $('cleanupHintToggle');
    toggle.disabled = state.busy;
    toggle.setAttribute('aria-expanded', String(expanded));
    text($('cleanupHintAction'), t(expanded ? 'cleanupHideReasons' : 'cleanupShowReasons'));
    toggle.setAttribute('aria-label', `${$('cleanupHintSummary').textContent} · ${$('cleanupHintAction').textContent}`);
    document.querySelector('.results-panel').dataset.cleanupExpanded = String(expanded);
    explain(state, visible);
    for (const row of $('resultScroll').querySelectorAll('.history-row')) {
      decorate(row.querySelector('.page-heading'), [{ url: row.querySelector('.row-select').dataset.url }]);
    }
    for (const group of $('resultScroll').querySelectorAll('.website-group')) decorate(group.querySelector('.group-toggle'), group.historyItems, true);
    if (!visible || state.busy) return;
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
    const toggle = $('cleanupHintToggle');
    explanationSignature = null;
    explanation = document.createElement('div'); explanation.id = 'cleanupHintReasons'; explanation.className = 'cleanup-hint-reasons'; explanation.hidden = true;
    explanation.setAttribute('role', 'region'); explanation.setAttribute('aria-labelledby', 'cleanupHintSummary');
    const hint = document.createElement('p'); hint.className = 'wt-note'; hint.textContent = t('cleanupPreviewHint'); explanation.append(hint);
    explanationList = document.createElement('div'); explanation.append(explanationList); $('cleanupHint').append(explanation);
    toggle.setAttribute('aria-controls', explanation.id);
    toggle.addEventListener('click', () => {
      expanded = !expanded; stopMotion(); sync();
      if (expanded && !motion.matches && settings?.cue !== 'never') {
        document.querySelectorAll('.cleanup-reason').forEach((badge, index) => badge.animate(
          [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, delay: Math.min(index, 6) * 35, fill: 'backwards', easing: 'ease-out' },
        ));
      }
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
    newSearch() { remaining.clear(); remainingVersion++; expanded = false; explanationSignature = null; },
    clearRemaining() { if (remaining.size) { remaining.clear(); remainingVersion++; sync(); } },
    verified(urls) { for (const url of urls) remaining.add(url); remainingVersion++; },
  };
}
