import test from 'node:test';
import assert from 'node:assert/strict';
import { createLauncher } from '../extension/launcher.mjs';

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { for (const fn of listeners) fn(...args); }, listeners };
}

function fixture({ storedMode, scriptResult = { opened: true }, scriptError, localGet } = {}) {
  const state = { local: storedMode === undefined ? {} : { launchMode: storedMode }, session: {} };
  const calls = { popups: [], opened: [], scripts: [], localWrites: [], sessionWrites: [] };
  const chromeApi = {
    runtime: {
      id: 'unit', getURL: path => `chrome-extension://unit/${path}`,
      onStartup: event(), onInstalled: event(),
    },
    action: { onClicked: event(), setPopup: async value => calls.popups.push(value.popup) },
    tabs: {
      onRemoved: event(),
      create: async value => { calls.opened.push(value.url); return { id: calls.opened.length }; },
    },
    scripting: { executeScript: async value => {
      calls.scripts.push(value);
      if (scriptError) throw scriptError;
      return [{ result: scriptResult }];
    } },
    storage: {
      onChanged: event(),
      local: {
        get: async key => localGet ? localGet(key, state.local) : ({ [key]: state.local[key] }),
        set: async value => {
          calls.localWrites.push(value);
          Object.assign(state.local, value);
          chromeApi.storage.onChanged.fire(Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }])), 'local');
        },
      },
      session: {
        get: async key => ({ [key]: state.session[key] }),
        set: async value => { calls.sessionWrites.push(value); Object.assign(state.session, value); },
        remove: async key => { delete state.session[key]; },
      },
    },
  };
  return { state, calls, chromeApi, make: () => createLauncher(chromeApi) };
}

const idle = () => new Promise(resolve => setImmediate(resolve));

test('saved preference selects popup, modal or fullpage and invalid values use popup', async () => {
  for (const [storedMode, expected, popup] of [
    ['popup', 'popup', 'popup.html'], ['modal', 'modal', ''], ['fullpage', 'fullpage', ''],
    ['invalid', 'popup', 'popup.html'],
  ]) {
    const f = fixture({ storedMode });
    const launcher = f.make();
    await launcher.register();
    assert.equal(await launcher.getMode(), expected);
    assert.equal(f.calls.popups.at(-1), popup);
    assert.deepEqual(f.calls.localWrites, []);
  }
});

test('cold-start action waits for stored preference before choosing its route', async () => {
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const f = fixture({ storedMode: 'modal', localGet: async (key, values) => {
    await deferred;
    return { [key]: values[key] };
  } });
  const launcher = f.make();
  const ready = launcher.register();
  f.chromeApi.action.onClicked.fire({ id: 31, url: 'https://example.test/' });
  await Promise.resolve();
  assert.equal(f.calls.scripts.length, 0);
  assert.equal(await Promise.race([launcher.getMode().then(() => 'ready'), Promise.resolve('waiting')]), 'waiting');
  release();
  await ready;
  assert.equal(await launcher.getMode(), 'modal');
  await idle();
  assert.equal(f.calls.scripts.length, 1);
});

test('a delayed stale preference read cannot overwrite a newer storage change', async () => {
  const reads = [];
  const f = fixture({ storedMode: 'popup', localGet: key => new Promise(resolve => reads.push({ key, resolve })) });
  const launcher = f.make();
  const ready = launcher.register();
  await idle();
  f.state.local.launchMode = 'modal';
  f.chromeApi.storage.onChanged.fire({ launchMode: { newValue: 'modal' } }, 'local');
  reads[0].resolve({ launchMode: 'popup' });
  await ready;
  await idle();
  reads[1].resolve({ launchMode: f.state.local.launchMode });
  await idle();
  assert.equal(await launcher.getMode(), 'modal');
  assert.equal(f.calls.popups.at(-1), '');
});

test('storage changes and worker startup reapply the saved mode', async () => {
  const f = fixture();
  const launcher = f.make();
  await launcher.register();
  f.state.local.launchMode = 'modal';
  f.chromeApi.storage.onChanged.fire({ launchMode: { newValue: 'modal' } }, 'local');
  await idle();
  assert.equal(await launcher.getMode(), 'modal');
  f.state.local.launchMode = 'fullpage';
  f.chromeApi.runtime.onStartup.fire();
  await idle();
  assert.equal(await launcher.getMode(), 'fullpage');
});

test('setMode persists only launchMode and toolbar action routes to full page', async () => {
  const f = fixture();
  const launcher = f.make();
  await launcher.register();
  assert.equal(await launcher.setMode('fullpage'), 'fullpage');
  assert.equal(f.calls.popups.at(-1), '');
  f.chromeApi.action.onClicked.fire({ id: 4, url: 'https://example.test/' });
  await idle();
  assert.deepEqual(f.calls.localWrites, [{ launchMode: 'fullpage' }]);
  assert.match(f.calls.opened[0], /manager\.html$/);
});

test('modal launch injects into the active tab and falls back when injection is rejected', async () => {
  const f = fixture();
  const launcher = f.make();
  await launcher.register();
  await launcher.setMode('modal');
  f.chromeApi.action.onClicked.fire({ id: 7, url: 'https://example.test/page' });
  await idle();
  assert.equal(f.calls.scripts[0].target.tabId, 7);
  assert.equal(f.calls.scripts[0].world, 'ISOLATED');
  assert.equal(f.calls.scripts[0].args[0].includes('#launch='), true);
  assert.equal(Object.keys(f.state.session.modalLaunchSessions).length, 1);

  const blocked = fixture({ scriptError: new Error('restricted') });
  const other = blocked.make();
  await other.register();
  await other.setMode('modal');
  blocked.chromeApi.action.onClicked.fire({ id: 8, url: 'https://example.test/page' });
  await idle();
  assert.match(blocked.calls.opened[0], /manager\.html#modalUnavailable$/);
  assert.equal(blocked.state.session.modalLaunchSessions, undefined);
});

test('restricted URLs and repeated modal toggles clean unused claims', async () => {
  const blocked = fixture();
  const launcher = blocked.make();
  await launcher.register();
  await launcher.setMode('modal');
  blocked.chromeApi.action.onClicked.fire({ id: 9, url: 'chrome://settings' });
  await idle();
  assert.equal(blocked.calls.scripts.length, 0);
  assert.match(blocked.calls.opened[0], /#modalUnavailable$/);

  const toggle = fixture({ scriptResult: { opened: false } });
  const toggler = toggle.make();
  await toggler.register();
  await toggler.setMode('modal');
  toggle.chromeApi.action.onClicked.fire({ id: 10, url: 'https://example.test/' });
  await idle();
  assert.equal(toggle.state.session.modalLaunchSessions, undefined);
  assert.equal(toggle.calls.opened.length, 0);
});

test('modal claims are one-use, bound to one tab, child frame and document across worker restart', async () => {
  const f = fixture();
  const launcher = f.make();
  await launcher.register();
  await launcher.setMode('modal');
  f.chromeApi.action.onClicked.fire({ id: 12, url: 'https://example.test/' });
  await idle();
  const modalUrl = f.calls.scripts[0].args[0];
  const sender = { id: 'unit', url: modalUrl, tab: { id: 12 }, frameId: 3, documentId: 'modal-document' };
  const key = new URLSearchParams(new URL(modalUrl).hash.slice(1)).get('launch');

  assert.equal(await launcher.claimModal(key, { ...sender, frameId: 0 }), false);
  assert.equal(await launcher.claimModal(key, { ...sender, id: 'other' }), false);
  assert.equal(await launcher.claimModal(key, { ...sender, tab: { id: 99 } }), false);
  assert.equal(await launcher.claimModal(key, { ...sender, url: modalUrl.replace('chrome-extension:', 'https:') }), false);
  assert.equal(await launcher.claimModal(key, { ...sender, url: modalUrl.replace('://unit/', '://other/') }), false);
  const claims = await Promise.all([launcher.claimModal(key, sender), launcher.claimModal(key, sender)]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(await launcher.isTrustedModal(sender), true);

  const restartedWorker = f.make();
  assert.equal(await restartedWorker.isTrustedModal(sender), true);
  assert.equal(await restartedWorker.isTrustedModal({ ...sender, url: modalUrl.replace('chrome-extension:', 'https:') }), false);
  assert.equal(await restartedWorker.isTrustedModal({ ...sender, url: modalUrl.replace('://unit/', '://other/') }), false);
  assert.equal(await restartedWorker.isTrustedModal({ ...sender, frameId: 4 }), false);
  assert.equal(await restartedWorker.isTrustedModal({ ...sender, documentId: 'new-document' }), false);
  assert.equal(await restartedWorker.isTrustedModal({ ...sender, frameId: 0 }), false);
  assert.equal(await restartedWorker.claimModal(key, sender), false);
});

test('unclaimed modal session expires and tab removal clears it', async () => {
  const f = fixture();
  const launcher = f.make();
  await launcher.register();
  await launcher.setMode('modal');
  f.chromeApi.action.onClicked.fire({ id: 21, url: 'https://example.test/' });
  await idle();
  const modalUrl = f.calls.scripts[0].args[0];
  const key = new URLSearchParams(new URL(modalUrl).hash.slice(1)).get('launch');
  const sender = { id: 'unit', url: modalUrl, tab: { id: 21 }, frameId: 2, documentId: 'doc' };
  f.state.session.modalLaunchSessions[key].expires = 0;
  assert.equal(await launcher.claimModal(key, sender), false);

  f.chromeApi.action.onClicked.fire({ id: 22, url: 'https://example.test/' });
  await idle();
  f.chromeApi.tabs.onRemoved.fire(22);
  await idle();
  assert.equal(f.state.session.modalLaunchSessions, undefined);
});
