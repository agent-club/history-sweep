import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker, isNewerVersion } from '../extension/update-check.mjs';

const extensionId = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
const updateUrl = 'https://clients2.google.com/service/update2/crx';
function fixture(overrides = {}) {
  const saved = {};
  const requests = [];
  let checks = 0, time = 1000000;
  const chrome = {
    management: { getSelf: async () => ({ id: extensionId, installType: 'normal', updateUrl, ...overrides.self }) },
    runtime: {
      getManifest: () => ({ version: overrides.installed || '0.3.1' }),
      requestUpdateCheck: async () => { checks++; return overrides.result || { status: 'update_available', version: '0.3.2' }; },
    },
    storage: { local: { get: async () => structuredClone(saved), set: async data => { Object.assign(saved, data); } } },
  };
  const options = {
    now: () => time,
    fetchVersion: async (...args) => {
      requests.push(args);
      if (overrides.fetchVersion) return overrides.fetchVersion(...args);
      return { ok: overrides.ok !== false, json: async () => Object.hasOwn(overrides, 'hint') ? overrides.hint : { extensionId, version: '0.3.2' } };
    },
  };
  return { chrome, options, saved, requests, check: createUpdateChecker(chrome, options), get checks() { return checks; }, advance: ms => { time += ms; } };
}

test('Chrome versions use numeric components and reject invalid or non-newer candidates', () => {
  for (const [candidate, installed] of [['0.3.10', '0.3.9'], ['1', '0.99.99.99'], ['0.3.2.1', '0.3.2']]) assert.equal(isNewerVersion(candidate, installed), true);
  for (const candidate of ['0.3.2', '0.3.2.0', '0.3.1', '0.0.0.0', '0.03.3', '65536', '1.2.3.4.5', '1.2-beta', null, 4]) assert.equal(isNewerVersion(candidate, '0.3.2'), false);
});

test('only the official store install queries an anonymous version hint and requests a Chrome update', async () => {
  const f = fixture();
  assert.equal(await f.check(), '0.3.2');
  assert.equal(f.checks, 1);
  const [url, options] = f.requests[0];
  assert.equal(url, 'https://sweep.agentclub.dev/extension-updates.json');
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(f.saved.extensionUpdateCheck.status, 'ready');
  assert.equal(f.saved.extensionUpdateCheck.version, '0.3.2');
});

test('unpacked, forked and managed installs make no website or store request', async () => {
  for (const self of [{ installType: 'development' }, { id: 'fork' }, { installType: 'admin' }, { updateUrl: 'https://other.test/update' }]) {
    const f = fixture({ self });
    assert.equal(await f.check(), null);
    assert.equal(f.requests.length, 0); assert.equal(f.checks, 0);
    assert.equal(f.saved.extensionUpdateCheck.status, 'manual');
    assert.equal(f.saved.extensionUpdateCheck.channel, self.installType === 'development' ? 'development' : self.installType === 'admin' ? 'managed' : 'other');
  }
});

test('concurrent views share one check; cooldown survives worker restart and expires after 15 minutes', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const f = fixture({ fetchVersion: () => response });
  const first = f.check(), second = f.check();
  assert.equal(first, second);
  resolve({ ok: true, json: async () => ({ extensionId, version: '0.3.2' }) });
  assert.deepEqual(await Promise.all([first, second]), ['0.3.2', '0.3.2']);
  assert.equal(f.requests.length, 1); assert.equal(f.checks, 1);
  assert.equal(await createUpdateChecker(f.chrome, f.options)(), null);
  f.advance(15 * 60 * 1000);
  assert.equal(await f.check(), '0.3.2');
  assert.equal(f.requests.length, 2); assert.equal(f.checks, 2);
});

test('clock rollback and extension upgrades do not permanently suppress checks', async () => {
  const f = fixture();
  await f.check();
  f.advance(-1);
  await f.check();
  assert.equal(f.requests.length, 2);
  f.chrome.runtime.getManifest = () => ({ version: '0.3.2' });
  assert.equal(await f.check(), null);
  assert.equal(f.requests.length, 3); assert.equal(f.checks, 2);
});

test('missing, older, equal, malformed or wrong-extension hints cannot enable an update', async () => {
  for (const hint of [null, {}, { extensionId }, { extensionId, version: '0.3.0' }, { extensionId, version: '0.3.1.0' }, { extensionId, version: 'invalid' }, { extensionId: 'other', version: '2' }]) {
    const f = fixture({ hint });
    assert.equal(await f.check(), null); assert.equal(f.checks, 0);
  }
});

test('a website hint cannot substitute for a downloaded update confirmed by Chrome', async () => {
  for (const result of [{ status: 'no_update' }, { status: 'throttled' }, { status: 'update_available' }, { status: 'update_available', version: '0.3.0' }, { status: 'update_available', version: '0.3.1.0' }, { status: 'update_available', version: 'bad' }]) {
    const f = fixture({ result });
    assert.equal(await f.check(), null); assert.equal(f.checks, 1);
  }
});

test('offline, non-OK, invalid JSON and API failures remain nonfatal with a visible retry state', async () => {
  for (const overrides of [
    { fetchVersion: async () => { throw new TypeError('offline'); } },
    { ok: false },
    { fetchVersion: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }) },
  ]) {
    const f = fixture(overrides);
    assert.equal(await f.check(), null); assert.equal(await f.check(), null);
    assert.equal(f.requests.length, 1); assert.equal(f.checks, 0);
    assert.equal(f.saved.extensionUpdateCheck.status, 'error');
  }
  const f = fixture();
  f.chrome.runtime.requestUpdateCheck = async () => { throw new Error('unavailable'); };
  assert.equal(await f.check(), null);
  f.chrome.management.getSelf = async () => { throw new Error('unavailable'); };
  assert.equal(await f.check(), null);
});

test('published and throttled releases remain visible without enabling reload', async () => {
  for (const [result, status] of [[{ status: 'no_update' }, 'published'], [{ status: 'throttled' }, 'throttled']]) {
    const f = fixture({ result });
    assert.equal(await f.check(), null);
    assert.equal(f.saved.extensionUpdateCheck.status, status);
    assert.equal(f.saved.extensionUpdateCheck.version, '0.3.2');
    await createUpdateChecker(f.chrome, f.options)();
    assert.equal(f.requests.length, 1, 'reopening preserves the result without repeating requests');
    assert.equal(f.saved.extensionUpdateCheck.status, status);
    await f.check({ manual: true });
    assert.equal(f.requests.length, 2, 'manual checks refresh website metadata');
    assert.equal(f.checks, 1, 'manual checks respect the Chrome API cooldown');
    assert.equal(f.saved.extensionUpdateCheck.status, status);
  }
});

test('a manual retry recovers from network failure within the automatic cooldown', async () => {
  let online = false;
  const f = fixture({ result: { status: 'no_update' }, fetchVersion: async () => {
    if (!online) throw new TypeError('offline');
    return { ok: true, json: async () => ({ extensionId, version: '0.3.1' }) };
  } });
  await f.check();
  assert.equal(f.saved.extensionUpdateCheck.status, 'error');
  online = true;
  await f.check({ manual: true });
  assert.equal(f.requests.length, 2);
  assert.equal(f.saved.extensionUpdateCheck.status, 'current');
  assert.equal(f.checks, 1);
});

test('a suspended check becomes retryable and a known release survives a later network failure', async () => {
  const f = fixture({ result: { status: 'no_update' } });
  await f.check();
  f.saved.extensionUpdateCheck.status = 'checking';
  await createUpdateChecker(f.chrome, f.options)();
  assert.equal(f.saved.extensionUpdateCheck.status, 'error');
  assert.equal(f.requests.length, 1);
  f.options.fetchVersion = async () => { throw new TypeError('offline'); };
  await createUpdateChecker(f.chrome, f.options)({ manual: true });
  assert.equal(f.saved.extensionUpdateCheck.status, 'error');
  assert.equal(f.saved.extensionUpdateCheck.version, '0.3.2');
});

test('an unavailable Chrome API cannot be repeatedly invoked by manual retry', async () => {
  const f = fixture();
  let attempts = 0;
  f.chrome.runtime.requestUpdateCheck = async () => { attempts++; throw new Error('unavailable'); };
  await f.check();
  await f.check({ manual: true });
  assert.equal(attempts, 1);
  assert.equal(f.saved.extensionUpdateCheck.status, 'published');
});


test('manual checks can discover a Chrome download when website metadata is stale or unavailable', async () => {
  for (const overrides of [{ hint: { extensionId, version: '0.3.1' } }, { fetchVersion: async () => { throw new TypeError('offline'); } }]) {
    const f = fixture(overrides);
    assert.equal(await f.check({ manual: true }), '0.3.2');
    assert.equal(f.saved.extensionUpdateCheck.status, 'ready');
    assert.equal(f.checks, 1);
  }
});
