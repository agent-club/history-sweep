export function groupHistoryItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.url) continue;
    let key;
    let label;
    try {
      const url = new URL(item.url);
      // Exact hostnames keep unrelated sites and distinct subdomains separate.
      label = url.hostname.toLowerCase().replace(/\.$/, '') || url.protocol;
      key = url.hostname ? `host:${label}` : `scheme:${url.protocol}`;
    } catch {
      // Keep an unparseable result individually selectable without guessing its site.
      key = `url:${item.url}`;
      label = item.url;
    }
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export function groupHistoryByDate(items) {
  const byDay = new Map();
  const unknownItems = [];

  for (const item of items) {
    const timestamp = item?.lastVisitTime;
    if (!Number.isFinite(timestamp)) {
      unknownItems.push(item);
      continue;
    }

    const visited = new Date(timestamp);
    if (!Number.isFinite(visited.getTime())) {
      unknownItems.push(item);
      continue;
    }

    const date = new Date(visited.getFullYear(), visited.getMonth(), visited.getDate());
    const key = [date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0')].join('-');
    if (!byDay.has(key)) byDay.set(key, { key, date, items: [] });
    byDay.get(key).items.push(item);
  }

  const result = [...byDay.values()]
    .sort((left, right) => right.key.localeCompare(left.key))
    .map(day => ({ ...day, groups: groupHistoryItems(day.items) }));

  if (unknownItems.length) {
    result.push({ key: 'unknown', date: null, items: unknownItems, groups: groupHistoryItems(unknownItems) });
  }
  return result;
}
