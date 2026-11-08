import { cleanLink, validateLinkRule, WORKSPACE_TOOLS_KEY } from './workspace-tools.mjs';
import { linkCleanupText } from './link-cleanup-copy.mjs';
import { automaticLinkRules } from './automatic-link-cleanup.mjs';
import { addPreferenceHelp } from './preference-help.mjs';

const make = (tag, properties, parent) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'role' || key === 'form' || key.startsWith('aria-')) element.setAttribute(key, value);
    else element[key] = value;
  }
  parent?.append(element);
  return element;
};

export function mountLinkCleanupSettings(root, { lang, request, onDirty, onPage, onPagesClosed }) {
  const t = (key, values) => linkCleanupText(lang, key, values);
  const events = new AbortController();
  root.classList.add('auto-cleanup-root', 'link-cleanup-root');
  let rules = [], page = 'list', editing = null, original = null, editorBaseline = '', busy = false, loaded = false, disposed = false;
  let automatic = { available: false, paused: false, hosts: [], installed: [], error: null };
  let pendingConfirmation;
  let notice = '', noticeFailed = false;
  const lastMutations = new Map();
  const button = (text, handler, parent, className = 'quiet') => {
    const control = make('button', { type: 'button', textContent: text, className }, parent);
    control.addEventListener('click', handler);
    return control;
  };
  const field = (parent, text, help, id, multiline = false) => {
    const wrapper = make('div', { className: 'auto-field' }, parent);
    const label = make('label', { htmlFor: id, textContent: text }, wrapper);
    const input = make(multiline ? 'textarea' : 'input', { id, spellcheck: false, autocomplete: 'off' }, wrapper);
    if (help) input.setAttribute('aria-describedby', addPreferenceHelp(label, lang, text, help).id);
    return input;
  };
  const section = id => {
    const panel = make('section', { id: `link-cleanup-${id}`, className: 'auto-page', hidden: true }, root);
    return { panel, scroll: make('div', { className: 'auto-scroll' }, panel) };
  };
  const list = section('list'), editor = section('editor');
  const heading = make('header', { className: 'auto-section-heading' }, list.scroll);
  const titleBlock = make('div', {}, heading);
  const listTitle = make('h1', { textContent: t('title'), tabIndex: -1 }, titleBlock);
  addPreferenceHelp(listTitle, lang, t('title'), t('intro'), t('local'));
  const add = button(t('add'), () => openEditor(), heading, 'primary'); add.id = 'link-cleanup-add';
  const listStatus = make('p', { className: 'link-rule-notice', role: 'status' }, list.scroll);
  const retry = button(t('retry'), () => void enter(), list.scroll); retry.hidden = true;
  const rows = make('div', { className: 'link-rule-list' }, list.scroll);
  const empty = make('div', { className: 'link-rule-empty' }, list.scroll);
  make('strong', { textContent: t('empty') }, empty); make('p', { textContent: t('emptyHint') }, empty);
  const globalAuto = make('section', { className: 'link-rule-auto', hidden: true }, list.scroll);
  make('h2', { textContent: t('automatic') }, globalAuto);
  const pauseLabel = make('label', { className: 'link-rule-enabled' }, globalAuto);
  const pause = make('input', { type: 'checkbox', id: 'link-cleanup-pause' }, pauseLabel);
  make('span', { textContent: t('pauseAll') }, pauseLabel);
  const automaticStatus = make('p', { className: 'link-rule-notice', role: 'status' }, globalAuto);

  const backButton = button(t('back'), () => back(), editor.scroll, 'auto-breadcrumb quiet');
  backButton.prepend(make('img', { src: './icons/ui/arrow-left.svg', alt: '' }));
  const editorTitle = make('h1', { tabIndex: -1 }, editor.scroll);
  addPreferenceHelp(editorTitle, lang, t('title'), t('editorHint'));
  const form = make('form', { id: 'link-cleanup-form', className: 'link-rule-editor', noValidate: true }, editor.scroll);
  const ruleRow = make('div', { className: 'settings-action-row' }, form);
  const ruleIdentity = make('div', { className: 'settings-action-main' }, ruleRow);
  const hostname = field(ruleIdentity, t('hostname'), t('hostnameHint'), 'link-cleanup-hostname');
  const enabledLabel = make('label', { className: 'link-rule-enabled settings-action-controls' }, ruleRow);
  const enabled = make('input', { type: 'checkbox', id: 'link-cleanup-enabled' }, enabledLabel);
  make('span', { textContent: t('enabled') }, enabledLabel);
  const parameters = field(form, t('parameters'), t('parametersHint'), 'link-cleanup-parameters', true);
  const details = make('details', { className: 'link-rule-exceptions', open: true }, form);
  make('summary', { textContent: t('exceptions') }, details);
  const columns = make('div', { className: 'link-rule-columns' }, details);
  const preserve = field(columns, t('preserve'), t('preserveHint'), 'link-cleanup-preserve', true);
  const paths = field(columns, t('paths'), t('pathsHint'), 'link-cleanup-paths', true);
  const sample = field(form, t('sample'), t('sampleHint'), 'link-cleanup-sample');
  const preview = make('section', { className: 'link-rule-preview', 'aria-label': t('preview') }, form);
  make('strong', { textContent: t('preview') }, preview);
  const previewUrl = make('p', { className: 'link-rule-preview-url', id: 'link-cleanup-preview-url' }, preview);
  const previewNote = make('p', { className: 'link-rule-preview-note', role: 'status', id: 'link-cleanup-preview-note' }, preview);
  const error = make('p', { className: 'link-rule-error', role: 'alert', id: 'link-cleanup-error' }, form);
  const autoSection = make('section', { className: 'link-rule-auto' }, editor.scroll);
  const autoRow = make('div', { className: 'settings-action-row' }, autoSection);
  const autoCopy = make('div', { className: 'link-rule-auto-copy settings-action-main' }, autoRow);
  const autoHeading = make('div', { className: 'link-rule-auto-heading' }, autoCopy);
  const automaticTitle = make('h2', { textContent: t('automatic') }, autoHeading);
  addPreferenceHelp(automaticTitle, lang, t('automatic'), t('autoHint'), t('encodedKeys'));
  const autoState = make('span', { className: 'link-rule-state', id: 'link-cleanup-auto-state' }, autoHeading);
  const autoHelp = make('p', { className: 'link-rule-auto-description' }, autoCopy);
  const autoActions = make('div', { className: 'auto-footer-actions link-rule-auto-actions settings-action-controls' }, autoRow);
  const enableAuto = button(t('enableAuto'), () => void enableAutomatic(), autoActions, 'auto-secondary'); enableAuto.id = 'link-cleanup-enable-auto';
  const disableAuto = button(t('disableAuto'), () => void run(async () => {
    automatic = await request({ type: 'set-link-cleanup-automatic', hostname: original.hostname, enabled: false });
    updateEditor(); status(t(automatic.error ? 'autoError' : 'autoSaved'), Boolean(automatic.error));
  }, 'disable-auto'), autoActions); disableAuto.id = 'link-cleanup-disable-auto';
  const editorFooter = make('footer', { className: 'auto-footer' }, editor.panel);
  const draftState = make('p', { role: 'status' }, editorFooter);
  const footerActions = make('div', { className: 'auto-footer-actions' }, editorFooter);
  const remove = button(t('remove'), () => confirm('delete', async () => {
    await run(async () => {
      await request({ type: 'remove-link-rule', hostname: original.hostname, expectedRule: original });
      editorBaseline = ''; original = null; await load(); show('list'); onPagesClosed(['editor']); status(t('removedRule'));
    }, 'remove');
  }), footerActions, 'quiet recommendation-remove'); remove.id = 'link-cleanup-remove';
  button(t('cancel'), () => back(), footerActions);
  const save = make('button', { type: 'submit', form: form.id, textContent: t('save'), className: 'primary', id: 'link-cleanup-save' }, footerActions);

  const confirmation = make('dialog', { className: 'link-cleanup-confirm', id: 'link-cleanup-confirm' }, root.closest('#preferencesDialog') || root);
  const confirmTitle = make('h2', { id: 'link-cleanup-confirm-title' }, confirmation);
  confirmation.setAttribute('aria-labelledby', confirmTitle.id);
  const confirmBody = make('p', {}, confirmation);
  const confirmActions = make('div', { className: 'dialog-actions' }, confirmation);
  const keep = button(t('keepEditing'), () => confirmation.close(), confirmActions);
  const accept = button(t('discard'), () => { const action = pendingConfirmation; confirmation.close(); void action?.(); }, confirmActions, 'primary');
  confirmation.addEventListener('close', () => { pendingConfirmation = null; if (!root.hidden && page === 'editor') editorTitle.focus({ preventScroll: true }); });
  function status(text, failed = false) {
    notice = text; noticeFailed = failed;
    listStatus.textContent = text; listStatus.dataset.error = String(failed);
    if (page === 'editor') { error.textContent = failed ? text : ''; if (!failed) draftState.textContent = text; }
  }
  const split = value => [...new Set(value.split(/[,，\n]+/).map(name => name.trim()).filter(Boolean))];
  const draftValue = () => JSON.stringify([hostname.value, enabled.checked, parameters.value, preserve.value, paths.value]);
  const hasUnsavedChanges = () => Boolean(editorBaseline && draftValue() !== editorBaseline);
  const candidate = () => validateLinkRule({ hostname: hostname.value, parameters: split(parameters.value), enabled: enabled.checked,
    preserveParameters: split(preserve.value), excludedPaths: split(paths.value) });
  function validation() {
    if (!hostname.value.trim() || /[\s/:?#*]/.test(hostname.value.trim())) return t('invalidHostname');
    try {
      const next = candidate();
      if (rules.some(rule => rule.hostname === next.hostname && rule.hostname !== editing)) return t('duplicate');
    } catch { return t('invalid'); }
    return '';
  }
  function automaticLabel(host) {
    if (automatic.unavailableHosts?.includes(host)) return t('autoUnavailable');
    if (!automatic.hosts.includes(host)) return t(automatic.installed.includes(host) ? 'autoError' : 'autoOff');
    if (automatic.error) return t('autoError');
    if (automatic.paused) return t(automatic.installed.includes(host) ? 'autoError' : 'autoPaused');
    return t(automatic.installed.includes(host) ? 'autoOn' : 'autoPermission');
  }
  function renderList() {
    rows.replaceChildren(); rows.hidden = !rules.length; empty.hidden = Boolean(rules.length);
    for (const rule of rules) {
      const row = make('div', { className: 'link-rule-row' }, rows);
      const copy = make('div', { className: 'link-rule-copy' }, row);
      make('strong', { textContent: rule.hostname }, copy);
      make('p', { textContent: t('ruleSummary', { parameters: rule.parameters.length, exceptions: rule.preserveParameters.length + rule.excludedPaths.length }) }, copy);
      make('div', { className: 'link-rule-state', textContent: automaticLabel(rule.hostname) }, copy);
      const actions = make('div', { className: 'link-rule-actions' }, row);
      const toggleLabel = make('label', { className: 'link-rule-enabled' }, actions);
      const toggle = make('input', { type: 'checkbox', checked: rule.enabled }, toggleLabel);
      toggle.setAttribute('aria-label', `${t('enabled')} ${rule.hostname}`);
      make('span', { textContent: t(rule.enabled ? 'enabled' : 'disabled') }, toggleLabel);
      toggle.addEventListener('change', () => void run(async () => {
        await request({ type: 'save-link-rule', rule: { ...rule, enabled: toggle.checked }, expectedRule: rule });
        await load(); status(t('saved'));
      }, `toggle:${rule.hostname}`, true));
      const edit = button(t('edit'), () => openEditor(rule.hostname), actions);
      edit.setAttribute('aria-label', `${t('edit')} ${rule.hostname}`);
    }
    globalAuto.hidden = !automatic.available && !automatic.hosts.length;
    pause.checked = automatic.paused;
    automaticStatus.textContent = automatic.error ? t('autoError') : '';
  }
  function updateEditor() {
    const dirty = hasUnsavedChanges(), invalid = validation();
    save.disabled = busy || !dirty || Boolean(invalid);
    draftState.textContent = !dirty && notice && !noticeFailed ? notice : t(dirty ? 'dirty' : 'savedState');
    error.textContent = (dirty ? invalid : '') || (noticeFailed ? notice : '');
    previewUrl.textContent = sample.value;
    previewNote.textContent = t('previewEmpty');
    if (sample.value.trim()) {
      try {
        const result = cleanLink(sample.value, candidate());
        previewUrl.textContent = result.url;
        previewNote.textContent = result.skip === 'disabled' ? t('skippedDisabled') : result.skip === 'path' ? t('skippedPath') :
          result.removed.length ? t('removed', { names: result.removed.join(', ') }) : t('noChange');
      } catch { previewNote.textContent = invalid || t('hostMismatch'); }
    }
    const automaticEnabled = original && (automatic.hosts.includes(original.hostname) || automatic.installed.includes(original.hostname));
    let automaticCompatible = false;
    if (original) {
      try { automaticCompatible = automaticLinkRules(original).length > 0; } catch {}
    }
    autoState.textContent = original ? automaticLabel(original.hostname) : t('autoOff');
    enableAuto.hidden = Boolean(automaticEnabled) || !automatic.available;
    disableAuto.hidden = !automaticEnabled;
    enableAuto.disabled = busy || dirty || !original || !original.enabled || !automaticCompatible;
    disableAuto.disabled = busy || dirty || !original;
    autoHelp.textContent = dirty || !original || !original.enabled ? t('saveFirst') : !automatic.available || !automaticCompatible ? t('autoUnavailable') : t('accessHint');
    onDirty();
  }
  function show(name, preserveScroll = false) {
    page = name;
    list.panel.hidden = name !== 'list'; editor.panel.hidden = name !== 'editor';
    const surface = name === 'list' ? list : editor;
    if (!preserveScroll) surface.scroll.scrollTop = 0;
    surface.scroll.querySelector('h1').focus({ preventScroll: true });
    onPage({ id: name, section: 'links', title: name === 'list' ? t('title') : editorTitle.textContent, panelId: surface.panel.id });
  }
  async function load() {
    const data = await request({ type: 'get-workspace-tools' });
    const auto = await request({ type: 'get-link-cleanup-state' });
    if (disposed) return;
    rules = data.tools.linkRules; automatic = auto; loaded = true;
    retry.hidden = true; add.disabled = false; renderList();
  }
  async function enter() {
    if (busy || hasUnsavedChanges()) return;
    busy = true; add.disabled = true; status(''); show('list');
    try { await load(); }
    catch { if (!disposed) { loaded = false; status(t('loadFailed'), true); retry.hidden = false; } }
    finally { busy = false; }
  }
  async function run(action, key, independent = false) {
    const now = performance.now();
    // Checkbox reversals are independent choices, not repeated submissions.
    if (busy || !independent && now - (lastMutations.get(key) ?? -Infinity) < 800) return;
    lastMutations.set(key, now); busy = true;
    const controls = [...root.querySelectorAll('button, input, textarea')].map(control => [control, control.disabled]);
    for (const [control] of controls) control.disabled = true;
    let failedMessage;
    try { await action(); }
    catch (failure) { failedMessage = t(failure?.message === 'LINK_RULE_CHANGED' ? 'changedElsewhere' : failure?.message === 'LINK_AUTO_UNSUPPORTED' ? 'autoUnavailable' : 'saveFailed'); }
    finally {
      busy = false;
      for (const [control, disabled] of controls) control.disabled = disabled;
      if (page === 'editor') updateEditor();
      else if (failedMessage) renderList();
      if (failedMessage) status(failedMessage, true);
      onDirty();
    }
  }
  function openEditor(host = null) {
    if (!loaded || busy) return;
    if (hasUnsavedChanges()) { show('editor', true); return; }
    notice = ''; noticeFailed = false;
    original = host ? structuredClone(rules.find(rule => rule.hostname === host)) : null;
    editing = host;
    hostname.value = original?.hostname || ''; enabled.checked = original ? original.enabled : true;
    parameters.value = original?.parameters.join('\n') || '';
    preserve.value = original?.preserveParameters.join('\n') || ''; paths.value = original?.excludedPaths.join('\n') || '';
    sample.value = ''; editorTitle.textContent = t(original ? 'editTitle' : 'addTitle'); remove.hidden = !original;
    editorBaseline = draftValue(); updateEditor(); show('editor'); hostname.focus();
  }
  function confirm(kind, action) {
    if (busy || confirmation.open) return;
    const deleting = kind === 'delete';
    confirmTitle.textContent = t(deleting ? 'deleteTitle' : 'discardTitle');
    confirmBody.textContent = deleting ? t('deleteBody', { hostname: original.hostname }) : t('discardBody');
    keep.textContent = t(deleting ? 'cancel' : 'keepEditing'); accept.textContent = t(deleting ? 'remove' : 'discard');
    pendingConfirmation = action; confirmation.showModal(); keep.focus();
  }
  function discardDraft() { editorBaseline = ''; original = null; editing = null; onDirty(); }
  function guardUnsaved(action) {
    if (busy) return;
    if (!hasUnsavedChanges()) { action(); return; }
    confirm('discard', () => { discardDraft(); onPagesClosed(['editor']); action(); });
  }
  function back() {
    if (busy) return true;
    if (page === 'list') return false;
    guardUnsaved(() => { discardDraft(); show('list'); onPagesClosed(['editor']); }); return true;
  }
  async function enableAutomatic() {
    if (busy || !original || hasUnsavedChanges() || !original.enabled) return;
    try { if (!automaticLinkRules(original).length) return; }
    catch { status(t('autoUnavailable'), true); return; }
    // Keep the browser permission request inside the initiating click's user gesture.
    await run(async () => {
      const granted = await chrome.permissions.request({ origins: [`https://${original.hostname}/*`] });
      if (!granted) { status(t('denied')); return; }
      automatic = await request({ type: 'set-link-cleanup-automatic', hostname: original.hostname, enabled: true });
      updateEditor(); status(t(automatic.error ? 'autoError' : 'autoSaved'), Boolean(automatic.error));
    }, 'enable-auto');
  }
  form.addEventListener('input', () => { status(''); updateEditor(); });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || validation() || !hasUnsavedChanges()) return;
    void run(async () => {
      const next = candidate();
      await request({ type: 'save-link-rule', rule: next, previousHostname: editing, expectedRule: original });
      await load(); original = structuredClone(next); editing = next.hostname; editorBaseline = draftValue();
      editorTitle.textContent = t('editTitle'); remove.hidden = false; updateEditor(); status(t('saved'));
    }, `save:${draftValue()}`);
  });
  pause.addEventListener('change', () => void run(async () => {
    automatic = await request({ type: 'pause-link-cleanup', paused: pause.checked }); renderList(); status(t(automatic.error ? 'autoError' : 'autoSaved'), Boolean(automatic.error));
  }, 'pause', true));
  const storageChanged = (changes, area) => {
    if (area !== 'local' || disposed || busy || root.hidden || page !== 'list' || hasUnsavedChanges()) return;
    if (Object.hasOwn(changes, WORKSPACE_TOOLS_KEY) || Object.hasOwn(changes, 'linkCleanupAutomatic')) void enter();
  };
  chrome.storage.onChanged.addListener(storageChanged);
  const beforeUnload = event => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload, { signal: events.signal });
  return {
    enter, back, guardUnsaved, hasUnsavedChanges, isBusy: () => busy,
    activatePage(name) { if (busy) return; if (name === 'editor' && editorBaseline) show('editor', true); else if (!hasUnsavedChanges()) void enter(); else show('list', true); },
    closePage(name, done) { guardUnsaved(() => { discardDraft(); done(name === 'list' ? ['list', 'editor'] : ['editor']); }); },
    destroy() { disposed = true; events.abort(); confirmation.remove(); root.replaceChildren(); chrome.storage.onChanged.removeListener(storageChanged); },
  };
}
