// Local daily totals and one minimal summary per website. Full URLs never enter storage.
export function createActivityLog(storage, now = () => new Date()) {
  let queue = Promise.resolve();
  let recordingFailed = false;
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  async function readLog() {
    const { localActivity } = await storage.get('localActivity');
    if (localActivity === undefined) {
      const fresh = { version: 1, startedOn: dateKey(now()), days: {} };
      await storage.set({ localActivity: fresh });
      return fresh;
    }
    if (localActivity?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(localActivity.startedOn) ||
        !localActivity.days || typeof localActivity.days !== 'object' || Array.isArray(localActivity.days) ||
        !Object.entries(localActivity.days).every(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          Number.isSafeInteger(day?.operations) && day.operations >= 0 && Number.isSafeInteger(day.pages) && day.pages >= 0 &&
          (day.websites === undefined || (Array.isArray(day.websites) && typeof day.websitesComplete === 'boolean' && day.websites.every(site =>
            typeof site?.domain === 'string' && site.domain.length > 0 &&
            (site.title === undefined || typeof site.title === 'string') &&
            (site.lastVisitTime === undefined || (Number.isFinite(site.lastVisitTime) && site.lastVisitTime > 0))))))) {
      throw new Error('ACTIVITY_UNAVAILABLE');
    }
    return localActivity;
  }
  return {
    read: () => serial(async () => ({ log: await readLog(), recordingFailed })),
    record: (pages, items = []) => serial(async () => {
      try {
        if (!Number.isSafeInteger(pages) || pages < 0) throw new Error('INVALID_ACTIVITY_COUNT');
        const log = await readLog();
        const date = dateKey(now());
        const previous = log.days[date];
        const day = { operations: previous ? previous.operations + 1 : 1, pages: previous ? previous.pages + pages : pages };
        const websites = new Map((previous?.websites || []).map(site => [site.domain, site]));
        let identified = 0;
        for (const item of items) {
          let domain;
          try { domain = new URL(item.url).hostname; } catch { continue; }
          if (!domain) continue;
          identified++;
          const site = { domain };
          if (typeof item.title === 'string' && item.title) site.title = item.title;
          if (Number.isFinite(item.lastVisitTime) && item.lastVisitTime > 0) site.lastVisitTime = item.lastVisitTime;
          const old = websites.get(domain);
          if (!old || (site.lastVisitTime !== undefined && (old.lastVisitTime === undefined || site.lastVisitTime > old.lastVisitTime))) websites.set(domain, site);
        }
        if (websites.size) {
          day.websites = [...websites.values()].sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0) || a.domain.localeCompare(b.domain));
          // Legacy totals cannot be reconstructed after deletion, including on a mixed old/new day.
          day.websitesComplete = (!previous || previous.pages === 0 || previous.websitesComplete === true) && identified === pages;
        }
        await storage.set({ localActivity: { ...log, days: { ...log.days, [date]: day } } });
        recordingFailed = false;
      } catch (error) { recordingFailed = true; throw error; }
    }),
  };
}
