import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { nativeFrame, readNative, readLines } from '../agent/protocol.mjs';
import { callProfile, listProfiles } from '../agent/client.mjs';
import { registrationPlan, prepareCompanion } from '../agent/install.mjs';

test('native framing handles fragmented UTF-8, two profiles, reconnect and clean shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-sweep-native-'));
  const previous = process.env.HISTORY_SWEEP_AGENT_HOME;
  process.env.HISTORY_SWEEP_AGENT_HOME = directory;
  const children = [];
  async function host(profileId) {
    const child = spawn(process.execPath, [new URL('../agent/native-host.mjs', import.meta.url).pathname], { env: { ...process.env, HISTORY_SWEEP_AGENT_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const ready = new Promise((resolve, reject) => {
      child.once('exit', code => reject(new Error(`Native host exited: ${code}`)));
      readNative(child.stdout, message => {
        if (message.type === 'ready') resolve();
        else child.stdin.write(nativeFrame({ id: message.id, ok: true, data: { profileId, operation: message.operation } }));
      }, () => reject(new Error('Invalid framing')));
    });
    const frame = nativeFrame({ type: 'hello', profileId });
    child.stdin.write(frame.subarray(0, 3)); child.stdin.write(frame.subarray(3));
    await ready;
    return child;
  }
  try {
    const first = randomUUID(), second = randomUUID();
    const child = await host(first);
    await host(second);
    assert.equal((await listProfiles()).length, 2);
    assert.equal((await callProfile(first, randomUUID(), 'list', {})).profileId, first);
    assert.equal((await callProfile(second, randomUUID(), 'preview', { rule: { domain: '合成.example' } })).profileId, second);
    const duplicate = await host(first);
    await assert.rejects(callProfile(first, randomUUID(), 'list', {}), /AGENT_PROFILE_AMBIGUOUS/);
    const closed = once(duplicate, 'exit'); duplicate.stdin.end(); await closed;
    const stopped = once(child, 'exit'); child.stdin.end(); await stopped;
    await assert.rejects(callProfile(first, randomUUID(), 'list', {}), /AGENT_PROFILE_DISCONNECTED/);
    await host(first);
    assert.equal((await callProfile(first, randomUUID(), 'list', {})).profileId, first);
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    }
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null).map(async child => { const stopped = once(child, 'exit'); child.stdin.end(); await stopped; }));
    if (previous === undefined) delete process.env.HISTORY_SWEEP_AGENT_HOME; else process.env.HISTORY_SWEEP_AGENT_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test('installer creates a self-contained companion and preserves an existing different file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history sweep install-'));
  try {
    const extensionId = 'a'.repeat(32);
    const plan = await prepareCompanion(directory, extensionId);
    assert.deepEqual(plan.manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    for (const platform of ['darwin', 'linux', 'win32']) {
      const target = registrationPlan({ platform, home: directory, directory, extensionId });
      assert.equal(target.manifest.name, 'dev.agentclub.history_sweep');
      assert.ok(platform !== 'win32' || target.registryKey.startsWith('HKCU'));
    }
    await assert.rejects(prepareCompanion(directory, 'b'.repeat(32)), /Existing file differs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('packaged stdio MCP starts from a temporary path and handles discovery without browser access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history sweep stdio-'));
  let child;
  try {
    await prepareCompanion(directory, 'a'.repeat(32));
    child = spawn(process.execPath, [join(directory, 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const result = new Promise((resolve, reject) => {
      child.once('exit', () => reject(new Error('MCP exited before initialization')));
      readLines(child.stdout, resolve, () => reject(new Error('Invalid MCP output')));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
    const response = await result;
    assert.equal(response.result.protocolVersion, '2025-11-25');
    const exited = once(child, 'exit'); child.stdin.end(); await exited;
    assert.equal(child.exitCode, 0);
  } finally {
    if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
