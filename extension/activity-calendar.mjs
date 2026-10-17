import { formatDate, parseDate } from './calendar-dates.mjs';

export function activityCalendar(year, range, now = new Date()) {
  const lastMonth = year === now.getFullYear() ? now.getMonth() : 11;
  const start = new Date(year, range === 'quarter' ? lastMonth - 2 : 0, 1, 12);
  const end = new Date(year, range === 'quarter' ? lastMonth + 1 : 12, 0, 12);
  const first = new Date(start); first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  const last = new Date(end); last.setDate(last.getDate() + (7 - last.getDay()) % 7);
  const today = formatDate(now);
  const cells = [];
  const months = [];
  for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
    const index = cells.length;
    const inRange = date >= start && date <= end;
    if (inRange && (date.getDate() === 1 || index === 0)) months.push({ month: date.getMonth(), column: Math.floor(index / 7) });
    cells.push(inRange ? { date: formatDate(date), future: formatDate(date) > today } : null);
  }
  return { cells, months, weeks: cells.length / 7, start: formatDate(start), end: formatDate(end), today };
}

export function browsingActivity(items) {
  const days = {};
  const seen = new Set();
  for (const item of items) {
    if (!item.url || seen.has(item.url) || !Number.isFinite(item.lastVisitTime) || item.lastVisitTime <= 0) continue;
    const date = new Date(item.lastVisitTime);
    if (!Number.isFinite(date.getTime()) || date.getFullYear() < 100 || date.getFullYear() > 9999) continue;
    seen.add(item.url);
    const key = formatDate(date);
    if (!days[key]) days[key] = { pages: 0, sites: new Set(), websites: new Map() };
    days[key].pages++;
    try {
      const domain = new URL(item.url).hostname;
      days[key].sites.add(domain);
      if (!domain) continue;
      const previous = days[key].websites.get(domain);
      if (!previous || item.lastVisitTime > previous.lastVisitTime) {
        const site = { domain, lastVisitTime: item.lastVisitTime };
        if (typeof item.title === 'string' && item.title) site.title = item.title;
        days[key].websites.set(domain, site);
      }
    } catch {}
  }
  for (const day of Object.values(days)) day.websites = [...day.websites.values()].sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.domain.localeCompare(b.domain));
  return days;
}

export function activitySummary(days, start, end, today) {
  let operations = 0, pages = 0, activeDays = 0;
  const sites = new Set();
  for (const [date, day] of Object.entries(days)) {
    if (!parseDate(date) || date < start || date > end || date > today) continue;
    if (day.operations !== undefined) operations += day.operations;
    pages += day.pages;
    if ((day.operations === undefined ? day.pages : day.operations) > 0) activeDays++;
    if (day.sites) for (const site of day.sites) sites.add(site);
  }
  return { operations, pages, activeDays, sites: sites.size };
}
