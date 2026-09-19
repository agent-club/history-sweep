export const demoHistory = Array.from({ length: 124 }, (_, index) => ({
  id: String(index), url: 'https://x.com/' + ['studio_notes', 'design_archive', 'weekend_reads', 'daily_inspiration'][index % 4] + '/status/' + (100000 + index),
  title: ['Studio notes / X', 'A few things worth keeping / X', 'Weekend reading list / X', 'A quieter corner of the internet / X'][index % 4],
  lastVisitTime: Date.UTC(2026, 8, 19, 12) - index * 3600000, visitCount: index % 4 + 1,
})).concat([{ id: 'other', url: 'https://example.org/keep', title: 'A page to keep', lastVisitTime: Date.UTC(2026, 8, 17), visitCount: 2 }]);
export async function installMock(page, records = demoHistory) {
  await page.addInitScript((items) => {
    let history = [...items]; window.__deleted = []; window.__opened = [];
    window.chrome = {
      history: {
        search: async () => { if(window.__failSearch) throw new Error('fixture'); return [...history]; },
        deleteUrl: async ({url}) => { if(window.__failDelete === url) throw new Error('fixture'); window.__deleted.push(url); history = history.filter(item=>item.url!==url); },
        getVisits: async ({url}) => { if(window.__failVerify) throw new Error('fixture'); return history.some(item=>item.url===url)?[{visitId:'1'}]:[]; },
      },
      runtime: { getURL: (path) => 'chrome-extension://illustrative/' + path },
      tabs: { create: async ({url}) => { window.__opened.push(url); } },
    };
  }, records);
}
