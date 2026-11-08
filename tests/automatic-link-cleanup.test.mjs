import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticLinkRules, createAutomaticLinkCleanup, LINK_AUTOMATIC_KEY } from '../extension/automatic-link-cleanup.mjs';
import { workspaceDefaults, WORKSPACE_TOOLS_KEY } from '../extension/workspace-tools.mjs';

const HOST = 'shop.example.test';
const rule = (extra = {}) => ({ hostname: HOST, parameters: ['utm_source'], ...extra });
const foreignRule = { id: 42, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||foreign.test^' } };

function fixture({ workspace, automatic, rules = [], permitted = true, regexSupported = true, updateError = null } = {}) {
  const state = {
    [WORKSPACE_TOOLS_KEY]: workspace ?? { ...workspaceDefaults(), linkRules: [rule()] },
    ...(automatic === undefined ? {} : { [LINK_AUTOMATIC_KEY]: structuredClone(automatic) })
  };
  const dynamic = structuredClone(rules);
  const writes = [];
  let permission = permitted;
  let onAdded, onRemoved, onStorage, onStartup, onInstalled;
  const api = {
    storage: {
      local: {
        get: async key => ({ [key]: state[key] }),
        set: async values => { writes.push(structuredClone(values)); Object.assign(state, structuredClone(values)); }
      },
      onChanged: { addListener: callback => { onStorage = callback; } }
    },
    permissions: {
      contains: async ({ origins }) => permission && origins.includes(`https://${HOST}/*`),
      onAdded: { addListener: callback => { onAdded = callback; } },
      onRemoved: { addListener: callback => { onRemoved = callback; } }
    },
    declarativeNetRequest: {
      getDynamicRules: async () => structuredClone(dynamic),
      isRegexSupported: async () => ({ isSupported: regexSupported }),
      updateDynamicRules: async ({ removeRuleIds, addRules }) => {
        if (updateError) throw updateError;
        for (let i = dynamic.length - 1; i >= 0; i--) if (removeRuleIds.includes(dynamic[i].id)) dynamic.splice(i, 1);
        dynamic.push(...structuredClone(addRules));
      }
    },
    runtime: {
      onStartup: { addListener: callback => { onStartup = callback; } },
      onInstalled: { addListener: callback => { onInstalled = callback; } }
    }
  };
  const controller = createAutomaticLinkCleanup(api);
  return {
    controller, state, dynamic, writes,
    setPermission(value) { permission = value; },
    async reconcile() { return controller.reconcile(); },
    async flushEvent(callback, ...args) { callback?.(...args); return controller.reconcile(); },
    events: { onAdded: () => onAdded, onRemoved: () => onRemoved, onStorage: () => onStorage,
      onStartup: () => onStartup, onInstalled: () => onInstalled }
  };
}

test('no automatic authorization or rules exist by default', async () => {
  const f = fixture({ workspace: workspaceDefaults() });
  const result = await f.reconcile();
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.installed, []);
  assert.equal(f.state[LINK_AUTOMATIC_KEY], undefined);
  assert.deepEqual(f.dynamic, []);
});

test('only explicit enable with site permission persists authorization and installs rules', async () => {
  const f = fixture();
  f.setPermission(false);
  await assert.rejects(f.controller.setAutomatic(HOST, true), /LINK_AUTO_UNSUPPORTED/);
  assert.equal(f.state[LINK_AUTOMATIC_KEY], undefined);
  assert.equal(f.writes.some(write => Object.hasOwn(write, LINK_AUTOMATIC_KEY)), false);

  f.setPermission(true);
  const result = await f.controller.setAutomatic(HOST, true);
  assert.deepEqual(result.hosts, [HOST]);
  assert.deepEqual(result.installed, [HOST]);
  assert.deepEqual(f.state[LINK_AUTOMATIC_KEY], { version: 1, paused: false, hosts: [HOST] });
  assert.ok(f.dynamic.some(item => item.action.type === 'redirect'));
});

test('disabling or removing the link rule clears automatic authorization without restoring it later', async () => {
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] } });
  f.state[WORKSPACE_TOOLS_KEY].linkRules[0].enabled = false;
  let result = await f.reconcile();
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(f.dynamic, []);
  f.state[WORKSPACE_TOOLS_KEY].linkRules[0].enabled = true;
  result = await f.reconcile();
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(f.dynamic, []);

  f.state[LINK_AUTOMATIC_KEY] = { version: 1, paused: false, hosts: [HOST] };
  f.state[WORKSPACE_TOOLS_KEY].linkRules = [];
  result = await f.reconcile();
  assert.deepEqual(result.hosts, []);
  f.state[WORKSPACE_TOOLS_KEY].linkRules = [rule()];
  result = await f.reconcile();
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(f.dynamic, []);
});

test('global pause removes owned rules while preserving host authorization and workspace rule', async () => {
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] }, rules: [foreignRule] });
  const workspaceBefore = structuredClone(f.state[WORKSPACE_TOOLS_KEY]);
  const result = await f.controller.pause(true);
  assert.equal(result.paused, true);
  assert.deepEqual(result.hosts, [HOST]);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(f.dynamic, [foreignRule]);
  assert.deepEqual(f.state[WORKSPACE_TOOLS_KEY], workspaceBefore);
});

test('permission removal clears owned rules and intent; a later grant requires explicit re-enable', async () => {
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] } });
  assert.deepEqual((await f.reconcile()).installed, [HOST]);
  f.setPermission(false);
  const removed = await f.flushEvent(f.events.onRemoved());
  assert.deepEqual(removed.installed, []);
  assert.deepEqual(f.dynamic, []);
  assert.deepEqual(removed.hosts, []);
  assert.deepEqual(f.state[LINK_AUTOMATIC_KEY].hosts, []);
  f.setPermission(true);
  const restored = await f.flushEvent(f.events.onAdded());
  assert.deepEqual(restored.hosts, []);
  assert.deepEqual(restored.installed, []);
  const explicitlyEnabled = await f.controller.setAutomatic(HOST, true);
  assert.deepEqual(explicitlyEnabled.hosts, [HOST]);
  assert.deepEqual(explicitlyEnabled.installed, [HOST]);
});

test('reconcile retains foreign dynamic rules and refuses path allow rules when foreign rules exist', async () => {
  const f = fixture({ workspace: { ...workspaceDefaults(), linkRules: [rule({ excludedPaths: ['/checkout'] })] },
    automatic: { version: 1, paused: false, hosts: [HOST] }, rules: [foreignRule] });
  const result = await f.reconcile();
  assert.deepEqual(f.dynamic, [foreignRule]);
  assert.equal(result.unavailableHosts.includes(HOST), true);
  assert.deepEqual(result.installed, []);
});

test('DNR update failure reports actual installed state and an error, never success', async () => {
  const existing = automaticLinkRules(rule());
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] }, rules: existing,
    updateError: new Error('simulated DNR rejection') });
  f.state[WORKSPACE_TOOLS_KEY].linkRules[0].parameters = ['utm_campaign'];
  const result = await f.reconcile();
  assert.deepEqual(result.installed, [HOST]);
  assert.notEqual(result.error, null);
  assert.notDeepEqual(f.dynamic, []);
  assert.equal(f.dynamic.some(item => item.action.redirect?.transform?.queryTransform?.removeParams?.includes('utm_campaign')), false);
});

test('startup and reconcile restore a desired versus actual rules difference', async () => {
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] } });
  const startup = f.events.onStartup();
  startup?.();
  const result = await f.reconcile();
  assert.deepEqual(result.hosts, [HOST]);
  assert.deepEqual(result.installed, [HOST]);
  assert.ok(f.dynamic.length > 0);
  assert.equal(typeof f.events.onInstalled(), 'function');
});

test('compiler rejects unsupported parameter names and unsupported regexes without broadening matches', async () => {
  assert.throws(() => automaticLinkRules(rule({ parameters: ['utm&source'] })), /LINK_AUTO_UNSUPPORTED/);
  const f = fixture({ automatic: { version: 1, paused: false, hosts: [HOST] }, regexSupported: false });
  const result = await f.reconcile();
  assert.deepEqual(f.dynamic, []);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.unavailableHosts, [HOST]);
});

test('compiled production regex constrains encoded query keys, path boundaries, method, resource and host', () => {
  const compiled = automaticLinkRules(rule({ excludedPaths: ['/checkout', '/encoded%2Fpath'] }));
  const redirect = compiled.find(item => item.action.type === 'redirect');
  const exceptions = compiled.filter(item => item.action.type === 'allow');
  const regex = new RegExp(redirect.condition.regexFilter);
  const matches = url => regex.test(url);

  assert.equal(matches('https://shop.example.test/p?utm_source=x'), true);
  assert.equal(matches('https://shop.example.test/p?utm%5Fsource=x'), false);
  assert.equal(matches('https://shop.example.test/p?keep=%2f+z&utm_source=x#frag'), true);
  assert.equal(matches('https://shop.example.test/p?utm_source=x#?encoded%5Ffragment=kept'), true);
  assert.equal(matches('https://shop.example.test/p?utm%5Fsource=x#frag'), false);
  assert.equal(matches('https://shop.example.test.evil/p?utm_source=x'), false);
  assert.equal(matches('http://shop.example.test/p?utm_source=x'), false);
  assert.deepEqual(redirect.condition.requestDomains, [HOST]);
  assert.deepEqual(redirect.condition.requestMethods, ['get']);
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  assert.equal(redirect.condition.isUrlFilterCaseSensitive, true);

  const exceptionPatterns = exceptions.map(item => new RegExp(item.condition.regexFilter));
  const exceptionMatches = url => exceptionPatterns.some(pattern => pattern.test(url));
  assert.equal(exceptionMatches('https://shop.example.test/checkout?utm_source=x'), true);
  assert.equal(exceptionMatches('https://shop.example.test/checkout/item?utm_source=x'), true);
  assert.equal(exceptionMatches('https://shop.example.test/checkout/item?utm_source=x#notes'), true);
  assert.equal(exceptionMatches('https://shop.example.test/checkout-v2?utm_source=x'), false);
  assert.equal(exceptionMatches('https://shop.example.test/encoded%2Fpath/child?utm_source=x'), true);
  assert.equal(exceptionMatches('https://shop.example.test.evil/checkout?utm_source=x'), false);
  for (const item of exceptions) {
    assert.deepEqual(item.condition.requestDomains, [HOST]);
    assert.deepEqual(item.condition.requestMethods, ['get']);
    assert.deepEqual(item.condition.resourceTypes, ['main_frame']);
  }
});
