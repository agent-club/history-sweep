import { readLanguage, translate } from './i18n.mjs';
import { validateConnection, permissionOrigin, createRemote, encryptBackup, decryptBackup } from './config-sync.mjs';
import { createConfigStore } from './config-store.mjs';
import { mountLocalBackup } from './backup-page.mjs';
import { MAX_BACKUP_BYTES } from './local-backup.mjs';
import { workspaceText } from './workspace-copy.mjs';

export function mountSyncSettings(root, { lang = readLanguage(), request } = {}) {
const embedded = root.dataset.embedded === 'true';
root.classList.add('sync-root');
const t = (key, values) => translate(lang, key, values);
const $ = id => root.querySelector(`#${id}`);
const field = (id, label, type = 'text', placeholder = '') => `<label for="${id}">${label}<input id="${id}" type="${type}" ${placeholder ? `placeholder="${placeholder}"` : ''} autocomplete="off" spellcheck="false" maxlength="4096"></label>`;
root.innerHTML = `<header class="sync-heading">${embedded ? '' : '<img src="icons/mark.svg" alt="">'}<div><h1 tabindex="-1">${t('syncSettings')}</h1>${embedded ? '' : '<p>History Sweep</p>'}</div><div id="connectionNotice" class="settings-notice" role="status" aria-live="polite" hidden><span></span><button class="settings-notice-close" type="button" aria-label="${t('syncNoticeDismiss')}">×</button></div></header>
  <p class="sync-note">${t('syncPersistence')}</p>
  <section aria-labelledby="connectionTitle"><h2 id="connectionTitle">${t('syncConnection')}</h2><p>${t('syncConnectionHint')}</p>
    <form id="connectionForm"><fieldset id="connectionFields" disabled>
      <fieldset id="webdavFields">${field('davUrl', t('syncFileUrl'), 'url', 'https://dav.example.com/folder/history-sweep.json')}${field('davUser', t('syncUsername'), 'text', t('syncUsernamePlaceholder'))}${field('davPassword', t('syncAuthLabel'), 'password', t('syncPasswordPlaceholder'))}</fieldset>
      <div class="sync-connection-actions"><button class="primary" type="submit">${t('syncSave')}</button></div>
    </fieldset></form>
  </section>
  <section aria-labelledby="transferTitle"><h2 id="transferTitle">${t('syncTransfer')}</h2><p>${t('syncScope')}</p><p>${t('syncManual')}</p>
    <div class="sync-actions"><button id="testConnection" disabled>${t('syncTest')}</button><button id="uploadConfig" disabled>${t('syncUpload')}</button><button id="downloadConfig" disabled>${t('syncDownload')}</button></div>
  </section>
  <section aria-labelledby="backupTitle"><h2 id="backupTitle">${t('syncBackup')}</h2><p>${t('syncBackupHint')}</p>
    <label for="backupPassword" class="sync-password-field">${t('syncPassphraseLabel')}<input id="backupPassword" type="password" placeholder="${t('syncPassphrasePlaceholder')}" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="backupPasswordHelp"></label>
    <div id="backupPasswordHelp" class="sync-password-help"><span>${t('syncPassphraseExportHint')}</span><span>${t('syncPassphraseImportHint')}</span><span>${t('syncPassphraseKeepHint')}</span></div>
    <div class="sync-file-field"><label for="backupFile">${t('syncBackupFile')}</label>
      <div id="backupFilePicker" class="sync-file-picker">
        <svg class="sync-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>
        <span class="sync-file-copy"><span id="backupFileName" class="sync-file-name">${t('syncFileEmpty')}</span><span id="backupFileHint" class="sync-file-hint">${t('syncFileHint')}</span></span>
        <span class="sync-file-action" aria-hidden="true">${t('syncFileChoose')}</span>
        <input id="backupFile" type="file" accept=".json,application/json" aria-describedby="backupFileHint">
      </div>
    </div>
    <div class="sync-actions"><button id="exportBackup" disabled>${t('syncExport')}</button><button id="importBackup" disabled>${t('syncImport')}</button></div>
  </section><p id="syncStatus" role="status" aria-live="polite"></p>
  <dialog id="restoreDialog" aria-labelledby="restoreTitle"><h2 id="restoreTitle">${t('syncRestoreTitle')}</h2><p id="restoreSummary"></p><form method="dialog"><button value="cancel" autofocus>${t('preferencesCancel')}</button><button value="confirm" class="primary">${t('syncRestore')}</button></form></dialog>`;

const clientId = crypto.randomUUID();
const localBackup = mountLocalBackup(root, { lang, request: request || (async message => {
  const response = await chrome.runtime.sendMessage({ ...message, clientId });
  if (!response?.ok) throw new Error(response?.code || 'BACKGROUND_UNAVAILABLE');
  return response.data;
}) });

let store;
let busy = false;
let ready = false;
let savedConnection = null;
const operations = ['testConnection', 'uploadConfig', 'downloadConfig'];
const davFields = [['url', 'davUrl'], ['username', 'davUser'], ['password', 'davPassword']];
function status(key, error = false) {
  $('syncStatus').textContent = t(key); $('syncStatus').dataset.error = String(error);
}
function formConnection() {
  return validateConnection({ provider: 'webdav', ...Object.fromEntries(davFields.map(([key, id]) => [key, $(id).value])) });
}
function fillConnection(value) {
  if (value === null) return;
  for (const [key, id] of davFields) $(id).value = value[key];
}
function controls() {
  localBackup.setBusy(!ready || busy);
  $('connectionFields').disabled = !ready || busy;
  for (const id of operations) $(id).disabled = !ready || busy || savedConnection === null;
  for (const id of ['exportBackup', 'importBackup', 'backupPassword', 'backupFile']) $(id).disabled = !ready || busy;
  $('backupFilePicker').dataset.disabled = String(!ready || busy);
}
function cleanConnection() {
  if (savedConnection === null) throw new Error('INVALID_CONNECTION');
  if (JSON.stringify(formConnection()) !== JSON.stringify(savedConnection)) throw new Error('UNSAVED_CONNECTION');
  return savedConnection;
}
function hasUnsavedConnection() {
  const values = Object.fromEntries(davFields.map(([key, id]) => [key, $(id).value]));
  if (savedConnection === null) return davFields.some(([, id]) => $(id).value !== '');
  try { return JSON.stringify(formConnection()) !== JSON.stringify(savedConnection); }
  catch { return davFields.some(([key]) => values[key] !== savedConnection[key]); }
}
let noticeTimer;
function connectionNotice(message, { error = false, duration = 0 } = {}) {
  const notice = $('connectionNotice');
  clearTimeout(noticeTimer);
  notice.querySelector('span').textContent = message;
  notice.dataset.error = String(error);
  notice.hidden = !message;
  if (duration > 0) noticeTimer = setTimeout(() => { notice.hidden = true; }, duration);
}
async function run(operation) {
  if (!ready || busy) return;
  busy = true; controls(); status('syncWorking');
  try { await operation(); } catch (error) {
    const key = `syncError_${error.message}`;
    status(t(key) === key ? 'syncError_GENERIC' : key, true);
  } finally { busy = false; controls(); }
}
function confirmRestore(config, connection) {
  const { preferences, historyTags, domainLabels } = config;
  const summary = t('syncRestoreSummary', { language: preferences.language, theme: t(`theme_${preferences.theme}`), launch: t(`launch_${preferences.launchMode}`), tags: Object.keys(historyTags).length, domains: Object.keys(domainLabels).length });
  $('restoreSummary').textContent = `${summary}\n${connection ? t('syncRestoreConnection') : t('syncRestoreNoConnection')}`;
  const dialog = $('restoreDialog'); dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
}
async function apply(config, connection) {
  if (!await confirmRestore(config, connection)) { status('syncCancelled'); return; }
  await store.apply(config, connection);
  if (connection) { savedConnection = connection; fillConnection(connection); connectionNotice(''); }
  document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: config.preferences.theme }));
  status('syncRestored');
}

$('connectionForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!ready || busy) return;
  busy = true; controls(); connectionNotice('');
  void (async () => {
    try {
      const config = formConnection();
      await store.saveConnection(config); savedConnection = config;
      connectionNotice(t('syncSaveSuccess'), { duration: 2800 });
    } catch (error) {
      const key = `syncError_${error.message}`;
      connectionNotice(t(t(key) === key ? 'syncSaveFailure' : key), { error: true });
    } finally { busy = false; controls(); }
  })();
});
root.querySelector('.settings-notice-close').addEventListener('click', () => connectionNotice(''));
for (const [, id] of davFields) $(id).addEventListener('input', () => {
  if (hasUnsavedConnection()) connectionNotice(t('syncUnsavedConnection'));
  else connectionNotice('');
});
for (const id of operations) $(id).addEventListener('click', () => {
  if (!ready || busy) return;
  let config;
  try { config = cleanConnection(); } catch (error) { status(`syncError_${error.message}`, true); return; }
  if (id === 'uploadConfig' && !confirm(t('syncUploadConfirm'))) return;
  // Keep the optional permission request inside the user gesture.
  const permission = chrome.permissions.request({ origins: [permissionOrigin(config)] });
  void run(async () => {
    if (!await permission) throw new Error('PERMISSION_REQUIRED');
    const remote = createRemote(config); const previous = await remote.read();
    if (id === 'testConnection') { status(previous === null ? 'syncMissing' : 'syncConnected'); return; }
    if (id === 'uploadConfig') { await remote.write(await store.read(), previous); status('syncUploaded'); return; }
    if (previous === null) throw new Error('REMOTE_MISSING');
    await apply(previous.config);
  });
});
$('exportBackup').addEventListener('click', () => void run(async () => {
  if (hasUnsavedConnection()) throw new Error('UNSAVED_CONNECTION');
  const text = await encryptBackup(savedConnection, await store.read(), $('backupPassword').value, await localBackup.readExtra());
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'history-sweep-backup.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); $('backupPassword').value = ''; status('syncExported');
}));
$('importBackup').addEventListener('click', () => void run(async () => {
  const file = $('backupFile').files[0];
  if (!file || file.size > MAX_BACKUP_BYTES) throw new Error('INVALID_BACKUP');
  const backup = await decryptBackup(await file.text(), $('backupPassword').value);
  $('backupPassword').value = '';
  if (backup.localSettings !== undefined) {
    const result = await localBackup.restore(backup);
    if (!result.restored) { status('syncCancelled'); return; }
    if (result.connectionRestored) { savedConnection = backup.connection; fillConnection(savedConnection); connectionNotice(''); }
    if (result.schedulePending) { $('syncStatus').textContent = workspaceText(lang, 'schedulePending'); return; }
    status('syncRestored');
  } else await apply(backup.config, backup.connection);
}));
$('backupFile').addEventListener('change', () => {
  const file = $('backupFile').files[0];
  $('backupFileName').textContent = file ? file.name : t('syncFileEmpty');
  $('backupFileName').title = file ? file.name : '';
  $('backupFilePicker').dataset.selected = String(!!file);
  $('backupFilePicker').querySelector('.sync-file-action').textContent = t(file ? 'syncFileChange' : 'syncFileChoose');
});

async function initialize() {
try {
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.permissions) throw new Error('EXTENSION_REQUIRED');
  store = createConfigStore(chrome.storage.local, localStorage);
  // Keep import and editing available if an existing saved document is corrupt.
  ready = true;
  savedConnection = await store.connection(); fillConnection(savedConnection); await store.read();
} catch (error) { status(error.message === 'EXTENSION_REQUIRED' ? 'syncError_EXTENSION_REQUIRED' : 'syncError_GENERIC', true); }
controls();

}
void initialize();
return { isBusy: () => busy };
}

const standalone = document.getElementById('syncApp');
if (standalone) {
  const lang = readLanguage();
  document.documentElement.lang = lang;
  document.title = `${translate(lang, 'syncTitle')} — History Sweep`;
  mountSyncSettings(standalone, { lang });
}
