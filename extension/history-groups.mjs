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
