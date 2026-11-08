import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const UPDATE_URL = 'https://sweep.agentclub.dev/agent/latest.json';
export const RELEASE_ROOT = 'https://sweep.agentclub.dev/agent/releases/';
export const MAX_FILE_SIZE = 2 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 8 * 1024 * 1024;
export const BUNDLE_FILES = Object.freeze([
  'metadata.mjs', 'protocol.mjs', 'native-host.mjs', 'client.mjs', 'mcp.mjs',
  'install.mjs', 'manage.mjs', 'updates.mjs', 'skills/history-sweep/SKILL.md',
]);
const execFileAsync = promisify(execFile);
const timeoutSignal = () => AbortSignal.timeout(30_000);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..') && posix.normalize(value) === value;
}

async function fetchBytes(fetchImpl, url, limit) {
  const response = await fetchImpl(url, { redirect: 'error', signal: timeoutSignal() });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('Download exceeds size limit');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('Download exceeds size limit');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Download exceeds size limit');
  return bytes;
}

function parseRelease(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Invalid agent release manifest');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== BUNDLE_FILES.length) throw new Error('Invalid release file set');
  const entries = new Map();
  for (const file of manifest.files) {
    if (!file || !validRelativePath(file.path) || !BUNDLE_FILES.includes(file.path) || entries.has(file.path)) throw new Error('Invalid release file path');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid release file metadata');
    }
    const expectedUrl = `${RELEASE_ROOT}${manifest.version}/${file.path}`;
    if (file.url !== expectedUrl) throw new Error('Invalid release file URL');
    entries.set(file.path, file);
  }
  if (BUNDLE_FILES.some(path => !entries.has(path))) throw new Error('Incomplete release file set');
  return entries;
}

export async function downloadVerifiedRelease({ fetchImpl = globalThis.fetch, directory }) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');
  const manifestBytes = await fetchBytes(fetchImpl, UPDATE_URL, 256 * 1024);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('Invalid agent release manifest JSON'); }
  const entries = parseRelease(manifest);
  const declaredTotal = [...entries.values()].reduce((sum, file) => sum + file.size, 0);
  if (declaredTotal > MAX_TOTAL_SIZE) throw new Error('Release exceeds total size limit');
  const base = await realpath(directory);
  for (const path of BUNDLE_FILES) {
    const file = entries.get(path);
    const url = `${RELEASE_ROOT}${manifest.version}/${path}`;
    const bytes = await fetchBytes(fetchImpl, url, Math.min(MAX_FILE_SIZE, file.size));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Release verification failed: ${path}`);
    const target = resolve(base, ...path.split('/'));
    if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('Release path escapes temporary directory');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { version: manifest.version, directory: base, installScript: join(base, 'install.mjs') };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--extension-id', '--client'].includes(flag) || values.has(flag) || !value) throw new Error('Usage: node bootstrap.mjs --extension-id ID --client codex|claude-code');
    values.set(flag, value);
  }
  const extensionId = values.get('--extension-id');
  const client = values.get('--client');
  if (!/^[a-p]{32}$/.test(extensionId || '') || !['codex', 'claude-code'].includes(client)) throw new Error('Invalid bootstrap arguments');
  return { extensionId, client };
}

export async function runBootstrap({ extensionId, client, fetchImpl = globalThis.fetch, tempRoot = tmpdir(), run = execFileAsync }) {
  if (!/^[a-p]{32}$/.test(extensionId || '') || !['codex', 'claude-code'].includes(client)) throw new Error('Invalid bootstrap arguments');
  const root = await realpath(tempRoot);
  const temporary = await mkdtemp(join(root, 'history-sweep-bootstrap-'));
  const resolved = await realpath(temporary);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error('Temporary directory is outside the system temporary root');
  try {
    const release = await downloadVerifiedRelease({ fetchImpl, directory: resolved });
    await run(process.execPath, [release.installScript, '--extension-id', extensionId, '--client', client, '--install'], { windowsHide: true });
    return release.version;
  } finally {
    await rm(resolved, { recursive: true, force: true });
  }
}

async function main() {
  const { extensionId, client } = parseArgs(process.argv.slice(2));
  const version = await runBootstrap({ extensionId, client });
  console.log(`History Sweep agent ${version} installed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
