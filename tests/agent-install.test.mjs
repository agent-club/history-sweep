import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { configureClients, prepareCompanion, registrationPlan, setupIntegration } from '../agent/install.mjs';
import { companionHealth } from '../agent/manage.mjs';
import { VERSION } from '../agent/metadata.mjs';

const extensionId = 'a'.repeat(32);
const developmentId = 'b'.repeat(32);
const origin = id => `chrome-extension://${id}/`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'history-sweep-one-click-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'companion'), home = join(root, 'home');
  return { root, directory, home };
}
function clientCommands(failClient) {
  const servers = new Map();
  const calls = [];
  const run = (executable, args) => {
    const client = executable.startsWith('codex') ? 'codex' : 'claude-code';
    calls.push([client, ...args]);
    if (args[1] === 'get') {
      if (!servers.has(client)) throw Object.assign(new Error('Not found'), { status: 1, stderr: 'No MCP server named history-sweep' });
      const value = servers.get(client);
      return client === 'codex' ? JSON.stringify({ transport: value }) : `Command: ${value.command}\nArgs: ${value.args.join(' ')}`;
    }
    if (args[1] === 'add') {
      if (client === failClient) throw new Error('Synthetic add failure');
      const separator = args.indexOf('--');
      servers.set(client, { command: args[separator + 1], args: args.slice(separator + 2) }); return 'Added';
    }
    if (args[1] === 'remove') { servers.delete(client); return ''; }
    throw new Error('Unexpected client operation');
  };
  return { run, servers, calls };
}
test('one installer configures both clients and Skills while preserving idempotent reinstall', async t => {
  const f = await fixture(t), commands = clientCommands();
  const options = { home: f.home, run: commands.run };
  await setupIntegration(f.directory, extensionId, ['codex', 'claude-code'], options);
  assert.equal(commands.servers.size, 2);
  const health = await companionHealth(f.directory);
  assert.equal(health.skillCount, 2); assert.equal(health.skillHealthy, true);
  assert.deepEqual(health.clients, ['codex', 'claude-code']);
  const first = await readFile(join(f.directory, 'installation.json'), 'utf8');
  await setupIntegration(f.directory, extensionId, ['codex', 'claude-code'], options);
  assert.equal(commands.calls.filter(call => call[1] === 'mcp' && call[2] === 'add').length, 2);
  assert.equal(await readFile(join(f.directory, 'installation.json'), 'utf8'), first);
});
test('reinstall adds the development ID to a store installation and preserves the archived installer', async t => {
  const f = await fixture(t), commands = clientCommands();
  const options = { platform: 'darwin', home: f.home, run: commands.run };
  const store = await setupIntegration(f.directory, extensionId, ['codex'], options);
  const archivedInstaller = join(f.directory, 'releases', VERSION, 'install.mjs');
  const previousInstaller = '// Installer from the original companion release\n';
  await writeFile(archivedInstaller, previousInstaller);

  await setupIntegration(f.directory, developmentId, ['codex'], options);
  const installed = await readFile(store.manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(installed).allowed_origins, [origin(extensionId), origin(developmentId)]);
  await setupIntegration(f.directory, developmentId, ['codex'], options);
  await setupIntegration(f.directory, extensionId, ['codex'], options);
  assert.equal(await readFile(store.manifestPath, 'utf8'), installed);
  assert.equal(await readFile(archivedInstaller, 'utf8'), previousInstaller);
  assert.equal(commands.calls.filter(call => call[2] === 'add').length, 1);
});
test('failed development install restores the store registration and the prepared manifest', async t => {
  const f = await fixture(t), commands = clientCommands('claude-code');
  const options = { platform: 'darwin', home: f.home, run: commands.run };
  const store = await setupIntegration(f.directory, extensionId, ['codex'], options);
  const original = await readFile(store.manifestPath, 'utf8');
  const prepared = await readFile(store.localManifest, 'utf8');
  await assert.rejects(setupIntegration(f.directory, developmentId, ['claude-code'], options), /AGENT_CLIENT_CONFIGURATION_FAILED/);
  assert.equal(await readFile(store.manifestPath, 'utf8'), original);
  assert.equal(await readFile(store.localManifest, 'utf8'), prepared);
});
test('installing another ID refuses to edit a registration for a different launcher', async t => {
  const f = await fixture(t);
  const options = { platform: 'darwin', home: f.home };
  const store = await setupIntegration(f.directory, extensionId, [], options);
  const foreign = JSON.stringify({ ...store.manifest, path: join(f.root, 'another-host') });
  await writeFile(store.manifestPath, foreign);
  await assert.rejects(setupIntegration(f.directory, developmentId, [], options), /AGENT_REGISTRATION_CONFLICT/);
  assert.equal(await readFile(store.manifestPath, 'utf8'), foreign);
});
test('existing unrelated MCP entry is preserved and new native registration rolls back', async t => {
  const f = await fixture(t), commands = clientCommands();
  commands.servers.set('codex', { command: 'user-command', args: ['user-choice'] });
  await assert.rejects(setupIntegration(f.directory, extensionId, ['codex'], { home: f.home, run: commands.run }), /CONFIGURATION_CONFLICT/);
  assert.equal(commands.servers.get('codex').command, 'user-command');
  const plan = registrationPlan({ platform: process.platform, home: f.home, extensionId, directory: f.directory });
  await assert.rejects(access(plan.manifestPath), { code: 'ENOENT' });
});
test('user-edited Skill blocks installation without replacing its content', async t => {
  const f = await fixture(t), commands = clientCommands();
  const skillPath = join(f.home, '.agents', 'skills', 'history-sweep', 'SKILL.md');
  await mkdir(dirname(skillPath), { recursive: true }); await writeFile(skillPath, 'User-owned skill');
  await prepareCompanion(f.directory, extensionId, { home: f.home });
  await assert.rejects(configureClients(f.directory, ['codex'], { home: f.home, run: commands.run }), /SKILL_LOCAL_CHANGES/);
  assert.equal(await readFile(skillPath, 'utf8'), 'User-owned skill');
  assert.equal(commands.servers.size, 0);
});
test('second client failure removes only entries and Skills created by this install', async t => {
  const f = await fixture(t), commands = clientCommands('claude-code');
  await prepareCompanion(f.directory, extensionId, { home: f.home });
  await assert.rejects(configureClients(f.directory, ['codex', 'claude-code'], { home: f.home, run: commands.run }), /AGENT_CLIENT_CONFIGURATION_FAILED/);
  assert.equal(commands.servers.size, 0);
  for (const client of ['.agents', '.claude']) await assert.rejects(access(join(f.home, client, 'skills', 'history-sweep', 'SKILL.md')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'installation.json'), 'utf8')), {});
});
