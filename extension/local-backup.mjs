import { parseProtectedSites } from './history-filters.mjs';
import { validateBrowsingPreferences } from './browsing-preferences.mjs';
import { normalizeRule, rulesOverlap } from './auto-cleanup-model.mjs';
import { validateProtectedUrls } from './workspace-tools.mjs';

export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const fail = () => { throw new Error('INVALID_BACKUP'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateLocalBackup(value) {
  if (!object(value) || Object.keys(value).some(key => !['protection', 'browsing', 'tasks'].includes(key))) return fail();
  const result = {};
  if (Object.hasOwn(value, 'protection')) {
    const protection = value.protection;
    if (!object(protection) || Object.keys(protection).some(key => !['sites', 'urls'].includes(key)) ||
        !Array.isArray(protection.sites) || protection.sites.some(site => typeof site !== 'string')) return fail();
    result.protection = { sites: parseProtectedSites(protection.sites.join('\n')), urls: validateProtectedUrls(protection.urls) };
  }
  if (Object.hasOwn(value, 'browsing')) result.browsing = validateBrowsingPreferences(value.browsing);
  if (Object.hasOwn(value, 'tasks')) {
    if (!Array.isArray(value.tasks)) return fail();
    if (value.tasks.some(rule => !object(rule) || Object.keys(rule).some(key => !['domain', 'includeSubdomains', 'days', 'schedule'].includes(key)))) return fail();
    const tasks = value.tasks.map(normalizeRule);
    if (tasks.some((rule, i) => tasks.slice(i + 1).some(other => rulesOverlap(rule, other)))) return fail();
    result.tasks = tasks;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BACKUP_BYTES / 2) return fail();
  return result;
}

export function pausedTaskConfig(tasks, revision) {
  const clean = validateLocalBackup({ tasks }).tasks;
  if (!Number.isSafeInteger(revision) || revision < 0) return fail();
  // Restore declarative scopes only, never old enable flags, due times or completion state.
  return { version: 2, paused: true, revision: revision + 1, nextRunAt: null,
    rules: clean.map(rule => ({ id: crypto.randomUUID(), ...rule, enabled: false, nextRunAt: null, completed: false })) };
}
