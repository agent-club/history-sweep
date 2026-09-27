import { readFile } from 'node:fs/promises';
const backgroundSource = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');

export const demoHistory = Array.from({ length: 124 }, (_, index) => ({
  id: String(index), url: 'https://x.com/' + ['studio_notes', 'design_archive', 'weekend_reads', 'daily_inspiration'][index % 4] + '/status/' + (100000 + index),
  title: ['Studio notes / X', 'A few things worth keeping / X', 'Weekend reading list / X', 'A quieter corner of the internet / X'][index % 4],
  lastVisitTime: Date.UTC(2026, 8, 19, 12) - index * 3600000, visitCount: index % 4 + 1,
})).concat([{ id: 'other', url: 'https://example.org/keep', title: 'A page to keep', lastVisitTime: Date.UTC(2026, 8, 17), visitCount: 2 }]);
export async function installMock(page, records = demoHistory) {
  await page.addInitScript((items) => {
    const history = new Map(items.map(item => [item.url, item])); window.__deleted = []; window.__opened = []; window.__messages = [];
    window.chrome = {
      history: {
        search: async ({maxResults}) => { if(window.__failSearch) throw new Error('fixture'); return [...history.values()].slice(0,maxResults); },
        deleteUrl: async ({url}) => { if(window.__failDelete === url) throw new Error('fixture'); window.__deleted.push(url); history.delete(url); },
        getVisits: async ({url}) => { if(window.__failVerify) throw new Error('fixture'); return history.has(url)?[{visitId:'1'}]:[]; },
      },
      runtime: {
        id: 'illustrative', getURL: (path) => 'chrome-extension://illustrative/' + path,
        onMessage: { addListener: listener => { window.__backgroundListener = listener; } },
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
      tabs: { create: async ({url}) => { window.__opened.push(url); } },
    };
  }, records);
  // Exercise the production message handler rather than a second implementation.
  await page.addInitScript(backgroundSource);
}
