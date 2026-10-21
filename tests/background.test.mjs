import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as filters from '../extension/history-filters.mjs';
import { createLauncher } from '../extension/launcher.mjs';
import { createActivityLog } from '../extension/activity-log.mjs';
import { createUpdateChecker, isNewerVersion } from '../extension/update-check.mjs';

const source = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
const sender = { id: 'fixture', frameId: 0, documentId: 'popup-document', url: 'chrome-extension://fixture/popup.html' };
function worker(history, sessions = {}, currentVersion = '0.3.1', updateOptions = {}) {
  let listener;
  const opened = [];
  const timers = [];
  const saved = updateOptions.localState || {};
  const menus = [];
  const installed = [];
  let menuClicked, actionClicked;
  const injected = [];
  const popups = [];
  let activeUrl = 'https://example.test/current';
  let updateAvailable;
  let reloads = 0;
  const chrome = {
    management: { getSelf: async () => ({ id: 'fixture', installType: 'development' }) },
    history, tabs: { create: async ({ url }) => { opened.push(url); }, query: async () => [{ url: activeUrl }], onRemoved: { addListener() {} } },
    action: { setPopup: async data => { popups.push(data.popup); }, onClicked: { addListener: callback => { actionClicked = callback; } } },
    scripting: { executeScript: async data => { injected.push(data); return [{ result: { opened: true } }]; } },
    storage: {
      local: { get: async () => ({ ...saved }), set: async data => { Object.assign(saved, data); } },
      session: { get: async () => structuredClone(sessions), set: async data => { Object.assign(sessions, structuredClone(data)); }, remove: async key => { delete sessions[key]; } },
      onChanged: { addListener() {} },
    },
    i18n: { getMessage: () => 'Find this website in History Sweep' },
    contextMenus: { create: menu => { menus.push(menu); }, onClicked: { addListener: callback => { menuClicked = callback; } } },
    runtime: { id: 'fixture', getManifest: () => ({ version: currentVersion }), reload: () => { reloads++; }, onUpdateAvailable: { addListener: callback => { updateAvailable = callback; } }, getURL: path => 'chrome-extension://fixture/' + path, onMessage: { addListener: value => { listener = value; } }, onInstalled: { addListener: callback => { installed.push(callback); } }, onStartup: { addListener() {} } },
  };
  runInNewContext(source, { ...filters, createLauncher, createActivityLog, createUpdateChecker: api => createUpdateChecker({ ...api, ...updateOptions }, { fetchVersion: updateOptions.fetchVersion }), isNewerVersion, chrome, URL, crypto: { randomUUID }, setTimeout: callback => { timers.push(callback); }, Date: updateOptions.Date || Date });
  return {
    opened, timers, saved, menus, injected, popups, sessions, updateAvailable: details => updateAvailable(details), get reloads() { return reloads; }, clickAction: tab => actionClicked(tab), install: (reason = 'install') => installed.forEach(callback => callback({ reason })), clickMenu: info => menuClicked(info), setActiveUrl: url => { activeUrl = url; },
    send: (message, from = sender) => new Promise(resolve => {
      if (!listener(message, from, resolve)) resolve({ ok: false });
    }),
  };
}
async function finished(w, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await w.send({ type: 'delete-status', id });
    if (!['deleting', 'verifying'].includes(response.data.phase)) return response.data;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Deletion did not finish');
}

test('activity counts one verified task, excludes failed URLs, and status polling does not recount', async () => {
  const w = worker({ deleteUrl: async () => {}, getVisits: async ({ url }) => url.endsWith('/keep') ? [{ visitId: '1' }] : [] });
  const started = await w.send({ type: 'start-delete', urls: ['https://example.test/a', 'https://example.test/a', 'https://example.test/keep'] });
  assert.equal((await finished(w, started.data.id)).phase, 'partial');
  await w.send({ type: 'delete-status', id: started.data.id });
  const { log } = (await w.send({ type: 'get-activity' })).data;
  assert.equal(Object.values(log.days)[0].operations, 1);
  assert.equal(Object.values(log.days)[0].pages, 1);
  assert.equal(JSON.stringify(w.saved).includes('https:'), false);
  assert.equal((await w.send({ type: 'get-activity' }, { ...sender, url: 'https://example.test/' })).ok, false);
});

test('private cleanup skips all activity writes, preserves old records, and can be disabled', async () => {
  for (const existing of [false, true]) {
    const w = worker({ deleteUrl: async () => {}, getVisits: async ({ url }) => url.endsWith('/keep') ? [{}] : [] });
    w.saved.privateCleanup = true;
    if (existing) w.saved.localActivity = { version: 1, startedOn: '2026-01-01', days: { '2026-01-01': { operations: 2, pages: 5 } } };
    const before = structuredClone(w.saved);
    const started = await w.send({ type: 'start-delete', urls: ['https://example.test/a', 'https://example.test/keep'], details: [{ url: 'https://example.test/a', title: 'Private page', lastVisitTime: 12345 }] });
    assert.equal(started.data.privateCleanup, true);
    // Changing preferences while running does not change this task's privacy policy.
    w.saved.privateCleanup = false;
    const result = await finished(w, started.data.id);
    assert.equal(result.phase, 'partial');
    assert.equal(result.privateCleanup, true);
    assert.deepEqual(w.saved, { ...before, privateCleanup: false });
    const next = await w.send({ type: 'start-delete', urls: ['https://example.test/b'] });
    assert.equal((await finished(w, next.data.id)).privateCleanup, false);
    assert.equal(Object.values(w.saved.localActivity.days).reduce((sum, day) => sum + day.operations, 0), existing ? 3 : 1);
    assert.doesNotMatch(JSON.stringify(w.saved), /Private page|12345/);
  }
});

test('an invalid privacy setting blocks cleanup before any history is deleted', async () => {
  let deleted = 0;
  const w = worker({ deleteUrl: async () => { deleted++; }, getVisits: async () => [] });
  w.saved.privateCleanup = 'true';
  const result = await w.send({ type: 'start-delete', urls: ['https://example.test/a'] });
  assert.equal(result.ok, false);
  assert.equal(deleted, 0);
});

test('unverified deletions never become confirmed removed-page statistics', async () => {
  const w = worker({ deleteUrl: async () => {}, getVisits: async () => { throw new Error('verification unavailable'); } });
  const started = await w.send({ type: 'start-delete', urls: ['https://example.test/a'] });
  assert.equal((await finished(w, started.data.id)).phase, 'verifyFailed');
  assert.deepEqual(Object.keys((await w.send({ type: 'get-activity' })).data.log.days), []);
});

test('cleanup website metadata includes only verified selected URLs and survives a closed initiating view', async () => {
  const w = worker({ deleteUrl: async () => {}, getVisits: async ({ url }) => url.includes('keep.example') ? [{}] : [] });
  const time = new Date(2026, 9, 17, 12).getTime();
  const started = await w.send({ type: 'start-delete', urls: ['https://removed.example/page', 'https://keep.example/page'], details: [
    { url: 'https://removed.example/page', title: 'Removed title', lastVisitTime: time, extra: 'must not persist' },
    { url: 'https://keep.example/page', title: 'Kept title', lastVisitTime: time + 1 },
    { url: 'https://unselected.example/page', title: 'Unselected title', lastVisitTime: time + 2 },
  ] });
  assert.equal((await finished(w, started.data.id)).phase, 'partial');
  const day = Object.values((await w.send({ type: 'get-activity' })).data.log.days)[0];
  assert.equal(day.pages, 1); assert.equal(day.websitesComplete, true);
  assert.deepEqual(day.websites, [{ domain: 'removed.example', title: 'Removed title', lastVisitTime: time }]);
  assert.doesNotMatch(JSON.stringify(w.saved), /https:|Kept title|Unselected title|extra/);
});

test('Chrome update metadata survives worker suspension and is ignored after installation', async () => {
  const w = worker({});
  assert.equal((await w.send({ type: 'get-update-state' })).data.update, null);
  assert.equal((await w.send({ type: 'apply-update' })).code, 'UPDATE_UNAVAILABLE');
  assert.equal(w.reloads, 0);
  w.updateAvailable({ version: '0.3.2' });
  const pending = (await w.send({ type: 'get-update-state' })).data.update;
  assert.equal(pending.version, '0.3.2');
  assert.equal(pending.busy, false);
  const resumed = worker({}, w.sessions);
  assert.equal((await resumed.send({ type: 'get-update-state' })).data.update.version, '0.3.2');
  const upgraded = worker({}, w.sessions, '0.3.2');
  assert.equal((await upgraded.send({ type: 'get-update-state' })).data.update, null);
  assert.equal((await upgraded.send({ type: 'apply-update' })).code, 'UPDATE_UNAVAILABLE');
  assert.deepEqual(w.saved, {});
});

test('an opening update check never holds up deletion or permits reload during verification', async () => {
  let finishFetch, finishDelete, finishVerify;
  const fetching = new Promise(resolve => { finishFetch = resolve; });
  const deleting = new Promise(resolve => { finishDelete = resolve; });
  const verifying = new Promise(resolve => { finishVerify = resolve; });
  const w = worker({ deleteUrl: () => deleting, getVisits: () => verifying }, {}, '0.3.1', {
    management: { getSelf: async () => ({ id: 'bbccfejdhhcjmpfagjckiikgllpojhgm', installType: 'normal', updateUrl: 'https://clients2.google.com/service/update2/crx' }) },
    runtime: { getManifest: () => ({ version: '0.3.1' }), requestUpdateCheck: async () => ({ status: 'update_available', version: '0.3.2' }) },
    fetchVersion: () => fetching,
  });
  assert.equal((await w.send({ type: 'check-for-update' }, { ...sender, url: 'https://untrusted.test/' })).ok, false);
  const checking = w.send({ type: 'check-for-update' });
  const started = await w.send({ type: 'start-delete', urls: ['https://example.test/remove'] });
  assert.equal(started.ok, true);
  assert.equal((await w.send({ type: 'get-update-state' })).data.update, null);
  finishFetch({ ok: true, json: async () => ({ extensionId: 'bbccfejdhhcjmpfagjckiikgllpojhgm', version: '0.3.2' }) });
  const { update } = (await checking).data;
  assert.equal(update.version, '0.3.2'); assert.equal(update.busy, true);
  assert.equal((await w.send({ type: 'apply-update' })).code, 'UPDATE_BUSY');
  finishDelete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id })).data.phase, 'verifying');
  assert.equal((await w.send({ type: 'apply-update' })).code, 'UPDATE_BUSY');
  assert.equal(w.reloads, 0);
  finishVerify([]); await finished(w, started.data.id);
  assert.equal((await w.send({ type: 'apply-update' })).ok, true);
  assert.equal(w.reloads, 1);
});

test('a downloaded update skips further network checks and invalid update events stay hidden', async () => {
  const w = worker({});
  for (const version of ['0.3.0', '0.3.1.0', 'invalid']) w.updateAvailable({ version });
  assert.equal((await w.send({ type: 'get-update-state' })).data.update, null);
  w.updateAvailable({ version: '0.3.2' });
  assert.equal((await w.send({ type: 'check-for-update' })).data.update.version, '0.3.2');
  assert.deepEqual(w.saved, {});
});

test('update reload is blocked across views during both deletion and verification', async () => {
  let finishDelete, finishVerify;
  const deleting = new Promise(resolve => { finishDelete = resolve; });
  const verifying = new Promise(resolve => { finishVerify = resolve; });
  const w = worker({ deleteUrl: () => deleting, getVisits: async () => { await verifying; return []; } });
  const other = { ...sender, documentId: 'manager-document', url: 'chrome-extension://fixture/manager.html' };
  const started = await w.send({ type: 'start-delete', urls: ['https://example.test/remove'] });
  w.updateAvailable({ version: '0.3.2' });
  assert.equal((await w.send({ type: 'get-update-state' }, other)).data.update.busy, true);
  assert.equal((await w.send({ type: 'apply-update' }, other)).code, 'UPDATE_BUSY');
  assert.equal(w.reloads, 0);
  finishDelete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id })).data.phase, 'verifying');
  assert.equal((await w.send({ type: 'apply-update' }, other)).code, 'UPDATE_BUSY');
  finishVerify(); await finished(w, started.data.id);
  assert.equal((await w.send({ type: 'get-update-state' }, other)).data.update.busy, false);
  assert.equal(w.sessions.extensionUpdate.busy, false);
  assert.equal((await w.send({ type: 'apply-update' }, other)).ok, true);
  assert.equal(w.reloads, 1);
  assert.equal((await w.send({ type: 'start-delete', urls: ['https://example.test/next'] })).code, 'UPDATE_RELOADING');
});

test('a queued deletion is checked before update reload and untrusted pages cannot reload', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = worker({ deleteUrl: () => gate, getVisits: async () => [] });
  w.updateAvailable({ version: '0.3.2' });
  await w.send({ type: 'get-update-state' });
  assert.equal((await w.send({ type: 'apply-update' }, { ...sender, url: 'https://example.test/' })).ok, false);
  const start = w.send({ type: 'start-delete', urls: ['https://example.test/remove'] });
  const apply = w.send({ type: 'apply-update' });
  const started = await start;
  assert.equal((await apply).code, 'UPDATE_BUSY');
  assert.equal(w.reloads, 0);
  release(); await finished(w, started.data.id);
});

test('launch preferences persist and only a claimed modal document may use history operations', async () => {
  const removed = [];
  const w = worker({ deleteUrl: async ({ url }) => { removed.push(url); }, getVisits: async () => [] });
  assert.equal((await w.send({ type: 'get-launch-preference' })).data.launchMode, 'modal');
  assert.equal((await w.send({ type: 'set-launch-preference', launchMode: 'modal' })).data.launchMode, 'modal');
  assert.equal(w.saved.launchMode, 'modal');
  assert.equal(w.popups.at(-1), '');
  assert.equal((await w.send({ type: 'set-launch-preference', launchMode: 'invalid' })).ok, false);
  w.clickAction({ id: 7, url: 'https://example.test/' });
  await new Promise(resolve => setImmediate(resolve));
  const modalUrl = w.injected[0].args[0];
  const token = new URLSearchParams(new URL(modalUrl).hash.slice(1)).get('launch');
  const modal = { id: 'fixture', tab: { id: 7 }, frameId: 2, documentId: 'modal-document', url: modalUrl };
  const deletion = { type: 'start-delete', urls: ['https://example.test/remove'] };
  assert.equal((await w.send(deletion, modal)).ok, false);
  assert.equal((await w.send({ type: 'claim-modal', token }, { ...modal, tab: { id: 8 } })).ok, false);
  assert.equal((await w.send({ type: 'claim-modal', token }, modal)).ok, true);
  assert.equal((await w.send({ type: 'claim-modal', token }, modal)).ok, false);
  assert.equal((await w.send({ type: 'get-launch-preference' }, modal)).data.launchMode, 'modal');
  assert.equal((await w.send(deletion, { ...modal, documentId: 'other-document' })).ok, false);
  const started = await w.send(deletion, modal);
  assert.equal(started.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, deletion.urls);
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id }, modal)).data.phase, 'done');
});

test('authoritative kept rules reject an entire stale deletion batch and remain local', async () => {
  const removed = [];
  const w = worker({ deleteUrl: async ({ url }) => { removed.push(url); }, getVisits: async () => [] });
  assert.equal((await w.send({ type: 'get-protection' })).data.sites.length, 0);
  const saved = await w.send({ type: 'save-protection', input: 'example.org' });
  assert.equal(saved.ok, true);
  assert.deepEqual(w.saved.protectedSites, ['example.org']);
  const rejected = await w.send({ type: 'start-delete', urls: ['https://other.test/a', 'https://news.example.org/a'] });
  assert.equal(rejected.code, 'PROTECTED_URL');
  assert.deepEqual(removed, []);
  const invalid = await w.send({ type: 'save-protection', input: '*.example.org' });
  assert.equal(invalid.code, 'INVALID_PROTECTED_SITES');
  assert.deepEqual(w.saved.protectedSites, ['example.org']);
});

test('protection saves cannot race a deletion already accepted by the worker', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = worker({ deleteUrl: async () => { await gate; }, getVisits: async () => [] });
  const started = await w.send({ type: 'start-delete', urls: ['https://example.org/a'] });
  assert.equal((await w.send({ type: 'save-protection', input: 'example.org' })).code, 'RULES_BUSY');
  release(); await finished(w, started.data.id);
  assert.equal((await w.send({ type: 'save-protection', input: 'example.org' })).ok, true);
});

test('current website and context menu only open exact-host searches without deleting', async () => {
  let deletes = 0;
  const w = worker({ deleteUrl: async () => { deletes++; } });
  w.setActiveUrl('https://docs.example.org/path?fixture=1');
  assert.equal((await w.send({ type: 'current-site' })).data.hostname, 'docs.example.org');
  w.setActiveUrl('chrome://extensions/');
  assert.equal((await w.send({ type: 'current-site' })).code, 'CURRENT_SITE_UNAVAILABLE');
  assert.equal((await w.send({ type: 'current-site' }, { ...sender, url: 'chrome-extension://fixture/manager.html' })).ok, false);
  w.install(); assert.deepEqual([...w.menus[0].contexts], ['page']);
  w.clickMenu({ menuItemId: 'sweep-site', pageUrl: 'https://docs.example.org/private-path' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.opened.length, 1);
  assert.equal(w.opened[0].includes('example.org'), false);
  const handoffId = new URLSearchParams(new URL(w.opened[0]).hash.slice(1)).get('handoff');
  const data = (await w.send({ type: 'claim-workspace', handoffId }, { ...sender, url: w.opened[0] })).data;
  assert.equal(data.query, 'docs.example.org'); assert.equal(data.mode, 'host-exact');
  assert.equal(deletes, 0);
});

test('date filters survive one-use handoff and invalid filters never open a workspace', async () => {
  const w = worker({});
  const filters = { range: 'custom', startDate: '2026-09-01', endDate: '2026-10-01' };
  assert.equal((await w.send({ type: 'open-workspace', query: '', mode: 'smart', filters })).ok, true);
  const handoffId = new URLSearchParams(new URL(w.opened[0]).hash.slice(1)).get('handoff');
  assert.deepEqual((await w.send({ type: 'claim-workspace', handoffId }, { ...sender, url: w.opened[0] })).data.filters, filters);
  assert.equal((await w.send({ type: 'open-workspace', query: '', mode: 'smart', filters: { ...filters, startDate: '2026-10-02' } })).code, 'INVALID_TIME_RANGE');
  assert.equal(w.opened.length, 1);
});

test('confirmed deletion outlives a closed popup and verifies every selected URL', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const kept = 'https://example.test/keep';
  const selected = ['https://example.test/remove-a', 'https://example.test/remove-b'];
  const records = new Set([kept, ...selected]);
  const verified = [];
  const w = worker({
    deleteUrl: async ({ url }) => { await gate; records.delete(url); },
    getVisits: async ({ url }) => { verified.push(url); return records.has(url) ? [{}] : []; },
  });
  const response = await w.send({ type: 'start-delete', urls: selected });
  assert.equal(response.ok, true);
  // The initiating UI sends no more messages while the independent queue runs.
  release();
  await new Promise(resolve => setImmediate(resolve));
  const result = await finished(w, response.data.id);
  assert.equal(result.phase, 'done');
  assert.deepEqual([...records], [kept]);
  assert.deepEqual(verified.sort(), selected.sort());
  assert.equal((await w.send({ type: 'delete-status', id: result.id }, { ...sender, documentId: 'other-document' })).ok, false);
  await w.send({ type: 'release-delete', id: result.id });
  assert.equal((await w.send({ type: 'delete-status', id: result.id })).ok, false);
});

test('failed URLs remain selected; verification failure never reports success', async () => {
  const url = 'https://example.test/blocked';
  let attempts = 0;
  const w = worker({ deleteUrl: async () => { attempts++; throw new Error('fixture'); }, getVisits: async () => [{}] });
  const started = await w.send({ type: 'start-delete', urls: [url] });
  const result = await finished(w, started.data.id);
  assert.equal(result.phase, 'partial');
  assert.equal(result.remaining[0], url);
  assert.equal(attempts, 3);
  const failed = worker({ deleteUrl: async () => {}, getVisits: async () => { throw new Error('fixture'); } });
  const next = await failed.send({ type: 'start-delete', urls: [url] });
  assert.equal((await finished(failed, next.data.id)).phase, 'verifyFailed');
});

test('real toolbar popup identity supports deletion and isolates other popup instances', async () => {
  const popup = { id: 'fixture', url: 'chrome-extension://fixture/popup.html' };
  const clientId = randomUUID();
  const url = 'https://example.test/toolbar-delete';
  const records = new Set([url]);
  const w = worker({ deleteUrl: async ({ url }) => { records.delete(url); }, getVisits: async ({ url }) => records.has(url) ? [{}] : [] });
  const started = await w.send({ type: 'start-delete', urls: [url], clientId }, popup);
  assert.equal(started.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const status = await w.send({ type: 'delete-status', id: started.data.id, clientId }, popup);
  assert.equal(status.data.phase, 'done');
  assert.equal(records.size, 0);
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id, clientId: randomUUID() }, popup)).ok, false);
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id, clientId })).ok, false);
  const missingManagerIdentity = { ...popup, url: 'chrome-extension://fixture/manager.html' };
  assert.equal((await w.send({ type: 'start-delete', urls: [url], clientId }, missingManagerIdentity)).ok, false);
  assert.equal((await w.send({ type: 'start-delete', urls: [url], clientId: 'invalid' }, popup)).ok, false);
  assert.equal((await w.send({ type: 'start-delete', urls: [url], clientId }, { ...popup, tab: { id: 1 } })).ok, false);
  await w.send({ type: 'release-delete', id: started.data.id, clientId }, popup);
  assert.equal((await w.send({ type: 'delete-status', id: started.data.id, clientId }, popup)).ok, false);
});

test('search handoffs are one-use, expire, and never place search terms in a URL', async () => {
  const w = worker({});
  assert.equal((await w.send({ type: 'open-workspace', query: 'private search words', mode: 'contains' })).ok, true);
  assert.equal(w.opened[0].includes('private'), false);
  assert.equal(new URL(w.opened[0]).search, '');
  const handoffId = new URLSearchParams(new URL(w.opened[0]).hash.slice(1)).get('handoff');
  const manager = { ...sender, documentId: 'manager-document', url: w.opened[0] };
  assert.equal((await w.send({ type: 'claim-workspace', handoffId }, manager)).data.query, 'private search words');
  assert.equal((await w.send({ type: 'claim-workspace', handoffId }, manager)).ok, false);
  await w.send({ type: 'open-workspace', query: 'another search', mode: 'smart' });
  w.timers.forEach(callback => callback());
  const expired = new URLSearchParams(new URL(w.opened[1]).hash.slice(1)).get('handoff');
  assert.equal((await w.send({ type: 'claim-workspace', handoffId: expired }, manager)).ok, false);
});

test('untrusted pages, subframes and malformed deletion requests cannot mutate history', async () => {
  let deletes = 0;
  const w = worker({ deleteUrl: async () => { deletes++; } });
  const message = { type: 'start-delete', urls: ['https://example.test/remove'] };
  for (const from of [{ ...sender, id: 'other' }, { ...sender, url: 'https://example.test/popup.html' }, { ...sender, frameId: 1 }, { ...sender, documentId: undefined }]) {
    assert.equal((await w.send(message, from)).ok, false);
  }
  for (const urls of [[], ['not a URL'], [null], Array(100001).fill('https://example.test/remove')]) {
    assert.equal((await w.send({ type: 'start-delete', urls })).ok, false);
  }
  assert.equal(deletes, 0);
});

test('a 100,000-URL job completes without deleting an unselected URL', async () => {
  const urls = Array.from({ length: 100000 }, (_, i) => `https://bulk.example.test/${i}`);
  const remaining = new Set([...urls, 'https://example.test/keep']);
  const w = worker({ deleteUrl: async ({ url }) => { remaining.delete(url); }, getVisits: async ({ url }) => remaining.has(url) ? [{}] : [] });
  const started = await w.send({ type: 'start-delete', urls });
  const result = await finished(w, started.data.id);
  assert.equal(result.phase, 'done');
  assert.equal(result.completed, 100000);
  assert.deepEqual([...remaining], ['https://example.test/keep']);
});

function hintWorker(initial, localState = {}) {
  let now = initial.getTime();
  class HintDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return { ...worker({}, {}, '0.4.0', { Date: HintDate, localState }), setTime: date => { now = date.getTime(); } };
}

test('analytics hint is available once on each of the first three local calendar days, including across DST', async () => {
  const installed = new Date(2026, 2, 7, 23, 59);
  const w = hintWorker(installed);
  w.install();
  const claim = async () => (await w.send({ type: 'claim-activity-scroll-hint' })).data.show;
  assert.equal(await claim(), true);
  assert.equal(w.saved.activityScrollHint.installedAt, installed.getTime());
  assert.equal(await claim(), false);
  w.install('update');
  assert.equal(await claim(), false, 'updating must not reset today or installation date');
  w.setTime(new Date(2026, 2, 8, 0, 1));
  assert.equal(await claim(), true, 'a local midnight begins day two, even minutes after installation');
  assert.equal(await claim(), false);
  w.setTime(new Date(2026, 2, 9, 0, 1));
  assert.equal(await claim(), true);
  w.setTime(new Date(2026, 2, 10, 0, 1));
  assert.equal(await claim(), false, 'day four is outside the window even before 72 hours have elapsed');
  w.install('update');
  assert.equal(await claim(), false);
  assert.equal(w.saved.activityScrollHint.installedAt, installed.getTime());
});

test('analytics hint claims are serialized across views and survive worker restarts', async () => {
  const localState = {};
  const day = new Date(2026, 9, 22, 12);
  const w = hintWorker(day, localState);
  w.install();
  const claims = await Promise.all([w.send({ type: 'claim-activity-scroll-hint' }), w.send({ type: 'claim-activity-scroll-hint' }, { ...sender, documentId: 'manager', url: 'chrome-extension://fixture/manager.html' }), w.send({ type: 'claim-activity-scroll-hint' }, { ...sender, documentId: 'another-popup' })]);
  assert.equal(claims.filter(result => result.data.show).length, 1);
  const restarted = hintWorker(day, localState);
  assert.equal((await restarted.send({ type: 'claim-activity-scroll-hint' })).data.show, false);
  restarted.setTime(new Date(2026, 9, 24, 12));
  assert.equal((await restarted.send({ type: 'claim-activity-scroll-hint' })).data.show, true);
  restarted.setTime(new Date(2026, 9, 23, 12));
  assert.equal((await restarted.send({ type: 'claim-activity-scroll-hint' })).data.show, false, 'clock rollback does not repeat an earlier day');
  restarted.setTime(new Date(2026, 9, 25, 12));
  assert.equal((await restarted.send({ type: 'claim-activity-scroll-hint' })).data.show, false, 'a skipped day does not extend onboarding');
});

test('analytics hints do not invent install dates for existing users and require a persisted daily claim', async () => {
  const date = new Date(2026, 9, 22, 12);
  const old = hintWorker(date);
  old.install('update');
  assert.equal((await old.send({ type: 'claim-activity-scroll-hint' })).data.show, false);
  assert.equal(old.saved.activityScrollHint, undefined);
  const state = { installedAt: date.getTime(), lastShownOn: null };
  const localState = {};
  Object.defineProperty(localState, 'activityScrollHint', { value: state, writable: false, enumerable: true, configurable: true });
  const w = hintWorker(date, localState);
  assert.equal((await w.send({ type: 'claim-activity-scroll-hint' })).ok, false);
  assert.equal(state.lastShownOn, null);
  Object.defineProperty(localState, 'activityScrollHint', { value: state, writable: true, enumerable: true, configurable: true });
  assert.equal((await w.send({ type: 'claim-activity-scroll-hint' })).data.show, true);
  assert.equal((await w.send({ type: 'claim-activity-scroll-hint' }, { ...sender, url: 'https://example.test/' })).ok, false);
});
