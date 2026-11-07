import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VERSION } from './metadata.mjs';
import { checkUpdate, applyUpdate, recoverUpdate } from './updates.mjs';

export async function companionHealth(directory = process.env.HISTORY_SWEEP_COMPANION_ROOT) {
  if (!directory) return { managed: false, runningVersion: VERSION, installedVersion: VERSION, skillCount: 0, skillHealthy: null };
  const active = JSON.parse(await readFile(join(directory, 'active.json'), 'utf8'));
  const installation = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'; throw error;
  }));
  let skillHealthy = true;
  for (const file of installation.skillFiles ?? []) {
    const bytes = await readFile(file.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) skillHealthy = false;
  }
  const checked = JSON.parse(await readFile(join(directory, 'update-state.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return 'null'; throw error;
  }));
  // The last check can precede a successful atomic activation of that exact version.
  const update = checked && { ...checked, installedVersion: active.version,
    available: checked.available && checked.latestVersion !== active.version };
  return { managed: true, runningVersion: VERSION, installedVersion: active.version, restartRequired: active.version !== VERSION,
    skillCount: (installation.skillFiles ?? []).length, skillHealthy, clients: installation.clients ?? [], update };
}
let maintenance;
export async function maintainCompanion(operation, directory = process.env.HISTORY_SWEEP_COMPANION_ROOT) {
  if (operation === 'health') return companionHealth(directory);
  if (!directory) throw new Error('AGENT_NOT_MANAGED');
  if (!['check', 'update'].includes(operation)) throw new Error('AGENT_INVALID_REQUEST');
  if (maintenance) throw new Error('AGENT_UPDATE_BUSY');
  maintenance = (async () => {
    await recoverUpdate(directory);
    if (operation === 'check') await checkUpdate(directory); else await applyUpdate(directory);
    return companionHealth(directory);
  })();
  try { return await maintenance; } finally { maintenance = undefined; }
}
export async function runManagement(args = process.argv.slice(2)) {
  const operation = args.includes('--update') ? 'update' : args.includes('--check') ? 'check' : 'health';
  console.log(JSON.stringify(await maintainCompanion(operation), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runManagement().catch(error => { console.error(/^AGENT_[A-Z_]+$/.test(error?.message) ? error.message : 'AGENT_UNAVAILABLE'); process.exitCode = 1; });
}
