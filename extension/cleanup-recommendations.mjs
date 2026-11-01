import { recommendationDefaults } from './recommendation-settings.mjs';
import { isProtectedUrl } from './history-filters.mjs';

const browserProtocols = new Set(['http:', 'https:', 'ftp:', 'file:', 'ws:', 'wss:', 'chrome:', 'chrome-search:', 'chrome-untrusted:', 'edge:', 'about:', 'data:', 'javascript:', 'blob:', 'devtools:', 'view-source:']);
const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// The log records a hostname once per local date, not individual cleanup counts.
// Missing legacy website summaries provide no evidence for a recommendation.
export function cleanupRecommendations(items, { log, now = new Date(), hideCleanup = false, remaining = new Set(), settings = recommendationDefaults(), protectedSites = [] } = {}) {
  const daysByHost = new Map();
  if (log && !hideCleanup && settings.habit.enabled) {
    const day = new Date(now); day.setHours(12, 0, 0, 0);
    for (let offset = 0; offset < settings.habit.lookbackDays; offset++, day.setDate(day.getDate() - 1)) {
      const hosts = new Set((log.days[localDate(day)]?.websites || []).map(site => site.domain.toLowerCase().replace(/\.$/, '')));
      for (const host of hosts) daysByHost.set(host, (daysByHost.get(host) || 0) + 1);
    }
  }
  const recommendations = new Map();
  for (const item of items) {
    if (isProtectedUrl(item.url, protectedSites)) continue;
    if (remaining.has(item.url)) { recommendations.set(item.url, [{ type: 'remaining' }]); continue; }
    let url;
    try { url = new URL(item.url); } catch { continue; }
    const reasons = [];
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const days = daysByHost.get(host);
    if (['http:', 'https:'].includes(url.protocol)) {
      if (days >= settings.habit.minimumDays) reasons.push({ type: 'frequent', days, lookback: settings.habit.lookbackDays });
      for (const rule of settings.sites) {
        if (!rule.enabled || !(host === rule.domain || rule.includeSubdomains && host.endsWith(`.${rule.domain}`))) continue;
        if (rule.condition === 'always') reasons.push({ type: 'site' });
        // Use this URL's actual last visit; an unknown time is not evidence of inactivity.
        else if (Number.isFinite(item.lastVisitTime) && now.getTime() - item.lastVisitTime >= rule.days * 86400000) reasons.push({ type: 'inactive', days: rule.days });
      }
    }
    if (url.protocol === 'chrome-extension:' && settings.types.extension) reasons.push({ type: 'extension' });
    else if (url.protocol !== 'chrome-extension:' && !browserProtocols.has(url.protocol) && settings.types.application) reasons.push({ type: 'application' });
    if (reasons.length) recommendations.set(item.url, [...new Map(reasons.map(reason => [JSON.stringify(reason), reason])).values()]);
  }
  return recommendations;
}
