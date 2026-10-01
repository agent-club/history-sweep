export const defaultTimeFilter = () => ({ range: 'all', startDate: '', endDate: '' });

export function resolveTimeRange(filter, now = new Date()) {
  if (!filter || !['all', 'today', '7days', '30days', 'custom'].includes(filter.range) ||
      typeof filter.startDate !== 'string' || typeof filter.endDate !== 'string') throw new Error('INVALID_TIME_RANGE');
  if (filter.range === 'all') return null;
  const date = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_TIME_RANGE');
    const [year, month, day] = value.split('-').map(Number);
    const result = new Date(year, month - 1, day);
    if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) throw new Error('INVALID_TIME_RANGE');
    return result;
  };
  let start, end;
  if (filter.range === 'custom') {
    start = date(filter.startDate); end = date(filter.endDate);
    if (start > end) throw new Error('INVALID_TIME_RANGE');
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start);
    start.setDate(start.getDate() - ({ today: 0, '7days': 6, '30days': 29 })[filter.range]);
  }
  // Use local calendar days and an exclusive next-day boundary, including on DST days.
  end.setDate(end.getDate() + 1);
  return { startTime: start.getTime(), endTime: end.getTime() };
}

export function filterByTime(items, range) {
  if (!range) return items;
  return items.filter(item => Number.isFinite(item.lastVisitTime) && item.lastVisitTime >= range.startTime && item.lastVisitTime < range.endTime);
}

export function parseProtectedSites(input) {
  if (typeof input !== 'string' || input.length > 20000) throw new Error('INVALID_PROTECTED_SITES');
  const sites = input.split(/[\s,，;；]+/).filter(Boolean).map(entry => {
    // Accept hostnames only, so a path, port or wildcard cannot silently broaden a rule.
    if (!/^[\p{L}\p{N}.-]+$/u.test(entry)) throw new Error('INVALID_PROTECTED_SITES');
    let hostname;
    try { hostname = new URL('https://' + entry).hostname.toLowerCase().replace(/\.$/, ''); }
    catch { throw new Error('INVALID_PROTECTED_SITES'); }
    if (!hostname || hostname.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) throw new Error('INVALID_PROTECTED_SITES');
    return hostname;
  });
  return [...new Set(sites)].sort();
}

export function isProtectedUrl(value, sites) {
  let hostname;
  try { hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  return sites.some(site => hostname === site || hostname.endsWith(`.${site}`));
}
