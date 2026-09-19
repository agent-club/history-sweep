// All interpolated markup is authored UI copy; history data is inserted via textContent.
const icon = (name, className = '') => `<img class="ui-icon ${className}" src="icons/ui/${name}.svg" alt="" aria-hidden="true">`;

export function view(t, compact) {
  const language = `<div id="language" class="language-switch" role="group" aria-label="${t('language')}"><button type="button" data-language="en" lang="en" aria-label="English" aria-pressed="false">EN</button><button type="button" data-language="zh-CN" lang="zh-CN" aria-label="简体中文" aria-pressed="false">中文</button></div>`;
  const brand = `<a class="brand" href="manager.html"><img class="brand-mark" src="icons/mark-premium.png" width="40" height="40" alt=""><span class="brand-copy"><strong>History Sweep</strong><small>${t('tagline')}</small></span></a>`;
  const openButton = `<button id="openFull" class="icon-button" type="button" title="${t('full')}" aria-label="${t('full')}">${icon('arrow-square-out')}</button>`;

  return `${compact ? '' : `<aside class="sidebar">${brand}<span class="side-label">${t('workspace')}</span><div class="side-active">${icon('clock-counter-clockwise')}${t('history')}</div><div class="side-bottom"><h3>${t('privacy')}</h3><p>${t('privacyBody')}</p><span class="local-dot">${t('local')}</span></div></aside>`}
  <main class="app-shell">
    <header class="topbar">${compact ? brand : `<span class="breadcrumb">${t('workspace')} <span>/</span> ${t('history')}</span>`}<div class="top-actions">${language}${compact ? openButton : `<span class="version">v0.3</span>`}</div></header>
    ${compact ? '' : `<section class="intro"><span class="eyebrow">${t('pageEyebrow')}</span><h1>${t('heading')}</h1><p>${t('intro')}</p></section>`}
    <form id="searchForm" class="search-panel">
      <label class="query-field"><span>${t('searchLabel')}</span><div class="input-wrap">${icon('magnifying-glass')}<input id="query" type="text" required autocomplete="off" placeholder="${t('placeholder')}"><button id="clearQuery" class="clear-query" type="button" aria-label="${t('clearQuery')}" hidden>${icon('x')}</button></div></label>
      <label class="mode-field"><span>${t('modeLabel')}</span><select id="mode"><option value="smart">${t('smart')}</option><option value="host-subdomains">${t('domains')}</option><option value="host-exact">${t('exact')}</option><option value="contains">${t('contains')}</option></select></label>
      <button class="primary" id="search" type="submit">${icon('magnifying-glass')}<span>${t('scan')}</span></button>
      <p class="search-hint">${t('searchHint')}</p>
    </form>
    <section class="results-panel">
      <div class="results-heading"><h2 id="count">${t('resultCount', { n: 0 })}</h2><div class="toolbar"><button id="selectAll" class="quiet select-all" disabled>${icon('check-square')}<span id="selectAllLabel">${t(compact ? 'selectAllCompact' : 'selectAll', { n: 0 })}</span></button><button id="clear" class="quiet" disabled>${t('clear')}</button><span id="selected">0 ${t('selected')}</span></div></div>
      <div id="resultScroll" class="result-scroll"><div id="empty" class="empty">${icon('magnifying-glass','empty-icon')}<h3>${t('emptyTitle')}</h3><p>${t('emptyBody')}</p></div><table id="table" hidden><thead><tr><th><span class="sr-only">${t('selected')}</span></th><th>${t('page')}</th><th class="date-column">${t('lastVisit')}</th><th class="visit-column">${t('visits')}</th></tr></thead><tbody id="rows"></tbody></table><button id="loadMore" class="quiet more" hidden>${t('loadMore')}</button></div>
      <p id="preview" class="preview" hidden></p>
    </section>
    <div class="status-area"><progress id="progress" value="0" max="1" aria-label="${t('progress')}" hidden></progress><p id="status" role="status" aria-live="polite">${t('ready')}</p></div>
    <footer class="actionbar"><button id="openFullFooter" class="secondary-action" type="button">${icon('arrow-square-out')}<span>${t('full')}</span></button><span class="delete-note">${t('deleteNote')}</span><button id="delete" class="delete" disabled>${icon('trash')}<span id="deleteLabel">${t('delete')}</span></button></footer>
  </main>
  <dialog id="confirmDialog" aria-labelledby="confirmTitle"><form method="dialog"><div class="dialog-symbol">${icon('trash')}</div><h2 id="confirmTitle">${t('confirmTitle')}</h2><p id="confirmBody"></p><p class="keep-open">${t('keepOpen')}</p><div class="dialog-actions"><button value="cancel" autofocus>${t('cancel')}</button><button class="delete" value="confirm">${icon('trash')}<span>${t('confirm')}</span></button></div></form></dialog>`;
}
