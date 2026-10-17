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
  const expected = structuredClone(manifest);
  delete expected.options_ui; delete expected.optional_host_permissions;
  expected.content_security_policy.extension_pages = "script-src 'self'; object-src 'none'; connect-src 'none'";
  assert.deepEqual(released, expected, 'the v0.4.0 manifest excludes deferred sync permissions');
  for (const file of ['sync.html', 'sync.css', 'sync-page.mjs', 'config-sync.mjs', 'config-store.mjs']) {
    assert.equal((await readdir(join(temporary, 'extension'))).includes(file), false, `${file} remains deferred`);
  }
  const syncEntry = '<p><a href="sync.html" target="_blank" rel="noopener">${t(\'syncSettings\')}</a></p>';
  let compared = 0;
  async function compareTree(packed, source, extension = false) {
    for (const entry of await readdir(packed, { withFileTypes: true })) {
      const file = join(packed, entry.name), original = join(source, entry.name);
      if (entry.isDirectory()) { await compareTree(file, original, extension); continue; }
      if (extension && entry.name === 'manifest.json') continue;
      const wanted = extension && entry.name === 'view.mjs'
        ? Buffer.from((await readFile(original, 'utf8')).replace(syncEntry, '')) : await readFile(original);
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
  for (const [script, ...args] of [
    ['verify-release.mjs'], ['verify-native.mjs'], ['verify-theme-native.mjs'],
    ['verify-activity-native.mjs'], ['verify-row-removal.mjs', '--native'],
    ['verify-batch-removal.mjs', '--native'], ['verify-deletion-expansion.mjs'], ['verify-site.mjs'],
  ]) execFileSync(process.execPath, [join(temporary, 'scripts', script), ...args], {
    cwd: temporary, stdio: 'inherit', env: process.env,
  });
  console.log(`Release archives verified: ${compared} file comparisons, matching download copies, release scope, and browser/native suites.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
