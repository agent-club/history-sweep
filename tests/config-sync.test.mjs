import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateConfig, parseConfig, validateConnection, connectionUrl, permissionOrigin, requestHeaders, createRemote, encryptBackup, decryptBackup, MAX_CONFIG_BYTES } from '../extension/config-sync.mjs';
import { createConfigStore } from '../extension/config-store.mjs';

const document = () => ({ format: 'history-sweep-config', version: 1,
  preferences: { language: 'zh-CN', theme: 'dark', launchMode: 'fullpage' },
  historyTags: { custom: ['Read later'] }, domainLabels: { 'example.test': ['Reference'] } });
// Runtime-generated values are synthetic and are never printed or sent to real servers.
const dav = () => Object.fromEntries([['provider', 'webdav'], ['url', 'https://dav.example.test/backup/config.json'], ['username', 'test-user'], ['password', randomBytes(18).toString('hex')]]);
const allowed = { contains: async () => true };
const response = (value = document(), headers = { etag: '"v1"' }) => new Response(JSON.stringify(value), { headers });

test('versioned configuration rejects history, credentials, unknown fields and malformed preferences', () => {
  assert.deepEqual(parseConfig(JSON.stringify(document())), document());
  for (const value of [null, [], {}, { ...document(), version: 2 }, { ...document(), history: [] },
    { ...document(), connection: dav() }, { ...document(), preferences: { ...document().preferences, theme: false } },
    { ...document(), domainLabels: { 'https://example.test/path': ['Label'] } },
    { ...document(), historyTags: JSON.parse('{"__proto__":["bad"]}') },
    { ...document(), domainLabels: { 'example.test': [''] } }]) assert.throws(() => validateConfig(value), /INVALID_CONFIG/);
  assert.throws(() => parseConfig('invalid json'), /INVALID_CONFIG/);
  assert.throws(() => parseConfig('x'.repeat(MAX_CONFIG_BYTES + 1)), /CONFIG_TOO_LARGE/);
  const huge = document(); huge.domainLabels = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`host${i}.test`, ['一'.repeat(80), '二'.repeat(80)]]));
  assert.throws(() => validateConfig(huge), /CONFIG_TOO_LARGE/);
});

test('WebDAV validates secure file targets, including Worker-backed gateways and custom ports', () => {
  for (const url of ['http://dav.example.test/config.json', 'https://dav.example.test/', 'https://dav.example.test/file?x=1', 'https://dav.example.test/file#secret', 'not a url']) {
    assert.throws(() => validateConnection({ ...dav(), url }), /INVALID_CONNECTION/);
  }
  const value = dav();
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(JSON.stringify(validateConnection(reordered)), JSON.stringify(validateConnection(value)), 'Chrome storage key order cannot change connection identity');
  const gateway = { ...value, url: 'https://dav-gateway.example.workers.dev/中文/config.json' };
  assert.equal(connectionUrl(gateway), 'https://dav-gateway.example.workers.dev/%E4%B8%AD%E6%96%87/config.json');
  assert.equal(permissionOrigin(gateway), 'https://dav-gateway.example.workers.dev/*');
  assert.equal(permissionOrigin({ ...value, url: 'https://dav.example.test:8443/config.json' }), 'https://dav.example.test/*');
  assert.throws(() => validateConnection({ provider: 'unsupported-fixture' }), /INVALID_CONNECTION/);
});

test('WebDAV authenticates with UTF-8 Basic auth; credentials never enter the payload', async () => {
  const config = dav(); config.username = '测试';
  const headers = requestHeaders(config);
  assert.equal(Buffer.from(headers.get('Authorization').slice(6), 'base64').toString('utf8'), `${config.username}:${config.password}`);
  const calls = [];
  const remote = createRemote(config, { permissions: allowed, fetchImpl: async (url, init) => { calls.push({ url, ...init }); return response(); } });
  const previous = await remote.read(); await remote.write(document(), previous);
  assert.equal(calls[1].headers.get('If-Match'), '"v1"');
  assert.deepEqual(JSON.parse(calls[1].body), document());
  assert.equal(calls[1].body.includes(config.password), false);
  for (const call of calls) { assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit'); assert.equal(call.cache, 'no-store'); }
});

test('missing file is created conditionally; conflicts and weak or missing ETags never overwrite', async () => {
  const calls = [];
  const remote = createRemote(dav(), { permissions: allowed, fetchImpl: async (_url, init) => {
    calls.push(init); return init.method === 'GET' ? new Response(null, { status: 404 }) : new Response(null, { status: 201 });
  } });
  const previous = await remote.read(); assert.equal(previous, null); await remote.write(document(), previous);
  assert.equal(calls[1].headers.get('If-None-Match'), '*');
  for (const etag of [null, '', 'W/"v1"', 'unquoted']) await assert.rejects(remote.write(document(), { etag }), /ETAG_REQUIRED/);
  assert.equal(calls.length, 2);
  for (const status of [409, 412]) {
    const conflict = createRemote(dav(), { permissions: allowed, fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(conflict.write(document(), { etag: '"v1"' }), /SYNC_CONFLICT/);
  }
});

test('permissions, errors, corrupt files and oversized streams fail without leaking server messages', async () => {
  let calls = 0;
  const denied = createRemote(dav(), { permissions: { contains: async () => false }, fetchImpl: async () => { calls++; } });
  await assert.rejects(denied.read(), /PERMISSION_REQUIRED/); assert.equal(calls, 0);
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [500, 'REMOTE_FAILED']]) {
    const remote = createRemote(dav(), { permissions: allowed, fetchImpl: async () => new Response('untrusted server response', { status }) });
    await assert.rejects(remote.read(), error => error.message === code);
  }
  const corrupt = createRemote(dav(), { permissions: allowed, fetchImpl: async () => new Response('<html>login</html>') });
  await assert.rejects(corrupt.read(), /INVALID_CONFIG/);
  const oversized = createRemote(dav(), { permissions: allowed, fetchImpl: async () => new Response('x'.repeat(MAX_CONFIG_BYTES + 1)) });
  await assert.rejects(oversized.read(), /CONFIG_TOO_LARGE/);
  const offline = createRemote(dav(), { permissions: allowed, fetchImpl: async () => { throw new Error('untrusted network detail'); } });
  await assert.rejects(offline.read(), error => error.message === 'NETWORK_FAILED');
});

test('encrypted disk backups restore connections and settings; wrong passwords and tampering are rejected', async () => {
  const config = document(); const connection = dav(); const passphrase = randomBytes(18).toString('hex');
  const encrypted = await encryptBackup(connection, config, passphrase);
  assert.equal(encrypted.includes(connection.password), false); assert.equal(encrypted.includes(connection.url), false);
  assert.deepEqual(await decryptBackup(encrypted, passphrase), { connection, config });
  assert.notEqual(encrypted, await encryptBackup(connection, config, passphrase));
  await assert.rejects(decryptBackup(encrypted, passphrase + 'wrong'), /INVALID_BACKUP/);
  const tampered = JSON.parse(encrypted); tampered.ciphertext = 'AAAA' + tampered.ciphertext.slice(4);
  await assert.rejects(decryptBackup(JSON.stringify(tampered), passphrase), /INVALID_BACKUP/);
  await assert.rejects(encryptBackup(connection, config, 'short'), /BACKUP_PASSPHRASE/);
  assert.deepEqual(await decryptBackup(await encryptBackup(null, config, passphrase), passphrase), { connection: null, config });
});

function stores() {
  const data = { protectedSites: ['keep.test'], localActivity: { days: { fixture: true } } }; const values = new Map();
  const storage = { get: async () => structuredClone(data), set: async update => { Object.assign(data, structuredClone(update)); } };
  const local = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  return { data, values, storage, local, store: createConfigStore(storage, local) };
}

test('profile persistence and reinstall recovery preserve unrelated local history and protection data', async () => {
  const source = stores(); const connection = dav();
  assert.equal((await source.store.read()).preferences.launchMode, 'modal');
  await source.store.saveConnection(connection); await source.store.apply(document());
  const reopened = createConfigStore(source.storage, source.local);
  assert.deepEqual(await reopened.connection(), connection); assert.deepEqual(await reopened.read(), document());
  const clean = stores(); const passphrase = randomBytes(18).toString('hex');
  const backup = await decryptBackup(await encryptBackup(await reopened.connection(), await reopened.read(), passphrase), passphrase);
  await clean.store.apply(backup.config, backup.connection);
  assert.deepEqual(await clean.store.connection(), connection); assert.deepEqual(await clean.store.read(), document());
  assert.deepEqual(clean.data.protectedSites, ['keep.test']); assert.deepEqual(clean.data.localActivity, { days: { fixture: true } });
  assert.equal(Object.hasOwn(await clean.store.read(), 'localActivity'), false);
});

test('invalid imports and failed storage writes do not replace existing preferences', async () => {
  const fixture = stores(); fixture.local.setItem('theme', 'light');
  await assert.rejects(fixture.store.apply({ ...document(), version: 999 }), /INVALID_CONFIG/);
  assert.equal(fixture.local.getItem('theme'), 'light');
  fixture.storage.set = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(fixture.store.apply(document()), /Storage unavailable/);
  assert.equal(fixture.local.getItem('theme'), 'light'); assert.equal(fixture.local.getItem('language'), null);
});
