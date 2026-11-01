export function recommendationSettingsView(t) {
  const id = name => `recommendation-${name}`;
  const button = (name, key, cls = 'quiet') => `<button id="${id(name)}" class="${cls}" type="button">${t(key)}</button>`;
  const heading = (key, description) => `<h1 tabindex="-1">${t(key)}</h1><p class="auto-description">${t(description)}</p>`;
  const back = name => `<button class="auto-breadcrumb quiet" type="button" data-rec-back="${name}"><img src="./icons/ui/arrow-left.svg" alt="" aria-hidden="true">${t('back')}</button>`;
  const footer = (note, actions) => `<footer class="auto-footer"><p>${t(note)}</p><div class="auto-footer-actions">${actions}</div></footer>`;
  const option = (value, key) => `<option value="${value}">${t(key)}</option>`;
  return `<div id="${id('status')}" class="settings-notice recommendation-status" role="status" aria-live="polite" hidden><span id="${id('statusMessage')}"></span><button id="${id('dismissStatus')}" class="settings-notice-close" type="button" aria-label="${t('dismissStatus')}"></button></div>
  <section id="${id('unavailable')}" class="auto-page" hidden><div class="auto-scroll">${heading('title','intro')}${button('retry','retry','auto-secondary')}</div></section>
  <section id="${id('list')}" class="auto-page" hidden><div class="auto-scroll">
    <header class="auto-section-heading"><div>${heading('title','intro')}</div></header>
    <p class="recommendation-scope">${t('scope')} ${button('protection','protection')}</p>
    <h2 class="recommendation-section">${t('automatic')}</h2>
    <div class="recommendation-row"><span class="recommendation-mark" aria-hidden="true">↺</span><div class="recommendation-copy"><strong>${t('habit')}</strong><p id="${id('habitSummary')}"></p></div><button id="${id('editHabit')}" class="recommendation-adjust" type="button"><img src="./icons/ui/sliders.svg" alt="" aria-hidden="true">${t('adjust')}</button><input id="${id('habitEnabled')}" type="checkbox" aria-label="${t('habit')}" class="recommendation-switch"></div>
    <div class="recommendation-row"><span class="recommendation-mark" aria-hidden="true">↗</span><div class="recommendation-copy"><strong>${t('types')}</strong><div class="recommendation-types">${['extension','application'].map(type=>`<label><input id="${id(type)}" type="checkbox">${t(type)}</label>`).join('')}</div></div><small class="recommendation-source">${t('typesHint')}</small></div>
    <div class="recommendation-section-heading"><h2 class="recommendation-section">${t('websites')}</h2><span id="${id('siteCount')}"></span><button id="${id('add')}" class="recommendation-add" type="button"><img src="./icons/ui/plus.svg" alt="" aria-hidden="true">${t('addSite')}</button></div>
    <div id="${id('sites')}"></div><div id="${id('empty')}" class="recommendation-empty"><div><strong>${t('noSites')}</strong><p>${t('noSitesHint')}</p></div></div>
    <div class="recommendation-frequency"><div><strong>${t('frequency')}</strong><p>${t('frequencyHint')}</p></div><label class="auto-field auto-select-field"><span class="sr-only">${t('frequency')}</span><select id="${id('cue')}">${['new','daily','weekly','never'].map(value=>option(value,`cue_${value}`)).join('')}</select></label></div>
    <p class="recommendation-note">${t('protectionNote')}</p>
    </div>${footer('local',button('preview','preview','auto-secondary')+button('save','save','primary'))}</section>
  <section id="${id('site')}" class="auto-page" hidden><div class="auto-scroll">${back('site')}
    <h1 id="${id('siteTitle')}" tabindex="-1"></h1><p class="auto-description">${t('siteIntro')}</p>
    <form id="${id('siteForm')}" novalidate><div class="auto-editor-fields recommendation-fields">
    <label class="auto-field">${t('domain')}<input id="${id('domain')}" type="text" autocomplete="off" spellcheck="false" placeholder="${t('domainPlaceholder')}" aria-describedby="${id('domainHint')}"><small id="${id('domainHint')}">${t('domainHint')}</small></label>
    <label class="auto-field auto-select-field">${t('matchScope')}<select id="${id('subdomains')}">${option('exact','exact')}${option('subdomains','subdomains')}</select></label></div>
    <fieldset class="recommendation-conditions"><legend>${t('when')}</legend>${['always','inactive'].map(condition=>`<label><input name="recommendationCondition" type="radio" value="${condition}"><span><strong>${t(condition)}</strong><small>${t(`${condition}Hint`)}</small></span></label>`).join('')}
    <label class="recommendation-days auto-field">${t('inactiveDays')}<input id="${id('days')}" type="number" min="1" max="365" step="1"></label></fieldset>
    <p id="${id('siteError')}" class="recommendation-error" role="alert"></p><p class="recommendation-note">${t('noAuto')}</p>
    </form></div>${footer('applyHint',button('remove','remove','quiet recommendation-remove')+button('cancelSite','cancel')+`<button form="${id('siteForm')}" class="primary" type="submit">${t('saveRule')}</button>`)}</section>
  <section id="${id('habit')}" class="auto-page" hidden><div class="auto-scroll">${back('habit')}${heading('habit','habitIntro')}
    <form id="${id('habitForm')}" novalidate><div class="auto-editor-fields recommendation-fields"><label class="auto-field">${t('lookback')}<span class="recommendation-unit"><input id="${id('lookback')}" type="number" min="1" max="365" step="1">${t('days')}</span></label><label class="auto-field">${t('minimum')}<span class="recommendation-unit"><input id="${id('minimum')}" type="number" min="1" max="365" step="1">${t('dates')}</span></label></div>
    <p id="${id('habitExplanation')}" class="recommendation-explanation"></p><p id="${id('habitError')}" class="recommendation-error" role="alert"></p>
    <div class="recommendation-counting"><strong>${t('countingTitle')}</strong><p>${t('countingHint')}</p><p>${t('privacyHint')}</p></div></form></div>${footer('applyHint',button('cancelHabit','cancel')+`<button form="${id('habitForm')}" class="primary" type="submit">${t('saveHabit')}</button>`)}</section>
  <section id="${id('previewPage')}" class="auto-page" hidden><div class="auto-scroll">${back('preview')}${heading('preview','previewIntro')}<p id="${id('previewNotice')}" class="recommendation-note"></p><p id="${id('previewCount')}" class="recommendation-explanation" role="status"></p><div id="${id('previewRows')}"></div><p id="${id('previewMore')}" class="recommendation-note"></p></div>${footer('previewMerged',`<button id="${id('backPreview')}" class="auto-secondary recommendation-back" type="button"><img src="./icons/ui/arrow-left.svg" alt="" aria-hidden="true">${t('returnSettings')}</button>`)}</section>
  <dialog id="${id('confirm')}" class="recommendation-confirm" aria-labelledby="${id('confirmTitle')}"><h2 id="${id('confirmTitle')}">${t('discardTitle')}</h2><p>${t('discardBody')}</p><div class="dialog-actions">${button('keep','keep')}${button('discard','discard','primary')}</div></dialog>`;
}
