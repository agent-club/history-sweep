import { workspaceDefaults, validateConditions, cleanLink, exportSelected, readVisitImpact } from './workspace-tools.mjs';
import { workspaceText } from './workspace-copy.mjs';
import { LABEL_COLOR_PRESETS, LABEL_BACKGROUNDS, LABEL_IMAGE_MAX_LENGTH } from './label-appearance.mjs';

const node = (tag, properties = {}, parent) => {
  const element = document.createElement(tag); Object.assign(element, properties); parent?.append(element); return element;
};
const button = (label, action, parent, className = 'quiet') => {
  const element = node('button', { type: 'button', textContent: label, className }, parent);
  element.addEventListener('click', action); return element;
};
const labelField = (parent, label, value = '', tag = 'input') => {
  const wrapper = node('label', { className: 'wt-field' }, parent);
  node('span', { textContent: label }, wrapper);
  return node(tag, { value }, wrapper);
};
const choices = (parent, entries, value) => {
  const select = node('select', {}, parent);
  for (const [key, label] of entries) node('option', { value: key, textContent: label }, select);
  select.value = value; return select;
};

function styleLabel(element, appearance) {
  element.style.color = appearance?.foreground || '';
  element.style.backgroundColor = appearance?.background || '';
  const image = appearance?.image;
  // Tint personal photos so the same text/background pair remains legible at badge size.
  element.style.backgroundImage = !image ? '' : Object.hasOwn(LABEL_BACKGROUNDS, image) ? LABEL_BACKGROUNDS[image] :
    `linear-gradient(${appearance.background}cc, ${appearance.background}cc), url("${image}")`;
}

export function mountWorkspaceTools({ lang, request, snapshot, applySearch, onChange, onCriteriaInput, onSearch, onDelete }) {
  const t = (key, values) => workspaceText(lang, key, values);
  const $ = id => document.getElementById(id);
  const events = new AbortController();
  let tools = workspaceDefaults(), ready = false, busy = false, refreshId = 0, interrupted = false;
  let returnFocus, submit, epoch = 0, impactController, dialogAnchor;
  const owned = [], conditionRows = [], disabledControls = new Map();
  const date = timestamp => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);

  const toolbar = node('div', { className: 'wt-toolbar' }); owned.push(toolbar);
  $('search').before(toolbar);
  $('searchForm').classList.add('wt-search-form');
  const inputWrap = $('query').closest('.input-wrap');
  inputWrap.append($('mode').closest('.mode-field'));
  const savedButton = button(t('savedSearches'), () => { if (dialog.open && dialogAnchor === savedButton) { dismiss(); return; } closeFilters(); openSearches(); }, toolbar); savedButton.id = 'savedSearches';
  savedButton.setAttribute('aria-haspopup', 'dialog'); savedButton.setAttribute('aria-controls', 'workspaceDialog'); savedButton.setAttribute('aria-expanded', 'false');
  const savedIcon = node('img', { src: 'icons/ui/bookmark-simple.svg', alt: '', className: 'ui-icon' }); savedButton.prepend(savedIcon);
  const advanced = node('details', { className: 'wt-advanced' }, toolbar);
  const advancedToggle = node('summary', {}, advanced);
  node('img', { src: 'icons/ui/sliders.svg', alt: '', className: 'ui-icon' }, advancedToggle);
  const advancedLabel = node('span', { textContent: t('filtersShort') }, advancedToggle);
  advancedToggle.setAttribute('aria-label', t('advanced')); advancedToggle.title = t('advanced');
  advancedToggle.setAttribute('aria-controls', 'advancedFilterPanel');
  const advancedBody = node('div', { className: 'wt-advanced-body' }, advanced);
  advancedBody.id = 'advancedFilterPanel'; advancedBody.setAttribute('role', 'region'); advancedBody.setAttribute('aria-label', t('advanced'));
  node('strong', { textContent: t('allConditions') }, advancedBody);
  const conditionsList = node('div', { className: 'wt-conditions' }, advancedBody);
  const filterActions = node('div', { className: 'wt-actions' }, advancedBody);
  button(t('addCondition'), () => { addCondition(); onCriteriaInput(); }, filterActions);
  button(t('reset'), () => { setConditions([]); advanced.open = true; onCriteriaInput(); }, filterActions);
  button(t('applyFilters'), () => { if (validConditions()) { closeFilters(true); void onSearch(); } }, filterActions, 'primary');
  const advancedStatus = node('p', { className: 'wt-status' }, advancedBody); advancedStatus.setAttribute('role', 'status');
  node('p', { className: 'wt-note', textContent: t('conditionHint') }, advancedBody);
  const conditionChips = node('div', { className: 'wt-condition-chips', hidden: true }, $('searchForm')); owned.push(conditionChips);
  advanced.addEventListener('toggle', () => {
    advancedToggle.setAttribute('aria-expanded', String(advanced.open));
    if (advanced.open) { if (dialog.open) dismiss(); positionFilters(); }
  });
  function closeFilters(focus = false) { advanced.open = false; advancedToggle.setAttribute('aria-expanded', 'false'); if (focus) advancedToggle.focus({ preventScroll: true }); }
  function positionPanel(panel, anchor) {
    const bounds = anchor.getBoundingClientRect(), margin = 12;
    const width = Math.min(panel === advancedBody ? 480 : 520, innerWidth - margin * 2);
    const top = Math.min(bounds.bottom + 8, innerHeight - 80);
    panel.style.left = `${Math.max(margin, Math.min(bounds.right - width, innerWidth - width - margin))}px`;
    panel.style.top = `${Math.max(margin, top)}px`;
    panel.style.width = `${width}px`; panel.style.maxHeight = `${Math.max(60, innerHeight - top - margin)}px`;
  }
  function positionFilters() { if (advanced.open) positionPanel(advancedBody, advancedToggle); }
  function positionSearches() { if (dialog.open && dialogAnchor) positionPanel(dialog, dialogAnchor); }
  for (const target of [window, document]) {
    target.addEventListener('scroll', () => { positionFilters(); positionSearches(); }, { capture: true, signal: events.signal });
  }
  window.addEventListener('resize', () => { positionFilters(); positionSearches(); }, { signal: events.signal });

  const protectedButton = button('', () => { $('filters').open = false; showProtected(); }, $('editProtection').parentElement);
  protectedButton.id = 'keptUrls'; protectedButton.classList.add('wt-kept-urls'); owned.push(protectedButton);
  const exportButton = button(t('export'), () => showExport(), $('delete').parentElement);
  exportButton.id = 'exportSelection'; exportButton.classList.add('wt-export'); $('delete').before(exportButton); owned.push(exportButton);

  const notice = node('section', { className: 'wt-interrupted', hidden: true }); owned.push(notice); $('searchForm').after(notice);
  notice.setAttribute('role', 'status');
  const noticeCopy = node('div', {}, notice);
  node('strong', { textContent: t('interrupted') }, noticeCopy); node('p', { textContent: t('interruptedHint') }, noticeCopy);
  button(t('recheck'), () => { $('query').focus(); if ($('query').value.trim()) void onSearch(); }, notice, 'primary');
  button(t('dismiss'), () => void dismissNotice(), notice);

  const privacy = node('section', { className: 'wt-clear-activity' }, document.querySelector('[data-preference-page=privacy]')); owned.push(privacy);
  node('h3', { textContent: t('clearActivity') }, privacy);
  node('p', { className: 'wt-note', textContent: t('clearActivityHint') }, privacy);
  const clearButton = button(t('clearActivity'), () => clearActivity(), privacy); clearButton.id = 'clearLocalActivity';

  const dialog = node('dialog', { id: 'workspaceDialog', className: 'wt-dialog' }, $('app')); owned.push(dialog);
  dialog.setAttribute('aria-labelledby', 'workspaceDialogTitle');
  const header = node('header', { className: 'wt-dialog-header' }, dialog);
  const title = node('h2', { id: 'workspaceDialogTitle' }, header);
  const close = button(t('close'), () => dismiss(), header); close.className = 'quiet wt-close';
  const form = node('form', {}, dialog), body = node('div', { className: 'wt-dialog-body' }, form);
  const feedback = node('p', { className: 'wt-status', id: 'workspaceDialogStatus' }, form); feedback.setAttribute('role', 'status');
  const footer = node('footer', { className: 'wt-actions wt-dialog-actions' }, form);
  form.addEventListener('submit', event => { event.preventDefault(); if (submit && form.reportValidity()) void perform(submit); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    epoch++;
    if (!dialog.open) savedButton.setAttribute('aria-expanded', 'false');
    if (dialogAnchor && document.activeElement !== document.body && document.activeElement !== dialogAnchor && !dialog.contains(document.activeElement)) returnFocus = undefined;
    const label = returnFocus?.getAttribute('aria-label');
    const target = returnFocus?.isConnected ? returnFocus : returnFocus?.id ? $(returnFocus.id) :
      label ? [...document.querySelectorAll('button[aria-label]')].find(element => element.getAttribute('aria-label') === label) : undefined;
    target?.focus({ preventScroll: true });
  });
  document.addEventListener('focusin', event => {
    if (!busy && dialog.open && dialogAnchor && !dialog.contains(event.target) && event.target !== dialogAnchor) {
      // Tab may leave this nonmodal menu naturally; keep focus at its new destination.
      returnFocus = undefined; dialog.close();
    }
  }, { signal: events.signal });

  const impact = node('div', { className: 'wt-impact' }); owned.push(impact);
  $('previewTimeWarning').after(impact);
  $('confirmDialog').addEventListener('close', () => impactController?.abort(), { signal: events.signal });

  function message(error) {
    return t(error.message === 'RULES_BUSY' ? 'busy' : error.message === 'VIEW_HIDDEN' ? 'hiddenView' :
      error.message === 'INVALID_WORKSPACE_SETTINGS' ? 'invalid' : error.message === 'SELECTION_CHANGED' ? 'selectionChanged' : 'failed');
  }
  async function perform(action) {
    if (busy) return;
    busy = true; feedback.textContent = ''; feedback.dataset.error = 'false'; setBusy();
    try { await action(); }
    catch (error) { if (dialog.open) { feedback.textContent = message(error); feedback.dataset.error = 'true'; } }
    finally { busy = false; setBusy(); sync(); }
  }
  function setBusy() {
    for (const control of dialog.querySelectorAll('input, textarea, select, button')) {
      if (busy) { disabledControls.set(control, control.disabled); control.disabled = true; }
      else if (disabledControls.has(control)) control.disabled = disabledControls.get(control);
    }
    if (!busy) disabledControls.clear();
  }
  function dismiss() { if (!busy) dialog.close(); }
  function open(heading, render, primary, anchor = null) {
    epoch++;
    if (!dialog.open) returnFocus = document.activeElement;
    dialogAnchor = anchor;
    dialog.classList.toggle('wt-anchored', Boolean(anchor));
    if (!anchor) for (const property of ['left', 'top', 'width', 'max-height']) dialog.style.removeProperty(property);
    title.textContent = heading; body.replaceChildren(); footer.replaceChildren(); feedback.textContent = ''; submit = primary;
    render(body);
    button(t('cancel'), dismiss, footer);
    if (primary) node('button', { type: 'submit', className: 'primary', textContent: t('save') }, footer);
    if (!dialog.open) { if (anchor) dialog.show(); else dialog.showModal(); }
    savedButton.setAttribute('aria-expanded', String(anchor === savedButton));
    positionSearches();
    (body.querySelector('input:not([type=checkbox]), textarea') || footer.querySelector('button')).focus({ preventScroll: true });
  }
  const primaryLabel = label => { footer.querySelector('[type=submit]').textContent = label; };

  async function refresh() {
    const id = ++refreshId;
    try {
      const data = await request({ type: 'get-workspace-tools' });
      if (events.signal.aborted || id !== refreshId) return;
      const changed = !ready || JSON.stringify(tools) !== JSON.stringify(data.tools);
      tools = data.tools; interrupted = data.interrupted; ready = true;
      if (changed) onChange(tools);
      notice.hidden = !interrupted; sync();
    } catch { if (!events.signal.aborted && id === refreshId) { ready = false; sync(); } }
  }
  async function save(message) { await request(message); await refresh(); }
  async function dismissNotice() {
    try { await request({ type: 'dismiss-cleanup-notice' }); interrupted = false; notice.hidden = true; }
    catch { noticeCopy.querySelector('p').textContent = t('busy'); }
  }
  function sync() {
    const current = snapshot(), blocked = !ready || current.busy;
    savedButton.disabled = blocked; clearButton.disabled = blocked;
    exportButton.disabled = blocked || current.stale || !current.selected.size;
    protectedButton.disabled = blocked; protectedButton.textContent = t('protectedUrls', { n: tools.protectedUrls.length });
    advancedLabel.textContent = t('filtersShort') + (conditionRows.length ? ` · ${conditionRows.length}` : '');
    for (const control of advanced.querySelectorAll('input, select, button')) control.disabled = current.busy;
    const values = current.conditions || [];
    const chipKey = JSON.stringify(values);
    conditionChips.hidden = !values.some(condition => condition.value);
    if (conditionChips.dataset.values !== chipKey) {
      conditionChips.dataset.values = chipKey; conditionChips.replaceChildren();
      values.forEach((condition, index) => {
        if (!condition.value) return;
        const chip = button(`${t(condition.field)} ${t(condition.operator)} ${condition.value}`, () => {
          const entry = conditionRows[index]; entry.row.remove(); conditionRows.splice(index, 1); onCriteriaInput(); void onSearch();
        }, conditionChips, 'wt-condition-chip');
        node('img', { src: 'icons/ui/x.svg', alt: '', className: 'ui-icon' }, chip);
        chip.setAttribute('aria-label', `${t('remove')}: ${chip.textContent}`);
        chip.disabled = current.busy || current.stale;
      });
    }
    for (const chip of conditionChips.querySelectorAll('button')) chip.disabled = current.busy || current.stale;
    positionFilters(); positionSearches();
  }
  function addCondition(value = { field: 'path', operator: 'includes', value: '' }) {
    const row = node('div', { className: 'wt-condition' }, conditionsList);
    const field = choices(row, [['path', t('path')], ['text', t('text')]], value.field);
    const operator = choices(row, [['includes', t('includes')], ['excludes', t('excludes')]], value.operator);
    const input = node('input', { type: 'text', value: value.value }, row); input.setAttribute('aria-label', t('conditionValue')); input.maxLength = 4096;
    const updatePlaceholder = () => { input.placeholder = t(field.value === 'path' ? 'pathPlaceholder' : 'textPlaceholder'); };
    updatePlaceholder(); field.addEventListener('input', updatePlaceholder);
    field.setAttribute('aria-label', t('advanced')); operator.setAttribute('aria-label', t('allConditions'));
    const entry = { row, field, operator, input }; conditionRows.push(entry);
    button(t('remove'), () => { row.remove(); conditionRows.splice(conditionRows.indexOf(entry), 1); onCriteriaInput(); sync(); }, row);
    for (const control of [field, operator, input]) control.addEventListener('input', onCriteriaInput);
    sync();
  }
  function setConditions(conditions) { conditionsList.replaceChildren(); conditionRows.length = 0; conditions.forEach(addCondition); closeFilters(); sync(); }
  function draftConditions() { return conditionRows.map(({ field, operator, input }) => ({ field: field.value, operator: operator.value, value: input.value })); }
  function validConditions() {
    try { validateConditions(draftConditions()); advancedStatus.textContent = ''; return true; }
    catch { advanced.open = true; advancedStatus.textContent = t('invalid'); advancedStatus.dataset.error = 'true'; return false; }
  }

  function openSearches(editing) {
    let name;
    open(t('savedSearches'), root => {
      node('p', { className: 'wt-note', textContent: t('savedHint') }, root);
      const list = node('div', { className: 'wt-saved-list' }, root);
      if (!tools.searches.length) node('p', { textContent: t('emptySearches') }, list);
      for (const saved of tools.searches) {
        const row = node('div', { className: 'wt-search-item' }, list);
        const copy = node('div', {}, row);
        node('strong', { textContent: saved.name }, copy);
        node('small', { textContent: [saved.query, t(`range_${saved.range}`), t(`view_${saved.view}`)].filter(Boolean).join(' · ') }, copy);
        const actions = node('div', { className: 'wt-actions' }, row);
        button(t('apply'), () => void perform(async () => { await applySearch(saved); dialog.close(); }), actions);
        button(t('rename'), () => openSearches(saved), actions);
        const confirmation = node('div', { className: 'wt-inline-confirm', hidden: true }, row);
        node('p', { textContent: t('deleteSearch') }, confirmation);
        button(t('remove'), () => void perform(async () => { await save({ type: 'remove-workspace-search', id: saved.id }); row.remove(); }), confirmation, 'delete');
        button(t('cancel'), () => { confirmation.hidden = true; }, confirmation);
        button(t('remove'), () => { confirmation.hidden = false; }, actions);
      }
      node('h3', { textContent: editing ? t('rename') : t('saveCurrent') }, root);
      name = labelField(root, t('name'), editing?.name || ''); name.required = true; name.maxLength = 80;
      if (!editing && snapshot().filters.range === 'custom') node('p', { className: 'wt-note', textContent: t('customSearch') }, root);
    }, async () => {
      const current = snapshot();
      if (!editing && (current.filters.range === 'custom' || !validConditions())) throw new Error('INVALID_WORKSPACE_SETTINGS');
      const saved = editing ? { ...editing, name: name.value } : { id: crypto.randomUUID(), name: name.value,
        query: current.query, mode: current.mode, range: current.filters.range, view: current.grouping, conditions: draftConditions() };
      await save({ type: 'save-workspace-search', search: saved }); dialog.close();
    }, savedButton);
  }

  function clearActivity() {
    const stamp = epoch + 1;
    open(t('clearQuestion'), root => {
      node('p', { textContent: t('clearActivityHint') }, root);
      const count = node('p', { className: 'wt-note' }, root);
      node('p', { className: 'wt-warning', textContent: t('clearWarning') }, root);
      void request({ type: 'get-activity' }).then(data => {
        if (epoch === stamp && dialog.open) count.textContent = t('activityDays', { n: Object.keys(data.log.days).length });
      }).catch(() => {});
    }, async () => { await request({ type: 'clear-local-activity' }); feedback.textContent = t('cleared'); submit = undefined; footer.replaceChildren(); button(t('close'), dismiss, footer); });
    primaryLabel(t('clearActivity')); footer.querySelector('[type=submit]').className = 'delete';
  }

  function showProtected() {
    open(t('protectedUrls', { n: tools.protectedUrls.length }), root => {
      node('p', { className: 'wt-note', textContent: t('protectedHint') }, root);
      if (!tools.protectedUrls.length) node('p', { textContent: t('emptyProtection') }, root);
      for (const url of tools.protectedUrls) {
        const row = node('div', { className: 'wt-list-row' }, root);
        node('span', { textContent: url }, row);
        button(t('unprotect'), () => void perform(async () => { await save({ type: 'save-url-protection', url, protected: false }); row.remove(); }), row);
      }
    });
  }

  async function copyUrl(value, field) {
    try { await navigator.clipboard.writeText(value); feedback.textContent = t('copied'); feedback.dataset.error = 'false'; return true; }
    catch { field.value = value; field.focus(); field.select(); feedback.textContent = t('copyBlocked'); feedback.dataset.error = 'true'; return false; }
  }
  function showCleanLink(item) {
    const hostname = new URL(item.url).hostname.toLowerCase().replace(/\.$/, '');
    let parameters, original, cleaned, summary, cleanedButton;
    const preview = () => {
      const names = parameters.value.split(/[,，\n]+/).map(value => value.trim()).filter(Boolean);
      if (!names.length) { cleaned.value = item.url; summary.textContent = t('noParameters'); cleanedButton.disabled = true; return; }
      try {
        const result = cleanLink(item.url, { hostname, parameters: names }); cleaned.value = result.url;
        summary.textContent = result.removed.length ? t('removedParams', { names: result.removed.join(', ') }) : t('noParamMatches');
        cleanedButton.disabled = !result.removed.length;
      } catch { summary.textContent = t('invalid'); cleanedButton.disabled = true; }
    };
    open(t('clean'), root => {
      node('p', { textContent: hostname }, root);
      original = labelField(root, t('original'), item.url, 'textarea'); original.readOnly = true;
      cleaned = labelField(root, t('cleaned'), item.url, 'textarea'); cleaned.readOnly = true;
      parameters = labelField(root, t('parameters'), (tools.linkRules.find(rule => rule.hostname === hostname)?.parameters || []).join('\n'), 'textarea');
      node('p', { className: 'wt-note', textContent: t('parametersHint') }, root);
      summary = node('p', { className: 'wt-note' }, root);
      button(t('saveRule'), () => void perform(async () => { await save({ type: 'save-link-rule', rule: { hostname, parameters: parameters.value.split(/[,，\n]+/).map(value => value.trim()).filter(Boolean) } }); feedback.textContent = t('saved'); }), root);
      node('p', { className: 'wt-note', textContent: t('cleanHint') }, root);
    });
    footer.replaceChildren();
    button(t('copyOriginal'), () => void copyUrl(item.url, original), footer);
    cleanedButton = button(t('copyClean'), () => void copyUrl(cleaned.value, cleaned), footer, 'primary');
    parameters.addEventListener('input', preview); preview();
  }

  function editLabels(hostname) {
    let input, visible, refreshPreview;
    const saved = tools.labels[hostname];
    const styles = new Map(Object.entries(saved?.styles || {}));
    const values = () => [...new Set(input.value.split(/[,，\n]+/).map(value => value.trim()).filter(Boolean))];
    const defaultColors = () => {
      const theme = getComputedStyle(document.documentElement);
      return { foreground: theme.getPropertyValue('--muted').trim(), background: theme.getPropertyValue('--mist').trim() };
    };
    open(t('labels'), root => {
      node('p', { textContent: t('exactHost', { host: hostname }) }, root);
      node('p', { className: 'wt-note', textContent: t('localLabels') }, root);
      input = labelField(root, t('labelInput'), saved ? saved.values.join('\n') : '', 'textarea');
      node('p', { className: 'wt-note', textContent: t('labelHint') }, root);
      const preview = node('div', { className: 'wt-label-preview' }, root);
      preview.setAttribute('role', 'group'); preview.setAttribute('aria-label', t('labelPreview'));
      const empty = node('p', { className: 'wt-note', textContent: t('labelPreviewEmpty') }, root);
      const editor = node('section', { className: 'wt-label-editor' }, root);
      const heading = node('div', { className: 'wt-label-editor-heading' }, editor);
      const current = node('strong', {}, heading);
      let selected;
      const appearance = () => styles.get(selected);
      const update = patch => {
        imageStatus.textContent = '';
        styles.set(selected, { ...(appearance() || defaultColors()), ...patch });
        refreshPreview();
      };
      button(t('labelReset'), () => { imageStatus.textContent = ''; styles.delete(selected); refreshPreview(); }, heading);
      const palettes = node('div', { className: 'wt-label-palettes' }, editor);
      palettes.setAttribute('role', 'group'); palettes.setAttribute('aria-label', t('labelPalette'));
      const paletteButtons = Object.entries(LABEL_COLOR_PRESETS).map(([key, colors]) => {
        const option = button(t(`labelColor_${key}`), () => update(colors), palettes, 'wt-label-palette');
        styleLabel(option, colors);
        return [option, colors];
      });
      const colorFields = node('div', { className: 'wt-label-colors' }, editor);
      const colorInputs = ['foreground', 'background'].map(key => {
        const field = node('label', { className: 'wt-label-color-field' }, colorFields);
        node('span', { textContent: t(key === 'foreground' ? 'labelForeground' : 'labelBackground') }, field);
        const color = node('input', { type: 'color' }, field);
        color.setAttribute('aria-label', t(key === 'foreground' ? 'labelForeground' : 'labelBackground'));
        const hex = node('span', { className: 'wt-label-color-value' }, field);
        hex.setAttribute('aria-hidden', 'true');
        color.addEventListener('input', () => update({ [key]: color.value }));
        return { key, color, hex };
      });
      node('p', { className: 'wt-label-section-title', textContent: t('labelImage') }, editor);
      const backgrounds = node('div', { className: 'wt-label-backgrounds' }, editor);
      backgrounds.setAttribute('role', 'group'); backgrounds.setAttribute('aria-label', t('labelImage'));
      const imageButtons = ['', ...Object.keys(LABEL_BACKGROUNDS)].map(key => {
        const option = button(t(key ? `labelImage_${key}` : 'labelImageNone'), () => update({ image: key || undefined }), backgrounds, 'wt-label-background');
        const sample = node('span', { className: 'wt-label-background-sample', textContent: 'Aa' }); option.prepend(sample);
        sample.setAttribute('aria-hidden', 'true');
        return { key, option, sample };
      });
      const uploadRow = node('div', { className: 'wt-label-upload-row' }, editor);
      const upload = button(t('labelUpload'), () => file.click(), uploadRow);
      upload.setAttribute('aria-pressed', 'false');
      const file = node('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', className: 'wt-label-image-input', hidden: true }, uploadRow);
      file.setAttribute('aria-label', t('labelUpload'));
      node('span', { className: 'wt-note', textContent: t('labelUploadHint') }, uploadRow);
      const imageStatus = node('p', { className: 'wt-status' }, editor); imageStatus.setAttribute('role', 'status');
      file.addEventListener('change', () => {
        const chosen = file.files[0]; file.value = '';
        if (!chosen) return;
        const target = selected, opened = epoch;
        // Reuse the dialog's busy/close guard while decoding; a late result cannot reach another editor.
        void perform(async () => {
          imageStatus.textContent = ''; imageStatus.dataset.error = 'false';
          let bitmap;
          try {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type) || chosen.size > 8 * 1024 * 1024) {
              imageStatus.textContent = t('labelImageFailed'); imageStatus.dataset.error = 'true'; return;
            }
            bitmap = await createImageBitmap(chosen);
            const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 128;
            const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
            canvas.getContext('2d').drawImage(bitmap, (canvas.width - bitmap.width * scale) / 2, (canvas.height - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
            const image = canvas.toDataURL('image/webp', .8);
            if (image.length > LABEL_IMAGE_MAX_LENGTH) {
              imageStatus.textContent = t('labelImageFailed'); imageStatus.dataset.error = 'true'; return;
            }
            if (opened !== epoch) return;
            styles.set(target, { ...(styles.get(target) || defaultColors()), image });
            refreshPreview();
          } catch {
            imageStatus.textContent = t('labelImageFailed'); imageStatus.dataset.error = 'true';
          } finally { bitmap?.close(); }
        });
      });
      refreshPreview = () => {
        const names = values();
        const restorePreviewFocus = preview.contains(document.activeElement);
        if (!names.includes(selected)) selected = names[0];
        preview.replaceChildren(); empty.hidden = names.length > 0; editor.hidden = names.length === 0;
        for (const name of names) {
          const tag = button(name, () => { selected = name; refreshPreview(); }, preview, 'wt-label wt-label-preview-item');
          tag.title = name; tag.setAttribute('aria-pressed', String(name === selected));
          styleLabel(tag, styles.get(name));
          if (restorePreviewFocus && name === selected) tag.focus({ preventScroll: true });
        }
        if (!selected) return;
        current.textContent = t('labelStyleFor', { name: selected });
        const style = appearance() || defaultColors();
        for (const { key, color, hex } of colorInputs) { color.value = style[key]; hex.textContent = style[key].toUpperCase(); }
        for (const [option, colors] of paletteButtons) option.setAttribute('aria-pressed', String(Boolean(appearance()) && colors.foreground === style.foreground && colors.background === style.background));
        for (const { key, option, sample } of imageButtons) {
          option.setAttribute('aria-pressed', String((style.image || '') === key));
          styleLabel(sample, { ...style, image: key || undefined });
        }
        upload.setAttribute('aria-pressed', String(Boolean(style.image?.startsWith('data:'))));
      };
      input.addEventListener('input', refreshPreview); refreshPreview();
      const label = node('label', { className: 'wt-checkbox-row' }, root);
      visible = node('input', { type: 'checkbox', checked: saved ? saved.visible : true }, label);
      node('span', { textContent: t('showLabels') }, label);
      node('p', { className: 'wt-note', textContent: t('labelsHint') }, root);
    }, async () => {
      const names = values(), selectedStyles = Object.fromEntries([...styles].filter(([name]) => names.includes(name)));
      const label = { values: names, visible: visible.checked };
      if (Object.keys(selectedStyles).length) label.styles = selectedStyles;
      await save({ type: 'save-website-label', hostname, label }); dialog.close();
    });
  }

  async function showTimeline(row, item) {
    if (row.nextElementSibling?.classList.contains('wt-visit-detail')) { row.nextElementSibling.remove(); return; }
    const detail = document.createElement('tr'); detail.className = 'wt-visit-detail'; row.after(detail);
    const cell = node('td', { colSpan: row.children.length }, detail);
    node('strong', { textContent: t('timeline') }, cell); node('p', { className: 'wt-note', textContent: t('timelineHint') }, cell);
    const list = node('div', { className: 'wt-timeline', textContent: t('loading') }, cell);
    node('p', { className: 'wt-note', textContent: t('visitWarning') }, cell);
    try {
      const visits = await chrome.history.getVisits({ url: item.url });
      if (!detail.isConnected) return;
      list.replaceChildren();
      if (!visits.length) node('p', { textContent: t('noVisits') }, list);
      const ordered = [...visits].sort((a, b) => (b.visitTime ?? -Infinity) - (a.visitTime ?? -Infinity));
      let count = 0;
      const more = button('', append, cell);
      function append() {
        for (const visit of ordered.slice(count, count + 50)) {
          const entry = node('div', { className: 'wt-visit' }, list);
          node('time', { textContent: Number.isFinite(visit.visitTime) ? date(visit.visitTime) : t('unavailable') }, entry);
          node('span', { textContent: t(visit.transition === 'typed' ? 'typed' : visit.transition === 'link' ? 'link' : 'transitionUnknown') }, entry);
        }
        count += 50; more.hidden = count >= ordered.length; more.textContent = `${t('timeline')} · ${Math.min(50, ordered.length - count)}`;
      }
      append();
      detail.scrollIntoView({ block: 'nearest' });
    } catch { if (detail.isConnected) list.textContent = t('unavailable'); }
  }

  function decorateRow(row, item) {
    const protectedUrl = snapshot().protectedUrls.has(item.url);
    if (protectedUrl) {
      row.classList.add('wt-protected-row');
      const badge = node('span', { className: 'wt-label', textContent: t('protected') }, row.querySelector('.page-heading'));
      badge.title = t('protectedHint');
    }
    const actions = row.querySelector('.row-actions');
    const more = button(t('more'), () => {
      open(t('more'), root => {
        node('p', { className: 'wt-url', textContent: item.url }, root);
        const list = node('div', { className: 'wt-menu-list' }, root);
        button(t('timeline'), () => { dialog.close(); void showTimeline(row, item); }, list);
        button(t(protectedUrl ? 'unprotect' : 'protect'), () => void perform(async () => {
          await save({ type: 'save-url-protection', url: item.url, protected: !protectedUrl }); dialog.close();
        }), list);
        let url;
        try { url = new URL(item.url); } catch { /* No website-only actions for malformed history URLs. */ }
        if (url && ['http:', 'https:'].includes(url.protocol)) {
          button(t('clean'), () => showCleanLink(item), list);
          button(t('labels'), () => editLabels(url.hostname.toLowerCase().replace(/\.$/, '')), list);
        }
        if (!protectedUrl) button(lang === 'zh-CN' ? '删除这条记录' : 'Delete this record', () => { dialog.close(); onDelete([item.url]); }, list, 'delete');
      });
    }, actions, 'quiet wt-row-more');
    actions.prepend(more);
    more.setAttribute('aria-label', `${t('more')} · ${item.url}`);
    more.title = t('more'); more.textContent = '';
    const icon = node('img', { src: 'icons/ui/sliders.svg', alt: '', className: 'ui-icon' }, more); icon.setAttribute('aria-hidden', 'true');
  }
  function decorateGroup(identity, group, actions) {
    let url;
    try { url = new URL(group.items[0].url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const host = url.hostname.toLowerCase().replace(/\.$/, ''), saved = tools.labels[host];
    if (saved?.visible && saved.values.length) {
      const labels = node('div', { className: 'wt-group-labels' }, identity);
      for (const value of saved.values.slice(0, 2)) {
        const tag = node('span', { className: 'wt-label', textContent: value, title: value }, labels);
        styleLabel(tag, Object.hasOwn(saved.styles || {}, value) ? saved.styles[value] : undefined);
      }
      if (saved.values.length > 2) button(`+${saved.values.length - 2}`, () => editLabels(host), labels, 'quiet wt-label-more');
      if (saved.values.length > 1) button(`+${saved.values.length - 1}`, () => editLabels(host), labels, 'quiet wt-label-more-narrow');
    }
    const edit = button(t('labels'), () => editLabels(host), actions, 'quiet wt-label-edit');
    edit.setAttribute('aria-label', `${t('labels')} · ${host}`);
    edit.title = t('labels'); edit.textContent = '';
    node('img', { src: 'icons/ui/gear.svg', alt: '', className: 'ui-icon' }, edit).setAttribute('aria-hidden', 'true');
  }

  function showExport() {
    const current = snapshot(), items = current.matches.filter(item => current.selected.has(item.url));
    if (!items.length || current.stale || current.busy) return;
    const targets = items.map(item => item.url).sort().join('\n');
    let format, preview, filename;
    const today = new Date(), stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    open(t('exportTitle', { n: items.length }), root => {
      node('p', { className: 'wt-note', textContent: t('exportHint') }, root);
      const label = node('label', { className: 'wt-field' }, root); node('span', { textContent: t('format') }, label);
      format = choices(label, [['text', t('plain')], ['csv', t('csv')]], 'text');
      preview = node('textarea', { readOnly: true, rows: 6, value: exportSelected(items, 'text') }, root);
      preview.setAttribute('aria-label', t('export'));
      filename = labelField(root, t('filename'), `history-sweep-selected-${stamp}.txt`); filename.required = true;
      node('p', { className: 'wt-note', textContent: t('exportNotice') }, root);
      format.addEventListener('change', () => { preview.value = exportSelected(items, format.value); filename.value = `history-sweep-selected-${stamp}.${format.value === 'csv' ? 'csv' : 'txt'}`; });
    }, async () => {
      const now = snapshot();
      if (now.stale || [...now.selected].sort().join('\n') !== targets) throw new Error('SELECTION_CHANGED');
      const url = URL.createObjectURL(new Blob([exportSelected(items, format.value)], { type: format.value === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
      const link = node('a', { href: url, download: filename.value.replace(/[\\/]/g, '-').trim() }); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000); dialog.close();
    }); primaryLabel(t('exportFile'));
  }

  function prepareImpact(urls, range) {
    impactController?.abort(); impact.replaceChildren();
    const trigger = button(t('impact'), async () => {
      trigger.disabled = true;
      impactController = new AbortController(); const controller = impactController;
      const output = node('div', { className: 'wt-impact-results' }, impact);
      output.setAttribute('aria-live', 'polite');
      try {
        const result = await readVisitImpact(chrome.history, urls, range, { signal: controller.signal,
          progress: (done, total) => { if (!controller.signal.aborted) output.textContent = t('impactProgress', { done, total }); } });
        if (controller.signal.aborted) return;
        output.replaceChildren();
        const known = result.filter(item => !item.unavailable);
        node('strong', { textContent: t('impactSummary', { urls: urls.length, visits: known.reduce((sum, item) => sum + item.visits.length, 0), outside: known.reduce((sum, item) => sum + item.outside, 0) }) }, output);
        if (known.length !== result.length || known.some(item => item.unknownTimes)) node('p', { className: 'wt-warning', textContent: t('impactPartial') }, output);
        for (const item of result) {
          const details = node('details', {}, output);
          node('summary', { textContent: `${item.url} · ${item.unavailable ? t('unavailable') : item.visits.length}` }, details);
          if (!item.unavailable) {
            let rendered = false;
            details.addEventListener('toggle', () => {
              if (!details.open || rendered) return; rendered = true;
              const entries = node('div', {}, details); let shown = 0;
              const more = button(t('timeline'), append, details);
              function append() {
                for (const visit of item.visits.slice(shown, shown + 50)) {
                  const row = node('div', { className: 'wt-visit' }, entries);
                  node('time', { textContent: Number.isFinite(visit.visitTime) ? date(visit.visitTime) : t('unavailable') }, row);
                  if (range && Number.isFinite(visit.visitTime)) node('span', { textContent: t(visit.visitTime < range.startTime || visit.visitTime >= range.endTime ? 'outside' : 'inside') }, row);
                }
                shown += 50; more.hidden = shown >= item.visits.length;
              }
              append();
            });
          }
        }
        node('p', { className: 'wt-note', textContent: t('impactHint') }, output);
      } catch (error) { if (error.name !== 'AbortError') { output.textContent = t('unavailable'); trigger.disabled = false; } }
    }, impact);
  }

  void refresh(); sync();
  return { refresh, sync, decorateRow, decorateGroup, prepareImpact, setConditions, draftConditions, validConditions,
    isBusy: () => busy, dismiss,
    destroy: () => { events.abort(); refreshId++; impactController?.abort(); owned.forEach(element => element.remove()); },
  };
}
