import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';
import { prepareCompanion, configureClients, hostName } from '../agent/install.mjs';
import { readLines } from '../agent/protocol.mjs';
import { BUNDLE_FILES, VERSION, UPDATE_URL } from '../agent/metadata.mjs';
import { macInstallerArchive } from '../extension/agent-installers.mjs';

// The installer is a separate GitHub release asset and is not stored in the extension tree.
const macInstallerSha256 = 'bdfa444cd3522c5ccf31f5aac481869f597ff7f0589f3c1a9387b63433a03718';
const { chromium } = dependency('playwright');
const root = await mkdtemp(join(tmpdir(), 'history-sweep-agent-browser-'));
const extension = join(root, 'extension');
const home = join(root, 'home');
const ipc = join(root, 'ipc');
const screenshots = process.env.HISTORY_SWEEP_AGENT_SCREENSHOTS;
const uiCapture = process.env.HISTORY_SWEEP_AGENT_UI_CAPTURE;
const uiReceipts = [];
const uiStates = { 'tasks-entry':'agent-tasks-entry', 'toolbar-entry':'agent-toolbar-entry', 'settings-popup':'agent-settings-popup', 'settings-client-options':'agent-settings-selector',
  'settings-desktop':'agent-settings-desktop', 'settings-website':'agent-settings-website', 'settings-from-tasks':'agent-settings-from-tasks', 'disconnected-en':'agent-disconnected',
  'installer-client-options-en':'agent-installer-selector', 'installer-options-narrow':'agent-platform-selector',
  'connected-en':'agent-connected', 'save-approval-en':'agent-save-approval', 'save-approval-zh-narrow':'agent-save-narrow',
  'execute-approval-zh-narrow':'agent-execute-narrow', 'completed-en':'agent-completed', 'update-available-en':'agent-update-available',
  'toolbar-working':'agent-toolbar-working', 'toolbar-working-reduced':'agent-toolbar-working-reduced',
  'settings-catching':'agent-settings-catching',
  'update-checking':'agent-update-checking', 'update-current':'agent-update-current',
  'updated-restart-required-en':'agent-restart-required', 'dark-agent':'agent-dark' };
const sourceFiles = ['.ui-acceptance.json','scripts/verify-agent.mjs','extension/agent.html','extension/agent.css','extension/agent-page.mjs','extension/agent-view.mjs','extension/agent-copy.mjs',
  'extension/app.mjs','extension/auto-cleanup.css','extension/background.mjs','extension/modal-host.mjs','extension/manifest.json',
  'extension/agent-installers.mjs','extension/agent-release.mjs','extension/agent-access.mjs','extension/agent-bridge.mjs','extension/agent-motion.mjs','extension/auto-cleanup-page.mjs','extension/auto-cleanup.mjs','extension/app.css','extension/view.mjs','extension/theme.js','scripts/native-workspace.mjs',
  ...BUNDLE_FILES.map(path => `agent/${path}`)];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path,createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')])));
const initialHashes = uiCapture ? await sourceHashes() : null;
let registration;
let registrationText;
let registered = false;
let context;
let mcp;
let sequence = 0;
const responses = new Map();
const errors = [];
let cleanupPromise;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (mcp && mcp.exitCode === null && mcp.signalCode === null) { const exited = once(mcp, 'exit'); mcp.stdin.end(); await exited; }
    if (context) await context.close();
    if (registered) {
      const current = await readFile(registration, 'utf8').catch(() => null);
      if (current === registrationText) await unlink(registration);
    }
    await rm(root, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });
async function until(read, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
}
async function launch(profile = 'browser') {
  context = await chromium.launchPersistentContext(join(root, profile), {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.mjs')) ?? await context.waitForEvent('serviceworker');
  return `chrome-extension://${new URL(worker.url()).hostname}`;
}
async function openWebsiteModal(control) {
  const site = 'https://agent-modal.example.test/';
  const host = await context.newPage();
  // Keep the toolbar entry in this installer fixture. The wide edge entry is covered by verify-modal-focus.
  await host.setViewportSize({ width: 1160, height: 720 });
  await host.route(site, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>History Sweep test page</title><main>Test website</main>' }));
  await host.goto(site);
  const navigation = host.waitForEvent('framenavigated', { predicate: frame => new URL(frame.url()).pathname === '/modal.html' });
  await control.evaluate(async site => {
    const [tab] = await chrome.tabs.query({ url: site });
    const fixtureLaunch = crypto.randomUUID();
    await chrome.storage.session.set({ modalLaunchSessions: { [fixtureLaunch]: { tabId: tab.id, expires: Date.now() + 60_000 } } });
    const { injectModal } = await import('./modal-host.mjs');
    const url = new URL(chrome.runtime.getURL('modal.html'));
    url.hash = new URLSearchParams({ launch: fixtureLaunch });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: injectModal, args: [url.href] });
  }, site);
  return { host, modal: await navigation };
}
function rpc(method, params) {
  const id = ++sequence;
  const deferred = Promise.withResolvers();
  const timer = setTimeout(() => deferred.reject(new Error(`MCP timeout: ${method}`)), 30000);
  responses.set(id, deferred);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return deferred.promise.finally(() => { clearTimeout(timer); responses.delete(id); });
}
async function tool(operation, args = {}) {
  const result = await rpc('tools/call', { name: `history_sweep_${operation}`, arguments: args });
  assert.ok(!result.error, JSON.stringify(result.error));
  assert.ok(!result.result.isError, JSON.stringify(result.result.content));
  return result.result.structuredContent;
}
async function startMcp() {
  mcp = spawn(process.execPath, [join(root, 'companion', 'mcp.mjs')], { env: { ...process.env, HISTORY_SWEEP_AGENT_HOME: ipc }, stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.on('exit', () => { for (const pending of responses.values()) pending.reject(new Error('MCP process exited')); });
  readLines(mcp.stdout, message => { responses.get(message.id)?.resolve(message); responses.delete(message.id); }, () => { throw new Error('MCP framing failed'); });
  await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'synthetic-test', version: '1' }, capabilities: {} });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}
const installerRadio = (surface, name, value) => surface.locator(`#installerChoices input[name="${name}"][value="${value}"]`);
const chooseInstallerOption = (surface, name, value) => installerRadio(surface, name, value).locator('..').click();

async function screenshot(page, name, surface = page) {
  if (screenshots) {
    if (surface !== page) {
      // Let the cross-origin extension frame commit its new tab before capturing the host page.
      await surface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await mkdir(screenshots, { recursive: true }); const path = join(screenshots, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    if (uiCapture) {
      const observed = await surface.evaluate(() => {
        const visible = node => Boolean(node && !node.hidden && node.getBoundingClientRect().width && node.getBoundingClientRect().height);
        const requests = [...document.querySelectorAll('#requests [data-request]')];
        const text = document.querySelector('#requests')?.textContent ?? '';
        const agentSettings = document.querySelector('.agent-embedded');
        const platformSelection = document.querySelector('#installerPlatform :checked')?.value;
        const clientSelection = document.querySelector('#installerClient :checked')?.value;
        const installerChoicesFit = [...document.querySelectorAll('#installerChoices .agent-choice-face')].filter(visible).every(choice => {
          const rect = choice.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && choice.scrollWidth <= choice.clientWidth + 1;
        });
        return { horizontalOverflow:document.documentElement.scrollWidth > innerWidth, viewportWidth:innerWidth, viewportHeight:innerHeight,
          language:document.documentElement.lang, heading:document.querySelector('.agent-heading h1')?.textContent ?? '',
          agentEntryVisible:[...document.querySelectorAll('#agentAccess, .auto-agent-entry')].some(link=>{
            const rect=link.getBoundingClientRect();
            return visible(link)
              && rect.top>=0 && rect.bottom<=innerHeight && rect.left>=0 && rect.right<=innerWidth;
          }),
          agentToolbarVisible:visible(document.querySelector('.topbar #agentAccess')),
          agentSettingsVisible:visible(agentSettings),
          agentSettingsSelected:document.getElementById('settings-tab-agent')?.getAttribute('aria-selected') === 'true',
          agentSettingsConnected:agentSettings?.querySelector('#connectionState')?.textContent === 'Connected',
          agentSettingsClientVisible:visible(agentSettings?.querySelector('#installerClient')),
          singlePreferencesSurface:agentSettings?.closest('dialog')?.id === 'preferencesDialog' && document.querySelectorAll('dialog[open]').length === 1,
          standaloneTasksShell:Boolean(agentSettings?.closest('#cleanupSettings') && document.getElementById('standaloneTasks').hidden && !document.querySelector('dialog[open]')),
          tasksTabPresent:Boolean(document.getElementById('settings-tab-cleanup-tasksPage')),
          websiteModal:document.body.dataset.presentation === 'modal',
          macInstallerSelected:platformSelection === 'macos' && document.getElementById('installerClient')?.hidden === true,
          installerVisible:visible(document.getElementById('downloadInstaller')), installerOptions:document.querySelectorAll('#installerClient input[type=radio]').length,
          installerPlatformOptions:document.querySelectorAll('#installerPlatform input[type=radio]').length,
          installerChoicesFit, platformSelection, clientSelection,
          connected:['Connected','已连接'].includes(document.getElementById('connectionState')?.textContent),
          automaticUpdates:document.getElementById('automaticUpdates')?.checked ?? false,
          healthVisible:visible(document.getElementById('companionHealth')), skillHealthy:/match the installed bundle|与安装版本一致/i.test(document.getElementById('skillHealth')?.textContent ?? ''),
          pendingRequests:document.querySelectorAll('#requests button.primary').length,
          completedRequests:requests.filter(node=>['Completed','已完成'].includes(node.querySelector('p')?.textContent)).length,
          matches:Number(text.match(/(?:Matching URLs|匹配 URL 数):\s*(\d+)/)?.[1] ?? -1),
          irreversibleWarning:/all its visits|全部访问记录/.test(text),
          updateVisible:visible(document.getElementById('agentApplyUpdate')), restartRequired:visible(document.getElementById('restartNotice')),
          toolbarWorking:document.getElementById('agentAccess')?.hasAttribute('data-agent-working') === true && document.getElementById('agentToolbarStatus')?.textContent === 'MCP is working',
          toolbarMotion:Boolean(document.getElementById('agentAccess')?.getAnimations({ subtree: true }).length),
          toolbarIdleBlink:document.querySelector('#agentAccess .agent-robot-eye')?.getAnimations().some(animation => animation.animationName === 'agent-idle-blink') ?? false,
          dialogIdleVisible:visible(document.getElementById('agentDialogWorkLabel')) && document.getElementById('agentDialogWorkLabel').textContent === 'Agent resting',
          preferencesClosed:!document.getElementById('preferencesDialog')?.open,
          agentDialogCatchVisible:visible(document.getElementById('agentDialogWork')) && document.querySelector('#agentDialogWork .agent-robot-ticket')?.getAnimations().some(animation => animation.animationName === 'agent-catch'),
          updateChecking:document.getElementById('checkUpdates')?.getAttribute('aria-busy') === 'true' && /Checking for updates/.test(document.getElementById('updateState')?.textContent),
          scanMotion:document.querySelector('.agent-scan-beam')?.getAnimations().some(animation => animation.animationName === 'agent-scan-pass') ?? false,
          currentSeal:document.getElementById('checkUpdates')?.dataset.check === 'current' && /up to date/.test(document.getElementById('updateState')?.textContent),
          awaitingStatic:requests.some(node => node.querySelector('.agent-awaiting .agent-motion-icon')?.getAnimations().length === 0),
          dark:document.documentElement.dataset.theme === 'dark',
        };
      });
      uiReceipts.push({request:{state:uiStates[name],width:page.viewportSize().width,theme:observed.dark?'dark':'light'},observed,screenshot:path});
    }
  }
  assert.equal(await surface.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow');
}
try {
  await mkdir(home, { recursive: true });
  await cp(fileURLToPath(new URL('../extension', import.meta.url)), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions ?? []), 'https://agent-modal.example.test/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const firstRunOrigin = await launch('first-connect-browser');
  const firstRunPage = await context.newPage();
  await firstRunPage.goto(`${firstRunOrigin}/auto-cleanup.html`);
  const { modal: firstRunModal } = await openWebsiteModal(firstRunPage);
  await firstRunModal.locator('#agentAccess').waitFor({ state: 'attached' });
  await enterWorkspace(firstRunModal);
  await firstRunModal.locator('#agentAccess').click();
  const firstRunPanel = firstRunModal.locator('#preferencesDialog #settings-panel-agent');
  await firstRunPanel.getByText('Not connected', { exact: true }).waitFor({ timeout: 4000 });
  assert.equal(await firstRunPanel.locator('#agentStatus').textContent(), '');
  assert.equal(await firstRunModal.evaluate(() => chrome.permissions.contains({ permissions: ['nativeMessaging'] })), false);
  await context.close();

  // The remaining native-host tests run without an unattended Chrome permission prompt.
  manifest.permissions.push('nativeMessaging'); delete manifest.optional_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest));
  let origin = await launch();
  const id = new URL(origin).hostname;
  const companion = await prepareCompanion(join(root, 'companion'), id);
  let clientEntry;
  await configureClients(join(root, 'companion'), ['codex'], { home, run: (_command, args) => {
    if (args[1] === 'get') {
      if (!clientEntry) throw Object.assign(new Error('Missing fixture entry'), { status: 1, stderr: 'No MCP server named history-sweep' });
      return JSON.stringify({ transport: clientEntry });
    }
    if (args[1] === 'add') { const at = args.indexOf('--'); clientEntry = { command: args[at + 1], args: args.slice(at + 2) }; return 'Added'; }
    throw new Error('Unexpected fixture client operation');
  } });
  const nextVersion = VERSION.split('.').map((value, index) => index === 2 ? Number(value) + 1 : value).join('.');
  const remoteFiles = {}, releaseFiles = [];
  for (const path of BUNDLE_FILES) {
    let bytes = await readFile(new URL(`../agent/${path}`, import.meta.url));
    if (path === 'metadata.mjs') bytes = Buffer.from(bytes.toString().replace(`'${VERSION}'`, `'${nextVersion}'`));
    if (path === 'skills/history-sweep/SKILL.md') bytes = Buffer.concat([bytes, Buffer.from('\n<!-- Synthetic update fixture -->\n')]);
    const url = `https://sweep.agentclub.dev/agent/releases/${nextVersion}/${path}`;
    remoteFiles[url] = bytes.toString('base64');
    releaseFiles.push({ path, url, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  remoteFiles[UPDATE_URL] = Buffer.from(JSON.stringify({ schemaVersion: 1, version: nextVersion, files: releaseFiles })).toString('base64');
  const remoteFixture = join(root, 'synthetic-publisher.json');
  const currentManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: VERSION,
    files: releaseFiles.map(file => ({ ...file, url: file.url.replace(`/${nextVersion}/`, `/${VERSION}/`) })) })).toString('base64');
  const currentPublisher = { ...remoteFiles, [UPDATE_URL]: currentManifest };
  await writeFile(remoteFixture, JSON.stringify(remoteFiles));
  const nativeEntry = join(root, 'companion', 'native-entry.mjs');
  const entry = await readFile(nativeEntry, 'utf8');
  await writeFile(nativeEntry, `import {readFile as fixtureRead} from 'node:fs/promises';\nimport {setTimeout as fixtureDelay} from 'node:timers/promises';\nglobalThis.fetch=async(url)=>{if(url===${JSON.stringify(UPDATE_URL)})await fixtureDelay(1000);const fixture=JSON.parse(await fixtureRead(${JSON.stringify(remoteFixture)},'utf8'));if(!Object.hasOwn(fixture,url))throw new Error('Unexpected fixture URL');return new Response(Buffer.from(fixture[url],'base64'),{status:200});};\n${entry}`);
  const wrapper = companion.content.replace('#!/bin/sh\n', `#!/bin/sh\nexport HISTORY_SWEEP_AGENT_HOME='${ipc}'\n`);
  await writeFile(companion.launcher, wrapper, { mode: 0o700 });
  // A caller can explicitly select the test browser's native-host directory.
  const registryRoot = join(root, 'browser', 'NativeMessagingHosts');
  registration = join(registryRoot, `${hostName}.json`);
  await mkdir(registryRoot, { recursive: true });
  registrationText = JSON.stringify(companion.manifest);
  await writeFile(registration, registrationText, { flag: 'wx', mode: 0o600 });
  registered = true;
  let page = await context.newPage();
  await page.goto(`${origin}/auto-cleanup.html`);
  const { host, modal } = await openWebsiteModal(page);
  await modal.locator('#agentAccess').waitFor({ state: 'attached' });
  await enterWorkspace(modal);
  await modal.locator('#agentAccess').click();
  const websitePanel = modal.locator('#preferencesDialog #settings-panel-agent');
  await websitePanel.getByText('Not connected', { exact: true }).waitFor({ timeout: 4000 });
  assert.equal(host.frames().length, 2, 'Agent renders inside the authenticated modal document');
  await chooseInstallerOption(websitePanel, 'platform', 'macos');
  assert.equal(await websitePanel.locator('#installerClient').isVisible(), false);
  assert.match(await websitePanel.locator('#installerNote').textContent(), new RegExp(id));
  await screenshot(host, 'settings-website', modal);
  const macDownload = host.waitForEvent('download');
  await websitePanel.locator('#downloadInstaller').click();
  const macArchive = await macDownload;
  assert.equal(macArchive.suggestedFilename(), macInstallerArchive);
  const macDownloadHost = new URL(macArchive.url()).hostname;
  assert.ok(['github.com', 'release-assets.githubusercontent.com'].includes(macDownloadHost), `Expected a GitHub download, got ${macDownloadHost}`);
  assert.equal(createHash('sha256').update(await readFile(await macArchive.path())).digest('hex'), macInstallerSha256, 'GitHub must deliver the exact stapled app ZIP');
  await chooseInstallerOption(websitePanel, 'platform', 'windows');
  const websiteDownload = host.waitForEvent('download');
  await websitePanel.locator('#downloadInstaller').click();
  assert.match((await websiteDownload).suggestedFilename(), /\.cmd\.zip$/);
  await installerRadio(websitePanel, 'platform', 'windows').focus();
  await host.keyboard.press('Escape');
  await websitePanel.waitFor({ state: 'hidden' });
  assert.equal(await modal.locator('#agentAccess').evaluate(button => document.activeElement === button), true);
  await modal.locator('#openPreferences').click();
  await modal.locator('[data-settings-section="tasks"]').click();
  await modal.locator('#cleanupSettingsContent .auto-agent-entry').click();
  await websitePanel.getByText('Not connected', { exact: true }).waitFor();
  assert.equal(await modal.locator('dialog[open]').count(), 1, 'Agent is a tab of the open Preferences window');
  await screenshot(host, 'settings-from-tasks', modal);
  await modal.locator('#settings-tab-cleanup-tasksPage').click();
  await modal.locator('#cleanupSettingsContent .auto-agent-entry').waitFor();
  assert.equal(await websitePanel.isVisible(), false, 'Returning to Cleanup tasks changes the active tab');
  await host.close();
  await page.waitForSelector('[data-auto-id="manageProtection"]');
  assert.equal(await page.locator('[data-auto-id="tasksPage"] .auto-scroll').count(), 1, 'Task DOM structure');
  const tasksAgent = page.locator('.auto-agent-entry');
  await tasksAgent.scrollIntoViewIfNeeded();
  await screenshot(page, 'tasks-entry');
  await tasksAgent.click();
  const tasksPanel = page.locator('#cleanupSettings .agent-embedded');
  await tasksPanel.getByText('Not connected', { exact: true }).waitFor();
  await screenshot(page, 'settings-desktop');
  await page.locator('#cleanupSettings .settings-back').click();
  await tasksPanel.waitFor({ state: 'hidden' });
  assert.equal(await tasksAgent.evaluate(button => document.activeElement === button), true);
  const agentSidebar = page.locator('#cleanupSettings [data-section="agent"]');
  await agentSidebar.press('Enter');
  await tasksPanel.getByRole('heading', { name: 'Agent access', exact: true }).waitFor();
  assert.equal(await agentSidebar.getAttribute('aria-current'), 'page');
  assert.equal(await tasksPanel.locator('h1').evaluate(heading => heading === document.activeElement), true);
  await page.setViewportSize({ width: 440, height: 590 });
  await page.goto(`${origin}/popup.html`);
  await enterWorkspace(page);
  await screenshot(page, 'toolbar-entry');
  const tabsBefore = context.pages().length;
  await page.locator('.topbar #agentAccess').click();
  const panel = page.locator('#preferencesDialog #settings-panel-agent');
  await panel.getByText('Not connected', { exact: true }).waitFor();
  assert.equal(context.pages().length, tabsBefore, 'Agent settings must open in the original tab');
  await chooseInstallerOption(panel, 'platform', 'windows');
  const panelDownload = page.waitForEvent('download');
  await panel.locator('#downloadInstaller').click();
  assert.match((await panelDownload).suggestedFilename(), /\.cmd\.zip$/);
  await panel.locator('#automaticUpdates').uncheck();
  await page.waitForTimeout(850);
  await panel.locator('#connect').click();
  await panel.getByText('Connected', { exact: true }).waitFor();
  await panel.evaluate(node => { node.scrollTop = 0; });
  await screenshot(page, 'settings-popup');
  await chooseInstallerOption(panel, 'client', 'claude-code');
  assert.equal(await installerRadio(panel, 'client', 'claude-code').isChecked(), true);
  await screenshot(page, 'settings-client-options');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#agentAccess').evaluate(button => document.activeElement === button), true);
  const workspace = page;
  page = await context.newPage();
  await page.goto(`${origin}/agent.html`);
  await page.locator('#disconnect').click();
  await page.getByText('Not connected', { exact: true }).waitFor();
  await workspace.close();
  await screenshot(page, 'disconnected-en');
  await chooseInstallerOption(page, 'platform', 'linux');
  await installerRadio(page, 'client', 'codex').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await installerRadio(page, 'client', 'claude-code').isChecked(), true);
  const clientIcons = page.locator('#installerClient .agent-choice-icon');
  await clientIcons.first().waitFor({ state: 'visible' });
  assert.equal(await clientIcons.evaluateAll(icons => icons.every(icon => icon.complete && icon.naturalWidth > 0)), true);
  const linuxDownload = page.waitForEvent('download');
  await page.locator('#downloadInstaller').click();
  const linuxInstaller = await linuxDownload;
  assert.match(linuxInstaller.suggestedFilename(), /\.sh\.zip$/);
  assert.match(await readFile(await linuxInstaller.path(), 'utf8'), /--client 'claude-code'/);
  await screenshot(page, 'installer-client-options-en');
  await page.setViewportSize({ width: 375, height: 812 });
  await chooseInstallerOption(page, 'platform', 'macos');
  assert.equal(await page.locator('#installerClient').isVisible(), false);
  await installerRadio(page, 'platform', 'macos').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await installerRadio(page, 'platform', 'windows').isChecked(), true);
  assert.equal(await installerRadio(page, 'client', 'claude-code').isChecked(), true);
  await screenshot(page, 'installer-options-narrow');
  await page.setViewportSize({ width: 1280, height: 720 });
  const downloaded = page.waitForEvent('download');
  await page.locator('#downloadInstaller').click();
  const installer = await downloaded; await installer.saveAs(join(root, 'installer.zip'));
  assert.match(installer.suggestedFilename(), /\.cmd\.zip$/);
  assert.match(await readFile(join(root, 'installer.zip'), 'utf8'), /--client 'claude-code'/);
  await page.locator('#connect').click();
  try { await page.waitForFunction(() => document.getElementById('connectionState').textContent === 'Connected', undefined, { timeout: 10000 }); }
  catch (error) { console.log(await page.evaluate(async () => { const state = await chrome.runtime.sendMessage({ type: 'agent-state' }); return { connected: state.data?.connected, error: state.data?.connectionError }; })); throw error; }
  const profileId = await page.locator('#profileId').inputValue();
  assert.equal(await page.locator('#agentStatus').textContent(), '', 'Connection warning must clear after success');
  await screenshot(page, 'connected-en');
  await startMcp();
  assert.equal((await tool('profiles')).profiles[0].profileId, profileId);
  const health = await tool('health', { profileId });
  assert.equal(health.connected, true); assert.equal(health.managed, true);
  assert.equal(health.installedVersion, health.mcpVersion);
  assert.ok(health.mcpLastSeenAt);
  const urls = ['https://fixture.example.test/a', 'https://fixture.example.test/b', 'https://keep.fixture.example.test/c', 'https://unrelated.example.test/d'];
  await page.evaluate(async urls => {
    for (const url of urls) await chrome.history.addUrl({ url });
    await chrome.storage.local.set({ protectedSites: ['keep.fixture.example.test'], privateCleanup: true });
  }, urls);
  const rule = { domain: 'fixture.example.test', includeSubdomains: true, days: null, schedule: { type: 'daily', time: '02:00' } };
  const motionPopup = await context.newPage();
  await motionPopup.setViewportSize({ width: 440, height: 590 });
  await motionPopup.goto(`${origin}/popup.html`);
  await enterWorkspace(motionPopup);
  const worker = context.serviceWorkers().find(service => service.url().endsWith('/background.mjs'));
  await worker.evaluate(() => {
    const search = chrome.history.search;
    const gate = Promise.withResolvers();
    globalThis.finishPreviewFixture = () => { chrome.history.search = search; gate.resolve(); };
    chrome.history.search = async options => {
      if (options.startTime === 0) await gate.promise;
      return search.call(chrome.history, options);
    };
  });
  const previewInProgress = tool('preview', { profileId, rule });
  try {
    await motionPopup.locator('#agentAccess[data-agent-working]').waitFor({ timeout: 5000 });
    await motionPopup.waitForFunction(() => document.querySelector('#agentAccess .agent-robot-signal').getAnimations().length > 0);
    await screenshot(motionPopup, 'toolbar-working');
    await motionPopup.emulateMedia({ reducedMotion: 'reduce' });
    await motionPopup.waitForFunction(() => document.getElementById('agentAccess').getAnimations({ subtree: true }).length === 0);
    await screenshot(motionPopup, 'toolbar-working-reduced');
  } finally {
    await worker.evaluate(() => globalThis.finishPreviewFixture());
  }
  const draft = await previewInProgress;
  await motionPopup.locator('#agentAccess:not([data-agent-working])').waitFor();
  assert.equal(await motionPopup.locator('#agentToolbarStatus').textContent(), '');
  await motionPopup.emulateMedia({ reducedMotion: 'no-preference' });
  await tool('list', { profileId });
  await motionPopup.waitForFunction(() => {
    const entry = document.getElementById('agentAccess');
    const catchMotion = entry.querySelector('.agent-robot-ticket').getAnimations().find(animation => animation.animationName === 'agent-catch');
    return !entry.hasAttribute('data-agent-working') && catchMotion?.effect.getTiming().duration === 2000 && catchMotion.currentTime >= 1000;
  }, undefined, { timeout: 5000 });
  await motionPopup.locator('#agentAccess:not([data-agent-catching])').waitFor();
  await motionPopup.locator('#agentAccess').click();
  await motionPopup.locator('#settings-panel-agent').getByText('Connected', { exact: true }).waitFor();
  const dialogWork = motionPopup.locator('#preferencesDialog[open] #agentDialogWork');
  const dialogIdle = dialogWork.getByText('Agent resting', { exact: true });
  await dialogIdle.waitFor();
  const eyes = await dialogWork.locator('.agent-robot-eye').evaluateAll(nodes => nodes.map(eye => {
    const blink = eye.getAnimations().find(animation => animation.animationName === 'agent-idle-blink');
    const duration = blink.effect.getTiming().duration;
    const originalTime = blink.currentTime;
    const scaleAt = phase => {
      blink.currentTime = duration * phase;
      return new DOMMatrixReadOnly(getComputedStyle(eye).transform).d;
    };
    const open = scaleAt(0);
    const closed = scaleAt(.17);
    const wink = scaleAt(.76);
    blink.currentTime = originalTime;
    return { open, closed, wink };
  }));
  assert.equal(eyes.length, 2);
  assert.ok(eyes.every(eye => eye.open === 1 && eye.closed < .2));
  assert.equal(eyes[0].wink, 1);
  assert.ok(eyes[1].wink < .2);
  assert.equal(await motionPopup.locator('#agentAccess .agent-robot-eye').first().evaluate(eye => eye.getAnimations().length), 0);
  const firstTrick = await motionPopup.waitForFunction(() => document.getElementById('agentDialogWork').dataset.agentIdleTrick);
  await motionPopup.waitForFunction(previous => {
    const trick = document.getElementById('agentDialogWork').dataset.agentIdleTrick;
    return trick && trick !== previous;
  }, await firstTrick.jsonValue(), { timeout: 9000 });
  assert.equal(await motionPopup.locator('#agentAccess').getAttribute('data-agent-idle-trick'), null);
  await tool('list', { profileId });
  await dialogWork.getByText('MCP request received', { exact: true }).waitFor({ timeout: 2500 });
  assert.equal(await dialogWork.getAttribute('data-agent-idle-trick'), null);
  assert.equal(await dialogWork.evaluate(badge => badge.querySelector('.agent-robot-ticket').getAnimations().some(animation => animation.animationName === 'agent-catch' && animation.effect.getTiming().duration === 2000)), true);
  await screenshot(motionPopup, 'settings-catching');
  await dialogIdle.waitFor();
  await motionPopup.emulateMedia({ reducedMotion: 'reduce' });
  await motionPopup.locator('#agentDialogWork:not([data-agent-idle-trick])').waitFor();
  assert.equal(await dialogWork.evaluate(badge => badge.getAnimations({ subtree: true }).length), 0);
  await tool('list', { profileId });
  await dialogWork.getByText('MCP request received', { exact: true }).waitFor({ timeout: 2500 });
  assert.equal(await dialogWork.evaluate(badge => badge.getAnimations({ subtree: true }).length), 0);
  await dialogIdle.waitFor();
  await motionPopup.close();
  assert.equal(draft.matches, 2); assert.equal(draft.protected, 1);
  assert.doesNotMatch(JSON.stringify(draft), /https:|lastVisitTime/);
  const saveArgs = { profileId, requestId: 'synthetic-save', revision: draft.revision, rule, enabled: true, previewId: draft.previewId };
  const pending = await tool('save', saveArgs);
  assert.equal(pending.status, 'pending');
  assert.equal((await tool('list', { profileId })).config.rules.length, 0);
  await page.locator(`[data-request="${pending.id}"] button.primary`).waitFor();
  try { await page.waitForFunction(id => document.activeElement?.dataset.request === id, pending.id, { timeout: 10000 }); }
  catch (error) {
    console.log(await page.evaluate(async () => ({ hash: location.hash, focusedTag: document.activeElement?.tagName,
      queryResult: await chrome.tabs.query({ url: `${chrome.runtime.getURL('agent.html')}*` }).then(tabs => ({ count: tabs.length }), reason => ({ error: reason.message })) })));
    throw error;
  }
  await screenshot(page, 'save-approval-en');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => localStorage.setItem('language', 'zh-CN')); await page.reload();
  await page.locator(`[data-request="${pending.id}"] button.primary`).waitFor();
  await screenshot(page, 'save-approval-zh-narrow');
  await page.locator(`[data-request="${pending.id}"] button.primary`).click();
  await until(async () => (await tool('status', { profileId, requestId: saveArgs.requestId })).status === 'done', 'Save did not complete');
  const saved = await tool('list', { profileId });
  assert.equal(saved.config.rules.length, 1);
  const taskId = saved.config.rules[0].id;
  const preview = await tool('preview', { profileId, id: taskId });
  const executeArgs = { profileId, requestId: 'synthetic-execute', id: taskId, revision: preview.revision, previewId: preview.previewId };
  const run = await tool('execute', executeArgs);
  assert.equal((await tool('execute', executeArgs)).id, run.id);
  assert.ok((await page.evaluate(url => chrome.history.getVisits({ url }), urls[0])).length);
  await page.locator(`[data-request="${run.id}"] button.primary`).waitFor();
  await page.waitForFunction(id => document.activeElement?.dataset.request === id, run.id);
  await screenshot(page, 'execute-approval-zh-narrow');
  await page.locator(`[data-request="${run.id}"] button.primary`).click();
  await until(async () => (await tool('status', { profileId, requestId: executeArgs.requestId })).status === 'done', 'Execution did not verify');
  const counts = await page.evaluate(async urls => Promise.all(urls.map(async url => (await chrome.history.getVisits({ url })).length)), urls);
  assert.deepEqual(counts, [0, 0, 1, 1]);
  await tool('execute', executeArgs);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.evaluate(() => localStorage.setItem('language', 'en')); await page.reload();
  await page.waitForFunction(() => document.getElementById('requests').textContent.includes('Completed'));
  await screenshot(page, 'completed-en');
  await writeFile(remoteFixture, JSON.stringify(currentPublisher));
  await page.locator('#checkUpdates').click();
  await page.locator('#checkUpdates[data-check=checking]').waitFor();
  await page.waitForFunction(() => document.querySelector('.agent-scan-beam').getAnimations().some(animation => animation.animationName === 'agent-scan-pass'));
  await screenshot(page, 'update-checking');
  await page.locator('#checkUpdates[data-check=current]').waitFor();
  await screenshot(page, 'update-current');
  const diagnostics = page.locator('#companionHealth .agent-update-details');
  const diagnosticsToggle = diagnostics.locator('summary');
  assert.equal(await diagnostics.locator('#mcpLastRequest').isVisible(), false);
  assert.equal(await diagnostics.locator('#installedVersion').isVisible(), false);
  await diagnosticsToggle.press('Enter');
  await diagnostics.locator('#mcpLastRequest').waitFor({ state: 'visible' });
  assert.equal(await diagnostics.locator('#installedVersion').textContent(), VERSION);
  assert.ok(await diagnostics.locator('#checkedAt').textContent());
  await diagnosticsToggle.press('Enter');
  await diagnostics.locator('#mcpLastRequest').waitFor({ state: 'hidden' });
  await writeFile(remoteFixture, JSON.stringify(remoteFiles));
  await page.locator('#checkUpdates').click();
  await page.locator('#agentApplyUpdate').waitFor({ state: 'visible' });
  await screenshot(page, 'update-available-en');
  await page.locator('#agentApplyUpdate').click();
  await page.locator('#restartNotice').waitFor({ state: 'visible' });
  const upgraded = await tool('health', { profileId });
  assert.equal(upgraded.installedVersion, nextVersion); assert.equal(upgraded.mcpRestartRequired, true);
  assert.equal(upgraded.skillHealthy, true);
  assert.match(await readFile(join(home, '.agents', 'skills', 'history-sweep', 'SKILL.md'), 'utf8'), /Synthetic update fixture/);
  await screenshot(page, 'updated-restart-required-en');
  await page.evaluate(() => localStorage.setItem('theme','dark')); await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelector('#companionHealth')?.hidden === false);
  await screenshot(page, 'dark-agent');
  await page.evaluate(() => localStorage.setItem('theme','light')); await page.reload();
  await page.locator('#disconnect').waitFor({state:'visible'});
  await page.locator('#disconnect').click();
  await page.waitForFunction(() => document.getElementById('connectionState').textContent === 'Not connected');
  await page.waitForTimeout(850); await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('connectionState').textContent === 'Connected');
  assert.equal(await page.locator('#profileId').inputValue(), profileId);
  assert.equal((await tool('list', { profileId })).config.rules.length, 1);
  assert.equal((await tool('health', { profileId })).runningVersion, nextVersion);
  const stopped = once(mcp, 'exit'); mcp.stdin.end(); await stopped;
  await startMcp();
  const current = await tool('health', { profileId });
  assert.equal(current.mcpVersion, nextVersion); assert.equal(current.mcpRestartRequired, false);
  await context.close(); context = undefined;
  origin = await launch();
  page = await context.newPage(); await page.goto(`${origin}/agent.html`);
  await page.waitForFunction(() => document.getElementById('connectionState').textContent === 'Connected');
  assert.equal((await tool('list', { profileId })).config.rules.length, 1);
  assert.deepEqual(errors, []);
  if (uiCapture) {
    assert.deepEqual(await sourceHashes(), initialHashes, 'UI sources changed during capture');
    await mkdir(dirname(uiCapture), {recursive:true});
    await writeFile(uiCapture, JSON.stringify({receipts:uiReceipts,sourceHashes:initialHashes,captureSource:'Fresh production UI in isolated Chrome; synthetic publisher and history'},null,2));
  }
  console.log('Agent browser workflow passed: installer download + real native host + MCP health + approved verified deletion + retained protection + synthetic publisher MCP/Skill update + reconnect/client restart + browser restart + EN/ZH layouts.');
} finally {
  await cleanup();
}
