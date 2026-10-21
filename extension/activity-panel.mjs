import { activityCalendar, browsingActivityAsync, activitySummary } from './activity-calendar.mjs';
import { parseDate } from './calendar-dates.mjs';
import { MAX_HISTORY_RESULTS } from './history-utils.mjs';

export function createActivityPanel({ compact, request, readHistory, t, language }) {
  let opened = false;
  try { opened = localStorage.getItem('activityOpen') === 'true'; } catch {}
  let mode = 'browsing', range = compact ? 'quarter' : 'year', year = new Date().getFullYear();
  let cleanup = null, browsing = null, selected = null, events, root, loading = false, failure = false, ticket = 0, refreshTimer;
  let collapseAnimation = null, tooltipTimer, tooltipHideTimer;
  let scrollHintTimer, scrollHintPending = opened, scrollHintTicket = 0;
  let renderedRoot, renderedData, renderedKey, detailRoot, detailData, detailDate;
  const dirty = new Set();
  const $ = id => root.querySelector(`#${id}`);
  const number = value => value.toLocaleString(language());
  const dateLabel = value => new Intl.DateTimeFormat(language(), { year: 'numeric', month: 'long', day: 'numeric' }).format(parseDate(value));
  const days = () => mode === 'cleanup' ? cleanup?.log.days : browsing?.days;
  const earliestYear = () => mode === 'cleanup'
    ? cleanup ? Number(cleanup.log.startedOn.slice(0, 4)) : year
    : browsing ? Math.min(new Date().getFullYear(), ...Object.keys(browsing.days).map(date => Number(date.slice(0, 4)))) : year;
  function hideScrollHint() {
    scrollHintTicket++;
    clearTimeout(scrollHintTimer);
    const hint = root?.querySelector('#activityScrollHint');
    if (hint) hint.hidden = true;
  }
  function scheduleScrollHint() {
    if (!scrollHintPending || loading || failure) return;
    scrollHintPending = false;
    const current = ++scrollHintTicket;
    scrollHintTimer = setTimeout(async () => {
      if (!opened || !root.isConnected) return;
      if (loading || failure) { scrollHintPending = true; return; }
      let allowed;
      try { allowed = await request({ type: 'claim-activity-scroll-hint' }); } catch { return; }
      if (!allowed?.show || current !== scrollHintTicket || !opened || !root.isConnected) return;
      const hint = $('activityScrollHint');
      hint.style.setProperty('--activity-legend-width', `${root.querySelector('.activity-legend').offsetWidth}px`);
      hint.hidden = false;
      // Match the selected concept: entrance, gesture and exit share one 1.2 s lifetime.
      scrollHintTimer = setTimeout(() => { hint.hidden = true; }, 1200);
    }, 300);
  }
  function detail(date) {
    const day = days()?.[date];
    return mode === 'cleanup'
      ? t(day?.websitesComplete ? 'activityDayCleanupSites' : 'activityDayCleanup', { operations: number(day ? day.operations : 0), pages: number(day ? day.pages : 0), sites: number(day?.websites?.length || 0) })
      : t('activityDayBrowsing', { pages: number(day ? day.pages : 0), sites: number(day ? day.sites.size : 0) });
  }
  function hideTooltip(immediate = false) {
    clearTimeout(tooltipTimer); clearTimeout(tooltipHideTimer);
    const tip = $('activityTooltip');
    tip.dataset.open = 'false';
    root.querySelector('[aria-describedby="activityTooltip"]')?.removeAttribute('aria-describedby');
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) tip.hidden = true;
    else tooltipHideTimer = setTimeout(() => { tip.hidden = true; }, 120);
  }
  function showTooltip(anchor, title, description, immediate = false) {
    clearTimeout(tooltipTimer); clearTimeout(tooltipHideTimer);
    const tip = $('activityTooltip');
    const show = () => {
      if (!anchor.isConnected || !opened) return;
      root.querySelector('[aria-describedby="activityTooltip"]')?.removeAttribute('aria-describedby');
      const heading = document.createElement('strong'); heading.textContent = title;
      tip.replaceChildren(heading);
      if (description) { const body = document.createElement('span'); body.textContent = description; tip.append(body); }
      tip.hidden = false; anchor.setAttribute('aria-describedby', 'activityTooltip');
      const bounds = root.getBoundingClientRect(); const cell = anchor.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(cell.left - bounds.left + cell.width / 2 - tip.offsetWidth / 2, bounds.width - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(4, cell.top - bounds.top - tip.offsetHeight - 9)}px`;
      // Resolve the hidden frame before revealing, including the first hover.
      tip.getBoundingClientRect(); tip.dataset.open = 'true';
    };
    if (immediate || !tip.hidden) show();
    else tooltipTimer = setTimeout(show, 100);
  }
  function renderSites(date) {
    const day = days()?.[date];
    const sites = day?.websites || [];
    const strip = $('activitySites'); strip.replaceChildren(); strip.hidden = !sites.length;
    $('activitySiteOrder').hidden = !sites.length;
    $('activitySiteNotice').textContent = mode === 'cleanup' && day?.pages > 0 && !day.websitesComplete ? t('activitySitesIncomplete') : '';
    for (const site of sites) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'activity-site';
      button.dataset.domain = site.domain;
      button.setAttribute('aria-label', site.title ? `${site.domain} · ${site.title}` : site.domain);
      const favicon = document.createElement('img'); favicon.alt = ''; favicon.width = 20; favicon.height = 20; favicon.hidden = true;
      favicon.addEventListener('load', () => { favicon.hidden = false; }, { once: true });
      favicon.addEventListener('error', () => { button.remove(); if (!strip.childElementCount) strip.hidden = true; }, { once: true });
      // Domain-only lookup uses Chrome's local favicon cache, including for removed pages.
      const source = new URL(chrome.runtime.getURL('_favicon/')); source.searchParams.set('pageUrl', `https://${site.domain}/`); source.searchParams.set('size', '32');
      favicon.src = source.href; button.append(favicon);
      button.addEventListener('pointerenter', () => showTooltip(button, site.domain, site.title));
      button.addEventListener('focus', () => showTooltip(button, site.domain, site.title, true));
      button.addEventListener('pointerleave', () => hideTooltip()); button.addEventListener('blur', () => hideTooltip());
      button.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
      strip.append(button);
    }
  }
  function collapse() {
    if (!opened) return;
    opened = false;
    scrollHintPending = false; hideScrollHint();
    try { localStorage.setItem('activityOpen', 'false'); } catch {}
    hideTooltip();
    const toggle = document.getElementById('toggleActivity');
    if (root.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    const shell = root.closest('.app-shell');
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const style = getComputedStyle(root);
      root.inert = true;
      const animation = root.animate([
        { height: `${root.getBoundingClientRect().height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: style.marginBottom, opacity: 1, overflow: 'hidden' },
        { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', opacity: 0, overflow: 'hidden' },
      ], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      collapseAnimation = animation;
      animation.finished.then(() => {
        if (collapseAnimation !== animation) return;
        collapseAnimation = null; animation.cancel(); root.inert = false;
        render(); shell.scrollTop = 0;
      }, () => {});
    }
    render();
    if (!collapseAnimation) shell.scrollTop = 0;
  }
  function showDay(button, tooltip = true, pin = false) {
    const date = button.dataset.date;
    if (pin) selected = date;
    for (const cell of root.querySelectorAll('.activity-day')) {
      cell.setAttribute('aria-pressed', String(cell.dataset.date === selected)); cell.tabIndex = cell.dataset.date === selected ? 0 : -1;
    }
    if (detailRoot !== root || detailData !== days() || detailDate !== date) {
      $('activityDate').textContent = dateLabel(date);
      $('activityDetail').textContent = detail(date);
      renderSites(date);
      detailRoot = root; detailData = days(); detailDate = date;
    }
    if (!tooltip) return;
    showTooltip(button, dateLabel(date), detail(date), true);
  }
  function render() {
    if (!root?.isConnected) return;
    root.hidden = !opened && !collapseAnimation;
    const toggle = document.getElementById('toggleActivity');
    toggle.setAttribute('aria-expanded', String(opened)); toggle.setAttribute('aria-pressed', String(opened));
    if (!opened) return;
    root.setAttribute('aria-busy', String(loading));
    $('activityYear').textContent = String(year);
    $('activityPreviousYear').disabled = (loading && !days()) || year <= earliestYear();
    $('activityNextYear').disabled = (loading && !days()) || year >= new Date().getFullYear();
    for (const button of root.querySelectorAll('[data-activity-mode]')) button.setAttribute('aria-pressed', String(button.dataset.activityMode === mode));
    for (const button of root.querySelectorAll('[data-activity-range]')) button.setAttribute('aria-pressed', String(button.dataset.activityRange === range));
    $('activityNotice').textContent = loading ? t('activityLoading') : failure ? t('activityLoadFailed') : '';
    $('activityNotice').classList.toggle('sr-only', loading);
    $('activityRetry').hidden = !failure;
    $('activityContent').hidden = failure;
    const data = days();
    const skeleton = !data;
    root.dataset.loading = String(skeleton && !failure);
    if (failure) { hideTooltip(true); renderedData = null; return; }
    scheduleScrollHint();
    const key = `${mode}:${year}:${range}:${language()}:${new Date().toDateString()}`;
    // Retain the chart and favicon nodes on reopen and while refreshing cached data.
    if (data && renderedRoot === root && renderedData === data && renderedKey === key) return;
    hideTooltip(true);
    renderedRoot = root; renderedData = data; renderedKey = key;
    const calendar = activityCalendar(year, range);
    const summary = data ? activitySummary(data, calendar.start, calendar.end, calendar.today) : {};

    const metrics = mode === 'cleanup'
      ? [[summary.operations, 'activityOperations'], [summary.pages, 'activityPages'], [summary.activeDays, 'activityActiveDays']]
      : [[summary.pages, 'activityHistoryPages'], [summary.sites, 'activitySites'], [summary.activeDays, 'activityHistoryDays']];
    $('activityStats').replaceChildren(...metrics.map(([value, key]) => {
      const item = document.createElement('span'); const count = document.createElement('strong'); count.textContent = skeleton ? '\u00a0' : number(value);
      item.append(count, document.createTextNode(t(key))); return item;
    }));
    const subtitle = skeleton ? '' : mode === 'cleanup'
      ? t('activitySince', { date: dateLabel(cleanup.log.startedOn) }) : t('activityHistoryHint');
    $('activitySubtitle').textContent = subtitle;
    $('activityScope').textContent = skeleton ? '' : mode === 'cleanup'
      ? t(cleanup.recordingFailed ? 'activityRecordingFailed' : 'activityVerifiedHint')
      : browsing.limited ? t('activityLimited') : t('activityLocalOnly');
    const grid = $('activityGrid'); grid.replaceChildren(); grid.style.setProperty('--activity-weeks', calendar.weeks); grid.dataset.range = range;
    for (const month of calendar.months) {
      const label = document.createElement('span'); label.className = 'activity-month';
      label.textContent = new Intl.DateTimeFormat(language(), { month: 'short' }).format(new Date(year, month.month, 1));
      label.style.gridColumn = month.column + 2; label.style.gridRow = 1; grid.append(label);
    }
    for (const weekday of [0, 2, 4, 6]) {
      const label = document.createElement('span'); label.className = 'activity-weekday';
      label.textContent = new Intl.DateTimeFormat(language(), { weekday: 'short' }).format(new Date(2026, 9, 12 + weekday));
      label.style.gridColumn = 1; label.style.gridRow = weekday + 2; grid.append(label);
    }
    const values = calendar.cells.map(cell => cell && !cell.future && data?.[cell.date] ? (mode === 'cleanup' ? data[cell.date].operations : data[cell.date].pages) : 0);
    const max = Math.max(1, ...values);
    const buttons = [];
    for (const [index, cell] of calendar.cells.entries()) {
      if (!cell) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'activity-day'; button.dataset.date = cell.date;
      button.style.gridColumn = Math.floor(index / 7) + 2; button.style.gridRow = index % 7 + 2;
      const beforeStart = Boolean(mode === 'cleanup' && cleanup && cell.date < cleanup.log.startedOn);
      button.disabled = skeleton || cell.future || beforeStart; button.tabIndex = -1;
      button.dataset.level = values[index] === 0 ? '0' : String(Math.ceil(values[index] / max * 4));
      button.dataset.today = String(cell.date === calendar.today);
      button.dataset.unavailable = String(cell.future || beforeStart);
      const caption = skeleton ? t('activityLoading') : cell.future ? t('activityFuture') : beforeStart ? t('activityBeforeStart') : detail(cell.date);
      button.setAttribute('aria-label', `${dateLabel(cell.date)} · ${caption}${cell.date === calendar.today ? ` · ${t('calendarToday')}` : ''}`);
      button.setAttribute('aria-pressed', 'false'); grid.append(button);
      if (!button.disabled) buttons.push(button);
    }
    const focused = buttons.find(button => button.dataset.date === selected) || buttons.find(button => button.dataset.today === 'true') || buttons.at(-1);
    $('activityDayDetail').hidden = !focused && !skeleton;
    if (skeleton) {
      detailDate = null;
      $('activityDate').textContent = ''; $('activityDetail').textContent = '';
      $('activitySites').replaceChildren(); $('activitySites').hidden = true;
      $('activitySiteOrder').hidden = true; $('activitySiteNotice').textContent = '';
    }
    if (focused) showDay(focused, false, true);
    const scrollAnchor = focused || grid.querySelector('[data-today=true]') || [...grid.querySelectorAll('[data-unavailable=false]')].at(-1);
    if (scrollAnchor) {
      // Align placeholders with the loaded chart on narrow surfaces too.
      const viewport = grid.parentElement;
      const bounds = viewport.getBoundingClientRect(); const cell = scrollAnchor.getBoundingClientRect();
      if (cell.left < bounds.left || cell.right > bounds.right) viewport.scrollLeft += cell.left - bounds.left - (viewport.clientWidth - cell.width) / 2;
    }
    $('activityEmpty').textContent = !skeleton && summary.activeDays === 0 ? t(mode === 'cleanup' ? 'activityEmptyCleanup' : 'activityEmptyBrowsing') : '';
    hideTooltip();
  }
  async function load() {
    if (!opened) return;
    const current = ++ticket; const source = mode;
    loading = true; failure = false; render();
    try {
      let data;
      if (source === 'cleanup') data = await request({ type: 'get-activity' });
      else {
        const items = await readHistory();
        const days = await browsingActivityAsync(items, () => current === ticket);
        data = { days, limited: items.length >= MAX_HISTORY_RESULTS };
      }
      if (current !== ticket) return;
      const previous = source === 'cleanup' ? cleanup : browsing;
      const serialize = (key, value) => value instanceof Set ? [...value].sort() : value;
      // An unchanged refresh must retain selected cells, decoded favicons and focus.
      if (JSON.stringify(previous, serialize) !== JSON.stringify(data, serialize)) {
        if (source === 'cleanup') cleanup = data; else browsing = data;
      }
      dirty.delete(source);
      year = Math.max(earliestYear(), Math.min(year, new Date().getFullYear()));
    } catch { if (current === ticket) failure = true; }
    finally { if (current === ticket) { loading = false; render(); } }
  }
  function invalidate(source) {
    if (!source || source === 'cleanup') dirty.add('cleanup');
    if (!source || source === 'browsing') dirty.add('browsing');
    if (opened && (!source || source === mode)) {
      // One bulk cleanup can emit a history event per URL. Coalesce those reads.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (!source || source === mode) void load(); }, 200);
    }
  }
  return {
    invalidate,
    async refreshCleanup() {
      clearTimeout(refreshTimer);
      const showingCleanup = opened && mode === 'cleanup';
      const current = showingCleanup ? ++ticket : null;
      if (showingCleanup) { loading = true; failure = false; render(); }
      dirty.add('browsing');
      try {
        // Read after the worker's commit. This path must not depend on onChanged delivery.
        const data = await request({ type: 'get-activity' });
        if (data?.log?.version !== 1 || typeof data.recordingFailed !== 'boolean') throw new Error('ACTIVITY_UNAVAILABLE');
        cleanup = data; dirty.delete('cleanup');
        if (mode === 'cleanup' && (!showingCleanup || current === ticket)) {
          failure = false;
          const now = new Date(); year = now.getFullYear();
          selected = null;
        }
        return !cleanup.recordingFailed;
      } catch {
        cleanup = null;
        if (showingCleanup && current === ticket) failure = true;
        return false;
      } finally {
        if (showingCleanup && current === ticket) { loading = false; render(); }
        if (opened && mode === 'browsing') void load();
      }
    },
    mount() {
      hideScrollHint(); scrollHintPending = opened;
      collapseAnimation?.cancel(); collapseAnimation = null;
      clearTimeout(tooltipTimer); clearTimeout(tooltipHideTimer);
      events?.abort(); events = new AbortController(); root = document.getElementById('activityPanel');
      const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: events.signal });
      listen(document.getElementById('toggleActivity'), 'click', () => {
        if (opened) return collapse();
        collapseAnimation?.cancel(); collapseAnimation = null; root.inert = false;
        opened = true;
        scrollHintPending = true;
        try { localStorage.setItem('activityOpen', 'true'); } catch {}
        if (!days() || dirty.has(mode)) void load(); else render();
      });
      const shell = root.closest('.app-shell');
      listen(shell, 'wheel', event => {
        // Wrapped website rows may extend below a compact viewport; let users reach them.
        if (!event.target.closest('#activitySites') && !event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) collapse();
      }, { passive: false });
      let touch = null;
      listen(shell, 'touchstart', event => {
        touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, sites: Boolean(event.target.closest('#activitySites')) } : null;
      }, { passive: true });
      listen(shell, 'touchmove', event => {
        if (!touch || event.touches.length !== 1) { touch = null; return; }
        const dx = event.touches[0].clientX - touch.x, dy = event.touches[0].clientY - touch.y;
        if (!touch.sites && Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx)) { collapse(); touch = null; }
      }, { passive: true });
      listen(shell, 'touchend', () => { touch = null; }, { passive: true });
      listen(shell, 'touchcancel', () => { touch = null; }, { passive: true });
      for (const button of root.querySelectorAll('[data-activity-mode]')) listen(button, 'click', () => {
        if (mode === button.dataset.activityMode) return;
        mode = button.dataset.activityMode; selected = null; failure = false; ticket++; loading = false;
        year = new Date().getFullYear();
        if (!days() || dirty.has(mode)) void load(); else render();
      });
      for (const button of root.querySelectorAll('[data-activity-range]')) listen(button, 'click', () => {
        if (range === button.dataset.activityRange) return;
        range = button.dataset.activityRange; selected = null; render();
      });
      for (const [id, change] of [['activityPreviousYear', -1], ['activityNextYear', 1]]) listen($(id), 'click', () => { year += change; selected = null; render(); });
      listen($('activityRetry'), 'click', () => { void load(); });
      listen($('activityGrid'), 'pointerover', event => {
        const cell = event.target.closest('.activity-day:not(:disabled)');
        if (cell && !cell.contains(event.relatedTarget)) showTooltip(cell, dateLabel(cell.dataset.date), detail(cell.dataset.date));
        else if (!cell) hideTooltip();
      });
      listen($('activityGrid'), 'pointerleave', () => hideTooltip());
      listen($('activityGrid').parentElement, 'scroll', () => hideTooltip(true));
      listen($('activityGrid'), 'focusin', event => { if (event.target.matches('.activity-day:not(:disabled)')) showDay(event.target, true, true); });
      listen($('activityGrid'), 'focusout', () => hideTooltip());
      listen($('activityGrid'), 'click', event => { const cell = event.target.closest('.activity-day:not(:disabled)'); if (cell) showDay(cell, true, true); });
      listen($('activityGrid'), 'keydown', event => {
        if (!event.target.matches('.activity-day')) return;
        const buttons = [...root.querySelectorAll('.activity-day:not(:disabled)')];
        const index = buttons.indexOf(event.target);
        const change = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : change === undefined ? null : Math.max(0, Math.min(buttons.length - 1, index + change));
        if (target !== null) { event.preventDefault(); buttons[target]?.focus({ preventScroll: true }); buttons[target]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        if (event.key === 'Escape') hideTooltip();
      });
      render(); if (opened && (!days() || dirty.has(mode))) void load();
    },
  };
}
