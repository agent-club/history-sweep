import { readFile } from 'node:fs/promises';
const backgroundSource = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
const filterSource = (await readFile(new URL('../extension/history-filters.mjs', import.meta.url), 'utf8')).replace(/\bexport /g, '');
const launcherSource = (await readFile(new URL('../extension/launcher.mjs', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replace(/\bexport /g, '');
const modalHostSource = (await readFile(new URL('../extension/modal-host.mjs', import.meta.url), 'utf8')).replace(/\bexport /g, '');

export const demoHistory = Array.from({ length: 124 }, (_, index) => ({
  id: String(index), url: 'https://x.com/' + ['studio_notes', 'design_archive', 'weekend_reads', 'daily_inspiration'][index % 4] + '/status/' + (100000 + index),
  title: ['Studio notes / X', 'A few things worth keeping / X', 'Weekend reading list / X', 'A quieter corner of the internet / X'][index % 4],
  lastVisitTime: Date.UTC(2026, 8, 19, 12) - index * 3600000, visitCount: index % 4 + 1,
})).concat([{ id: 'other', url: 'https://example.org/keep', title: 'A page to keep', lastVisitTime: Date.UTC(2026, 8, 17), visitCount: 2 }]);
export async function installMock(page, records = demoHistory) {
  await page.addInitScript((items) => {
    const history = new Map(items.map(item => [item.url, item])); window.__deleted = []; window.__opened = []; window.__messages = [];
    const listeners = [];
    const updateListeners = [];
    const sessions = {};
    const changed = (changes, area = 'local') => listeners.forEach(listener => listener(changes, area));
    window.__updateAvailable = version => updateListeners.forEach(listener => listener({ version }));
    window.addEventListener('storage', event => { if (event.key === 'fixture-kept-sites') changed({ protectedSites: {} }); });
    window.chrome = {
      history: {
        search: async ({maxResults, startTime, endTime}) => { if(window.__failSearch) throw new Error('fixture'); return [...history.values()].filter(item => (startTime === 0 || item.lastVisitTime >= startTime) && (endTime === undefined || item.lastVisitTime <= endTime)).slice(0,maxResults); },
        deleteUrl: async ({url}) => { if(window.__failDelete === url) throw new Error('fixture'); window.__deleted.push(url); history.delete(url); },
        getVisits: async ({url}) => { if(window.__failVerify) throw new Error('fixture'); return history.has(url)?[{visitId:'1'}]:[]; },
      },
      runtime: {
        id: 'illustrative', getURL: (path) => 'chrome-extension://illustrative/' + path,
        getManifest: () => ({ version: '0.3.1' }),
        reload: () => { window.__reloads = (window.__reloads || 0) + 1; },
        onUpdateAvailable: { addListener: listener => { updateListeners.push(listener); } },
        onMessage: { addListener: listener => { window.__backgroundListener = listener; } },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: message => {
          window.__messages.push(message);
          if (window.__backgroundUnavailable) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
          if (window.__failMessage) return Promise.reject(new Error('fixture'));
          return new Promise((resolve, reject) => {
            const path = location.pathname.split('/').at(-1);
            const sender = path === 'popup.html'
              ? { id: 'illustrative', url: 'chrome-extension://illustrative/popup.html' }
              : { id: 'illustrative', frameId: 0, documentId: 'fixture-page', url: 'chrome-extension://illustrative/' + path };
            if (!window.__backgroundListener(message, sender, resolve)) reject(new Error('fixture'));
          });
        },
      },
      tabs: { create: async ({url}) => { window.__opened.push(url); }, query: async () => [{ url: window.__activeUrl || 'https://x.com/current' }], onRemoved: { addListener: () => {} } },
      action: { setPopup: async ({ popup }) => { window.__actionPopup = popup; }, onClicked: { addListener: callback => { window.__actionClicked = callback; } } },
      scripting: { executeScript: async () => { throw new Error('Injection requires a host-page fixture'); } },
      i18n: { getMessage: () => 'Find this website in History Sweep' },
      contextMenus: { create: () => {}, onClicked: { addListener: callback => { window.__menuClicked = callback; } } },
      storage: {
        local: {
          get: async key => {
            if (key === 'launchMode') { const launchMode = localStorage.getItem('fixture-launch-mode'); return launchMode === null ? {} : { launchMode }; }
            if (window.__failRulesRead) throw new Error('fixture'); const value = localStorage.getItem('fixture-kept-sites'); return value === null ? {} : { protectedSites: JSON.parse(value) };
          },
          set: async data => {
            if (Object.hasOwn(data, 'launchMode')) { localStorage.setItem('fixture-launch-mode', data.launchMode); changed({ launchMode: { newValue: data.launchMode } }); }
            if (Object.hasOwn(data, 'protectedSites')) {
              if (window.__failRulesSave) throw new Error('fixture'); localStorage.setItem('fixture-kept-sites', JSON.stringify(data.protectedSites)); changed({ protectedSites: { newValue: data.protectedSites } });
            }
          },
        },
        session: { get: async () => structuredClone(sessions), set: async data => {
          const changes = Object.fromEntries(Object.entries(data).filter(([key, value]) => JSON.stringify(sessions[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { newValue: structuredClone(value) }]));
          Object.assign(sessions, structuredClone(data)); if (Object.keys(changes).length) changed(changes, 'session');
        }, remove: async key => { delete sessions[key]; } },
        onChanged: { addListener: listener => { listeners.push(listener); } },
      },
    };
  }, records);
  // Exercise the production message handler rather than a second implementation.
  await page.addInitScript(modalHostSource + '\n' + launcherSource + '\n' + filterSource + '\n' + backgroundSource);
}
