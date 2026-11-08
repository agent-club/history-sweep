import { readWorkspaceTools, validateLinkRule, websiteHostname, WORKSPACE_TOOLS_KEY } from './workspace-tools.mjs';

export const LINK_AUTOMATIC_KEY = 'linkCleanupAutomatic';
const FIRST_ID = 800_000_000, ID_COUNT = 100_000_000;
const owned = rule => rule.id >= FIRST_ID && rule.id < FIRST_ID + ID_COUNT;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idFor = key => {
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return FIRST_ID + (hash >>> 0) % ID_COUNT;
};
const stable = value => JSON.stringify(value, function (_, item) {
  return item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});

export function automaticLinkRules(value) {
  const rule = validateLinkRule(value);
  const remove = rule.parameters.filter(name => !rule.preserveParameters.includes(name));
  if (!rule.enabled || !remove.length) return [];
  if ([...remove, ...rule.preserveParameters].some(name => !/^[A-Za-z0-9_.~-]+$/.test(name))) throw new Error('LINK_AUTO_UNSUPPORTED');
  const origin = `^https://${escapeRegex(rule.hostname)}(?::[0-9]+)?`;
  // DNR does not decode query keys like the manual cleaner. Skip the entire
  // navigation when a key is encoded; never apply a different partial result.
  // Chrome's DNR matcher can include the fragment even though the network
  // request does not. Keep it outside the query-key eligibility check.
  const query = '\\?(?:[A-Za-z0-9_.~-]*(?:=[^&#]*)?)(?:&[A-Za-z0-9_.~-]*(?:=[^&#]*)?)*(?:#.*)?$';
  const condition = regexFilter => ({ regexFilter, isUrlFilterCaseSensitive: true, requestDomains: [rule.hostname], requestMethods: ['get'], resourceTypes: ['main_frame'] });
  const rules = [{
    id: idFor(`${rule.hostname}:redirect`), priority: 1,
    action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: remove } } } },
    condition: condition(`${origin}/[^?#]*${query}`),
  }];
  for (const path of rule.excludedPaths) {
    const suffix = path.endsWith('/') ? '[^?#]*' : '(?:/[^?#]*)?';
    rules.push({ id: idFor(`${rule.hostname}:except:${path}`), priority: 2, action: { type: 'allow' },
      condition: condition(`${origin}${escapeRegex(path)}${suffix}${query}`) });
  }
  if (rules.some(item => item.condition.regexFilter.length > 2000)) throw new Error('LINK_AUTO_UNSUPPORTED');
  return rules;
}

export function createAutomaticLinkCleanup(api) {
  let queue = Promise.resolve();
  let lastError = null;
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  async function readConfig() {
    const value = (await api.storage.local.get(LINK_AUTOMATIC_KEY))[LINK_AUTOMATIC_KEY];
    if (value === undefined) return { version: 1, paused: false, hosts: [] };
    if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.paused !== 'boolean' || !Array.isArray(value.hosts) ||
      Object.keys(value).some(key => !['version', 'paused', 'hosts'].includes(key)) || value.hosts.some(host => typeof host !== 'string' || websiteHostname(host) !== host)) throw new Error('INVALID_LINK_AUTOMATIC');
    return { version: 1, paused: value.paused, hosts: [...new Set(value.hosts)] };
  }
  const available = () => Boolean(api.declarativeNetRequest && api.permissions);
  const actualHosts = rules => [...new Set(rules.filter(item => owned(item) && item.action.type === 'redirect').flatMap(item => item.condition.requestDomains || []))];
  async function apply() {
    const config = await readConfig();
    if (!available()) return { available: false, paused: config.paused, hosts: config.hosts, installed: [], unavailableHosts: [], error: null };
    const current = await api.declarativeNetRequest.getDynamicRules();
    const tools = await readWorkspaceTools(api.storage.local);
    const retainedHosts = [];
    for (const host of config.hosts) {
      if (tools.linkRules.some(rule => rule.hostname === host && rule.enabled) && await api.permissions.contains({ origins: [`https://${host}/*`] })) retainedHosts.push(host);
    }
    // Revoking shared site access is an explicit stop. A later WebDAV grant
    // must not silently reactivate automatic cleanup for that hostname.
    if (retainedHosts.length !== config.hosts.length) {
      config.hosts = retainedHosts;
      await api.storage.local.set({ [LINK_AUTOMATIC_KEY]: config });
    }
    const requested = [], unavailableHosts = [];
    const hasForeignRules = current.some(item => !owned(item));
    if (!config.paused) {
      for (const hostname of config.hosts) {
        const rule = tools.linkRules.find(item => item.hostname === hostname);
        if (!rule?.enabled || !await api.permissions.contains({ origins: [`https://${hostname}/*`] })) continue;
        try {
          const compiled = automaticLinkRules(rule);
          // An allow exception must not bypass rules installed by another feature.
          if (hasForeignRules && compiled.some(item => item.action.type === 'allow')) throw new Error('LINK_AUTO_UNSUPPORTED');
          for (const item of compiled) {
            if (!(await api.declarativeNetRequest.isRegexSupported({ regex: item.condition.regexFilter, isCaseSensitive: true })).isSupported) throw new Error('LINK_AUTO_UNSUPPORTED');
          }
          requested.push(...compiled);
        } catch { unavailableHosts.push(hostname); }
      }
    }
    if (new Set(requested.map(item => item.id)).size !== requested.length) throw new Error('LINK_RULE_ID_COLLISION');
    const previous = current.filter(owned);
    if (stable(previous.sort((a, b) => a.id - b.id)) !== stable(requested.sort((a, b) => a.id - b.id))) {
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: previous.map(item => item.id), addRules: requested });
    }
    lastError = null;
    const installed = await api.declarativeNetRequest.getDynamicRules();
    return { available: true, paused: config.paused, hosts: config.hosts, installed: actualHosts(installed), unavailableHosts, error: null };
  }
  async function reconcile() {
    return serial(async () => {
      try { return await apply(); }
      catch (error) {
        lastError = error;
        const config = await readConfig();
        const installed = available() ? await api.declarativeNetRequest.getDynamicRules() : [];
        return { available: available(), paused: config.paused, hosts: config.hosts, installed: actualHosts(installed), unavailableHosts: [], error: 'LINK_AUTO_APPLY_FAILED' };
      }
    });
  }
  const schedule = () => { void reconcile().catch(error => { lastError = error; }); };
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (Object.hasOwn(changes, WORKSPACE_TOOLS_KEY) || Object.hasOwn(changes, LINK_AUTOMATIC_KEY))) schedule();
  });
  api.permissions?.onAdded?.addListener(schedule);
  api.permissions?.onRemoved?.addListener(schedule);
  api.runtime.onStartup.addListener(schedule);
  api.runtime.onInstalled.addListener(schedule);
  // Dynamic rules outlive the service worker; recheck their desired state on wake.
  schedule();
  return {
    reconcile,
    async setAutomatic(hostname, enabled) {
      if (typeof enabled !== 'boolean') throw new Error('INVALID_LINK_AUTOMATIC');
      hostname = websiteHostname(hostname);
      await serial(async () => {
        const config = await readConfig();
        if (enabled) {
          if (!available()) throw new Error('LINK_AUTO_UNSUPPORTED');
          const rule = (await readWorkspaceTools(api.storage.local)).linkRules.find(item => item.hostname === hostname);
          if (!rule?.enabled || !automaticLinkRules(rule).length || !await api.permissions.contains({ origins: [`https://${hostname}/*`] })) throw new Error('LINK_AUTO_UNSUPPORTED');
          config.hosts = [...new Set([...config.hosts, hostname])];
        } else config.hosts = config.hosts.filter(host => host !== hostname);
        await api.storage.local.set({ [LINK_AUTOMATIC_KEY]: config });
      });
      return reconcile();
    },
    async pause(paused) {
      if (typeof paused !== 'boolean') throw new Error('INVALID_LINK_AUTOMATIC');
      await serial(async () => {
        const config = await readConfig();
        await api.storage.local.set({ [LINK_AUTOMATIC_KEY]: { ...config, paused } });
      });
      return reconcile();
    },
  };
}
