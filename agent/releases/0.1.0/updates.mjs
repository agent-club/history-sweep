import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute, basename } from 'node:path';
import { UPDATE_URL, BUNDLE_FILES } from './metadata.mjs';

const FILE_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const LOCK_NAME = '.history-sweep-update-lock';
const semver = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`AGENT_UPDATE_${code}`); };
const safeJson = bytes => JSON.parse(bytes.toString('utf8'));
const errorMessage = error => error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';

function versionParts(version) {
  const match = typeof version === 'string' && version.match(semver);
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) fail('MANIFEST');
  return match.slice(1).map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) fail('MANIFEST');
  versionParts(manifest.version);
  if (manifest.files.length !== BUNDLE_FILES.length) fail('MANIFEST');
  const byPath = new Map();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || byPath.has(file.path) || !BUNDLE_FILES.includes(file.path)) fail('MANIFEST');
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > FILE_LIMIT) fail('MANIFEST');
    if (typeof file.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(file.sha256)) fail('MANIFEST');
    let url;
    try { url = new URL(file.url); } catch { fail('MANIFEST'); }
    const decodedPath = (() => { try { return decodeURIComponent(url.pathname); } catch { return ''; } })();
    const prefix = `/agent/releases/${manifest.version}/`;
    if (url.protocol !== 'https:' || url.host !== 'sweep.agentclub.dev' || url.username || url.password || url.search || url.hash || decodedPath !== `${prefix}${file.path}`) fail('MANIFEST');
    total += file.size;
    if (total > TOTAL_LIMIT) fail('MANIFEST');
    byPath.set(file.path, file);
  }
  if (BUNDLE_FILES.some(path => !byPath.has(path))) fail('MANIFEST');
  return BUNDLE_FILES.map(path => byPath.get(path));
}
function timeoutSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
async function request(fetcher, url) {
  const timeout = timeoutSignal();
  try {
    const response = await fetcher(url, { redirect: 'error', signal: timeout.signal });
    if (!response?.ok) fail('NETWORK');
    return { response, clear: timeout.clear };
  } catch (error) {
    timeout.clear();
    if (error?.message?.startsWith('AGENT_UPDATE_')) throw error;
    fail('NETWORK');
  }
}
async function boundedBytes(response, max) {
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel(); fail('SIZE'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > max) fail('SIZE');
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith('AGENT_UPDATE_')) throw error;
    fail('DOWNLOAD');
  }
}
async function fetchManifest(options) {
  const requestResult = await request(options.fetch ?? globalThis.fetch, UPDATE_URL);
  let manifest;
  try {
    try { manifest = safeJson(await boundedBytes(requestResult.response, 1024 * 1024)); } catch (error) {
      if (error?.message?.startsWith('AGENT_UPDATE_')) throw error;
      fail('MANIFEST');
    }
  } finally { requestResult.clear(); }
  return { manifest, files: validateManifest(manifest) };
}
async function readActive(directory) {
  try {
    const active = safeJson(await readFile(join(directory, 'active.json')));
    versionParts(active.version);
    if (typeof active.installedAt !== 'string') fail('STATE');
    return active;
  } catch (error) {
    if (error?.message?.startsWith('AGENT_UPDATE_')) throw error;
    fail('STATE');
  }
}
async function writeAtomic(path, bytes) {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
async function writeJson(path, value) { await writeAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
async function updateState(directory, value) { await writeJson(join(directory, 'update-state.json'), value); }
function installationPath(directory, value) {
  if (!isAbsolute(value)) fail('STATE');
  return resolve(value);
}
async function readInstallation(directory) {
  let installation;
  try { installation = safeJson(await readFile(join(directory, 'installation.json'))); }
  catch (error) { if (error.code === 'ENOENT') return {}; fail('STATE'); }
  if (!installation || typeof installation !== 'object' || (installation.skillFiles !== undefined && !Array.isArray(installation.skillFiles))) fail('STATE');
  return installation;
}
async function checkedSkills(directory, installation) {
  const skills = installation.skillFiles ?? [];
  const checked = [];
  for (const entry of skills) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) fail('STATE');
    const path = installationPath(directory, entry.path);
    let bytes;
    try { bytes = await readFile(path); } catch { fail('SKILL_CHANGED'); }
    if (digest(bytes) !== entry.sha256.toLowerCase()) fail('SKILL_CHANGED');
    checked.push({ path, sha256: entry.sha256.toLowerCase(), bytes });
  }
  return checked;
}

async function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
async function acquireLock(root) {
  const lockPath = join(root, LOCK_NAME);
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const info = { pid: process.pid, nonce: randomUUID() };
      try { await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' }); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      return async () => {
        try {
          const current = safeJson(await readFile(join(lockPath, 'owner.json')));
          if (current.pid === info.pid && current.nonce === info.nonce) await rm(lockPath, { recursive: true });
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let info;
    try { info = safeJson(await readFile(join(lockPath, 'owner.json'))); }
    catch { return null; }
    if (!Number.isSafeInteger(info?.pid) || info.pid <= 0 || typeof info.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(info.nonce)) return null;
    // A live PID owns the lock indefinitely; only a provably dead PID permits crash recovery.
    if (await processIsAlive(info.pid)) return null;
    const reclaimPath = join(lockPath, 'reclaim');
    try { await mkdir(reclaimPath, { mode: 0o700 }); }
    catch { return null; }
    let confirmed;
    try { confirmed = safeJson(await readFile(join(lockPath, 'owner.json'))); }
    catch {
      await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    if (confirmed.pid !== info.pid || confirmed.nonce !== info.nonce || await processIsAlive(confirmed.pid)) {
      await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    const stalePath = join(root, `${LOCK_NAME}-stale-${randomUUID()}`);
    try { await rename(lockPath, stalePath); }
    catch {
      let stillSameOwner = false;
      try {
        const current = safeJson(await readFile(join(lockPath, 'owner.json')));
        stillSameOwner = current.pid === info.pid && current.nonce === info.nonce;
      } catch {}
      if (stillSameOwner) await rm(reclaimPath, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    await rm(stalePath, { recursive: true, force: true });
  }
}

export async function withInstallationLock(directory, operation) {
  const root = resolve(directory);
  const releaseLock = await acquireLock(root);
  if (!releaseLock) fail('BUSY');
  try { return await operation(); }
  finally { await releaseLock(); }
}

function journalPathsAreSafe(root, transaction, journal) {
  if (!journal || journal.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/.test(journal.id) || basename(transaction) !== `.history-sweep-update-${journal.id}` || !Array.isArray(journal.backups)) return false;
  try { versionParts(journal.targetVersion); } catch { return false; }
  const releases = join(root, 'releases');
  if (journal.staging !== join(releases, `.history-sweep-staging-${journal.id}`) || journal.release !== join(releases, journal.targetVersion)) return false;
  let priorInstallation = {};
  try {
    if (journal.previousInstallation !== null) priorInstallation = safeJson(Buffer.from(journal.previousInstallation, 'base64'));
    if (!priorInstallation || typeof priorInstallation !== 'object' || (priorInstallation.skillFiles !== undefined && !Array.isArray(priorInstallation.skillFiles))) return false;
    safeJson(Buffer.from(journal.previousActive, 'base64'));
  } catch { return false; }
  const priorSkills = priorInstallation.skillFiles ?? [];
  if (priorSkills.length !== journal.backups.length) return false;
  const paths = new Set();
  return journal.backups.every((item, index) => {
    const prior = priorSkills[index];
    if (!item || typeof item.path !== 'string' || !isAbsolute(item.path) || resolve(item.path) !== item.path || item.backup !== `skill-${index}.bak` || !/^[a-f0-9]{64}$/.test(item.oldSha256) || !/^[a-f0-9]{64}$/.test(item.newSha256) || paths.has(item.path)) return false;
    if (!prior || typeof prior.path !== 'string' || resolve(prior.path) !== item.path || typeof prior.sha256 !== 'string' || prior.sha256.toLowerCase() !== item.oldSha256) return false;
    paths.add(item.path);
    return true;
  });
}

export async function checkUpdate(directory, options = {}) {
  const root = resolve(directory);
  const active = await readActive(root);
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    const { manifest } = await fetchManifest(options);
    const available = compareVersions(manifest.version, active.version) > 0;
    const result = { checkedAt, installedVersion: active.version, latestVersion: manifest.version, available };
    await updateState(root, result);
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const state = { checkedAt, installedVersion: active.version, latestVersion: null, available: false, error: message.startsWith('AGENT_UPDATE_') ? message : 'AGENT_UPDATE_NETWORK' };
    await updateState(root, state);
    throw message.startsWith('AGENT_UPDATE_') ? error : new Error(state.error);
  }
}

export async function applyUpdate(directory, options = {}) {
  const root = resolve(directory);
  const releaseLock = await acquireLock(root);
  if (!releaseLock) fail('BUSY');
  try {
    await recoverLocked(root);
    return await applyLocked(root, options);
  } finally { await releaseLock(); }
}

async function applyLocked(root, options = {}) {
  const active = await readActive(root);
  const installation = await readInstallation(root);
  const skills = await checkedSkills(root, installation);
  const { manifest, files } = await fetchManifest(options);
  if (compareVersions(manifest.version, active.version) <= 0) fail('NOT_NEWER');
  const releases = join(root, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const transactionId = randomUUID();
  const staging = join(releases, `.history-sweep-staging-${transactionId}`);
  const transaction = join(root, `.history-sweep-update-${transactionId}`);
  let journalWritten = false;
  let stagingCreated = false;
  let transactionCreated = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingCreated = true;
    await mkdir(transaction, { mode: 0o700 });
    transactionCreated = true;
    const downloaded = new Map();
    for (const file of files) {
      const requestResult = await request(options.fetch ?? globalThis.fetch, file.url);
      let bytes;
      try { bytes = await boundedBytes(requestResult.response, FILE_LIMIT); }
      finally { requestResult.clear(); }
      if (bytes.length !== file.size || digest(bytes) !== file.sha256.toLowerCase()) fail('INTEGRITY');
      downloaded.set(file.path, bytes);
      const target = join(staging, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    const newSkill = downloaded.get('skills/history-sweep/SKILL.md');
    const backups = [];
    for (let i = 0; i < skills.length; i++) {
      const backup = `skill-${i}.bak`;
      await writeFile(join(transaction, backup), skills[i].bytes, { mode: 0o600, flag: 'wx' });
      backups.push({ path: skills[i].path, backup, oldSha256: skills[i].sha256, newSha256: digest(newSkill) });
    }
    const previousInstallation = await readFile(join(root, 'installation.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const previousActive = await readFile(join(root, 'active.json'));
    const journal = { schemaVersion: 1, id: transactionId, phase: 'prepared', targetVersion: manifest.version, staging, release: join(releases, manifest.version), backups, previousInstallation: previousInstallation?.toString('base64') ?? null, previousActive: previousActive.toString('base64'), nextInstallation: { ...installation, skillFiles: backups.map(item => ({ path: item.path, sha256: item.newSha256 })) } };
    await writeJson(join(transaction, 'journal.json'), journal);
    journalWritten = true;
    const release = join(releases, manifest.version);
    let releaseExists = false;
    try { await stat(release); releaseExists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (releaseExists) {
      for (const path of BUNDLE_FILES) {
        let existing;
        try { existing = await readFile(join(release, ...path.split('/'))); }
        catch { fail('RELEASE_CONFLICT'); }
        if (!existing.equals(downloaded.get(path))) fail('RELEASE_CONFLICT');
      }
    } else await rename(staging, release);
    for (const item of backups) {
      const latest = await readFile(item.path).catch(() => fail('SKILL_CHANGED'));
      if (digest(latest) !== item.oldSha256) fail('SKILL_CHANGED');
      await writeAtomic(item.path, newSkill);
    }
    await writeJson(join(root, 'installation.json'), journal.nextInstallation);
    await writeJson(join(root, 'active.json'), { version: manifest.version, installedAt: new Date((options.now ?? Date.now)()).toISOString() });
    journal.phase = 'committed';
    await writeJson(join(transaction, 'journal.json'), journal);
    await rm(transaction, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    return { version: manifest.version, installedAt: (await readActive(root)).installedAt };
  } catch (error) {
    if (journalWritten) {
      try { await recoverLocked(root); } catch {}
    } else if (transactionCreated) await rm(transaction, { recursive: true, force: true }).catch(() => {});
    if (stagingCreated) await rm(staging, { recursive: true, force: true }).catch(() => {});
    const message = errorMessage(error);
    throw message.startsWith('AGENT_UPDATE_') ? error : new Error('AGENT_UPDATE_APPLY');
  }
}

async function recoverLocked(root) {
  const names = await readdir(root);
  const journals = names.filter(name => /^\.history-sweep-update-[0-9a-f-]+$/.test(name));
  for (const name of journals) {
    const transaction = join(root, name);
    let journal;
    try { journal = safeJson(await readFile(join(transaction, 'journal.json'))); }
    catch (error) { if (error.code === 'ENOENT') continue; fail('RECOVERY'); }
    if (!journalPathsAreSafe(root, transaction, journal)) fail('RECOVERY');
    const active = await readActive(root);
    const previousActive = safeJson(Buffer.from(journal.previousActive, 'base64'));
    versionParts(previousActive.version);
    if (active.version === journal.targetVersion) {
      // active.json is switched after Skill and installation metadata, so the target version is the commit point.
      if (journal.phase !== 'prepared' && journal.phase !== 'committed') fail('RECOVERY');
      await rm(journal.staging, { recursive: true, force: true });
      await rm(transaction, { recursive: true });
      continue;
    }
    if (active.version !== previousActive.version || journal.phase !== 'prepared') fail('RECOVERY');
    for (const item of journal.backups) {
      const path = installationPath(root, item.path);
      let current;
      try { current = await readFile(path); } catch { fail('RECOVERY'); }
      const currentHash = digest(current);
      if (currentHash !== item.oldSha256 && currentHash !== item.newSha256) fail('RECOVERY');
      if (currentHash === item.newSha256) {
        const backupPath = join(transaction, item.backup);
        const backup = await readFile(backupPath);
        if (digest(backup) !== item.oldSha256) fail('RECOVERY');
        await writeAtomic(path, backup);
      }
    }
    if (journal.previousInstallation === null) await rm(join(root, 'installation.json'), { force: true });
    else await writeAtomic(join(root, 'installation.json'), Buffer.from(journal.previousInstallation, 'base64'));
    await rm(journal.staging, { recursive: true, force: true });
    await rm(transaction, { recursive: true });
  }
}

export async function recoverUpdate(directory) {
  const root = resolve(directory);
  const releaseLock = await acquireLock(root);
  if (!releaseLock) return { busy: true };
  try { await recoverLocked(root); return { busy: false }; }
  finally { await releaseLock(); }
}
