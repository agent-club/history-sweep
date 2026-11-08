import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { BUNDLE_FILES, MAX_FILE_SIZE, RELEASE_ROOT, UPDATE_URL, downloadVerifiedRelease, runBootstrap } from '../agent/bootstrap.mjs';
import { createInstaller, createInstallerDownload } from '../extension/agent-installers.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const digest = 'a'.repeat(64);
const bytesFor = path => Buffer.from(`synthetic ${path}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture({ mutateManifest, corruptPath } = {}) {
  const files = BUNDLE_FILES.map(path => {
    const bytes = bytesFor(path);
    return { path, url: `${RELEASE_ROOT}1.2.3/${path}`, size: bytes.length, sha256: hash(bytes) };
  });
  let manifest = { schemaVersion: 1, version: '1.2.3', files };
  if (mutateManifest) manifest = mutateManifest(manifest);
  return async url => {
    if (url === UPDATE_URL) return response(Buffer.from(JSON.stringify(manifest)));
    const path = url.slice(`${RELEASE_ROOT}1.2.3/`.length);
    let bytes = bytesFor(path);
    if (path === corruptPath) bytes = Buffer.from('corrupt');
    return response(bytes);
  };
}

function response(bytes) {
  return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes };
}

test('installer generator validates arguments and emits platform launchers', () => {
  assert.throws(() => createInstaller({ platform: 'darwin', extensionId, client: 'codex', bootstrapSha256: digest }), /platform/i);
  assert.throws(() => createInstaller({ platform: 'macos', extensionId: 'bad', client: 'codex', bootstrapSha256: digest }), /extension/i);
  assert.throws(() => createInstaller({ platform: 'linux', extensionId, client: 'other', bootstrapSha256: digest }), /client/i);
  assert.throws(() => createInstaller({ platform: 'windows', extensionId, client: 'codex', bootstrapSha256: 'bad' }), /SHA/i);

  for (const [platform, filename] of [['macos', 'history-sweep-agent-install.command'], ['linux', 'history-sweep-agent-install.sh']]) {
    const installer = createInstaller({ platform, extensionId, client: 'codex', bootstrapSha256: digest });
    assert.equal(installer.filename, filename);
    assert.ok(installer.content.includes(digest));
    assert.ok(installer.content.includes('https://sweep.agentclub.dev/agent/bootstrap.mjs'));
    const check = spawnSync('sh', ['-n'], { input: installer.content, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
  const windows = createInstaller({ platform: 'windows', extensionId, client: 'claude-code', bootstrapSha256: digest });
  assert.equal(windows.filename, 'history-sweep-agent-install.cmd');
  assert.match(windows.content, /powershell\.exe -NoProfile -Command/);
  assert.doesNotMatch(windows.content, /ExecutionPolicy\s+Bypass/i);
  const commandLine = windows.content.split('\r\n')[1];
  assert.match(commandLine, /^powershell\.exe -NoProfile -Command "/);
  assert.ok(commandLine);
  const command = commandLine.split('-Command "')[1].slice(0, -1);
  assert.ok(command);
  assert.doesNotMatch(command, /[\r\n]/);
  assert.doesNotMatch(command, /"/);
  assert.ok(windows.content.includes(digest));
  const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', `[ScriptBlock]::Create(@'\n${command}\n'@) | Out-Null`], { encoding: 'utf8' });
  if (powershell.error?.code !== 'ENOENT') assert.equal(powershell.status, 0, powershell.stderr);
});

test('POSIX portable Node runtime is reused without downloading the archive again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-sweep runtime reuse-'));
  const home = join(root, 'home directory');
  const bin = join(root, 'mock-bin');
  const temporary = join(root, 'temporary files');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(bin), mkdir(temporary)]);
  const archive = Buffer.from('synthetic checked archive');
  const bootstrap = Buffer.from('synthetic pinned bootstrap');
  const callsFile = join(root, 'curl calls');
  const nodeCalls = join(root, 'runtime calls');
  const archiveFile = join(root, 'archive.fixture');
  const bootstrapFile = join(root, 'bootstrap.fixture');
  const nodeFile = join(root, 'node.fixture');
  await Promise.all([writeFile(archiveFile, archive), writeFile(bootstrapFile, bootstrap),
    writeFile(nodeFile, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NODE_CALL_LOG"\n`)]);
  const writeShim = async (name, body) => {
    const file = join(bin, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  };
  await writeShim('node', 'if [ "${1-}" = "-e" ]; then exit 1; fi; exit 99');
  await writeShim('uname', 'printf "x86_64\\n"');
  await writeShim('tar', 'cat "$NODE_FIXTURE"');
  await writeShim('curl', `while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac; done
printf '%s\\n' "$url" >> "$CURL_CALL_LOG"
case "$url" in *node-v24.22.2-linux-x64.tar.gz) cp "$ARCHIVE_FIXTURE" "$out" ;; *bootstrap.mjs) cp "$BOOTSTRAP_FIXTURE" "$out" ;; *) exit 2 ;; esac`);

  const installer = createInstaller({ platform: 'linux', extensionId, client: 'codex', bootstrapSha256: hash(bootstrap) });
  const officialHash = '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9';
  const launcherPath = join(root, installer.filename);
  await writeFile(launcherPath, installer.content.replace(officialHash, hash(archive)));
  const env = { ...process.env, HOME: home, TMPDIR: temporary, PATH: `${bin}:${process.env.PATH}`,
    ARCHIVE_FIXTURE: archiveFile, BOOTSTRAP_FIXTURE: bootstrapFile, NODE_FIXTURE: nodeFile,
    CURL_CALL_LOG: callsFile, NODE_CALL_LOG: nodeCalls };
  try {
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('sh', [launcherPath], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const urls = (await readFile(callsFile, 'utf8')).trim().split('\n');
    assert.equal(urls.filter(url => url.includes('node-v24.22.2-linux-x64.tar.gz')).length, 1);
    assert.equal(urls.filter(url => url.endsWith('/agent/bootstrap.mjs')).length, 2);
    assert.equal((await readFile(nodeCalls, 'utf8')).trim().split('\n').length, 2);
    const runtime = join(home, '.history-sweep', 'runtime', 'node-v24.22.2-linux-x64');
    const [archivePin, binaryPin] = (await readFile(join(runtime, 'verified'), 'utf8')).trim().split(' ');
    assert.equal(archivePin, hash(archive));
    assert.equal(binaryPin, hash(await readFile(join(runtime, 'node'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer download is a single-file ZIP that preserves POSIX execute bits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-sweep-zip-test-'));
  try {
    const options = { platform: 'macos', extensionId, client: 'codex', bootstrapSha256: digest };
    const plain = createInstaller(options);
    const zipped = createInstallerDownload(options);
    const archive = join(root, zipped.filename);
    await writeFile(archive, zipped.bytes);
    assert.equal(zipped.filename, `${plain.filename}.zip`);
    assert.equal(zipped.mimeType, 'application/zip');
    const integrity = spawnSync('unzip', ['-t', archive], { encoding: 'utf8' });
    assert.equal(integrity.status, 0, integrity.stderr || integrity.stdout);
    const contents = spawnSync('unzip', ['-p', archive, plain.filename]);
    assert.equal(contents.status, 0, contents.stderr?.toString());
    assert.equal(contents.stdout.toString(), plain.content);
    const bytes = await readFile(archive);
    const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(endOffset, -1);
    const externalAttributes = bytes.readUInt32LE(endOffset + 38);
    assert.equal(externalAttributes >>> 16, 0o100755);

    const windows = createInstallerDownload({ ...options, platform: 'windows' });
    const windowsArchive = join(root, windows.filename);
    await writeFile(windowsArchive, windows.bytes);
    const windowsBytes = await readFile(windowsArchive);
    const windowsCentral = windowsBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.equal(windowsBytes.readUInt32LE(windowsCentral + 38) >>> 16, 0o100644);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified release downloads the exact bundle under fixed release URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-sweep-test-'));
  try {
    const result = await downloadVerifiedRelease({ fetchImpl: fixture(), directory: root });
    assert.equal(result.version, '1.2.3');
    assert.equal(result.installScript, join(await realpath(root), 'install.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release path, declared size, and digest failures are rejected before installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-sweep-test-'));
  let executions = 0;
  try {
    await assert.rejects(downloadVerifiedRelease({ fetchImpl: fixture({ mutateManifest(manifest) {
      manifest.files[0].path = '../escape';
      return manifest;
    } }), directory: root }), /path/i);
    await assert.rejects(downloadVerifiedRelease({ fetchImpl: fixture({ mutateManifest(manifest) {
      manifest.files[0].size = MAX_FILE_SIZE + 1;
      return manifest;
    } }), directory: root }), /metadata/i);
    await assert.rejects(runBootstrap({ extensionId, client: 'codex', fetchImpl: fixture({ corruptPath: BUNDLE_FILES[0] }), tempRoot: root,
      run: async () => { executions++; } }), /verification failed/i);
    assert.equal(executions, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bootstrap arguments fail before network access', async () => {
  let requests = 0;
  await assert.rejects(runBootstrap({ extensionId: 'bad', client: 'codex', fetchImpl: async () => { requests++; }, tempRoot: tmpdir() }), /arguments/i);
  await assert.rejects(runBootstrap({ extensionId, client: 'invalid', fetchImpl: async () => { requests++; }, tempRoot: tmpdir() }), /arguments/i);
  assert.equal(requests, 0);
});
