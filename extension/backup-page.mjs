import { validateLocalBackup } from './local-backup.mjs';
import { workspaceText } from './workspace-copy.mjs';
import { translate } from './i18n.mjs';

const node = (tag, properties, parent) => { const element = document.createElement(tag); Object.assign(element, properties); parent.append(element); return element; };

export function mountLocalBackup(root, { lang, request }) {
  const t = (key, values) => workspaceText(lang, key, values);
  const options = node('div', { className: 'wt-backup-options' }, root.querySelector('[aria-labelledby=backupTitle]'));
  root.querySelector('#backupPassword').closest('label').before(options);
  node('strong', { textContent: t('backupInclude') }, options);
  node('p', { className: 'wt-note', textContent: t('backupIncludeHint') }, options);
  const checks = new Map();
  for (const [section, label] of [['protection', 'backupProtection'], ['browsing', 'backupBrowsing'], ['tasks', 'backupTasks']]) {
    const row = node('label', { className: 'wt-checkbox-row' }, options);
    const input = node('input', { type: 'checkbox', value: section }, row); input.dataset.backupSection = section;
    node('span', { textContent: t(label) }, row); checks.set(section, input);
  }

  const dialog = node('dialog', { className: 'wt-dialog', id: 'localRestoreDialog' }, root);
  dialog.setAttribute('aria-labelledby', 'localRestoreTitle');
  const heading = node('header', { className: 'wt-dialog-header' }, dialog);
  node('h2', { id: 'localRestoreTitle', textContent: t('restoreSelection') }, heading);
  const form = node('form', { method: 'dialog' }, dialog);
  const body = node('div', { className: 'wt-dialog-body' }, form);
  const actions = node('footer', { className: 'wt-actions wt-dialog-actions' }, form);
  node('button', { value: 'cancel', textContent: t('cancel') }, actions);
  const confirm = node('button', { value: 'confirm', className: 'primary', textContent: t('restoreConfirm') }, actions);

  async function readExtra() {
    const sections = [...checks].filter(([, input]) => input.checked).map(([section]) => section);
    if (!sections.length) return undefined;
    const current = await request({ type: 'get-local-backup' });
    return validateLocalBackup(Object.fromEntries(sections.map(section => [section, current[section]])));
  }

  async function restore(backup) {
    const local = validateLocalBackup(backup.localSettings);
    const current = await request({ type: 'get-local-backup' });
    body.replaceChildren();
    node('p', { className: 'wt-note', textContent: t('restoreHint') }, body);
    const selected = new Map();
    const row = (key, label, summary, checked = true) => {
      const container = node('div', { className: 'wt-restore-row' }, body);
      const labelNode = node('label', { className: 'wt-checkbox-row' }, container);
      const input = node('input', { type: 'checkbox', value: key, checked }, labelNode);
      node('span', { textContent: t(label) }, labelNode);
      if (summary) node('small', { textContent: summary }, container);
      selected.set(key, input); return container;
    };
    const { preferences } = backup.config;
    row('preferences', 'restorePreferences', `${preferences.language === 'zh-CN' ? '简体中文' : 'English'} · ${translate(lang, `theme_${preferences.theme}`)} · ${translate(lang, `launch_${preferences.launchMode}`)}`);
    if (Object.hasOwn(local, 'protection')) {
      const summary = value => `${t('sites', { n: value.sites.length })} · ${t('urls', { n: value.urls.length })}`;
      const container = row('protection', 'backupProtection', t('restoreDiff', { old: summary(current.protection), next: summary(local.protection) }));
      const diff = node('details', { className: 'wt-restore-diff' }, container);
      node('summary', { textContent: t('backupProtection') }, diff);
      for (const [label, value] of [[lang === 'zh-CN' ? '当前' : 'Current', current.protection], [lang === 'zh-CN' ? '备份' : 'Backup', local.protection]]) {
        const field = node('label', { className: 'wt-field' }, diff);
        node('span', { textContent: label }, field);
        node('textarea', { readOnly: true, rows: 4, value: [...value.sites, ...value.urls].join('\n') }, field);
      }
    }
    if (Object.hasOwn(local, 'browsing')) row('browsing', 'backupBrowsing', `${t(`view_${local.browsing.view}`)} · ${t(`range_${local.browsing.range}`)}`);
    if (Object.hasOwn(local, 'tasks')) {
      const container = row('tasks', 'backupTasks', t('tasks', { n: local.tasks.length }));
      const list = node('div', { className: 'wt-restore-diff' }, container);
      for (const rule of local.tasks) node('p', { className: 'wt-url', textContent: [rule.domain, rule.includeSubdomains ? t('subdomains') : '', rule.days === null ? '' : t('inactivity', { n: rule.days })].filter(Boolean).join(' · ') }, list);
      node('p', { className: 'wt-note', textContent: t('pausedTasks') }, body);
    }
    if (backup.connection) row('connection', 'restoreConnection', backup.connection.url, false);
    node('p', { className: 'wt-note', textContent: t('noHistoryBackup') }, body);
    const update = () => { confirm.disabled = ![...selected.values()].some(input => input.checked); };
    for (const input of selected.values()) input.addEventListener('change', update);
    update(); dialog.returnValue = '';
    const approved = await new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal(); actions.querySelector('button').focus();
    });
    if (!approved) return { restored: false };
    const sections = [...selected].filter(([, input]) => input.checked).map(([section]) => section);
    const restorePreferences = sections.includes('preferences');
    const old = Object.fromEntries(['language', 'theme'].map(key => [key, localStorage.getItem(key)]));
    let response;
    try {
      if (restorePreferences) {
        localStorage.setItem('language', preferences.language); localStorage.setItem('theme', preferences.theme);
      }
      response = await request({ type: 'restore-local-backup', config: backup.config, localSettings: local,
        sections, ...(sections.includes('connection') ? { connection: backup.connection } : {}) });
    } catch (error) {
      if (restorePreferences) for (const [key, value] of Object.entries(old)) {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
      }
      throw error;
    }
    if (restorePreferences) document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: preferences.theme }));
    return { restored: true, connectionRestored: sections.includes('connection'), schedulePending: response.schedulePending };
  }
  return { readExtra, restore, setBusy: busy => { for (const input of checks.values()) input.disabled = busy; } };
}
