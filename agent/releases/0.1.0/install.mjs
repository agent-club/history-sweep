import { mkdir, readFile, writeFile, chmod, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, win32, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { VERSION, BUNDLE_FILES } from './metadata.mjs';
import { withInstallationLock } from './updates.mjs';

export const hostName = 'dev.agentclub.history_sweep';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function registrationPlan({ platform, home, extensionId, directory, node = process.execPath, env = process.env }) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Supply the extension ID from chrome://extensions');
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Unsupported platform');
  const pathJoin = platform === 'win32' ? win32.join : posix.join;
  if ([node, directory].some(value => /[\r\n"]/.test(value))) throw new Error('Unsupported installation path');
  const launcher = pathJoin(directory, platform === 'win32' ? 'host.bat' : 'host');
  const manifest = { name: hostName, description: 'History Sweep local agent companion', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  const content = platform === 'win32'
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node.replaceAll('%', '%%')}" "${pathJoin(directory, 'native-entry.mjs').replaceAll('%', '%%')}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(pathJoin(directory, 'native-entry.mjs'))} "$@"\n`;
  const manifestPath = platform === 'darwin' ? pathJoin(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${hostName}.json`)
    : platform === 'linux' ? pathJoin(env.XDG_CONFIG_HOME || pathJoin(home, '.config'), 'google-chrome', 'NativeMessagingHosts', `${hostName}.json`)
    : pathJoin(directory, `${hostName}.json`);
  return { launcher, content, manifest, manifestPath, ...(platform === 'win32' ? { registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}` } : {}) };
}
async function writeOwned(path, content, mode = 0o600) {
  try { await writeFile(path, content, { flag: 'wx', mode }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) throw new Error(`Existing file differs; preserve it and choose a new companion directory: ${path}`);
  }
}
export async function prepareCompanion(directory, extensionId, options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const plan = registrationPlan({ platform, home, extensionId, directory, ...options });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const activePath = join(directory, 'active.json');
  const existing = await readFile(activePath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && existing.version !== VERSION) throw new Error('AGENT_USE_UPDATE_MANAGER');
  const release = join(directory, 'releases', VERSION);
  for (const name of BUNDLE_FILES) {
    const destination = join(release, name);
    await mkdir(fileURLToPath(new URL('.', pathToFileURL(destination))), { recursive: true, mode: 0o700 });
    await writeOwned(destination, await readFile(new URL(name, import.meta.url), 'utf8'));
  }
  for (const [name, target] of [['mcp.mjs', 'mcp'], ['native-entry.mjs', 'native-host'], ['manage.mjs', 'manage']]) {
    const wrapper = `import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nimport { fileURLToPath,pathToFileURL } from 'node:url';\nconst directory=fileURLToPath(new URL('.',import.meta.url));\nprocess.env.HISTORY_SWEEP_COMPANION_ROOT=directory;\nconst read=async()=>JSON.parse(await readFile(join(directory,'active.json'),'utf8'));\nlet active=await read();\nif(!/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(active.version))throw new Error('AGENT_INVALID_VERSION');\nawait (await import(pathToFileURL(join(directory,'releases',active.version,'updates.mjs')))).recoverUpdate(directory);\nactive=await read();\nif(!/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(active.version))throw new Error('AGENT_INVALID_VERSION');\nconst entry=await import(pathToFileURL(join(directory,'releases',active.version,'${target}.mjs')));\n${target === 'mcp' ? 'entry.runMcp();' : target === 'manage' ? 'await entry.runManagement();' : ''}\n`;
    await writeOwned(join(directory, name), wrapper);
  }
  if (!existing) await writeOwned(activePath, JSON.stringify({ version: VERSION, installedAt: new Date().toISOString() }));
  try { await writeFile(join(directory, 'installation.json'), '{}', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await writeOwned(plan.launcher, plan.content, 0o700);
  if (platform !== 'win32') await chmod(plan.launcher, 0o700);
  const localManifest = join(directory, `${hostName}.json`);
  await writeOwned(localManifest, JSON.stringify(plan.manifest, null, 2) + '\n');
  return { ...plan, localManifest };
}
export async function registerNative(prepared, { run = execFileSync } = {}) {
  if (prepared.registryKey) {
    let current;
    try { current = run('reg.exe', ['query', prepared.registryKey, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { if (error.status !== 1) throw new Error('AGENT_REGISTRATION_UNAVAILABLE'); }
    if (current) {
      if (!current.includes(prepared.manifestPath)) throw new Error('AGENT_REGISTRATION_CONFLICT');
      return false;
    }
    run('reg.exe', ['add', prepared.registryKey, '/ve', '/t', 'REG_SZ', '/d', prepared.manifestPath], { stdio: 'ignore' });
    return true;
  }
  await mkdir(fileURLToPath(new URL('.', pathToFileURL(prepared.manifestPath))), { recursive: true });
  const before = await readFile(prepared.manifestPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  await writeOwned(prepared.manifestPath, JSON.stringify(prepared.manifest, null, 2) + '\n');
  return before === null;
}

export async function configureClients(directory, clients, { home = homedir(), platform = process.platform, run = execFileSync } = {}) {
  if (!clients.length || clients.some(client => !['codex', 'claude-code'].includes(client))) throw new Error('AGENT_INVALID_CLIENT');
  const recordPath = join(directory, 'installation.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const active = JSON.parse(await readFile(join(directory, 'active.json'), 'utf8'));
  const skill = await readFile(join(directory, 'releases', active.version, 'skills', 'history-sweep', 'SKILL.md'), 'utf8');
  const sha256 = createHash('sha256').update(skill).digest('hex');
  const added = [], written = [];
  const commandOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 };
  const getArgs = client => ['mcp', 'get', 'history-sweep', ...(client === 'codex' ? ['--json'] : [])];
  function matches(client, value) {
    if (client !== 'codex') return String(value).includes(join(directory, 'mcp.mjs')) && String(value).includes(process.execPath);
    const config = JSON.parse(value).transport;
    return config?.command === process.execPath && JSON.stringify(config.args) === JSON.stringify([join(directory, 'mcp.mjs')]);
  }
  try {
    for (const client of [...new Set(clients)]) {
      const executable = (client === 'codex' ? 'codex' : 'claude') + (platform === 'win32' ? '.exe' : '');
      const mcpPath = join(directory, 'mcp.mjs');
      let existing;
      try { existing = run(executable, getArgs(client), commandOptions); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('AGENT_CLIENT_NOT_FOUND');
        if (error.status !== 1 || !/not found|no mcp server|does not exist/i.test(String(error.stderr))) throw new Error('AGENT_CLIENT_CONFIGURATION_UNAVAILABLE');
      }
      if (existing) {
        if (!matches(client, existing) || (client === 'claude-code' && !(record.clients ?? []).includes(client))) throw new Error('AGENT_CLIENT_CONFIGURATION_CONFLICT');
      }
      const skillPath = join(home, client === 'codex' ? '.agents' : '.claude', 'skills', 'history-sweep', 'SKILL.md');
      const before = await readFile(skillPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (before !== null && before !== skill) throw new Error('AGENT_SKILL_LOCAL_CHANGES');
      await mkdir(fileURLToPath(new URL('.', pathToFileURL(skillPath))), { recursive: true });
      await writeOwned(skillPath, skill);
      if (before === null) written.push(skillPath);
      if (!existing) {
        const args = client === 'codex' ? ['mcp', 'add', 'history-sweep', '--', process.execPath, mcpPath]
          : ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'history-sweep', '--', process.execPath, mcpPath];
        run(executable, args, commandOptions);
        added.push({ executable, client });
        // A CLI may print a success-shaped message without saving; verify the actual entry.
        if (!matches(client, run(executable, getArgs(client), commandOptions))) throw new Error('AGENT_CLIENT_CONFIGURATION_UNAVAILABLE');
      }
      record.skillFiles = [...(record.skillFiles ?? []).filter(file => file.path !== skillPath), { path: skillPath, sha256 }];
    }
    record.clients = [...new Set([...(record.clients ?? []), ...clients])];
    const temporary = `${recordPath}.install-${randomUUID()}`;
    try { await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, recordPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  } catch (error) {
    for (const path of written) if (await readFile(path, 'utf8').catch(() => null) === skill) await unlink(path);
    for (const { executable, client } of added.reverse()) {
      try {
        const current = run(executable, getArgs(client), commandOptions);
        if (matches(client, current)) run(executable, ['mcp', 'remove', ...(client === 'claude-code' ? ['--scope', 'user'] : []), 'history-sweep'], commandOptions);
      } catch {}
    }
    throw /^AGENT_[A-Z_]+$/.test(error?.message) ? error : new Error('AGENT_CLIENT_CONFIGURATION_FAILED');
  }
  return { clients: record.clients, skillCount: record.skillFiles.length };
}
export async function setupIntegration(directory, extensionId, clients, options = {}) {
  const prepared = await prepareCompanion(directory, extensionId, options);
  return withInstallationLock(directory, async () => {
  const created = await registerNative(prepared, options);
  try {
    const configured = clients.length ? await configureClients(directory, clients, options) : null;
    return { ...prepared, configured };
  } catch (error) {
    // Only undo the registration made by this failed installation; never remove another host.
    if (created && !prepared.registryKey) {
      const current = await readFile(prepared.manifestPath, 'utf8').catch(() => null);
      if (current === JSON.stringify(prepared.manifest, null, 2) + '\n') await unlink(prepared.manifestPath);
    }
    if (created && prepared.registryKey) {
      const run = options.run ?? execFileSync;
      try {
        const current = run('reg.exe', ['query', prepared.registryKey, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (current.includes(prepared.manifestPath)) run('reg.exe', ['delete', prepared.registryKey, '/f'], { stdio: 'ignore' });
      } catch {}
    }
    throw error;
  }
  });
}
async function main() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const extensionId = value('--extension-id');
  const directory = resolve(value('--directory') || join(homedir(), '.history-sweep', 'companion'));
  if (!extensionId || !['--prepare', '--install', '--unregister'].some(flag => args.includes(flag))) throw new Error('Usage: node agent/install.mjs --extension-id ID (--prepare|--install|--unregister) [--directory PATH] [--client codex|claude-code]');
  const plan = registrationPlan({ platform: process.platform, home: homedir(), extensionId, directory });
  if (args.includes('--unregister')) {
    if (plan.registryKey) {
      const current = execFileSync('reg.exe', ['query', plan.registryKey, '/ve'], { encoding: 'utf8' });
      if (!current.includes(plan.manifestPath)) throw new Error('Registry entry belongs to another installation');
      execFileSync('reg.exe', ['delete', plan.registryKey, '/f'], { stdio: 'ignore' });
    } else {
      const existing = JSON.parse(await readFile(plan.manifestPath, 'utf8'));
      if (existing.path !== plan.launcher || JSON.stringify(existing.allowed_origins) !== JSON.stringify(plan.manifest.allowed_origins)) throw new Error('Registration belongs to another installation');
      await unlink(plan.manifestPath);
    }
    console.log('Unregistered the native host. Companion files were preserved. Disconnect in the extension.');
    return;
  }
  const clients = args.flatMap((value, index) => value === '--client' ? [args[index + 1]] : []);
  const prepared = args.includes('--install') ? await setupIntegration(directory, extensionId, clients) : await prepareCompanion(directory, extensionId);
  console.log(JSON.stringify({ registered: args.includes('--install'), manifest: prepared.localManifest,
    mcp: { command: process.execPath, args: [join(directory, 'mcp.mjs')] } }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
