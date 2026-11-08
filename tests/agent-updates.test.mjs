import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BUNDLE_FILES, UPDATE_URL } from '../agent/metadata.mjs';
import { applyUpdate, checkUpdate, recoverUpdate, withInstallationLock } from '../agent/updates.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, version = '1.0.0') {
  const directory = await mkdtemp(join(tmpdir(), 'history-sweep-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'active.json'), JSON.stringify({ version, installedAt: '2026-01-01T00:00:00.000Z' }));
  return directory;
}
function bundle(version = '1.1.0') {
  const bytes = new Map(BUNDLE_FILES.map(path => [path, Buffer.from(path === 'skills/history-sweep/SKILL.md' ? `skill ${version}` : `${path} ${version}`)]));
  const manifest = { schemaVersion: 1, version, files: BUNDLE_FILES.map(path => ({ path, url: `https://sweep.agentclub.dev/agent/releases/${version}/${path}`, size: bytes.get(path).length, sha256: sha256(bytes.get(path)) })) };
  return { bytes, manifest };
}
function fakeFetch({ manifest, bytes, mutate, interrupt }) {
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === UPDATE_URL) return new Response(JSON.stringify(mutate ? mutate(manifest) : manifest), { status: 200 });
    if (interrupt && url.endsWith('/client.mjs')) throw new Error('connection reset');
    const path = decodeURIComponent(new URL(url).pathname.split('/agent/releases/')[1].split('/').slice(1).join('/'));
    return new Response(bytes.get(path), { status: 200 });
  };
}

test('check and apply a valid newer bundle, including registered Skill copies', async t => {
  const directory = await fixture(t);
  const { bytes, manifest } = bundle();
  const skillPath = join(directory, 'registered-skill.md');
  const oldSkill = Buffer.from('managed old skill');
  await writeFile(skillPath, oldSkill);
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ preserved: true, skillFiles: [{ path: skillPath, sha256: sha256(oldSkill) }] }));
  const fetch = fakeFetch({ manifest, bytes });
  assert.deepEqual(await checkUpdate(directory, { fetch, now: () => Date.parse('2026-05-01T00:00:00Z') }), {
    checkedAt: '2026-05-01T00:00:00.000Z', installedVersion: '1.0.0', latestVersion: '1.1.0', available: true,
  });
  await applyUpdate(directory, { fetch, now: () => Date.parse('2026-05-02T00:00:00Z') });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'active.json'))), { version: '1.1.0', installedAt: '2026-05-02T00:00:00.000Z' });
  assert.deepEqual(await readFile(skillPath), bytes.get('skills/history-sweep/SKILL.md'));
  const installation = JSON.parse(await readFile(join(directory, 'installation.json')));
  assert.equal(installation.preserved, true);
  assert.equal(installation.skillFiles[0].sha256, sha256(bytes.get('skills/history-sweep/SKILL.md')));
  for (const path of BUNDLE_FILES) assert.deepEqual(await readFile(join(directory, 'releases', '1.1.0', ...path.split('/'))), bytes.get(path));
});

test('same and older versions are unavailable', async t => {
  const directory = await fixture(t, '1.1.0');
  for (const version of ['1.1.0', '1.0.9']) {
    const { bytes, manifest } = bundle(version);
    const result = await checkUpdate(directory, { fetch: fakeFetch({ manifest, bytes }) });
    assert.equal(result.available, false);
  }
});

test('maps a null fetch rejection to AGENT_UPDATE_NETWORK safely', async t => {
  const directory = await fixture(t);
  await assert.rejects(checkUpdate(directory, { fetch: async () => { throw null; } }), /AGENT_UPDATE_NETWORK/);
  assert.equal(JSON.parse(await readFile(join(directory, 'update-state.json'))).error, 'AGENT_UPDATE_NETWORK');
});

test('rejects malicious URL, missing file and unsafe bundle path', async t => {
  const directory = await fixture(t);
  for (const mutate of [
    manifest => ({ ...manifest, files: manifest.files.map((file, i) => i ? file : { ...file, url: 'https://evil.example/file' }) }),
    manifest => ({ ...manifest, files: manifest.files.slice(1) }),
    manifest => ({ ...manifest, files: manifest.files.map((file, i) => i ? file : { ...file, path: '../active.json' }) }),
  ]) {
    const { bytes, manifest } = bundle();
    await assert.rejects(checkUpdate(directory, { fetch: fakeFetch({ manifest, bytes, mutate }) }), /AGENT_UPDATE_MANIFEST/);
  }
});

test('rejects wrong size, hash and interrupted download without switching', async t => {
  const directory = await fixture(t);
  const baseline = await readFile(join(directory, 'active.json'));
  for (const mutate of [m => ({ ...m, files: m.files.map((file, i) => i ? file : { ...file, size: file.size + 1 }) }),
    m => ({ ...m, files: m.files.map((file, i) => i ? file : { ...file, sha256: '0'.repeat(64) }) })]) {
    const { bytes, manifest } = bundle();
    await assert.rejects(applyUpdate(directory, { fetch: fakeFetch({ manifest, bytes, mutate }) }), /AGENT_UPDATE_(?:INTEGRITY|MANIFEST)/);
    assert.deepEqual(await readFile(join(directory, 'active.json')), baseline);
  }
  const { bytes, manifest } = bundle();
  await assert.rejects(applyUpdate(directory, { fetch: fakeFetch({ manifest, bytes, interrupt: true }) }), /AGENT_UPDATE_NETWORK/);
  assert.deepEqual(await readFile(join(directory, 'active.json')), baseline);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.history-sweep-staging-') || name.startsWith('.history-sweep-update-')), []);
});

test('does not replace locally modified managed Skill file', async t => {
  const directory = await fixture(t);
  const skillPath = join(directory, 'registered-skill.md');
  await writeFile(skillPath, 'locally edited');
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256('installed original') }] }));
  const { bytes, manifest } = bundle();
  await assert.rejects(applyUpdate(directory, { fetch: fakeFetch({ manifest, bytes }) }), /AGENT_UPDATE_SKILL_CHANGED/);
  assert.equal(await readFile(skillPath, 'utf8'), 'locally edited');
});

test('rolls back a failed switch and recovers a prepared journal', async t => {
  const directory = await fixture(t);
  const skillPath = join(directory, 'registered-skill.md');
  const oldSkill = Buffer.from('old skill');
  await writeFile(skillPath, oldSkill);
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256(oldSkill) }] }));
  const { bytes, manifest } = bundle();
  const fetch = fakeFetch({ manifest, bytes });
  await assert.rejects(applyUpdate(directory, { fetch, now: () => { throw new Error('simulated active switch failure'); } }), /AGENT_UPDATE_APPLY/);
  assert.equal(JSON.parse(await readFile(join(directory, 'active.json'))).version, '1.0.0');
  assert.deepEqual(await readFile(skillPath), oldSkill);
  assert.equal(JSON.parse(await readFile(join(directory, 'installation.json'))).skillFiles[0].sha256, sha256(oldSkill));

  const transaction = join(directory, '.history-sweep-update-abcdefab-cdef-abcd-efab-cdefabcdefab');
  await mkdir(transaction);
  await writeFile(join(transaction, 'skill-0.bak'), oldSkill);
  const changedSkill = Buffer.from('new skill');
  await writeFile(skillPath, changedSkill);
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256(changedSkill) }] }));
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ schemaVersion: 1, id: 'abcdefab-cdef-abcd-efab-cdefabcdefab', phase: 'prepared', targetVersion: '2.0.0', staging: join(directory, 'releases', '.history-sweep-staging-abcdefab-cdef-abcd-efab-cdefabcdefab'), release: join(directory, 'releases', '2.0.0'), backups: [{ path: skillPath, backup: 'skill-0.bak', oldSha256: sha256(oldSkill), newSha256: sha256(changedSkill) }], previousInstallation: Buffer.from(JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256(oldSkill) }] })).toString('base64'), previousActive: Buffer.from(JSON.stringify({ version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })).toString('base64') }));
  await recoverUpdate(directory);
  assert.deepEqual(await readFile(skillPath), oldSkill);
  assert.equal(JSON.parse(await readFile(join(directory, 'active.json'))).version, '1.0.0');
});

test('does not recover or start another update while a live update owns the lock', async t => {
  const directory = await fixture(t);
  const { bytes, manifest } = bundle();
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let releaseFetch;
  const waitFetch = new Promise(resolve => { releaseFetch = resolve; });
  const fetch = async (url, options) => {
    if (url === UPDATE_URL) { started(); await waitFetch; }
    return fakeFetch({ manifest, bytes })(url, options);
  };
  const running = applyUpdate(directory, { fetch });
  await entered;
  assert.deepEqual(await recoverUpdate(directory), { busy: true });
  await assert.rejects(applyUpdate(directory, { fetch: fakeFetch({ manifest, bytes }) }), /AGENT_UPDATE_BUSY/);
  releaseFetch();
  await running;
  assert.equal(JSON.parse(await readFile(join(directory, 'active.json'))).version, '1.1.0');
});

test('shares the installation lock with other installer operations', async t => {
  const directory = await fixture(t);
  let entered;
  const isInside = new Promise(resolve => { entered = resolve; });
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const operation = withInstallationLock(directory, async () => { entered(); await wait; return 'done'; });
  await isInside;
  await assert.rejects(withInstallationLock(directory, async () => 'unexpected'), /AGENT_UPDATE_BUSY/);
  finish();
  assert.equal(await operation, 'done');
  assert.equal(await withInstallationLock(directory, async () => 'next'), 'next');
});

test('recovers a prepared journal after its recorded process has exited', async t => {
  const directory = await fixture(t);
  const lockPath = join(directory, '.history-sweep-update-lock');
  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99_999_999, nonce: 'abcdefab-cdef-abcd-efab-cdefabcdefab' }));
  const transaction = join(directory, '.history-sweep-update-abcdefab-cdef-abcd-efab-cdefabcdefab');
  await mkdir(transaction);
  const skillPath = join(directory, 'skill.md');
  const oldSkill = Buffer.from('old'), newSkill = Buffer.from('new');
  await writeFile(skillPath, newSkill);
  await writeFile(join(transaction, 'skill-0.bak'), oldSkill);
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256(newSkill) }] }));
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ schemaVersion: 1, id: 'abcdefab-cdef-abcd-efab-cdefabcdefab', phase: 'prepared', targetVersion: '1.1.0', staging: join(directory, 'releases', '.history-sweep-staging-abcdefab-cdef-abcd-efab-cdefabcdefab'), release: join(directory, 'releases', '1.1.0'), backups: [{ path: skillPath, backup: 'skill-0.bak', oldSha256: sha256(oldSkill), newSha256: sha256(newSkill) }], previousInstallation: Buffer.from(JSON.stringify({ skillFiles: [{ path: skillPath, sha256: sha256(oldSkill) }] })).toString('base64'), previousActive: Buffer.from(JSON.stringify({ version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })).toString('base64') }));
  assert.deepEqual(await recoverUpdate(directory), { busy: false });
  assert.deepEqual(await readFile(skillPath), oldSkill);
  assert.equal(JSON.parse(await readFile(join(directory, 'active.json'))).version, '1.0.0');
});

test('serializes concurrent takeover attempts for one dead owner on disk', async t => {
  const directory = await fixture(t);
  const lockPath = join(directory, '.history-sweep-update-lock');
  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99_999_999, nonce: 'abcdefab-cdef-abcd-efab-cdefabcdefab' }));
  let activeOwners = 0;
  let maxActiveOwners = 0;
  const attempts = Array.from({ length: 12 }, () => withInstallationLock(directory, async () => {
    activeOwners++;
    maxActiveOwners = Math.max(maxActiveOwners, activeOwners);
    await new Promise(resolve => setTimeout(resolve, 5));
    activeOwners--;
    return true;
  }));
  const results = await Promise.allSettled(attempts);
  assert.equal(maxActiveOwners, 1);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value === true));
  for (const result of results) {
    if (result.status === 'rejected') assert.match(result.reason.message, /AGENT_UPDATE_BUSY/);
  }
});

test('keeps a version active when a prepared journal survived after active.json switched', async t => {
  const directory = await fixture(t);
  const id = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const transaction = join(directory, `.history-sweep-update-${id}`);
  await mkdir(transaction);
  await writeFile(join(directory, 'active.json'), JSON.stringify({ version: '1.1.0', installedAt: '2026-01-02T00:00:00.000Z' }));
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ schemaVersion: 1, id, phase: 'prepared', targetVersion: '1.1.0', staging: join(directory, 'releases', `.history-sweep-staging-${id}`), release: join(directory, 'releases', '1.1.0'), backups: [], previousInstallation: null, previousActive: Buffer.from(JSON.stringify({ version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })).toString('base64') }));
  await recoverUpdate(directory);
  assert.equal(JSON.parse(await readFile(join(directory, 'active.json'))).version, '1.1.0');
  await assert.rejects(readFile(transaction), { code: 'ENOENT' });
});
