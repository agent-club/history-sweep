import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { VERSION, BUNDLE_FILES } from '../agent/metadata.mjs';
import { createMacAppLauncher, macInstallerDefaultExtensionId } from '../extension/agent-installers.mjs';

const [destination, extensionId = macInstallerDefaultExtensionId] = process.argv.slice(2);
// The installer can change independently of the bundled companion version.
const installerBuild = '5';
if (process.platform !== 'darwin' || !destination || !/^[a-p]{32}$/.test(extensionId ?? '')) {
  throw new Error('On macOS, run node scripts/build-agent-macos-installer.mjs NEW_OUTPUT_DIRECTORY [CHROME_EXTENSION_ID]');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(destination);
await mkdir(output);
const scratch = await mkdtemp(join(tmpdir(), 'history-sweep-macos-installer-'));

async function buildIcon(resources) {
  const iconset = join(scratch, 'AppIcon.iconset');
  const mark = join(root, 'extension', 'icons', 'mark.svg');
  const sharp = dependency('sharp');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      const density = Math.max(72, Math.ceil(72 * pixels / 128));
      await sharp(mark, { density }).resize(pixels, pixels).png().toFile(join(iconset, name));
    }
  }
  execFileSync('iconutil', ['--convert', 'icns', '--output', join(resources, 'AppIcon.icns'), iconset]);
}

try {
  const app = join(scratch, 'History Sweep Agent Installer.app');
  const contents = join(app, 'Contents');
  const executable = 'HistorySweepAgentInstaller';
  const macos = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  await mkdir(macos, { recursive: true });
  await mkdir(resources);
  await buildIcon(resources);
  for (const path of BUNDLE_FILES) {
    const bundled = join(resources, 'agent', path);
    await mkdir(dirname(bundled), { recursive: true });
    await copyFile(join(root, 'agent', path), bundled);
  }
  await writeFile(join(resources, 'install.sh'), createMacAppLauncher());
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>History Sweep Agent Installer</string>
  <key>CFBundleIdentifier</key><string>dev.agentclub.history-sweep.agent-installer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${installerBuild}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>HistorySweepExtensionID</key><string>${extensionId}</string>
</dict></plist>\n`);
  const slices = ['arm64', 'x86_64'].map(architecture => {
    const target = join(scratch, architecture);
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${architecture}-apple-macos12.0`,
      '-module-cache-path', join(scratch, 'modules'), join(root, 'agent', 'macos-installer.swift'), '-o', target], { stdio: 'inherit' });
    return target;
  });
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', join(macos, executable)], { stdio: 'inherit' });
  const staged = join(output, 'History Sweep Agent Installer.app');
  await rename(app, staged);
  console.log(staged);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
