import { resolveTimeRange, parseProtectedSites } from './history-filters.mjs';
import { normalizeSearchText } from './search-text.mjs';
import { validateLabelAppearance } from './label-appearance.mjs';

export const WORKSPACE_TOOLS_KEY = 'workspaceTools';
export const MANUAL_CLEANUP_KEY = 'manualCleanupState';
export const workspaceDefaults = () => ({ version: 1, searches: [], protectedUrls: [], linkRules: [], labels: {} });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new Error('INVALID_WORKSPACE_SETTINGS'); };
const text = (value, max) => typeof value === 'string' && value.length <= max;
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

export function validateConditions(value) {
  if (!Array.isArray(value) || value.length > 20) return invalid();
  return value.map(condition => {
    if (!exact(condition, ['field', 'operator', 'value']) || !['path', 'text'].includes(condition.field) ||
        !['includes', 'excludes'].includes(condition.operator) || !text(condition.value, 4096) || !condition.value.trim()) return invalid();
    return { field: condition.field, operator: condition.operator, value: condition.value };
  });
}

export function matchesConditions(item, conditions) {
  return conditions.every(condition => {
    let candidate;
    if (condition.field === 'path') {
      try { candidate = new URL(item.url).pathname; } catch { return false; }
    } else candidate = `${typeof item.title === 'string' ? item.title : ''}\n${item.url}`;
    const matches = normalizeSearchText(candidate).includes(normalizeSearchText(condition.value));
    return condition.operator === 'includes' ? matches : !matches;
  });
}

export function validateSavedSearch(value) {
  if (!exact(value, ['id', 'name', 'query', 'mode', 'range', 'view', 'conditions']) ||
      !text(value.id, 80) || !value.id || !text(value.name, 80) || !value.name.trim() || !text(value.query, 20000) ||
      !['smart', 'host-exact', 'host-subdomains', 'contains'].includes(value.mode) ||
      !['all', 'today', '3days', '7days', '30days'].includes(value.range) || !['date', 'website', 'frequency'].includes(value.view)) return invalid();
  resolveTimeRange({ range: value.range, startDate: '', endDate: '' });
  return { id: value.id, name: value.name.trim(), query: value.query, mode: value.mode, range: value.range, view: value.view,
    conditions: validateConditions(value.conditions) };
}

export function validateProtectedUrls(value) {
  if (!Array.isArray(value) || value.some(url => !text(url, 20000))) return invalid();
  for (const url of value) { try { new URL(url); } catch { return invalid(); } }
  // Keep Chrome's exact URL bytes: fragments and query values are part of this protection.
  return [...new Set(value)];
}

export function websiteHostname(value) {
  const sites = parseProtectedSites(value);
  if (sites.length !== 1) return invalid();
  return sites[0];
}

export function validateLinkRule(value) {
  if (!exact(value, ['hostname', 'parameters']) || !Array.isArray(value.parameters) || !value.parameters.length ||
      value.parameters.some(name => !text(name, 256) || !name || /[\r\n]/.test(name))) return invalid();
  return { hostname: websiteHostname(value.hostname), parameters: [...new Set(value.parameters)] };
}

export function validateWebsiteLabel(value) {
  if (!exact(value, ['values', 'visible', 'styles']) || typeof value.visible !== 'boolean' || !Array.isArray(value.values) ||
      value.values.length > 30 || value.values.some(label => !text(label, 80) || !label.trim())) return invalid();
  const label = { values: [...new Set(value.values.map(label => label.trim()))], visible: value.visible };
  if (value.styles !== undefined) {
    if (!object(value.styles) || Object.keys(value.styles).some(name => !label.values.includes(name))) return invalid();
    label.styles = Object.fromEntries(Object.entries(value.styles).map(([name, style]) => [name, validateLabelAppearance(style)]));
  }
  return label;
}

export function validateWorkspaceTools(value) {
  if (value === undefined) return workspaceDefaults();
  if (!exact(value, ['version', 'searches', 'protectedUrls', 'linkRules', 'labels']) || value.version !== 1 ||
      !Array.isArray(value.searches) || !Array.isArray(value.linkRules) || !object(value.labels)) return invalid();
  const searches = value.searches.map(validateSavedSearch);
  const linkRules = value.linkRules.map(validateLinkRule);
  if (new Set(searches.map(search => search.id)).size !== searches.length ||
      new Set(linkRules.map(rule => rule.hostname)).size !== linkRules.length) return invalid();
  const labels = {};
  for (const [hostname, label] of Object.entries(value.labels)) {
    if (['__proto__', 'constructor', 'prototype'].includes(hostname) || websiteHostname(hostname) !== hostname) return invalid();
    labels[hostname] = validateWebsiteLabel(label);
  }
  return { version: 1, searches, protectedUrls: validateProtectedUrls(value.protectedUrls), linkRules, labels };
}

export async function readWorkspaceTools(storage) {
  return validateWorkspaceTools((await storage.get(WORKSPACE_TOOLS_KEY))[WORKSPACE_TOOLS_KEY]);
}

export async function readProtectedUrls(storage) {
  const value = (await storage.get(WORKSPACE_TOOLS_KEY))[WORKSPACE_TOOLS_KEY];
  return value === undefined ? [] : validateProtectedUrls(value.protectedUrls);
}

export function cleanLink(value, rule) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('LINK_UNAVAILABLE');
  const cleanRule = validateLinkRule(rule);
  if (parsed.hostname.toLowerCase().replace(/\.$/, '') !== cleanRule.hostname) throw new Error('LINK_UNAVAILABLE');
  const hashAt = value.indexOf('#');
  const queryAt = value.indexOf('?');
  if (queryAt < 0 || (hashAt >= 0 && queryAt > hashAt)) return { url: value, removed: [] };
  const fragment = hashAt < 0 ? '' : value.slice(hashAt);
  const query = value.slice(queryAt + 1, hashAt < 0 ? value.length : hashAt);
  const names = new Set(cleanRule.parameters), removed = [];
  // Do not serialize URLSearchParams: that would rewrite untouched signed/business parameters.
  const kept = query.split('&').filter(part => {
    let name;
    try { name = decodeURIComponent(part.split('=', 1)[0].replace(/\+/g, ' ')); } catch { return true; }
    if (!names.has(name)) return true;
    removed.push(name); return false;
  });
  return { url: removed.length ? value.slice(0, queryAt) + (kept.length ? '?' + kept.join('&') : '') + fragment : value,
    removed: [...new Set(removed)] };
}

export function exportSelected(items, format) {
  if (!['text', 'csv'].includes(format) || !Array.isArray(items)) throw new Error('INVALID_EXPORT');
  const unique = [...new Map(items.map(item => [item.url, item])).values()];
  if (format === 'text') return unique.map(item => item.url).join('\n');
  const cell = value => {
    let content = String(value);
    // Spreadsheet programs execute formula-like cells even inside quoted CSV fields.
    if (/^[=+\-@\t\r\n]/.test(content)) content = "'" + content;
    return '"' + content.replace(/"/g, '""') + '"';
  };
  return [['URL', 'Title', 'Last visit'], ...unique.map(item => [item.url,
    typeof item.title === 'string' ? item.title : '',
    Number.isFinite(item.lastVisitTime) ? new Date(item.lastVisitTime).toISOString() : ''])]
    .map(row => row.map(cell).join(',')).join('\r\n');
}

export async function readVisitImpact(history, urls, range, { signal, progress = () => {} } = {}) {
  const results = new Array(urls.length); let cursor = 0, completed = 0;
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (cursor < urls.length && !signal?.aborted) {
      const index = cursor++, url = urls[index];
      try {
        const visits = await history.getVisits({ url });
        if (!Array.isArray(visits)) throw new Error('INVALID_VISITS');
        const outside = range ? visits.filter(visit => Number.isFinite(visit.visitTime) &&
          (visit.visitTime < range.startTime || visit.visitTime >= range.endTime)).length : 0;
        results[index] = { url, visits, outside, unknownTimes: visits.filter(visit => !Number.isFinite(visit.visitTime)).length };
      } catch { results[index] = { url, unavailable: true }; }
      progress(++completed, urls.length);
    }
  }));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return results;
}
