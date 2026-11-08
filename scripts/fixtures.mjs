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
    const tabUpdateListeners = [];
    const sessions = {};
    const changed = (changes, area = 'local') => listeners.forEach(listener => listener(changes, area));
    window.__updateAvailable = version => updateListeners.forEach(listener => listener({ version }));
    window.__changeActiveUrl = url => {
      window.__activeUrl = url;
      tabUpdateListeners.forEach(listener => listener(1, { status: 'complete' }, { active: true, url }));
    };
    window.addEventListener('storage', event => { if (event.key === 'fixture-kept-sites') changed({ protectedSites: {} }); });
    window.chrome = {
      history: {
        search: async ({maxResults, startTime, endTime}) => {
          if(window.__failSearch) throw new Error('fixture');
          return [...history.values()].filter(item => item.visits
            ? item.visits.some(visit => visit.visitTime >= startTime && (endTime === undefined || visit.visitTime <= endTime))
            : (startTime === 0 || item.lastVisitTime >= startTime) && (endTime === undefined || item.lastVisitTime <= endTime)).slice(0,maxResults);
        },
        deleteUrl: async ({url}) => { if(window.__failDelete === url) throw new Error('fixture'); window.__deleted.push(url); history.delete(url); },
        getVisits: async ({url}) => {
          if(window.__failVerify || window.__failVisits === url) throw new Error('fixture');
          const item = history.get(url);
          if (!item) return [];
          return item.visits || Array.from({ length: item.visitCount || 1 }, (_, index) => ({ visitId: String(index), visitTime: item.lastVisitTime - index }));
        },
      },
      management: { getSelf: async () => ({ id: 'illustrative', installType: 'development' }) },
      runtime: {
        id: 'illustrative', getURL: (path) => 'chrome-extension://illustrative/' + path,
        getManifest: () => ({ version: '0.3.1' }),
        reload: () => { window.__reloads = (window.__reloads || 0) + 1; },
        onUpdateAvailable: { addListener: listener => { updateListeners.push(listener); } },
        onMessage: { addListener: listener => { window.__backgroundListener = listener; } },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: async message => {
          await window.__backgroundReady;
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
      tabs: {
        create: async ({url}) => { window.__opened.push(url); },
        query: async () => [{ url: window.__activeUrl || 'https://x.com/current' }],
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: listener => { tabUpdateListeners.push(listener); } },
      },
      action: { setPopup: async ({ popup }) => { window.__actionPopup = popup; }, onClicked: { addListener: callback => { window.__actionClicked = callback; } } },
      scripting: { executeScript: async () => { throw new Error('Injection requires a host-page fixture'); } },
      i18n: { getMessage: () => 'Find this website in History Sweep' },
      contextMenus: { create: () => {}, onClicked: { addListener: callback => { window.__menuClicked = callback; } } },
      storage: {
        local: {
          get: async key => {
            if (['workspaceTools', 'manualCleanupState', 'ratingInviteShown'].includes(key)) { const value = localStorage.getItem('fixture-' + key); return value === null ? {} : { [key]: JSON.parse(value) }; }
            if (key === 'nameplate') { const value = localStorage.getItem('fixture-nameplate'); return value === null ? {} : { nameplate: JSON.parse(value) }; }
            if (key === 'extensionUpdateCheck') { const value = localStorage.getItem('fixture-update-check'); return value === null ? {} : { extensionUpdateCheck: JSON.parse(value) }; }
            if (key === 'activityScrollHint') { const value = localStorage.getItem('fixture-activity-scroll-hint'); return value === null ? {} : { activityScrollHint: JSON.parse(value) }; }
            if (key === 'localActivity') {
              if (window.__failActivityRead) throw new Error('fixture');
              const value = localStorage.getItem('fixture-activity'); return value === null ? {} : { localActivity: JSON.parse(value) };
            }
            if (key === 'browsingPreferences') { const value = localStorage.getItem('fixture-browsing-preferences'); return value === null ? {} : { browsingPreferences: JSON.parse(value) }; }
            if (key === 'privateCleanup') { if (window.__failPrivacyRead) throw new Error('fixture'); const value = localStorage.getItem('fixture-private-cleanup'); return value === null ? {} : { privateCleanup: JSON.parse(value) }; }
            if (key === 'softPrivacy') { if (window.__failSoftPrivacyRead) throw new Error('fixture'); const value = localStorage.getItem('fixture-soft-privacy'); return value === null ? {} : { softPrivacy: JSON.parse(value) }; }
            if (key === 'launchMode') { const launchMode = localStorage.getItem('fixture-launch-mode'); return launchMode === null ? {} : { launchMode }; }
            if (['cleanupRecommendationSettings', 'cleanupRecommendationCue'].includes(key)) { if (key === 'cleanupRecommendationSettings' && window.__failRecommendationRead) throw new Error('fixture'); const value = localStorage.getItem('fixture-' + key); return value === null ? {} : { [key]: JSON.parse(value) }; }
            if (window.__failRulesRead) throw new Error('fixture'); const value = localStorage.getItem('fixture-kept-sites'); return value === null ? {} : { protectedSites: JSON.parse(value) };
          },
          remove: async key => { localStorage.removeItem('fixture-' + key); changed({ [key]: {} }); },
          set: async data => {
            for (const key of ['workspaceTools', 'manualCleanupState', 'ratingInviteShown']) if (Object.hasOwn(data, key)) { localStorage.setItem('fixture-' + key, JSON.stringify(data[key])); changed({ [key]: { newValue: data[key] } }); }
            for (const key of ['cleanupRecommendationSettings', 'cleanupRecommendationCue']) if (Object.hasOwn(data, key)) { if (key === 'cleanupRecommendationSettings' && window.__failRecommendationSave) throw new Error('fixture'); localStorage.setItem('fixture-' + key, JSON.stringify(data[key])); changed({ [key]: { newValue: data[key] } }); }
            if (Object.hasOwn(data, 'nameplate')) localStorage.setItem('fixture-nameplate', JSON.stringify(data.nameplate));
            if (Object.hasOwn(data, 'extensionUpdateCheck')) { localStorage.setItem('fixture-update-check', JSON.stringify(data.extensionUpdateCheck)); changed({ extensionUpdateCheck: { newValue: data.extensionUpdateCheck } }); }
            if (Object.hasOwn(data, 'activityScrollHint')) { localStorage.setItem('fixture-activity-scroll-hint', JSON.stringify(data.activityScrollHint)); changed({ activityScrollHint: { newValue: data.activityScrollHint } }); }
            if (Object.hasOwn(data, 'localActivity')) {
              if (window.__failActivitySave) throw new Error('fixture');
              localStorage.setItem('fixture-activity', JSON.stringify(data.localActivity)); changed({ localActivity: { newValue: data.localActivity } });
            }
            if (Object.hasOwn(data, 'browsingPreferences')) { if (window.__failBrowsingSave) throw new Error('fixture'); localStorage.setItem('fixture-browsing-preferences', JSON.stringify(data.browsingPreferences)); changed({ browsingPreferences: { newValue: data.browsingPreferences } }); }
            if (Object.hasOwn(data, 'privateCleanup')) { if (window.__failPrivacySave) throw new Error('fixture'); localStorage.setItem('fixture-private-cleanup', JSON.stringify(data.privateCleanup)); changed({ privateCleanup: { newValue: data.privateCleanup } }); }
            if (Object.hasOwn(data, 'softPrivacy')) { if (window.__failSoftPrivacySave) throw new Error('fixture'); localStorage.setItem('fixture-soft-privacy', JSON.stringify(data.softPrivacy)); changed({ softPrivacy: { newValue: data.softPrivacy } }); }
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
  // Load the real module graph so new worker dependencies cannot silently disappear
  // from the fixture. Message dispatch waits for listener registration.
  await page.addInitScript(() => {
    window.__backgroundReady = import(new URL('/extension/background.mjs', location.href).href);
  });
}
