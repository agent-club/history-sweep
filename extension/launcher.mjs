import { injectModal } from './modal-host.mjs';
const MODES = new Set(['popup', 'modal', 'fullpage']);
const KEY = 'modalLaunchSessions';
const TTL = 60_000;
export function createLauncher(chromeApi) {
  let mode = 'popup';
  let registered = false;
  let queue = Promise.resolve();
  let ready = Promise.resolve();
  function serial(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }
  const pageUrl = (page, hash = '') => `${chromeApi.runtime.getURL(page)}${hash}`;
  async function readSessions() {
    const saved = await chromeApi.storage.session.get(KEY);
    const value = saved?.[KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  async function writeSessions(sessions) {
    if (Object.keys(sessions).length) await chromeApi.storage.session.set({ [KEY]: sessions });
    else await chromeApi.storage.session.remove(KEY);
  }
  async function applyMode(value) {
    mode = MODES.has(value) ? value : 'popup';
    await chromeApi.action.setPopup({ popup: mode === 'popup' ? 'popup.html' : '' });
    return mode;
  }
  async function refreshMode() {
    return serial(async () => {
      const saved = await chromeApi.storage.local.get('launchMode');
      return applyMode(saved?.launchMode);
    });
  }
  const openManager = (hash = '') => chromeApi.tabs.create({ url: pageUrl('manager.html', hash) });
  function exactSender(sender, token) {
    if (sender?.id !== chromeApi.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id) ||
        !Number.isInteger(sender.frameId) || sender.frameId <= 0 ||
        typeof sender.documentId !== 'string' || !sender.documentId) return false;
    try {
      const actual = new URL(sender.url);
      const expected = new URL(chromeApi.runtime.getURL('modal.html'));
      return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname &&
        actual.search === '' && actual.hash === `#launch=${encodeURIComponent(token)}`;
    } catch { return false; }
  }
  async function discardSession(token) {
    await serial(async () => {
      const sessions = await readSessions();
      if (Object.hasOwn(sessions, token)) {
        delete sessions[token];
        await writeSessions(sessions);
      }
    });
  }
  async function launchModal(tab) {
    if (!Number.isInteger(tab?.id) || !/^https?:\/\//i.test(tab.url ?? '')) {
      return openManager('#modalUnavailable');
    }
    const key = globalThis.crypto.randomUUID();
    await serial(async () => {
      const sessions = await readSessions();
      for (const [oldKey, value] of Object.entries(sessions)) {
        if (!value || value.expires <= Date.now()) delete sessions[oldKey];
      }
      sessions[key] = { tabId: tab.id, expires: Date.now() + TTL };
      await writeSessions(sessions);
    });
    try {
      const result = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED', func: injectModal,
        args: [pageUrl('modal.html', `#launch=${encodeURIComponent(key)}`)],
      });
      const opened = result?.[0]?.result?.opened;
      if (opened !== true) {
        await discardSession(key);
        if (opened !== false) await openManager('#modalUnavailable');
      }
    } catch {
      await discardSession(key);
      await openManager('#modalUnavailable');
    }
  }
  async function launch(tab) {
    if (mode === 'fullpage') return openManager();
    if (mode === 'modal') return launchModal(tab);
  }
  function onChanged(changes, area) {
    if (area === 'local' && changes?.launchMode) void refreshMode().catch(() => {});
  }
  function onRemoved(tabId) {
    void serial(async () => {
      const sessions = await readSessions();
      let changed = false;
      for (const [key, value] of Object.entries(sessions)) {
        if (value?.tabId === tabId) { delete sessions[key]; changed = true; }
      }
      if (changed) await writeSessions(sessions);
    }).catch(() => {});
  }
  async function claimModal(token, sender) {
    if (typeof token !== 'string' || !token || !exactSender(sender, token)) return false;
    return serial(async () => {
      const sessions = await readSessions();
      const current = sessions[token];
      if (!current || current.expires <= Date.now() || current.tabId !== sender.tab.id || current.claim) return false;
      current.claim = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
      delete current.expires;
      await writeSessions(sessions);
      return true;
    });
  }
  async function isTrustedModal(sender) {
    if (sender?.id !== chromeApi.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id) ||
        !Number.isInteger(sender.frameId) || sender.frameId <= 0 || typeof sender.documentId !== 'string') return false;
    let key;
    try {
      const url = new URL(sender.url);
      const expected = new URL(chromeApi.runtime.getURL('modal.html'));
      if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.search) return false;
      const params = new URLSearchParams(url.hash.slice(1));
      key = params.get('launch');
      if (!key || params.size !== 1) return false;
    } catch { return false; }
    return serial(async () => {
      const record = (await readSessions())[key]?.claim;
      return !!record && record.tabId === sender.tab.id && record.frameId === sender.frameId &&
        record.documentId === sender.documentId;
    });
  }
  return {
    register() {
      if (!registered) {
        registered = true;
        chromeApi.action.onClicked.addListener(tab => { void ready.then(() => launch(tab)).catch(() => {}); });
        const reloadMode = () => { void refreshMode().catch(() => {}); };
        chromeApi.runtime.onStartup.addListener(reloadMode);
        chromeApi.runtime.onInstalled.addListener(reloadMode);
        chromeApi.storage.onChanged.addListener(onChanged);
        chromeApi.tabs.onRemoved.addListener(onRemoved);
        ready = refreshMode();
      }
      return ready;
    },
    async getMode() { await ready; return mode; },
    async setMode(value) {
      if (!MODES.has(value)) throw new TypeError('Invalid launch mode');
      return serial(async () => {
        await chromeApi.storage.local.set({ launchMode: value });
        return applyMode(value);
      });
    },
    claimModal,
    isTrustedModal,
  };
}
