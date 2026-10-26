import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(root + 'extension/manifest.json', 'utf8'));
const archive = root + `dist/history-sweep-${manifest.version}.zip`;
const website = root + `dist/history-sweep-site-${manifest.version}.zip`;
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-packages-'));
try {
  for (const [zip, target] of [[archive, 'extension'], [website, 'site']]) {
    await mkdir(join(temporary, target));
    execFileSync('unzip', ['-t', zip]);
    execFileSync('unzip', ['-q', zip, '-d', join(temporary, target)]);
  }
  const released = JSON.parse(await readFile(join(temporary, 'extension/manifest.json'), 'utf8'));
  assert.deepEqual(released, manifest, 'the release manifest includes the source entries and permissions');
  assert.equal(released.version, '0.6.0');
  assert.ok(released.permissions.includes('alarms'), 'cleanup scheduling permission ships in the candidate');
  assert.ok((await readdir(join(temporary, 'extension'))).includes('update-check.mjs'), 'official update checker is packaged');
  assert.match(await readFile(join(temporary, 'site/_headers'), 'utf8'), /Access-Control-Allow-Origin: \*/);
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'site/extension-updates.json'), 'utf8')),
    JSON.parse(await readFile(root + 'site/extension-updates.json', 'utf8')), 'published version metadata is packaged independently of the development version');
  for (const file of ['sync.html', 'sync.css', 'sync-page.mjs', 'config-sync.mjs', 'config-store.mjs']) {
    assert.equal((await readdir(join(temporary, 'extension'))).includes(file), true, `${file} ships with configuration sync`);
  }
  let compared = 0;
  async function compareTree(packed, source, extension = false) {
    for (const entry of await readdir(packed, { withFileTypes: true })) {
      const file = join(packed, entry.name), original = join(source, entry.name);
      if (entry.isDirectory()) { await compareTree(file, original, extension); continue; }
      if (extension && entry.name === 'manifest.json') continue;
      const wanted = await readFile(original);
      assert.deepEqual(await readFile(file), wanted, `${file}: packaged content matches its release source`);
      compared++;
    }
  }
  await compareTree(join(temporary, 'extension'), root + 'extension', true);
  await compareTree(join(temporary, 'site'), root + 'site');
  assert.deepEqual(await readFile(archive), await readFile(root + `site/downloads/history-sweep-${manifest.version}.zip`));
  assert.deepEqual(await readFile(archive), await readFile(join(temporary, `site/downloads/history-sweep-${manifest.version}.zip`)));
  // Browser suites resolve ../extension and ../site. Copy only their harness so
  // every page and native extension comes from the actual distribution archives.
  await cp(root + 'scripts', join(temporary, 'scripts'), { recursive: true });
  await symlink(root + 'node_modules', join(temporary, 'node_modules'), 'dir');
  const failures = [];
  for (const [script, ...args] of [
    ['verify-release.mjs'], ['verify-frequency.mjs'], ['verify-back-to-top.mjs'], ['verify-config-sync.mjs'], ['verify-updates.mjs'], ['verify-native.mjs'], ['verify-theme-native.mjs'],
    ['verify-auto-cleanup.mjs'], ['verify-help.mjs'], ['verify-nameplate.mjs'], ['verify-copy-url.mjs'], ['verify-preferences-close.mjs'], ['verify-soft-privacy.mjs'], ['verify-view-preferences.mjs'], ['verify-embedded-sync.mjs'],
    ['verify-activity-native.mjs'], ['verify-row-removal.mjs', '--native'],
    ['verify-batch-removal.mjs', '--native'], ['verify-deletion-expansion.mjs'], ['verify-site.mjs'],
  ]) {
    try {
      execFileSync(process.execPath, [join(temporary, 'scripts', script), ...args], {
        cwd: temporary, stdio: 'inherit', env: process.env,
      });
    } catch { failures.push(script); }
  }
  assert.deepEqual(failures, [], 'all packaged browser/native suites must pass');
  console.log(`Release archives verified: ${compared} file comparisons, matching download copies, release scope, and browser/native suites.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
