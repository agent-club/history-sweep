import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { DAY_MS } from '../extension/auto-cleanup-model.mjs';
import { AUTO_CLEANUP_ALARM, createAutoCleanup } from '../extension/auto-cleanup.mjs';
import { nextOccurrence } from '../extension/auto-cleanup-schedule.mjs';

const now = 2_000_000_000_000;
const rule = (domain = 'example.com', includeSubdomains = false, days = 7) => ({ domain, includeSubdomains, days });
const old = lastVisitTime => ({ url: 'https://example.com/old', title: 'Old page', lastVisitTime });

function harness(options = {}) {
  const saved = structuredClone(options.saved || {});
  const alarms = new Map();
  const alarmCalls = [];
  const deleted = [];
  const searchCalls = [];
  const visits = new Map(options.visits || []);
  const activities = [];
  let protectedSites = options.protectedSites || [];
  let searchItems = options.items || [];
  let clock = options.now ?? now;
  let cleanup;
  const api = {
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(saved, key)).map(key => [key, structuredClone(saved[key])])),
      set: async value => Object.assign(saved, structuredClone(value)),
    } },
    alarms: {
      create: async (name, info) => { alarmCalls.push({ type: 'create', name, info }); alarms.set(name, info); },
      clear: async name => { alarmCalls.push({ type: 'clear', name }); return alarms.delete(name); },
    },
    history: {
      search: async query => { searchCalls.push(query); return typeof searchItems === 'function' ? searchItems(query) : searchItems; },
      getVisits: async ({ url }) => {
        if (options.getVisits) return options.getVisits(url, visits);
        return structuredClone(visits.get(url) || []);
      },
      deleteUrl: async ({ url }) => {
        deleted.push(url);
        if (options.deleteUrl) await options.deleteUrl(url, deleted);
        visits.delete(url);
      },
    },
  };
  cleanup = createAutoCleanup(api, {
    readProtectedSites: async () => protectedSites,
    recordActivity: async (...args) => { if (!args[2] || await args[2]()) activities.push(args.slice(0, 2)); },
    runExclusive: fn => fn(),
    isBusy: () => false,
    now: () => clock,
  });
  return {
    cleanup, saved, alarms, alarmCalls, deleted, searchCalls, visits, activities,
    setItems(value) { searchItems = value; },
    setProtectedSites(value) { protectedSites = value; },
    setNow(value) { clock = value; },
    async state() { return (await cleanup.handle({ type: 'auto-get' }, 'owner')); },
  };
}

async function saveRule(h, { domain = 'example.com', includeSubdomains = false, days = 7, schedule, enabled = true } = {}) {
  const configured = { ...rule(domain, includeSubdomains, days), ...(schedule ? { schedule } : {}) };
  const preview = await h.cleanup.handle({ type: 'auto-preview', rule: configured }, 'owner');
  const state = await h.state();
  const result = await h.cleanup.handle({
    type: 'auto-save', revision: state.config.revision, rule: configured,
    enabled, ...(enabled ? { previewId: preview.previewId } : {}),
  }, 'owner');
  return { preview, state: result };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail('auto-cleanup task did not settle');
}

test('initial state and disabled rules never delete history or schedule cleanup', async () => {
  const h = harness({ items: [old(now - 8 * DAY_MS)] });
  await h.cleanup.initialize();
  assert.equal(h.deleted.length, 0);
  assert.equal(h.searchCalls.length, 0);
  assert.equal(h.alarms.has(AUTO_CLEANUP_ALARM), false);
  await saveRule(h, { enabled: false });
  assert.equal(h.deleted.length, 0);
  assert.equal(h.alarms.has(AUTO_CLEANUP_ALARM), false);
  assert.equal((await h.state()).config.rules[0].enabled, false);
});

test('enabling a disabled rule requires a preview and schedules its first check 24 hours later', async () => {
  const h = harness({ items: [old(now - 8 * DAY_MS)] });
  const created = await saveRule(h, { enabled: false });
  assert.equal(created.state.config.nextRunAt, null);
  const state = await h.state();
  const withoutPreview = await h.cleanup.handle({
    type: 'auto-toggle', id: state.config.rules[0].id, enabled: true, revision: state.config.revision,
  }, 'owner').then(() => null, error => error.message);
  assert.equal(withoutPreview, 'AUTO_PREVIEW_REQUIRED');
  const preview = await h.cleanup.handle({
    type: 'auto-preview', id: state.config.rules[0].id, rule: rule(), revision: state.config.revision,
  }, 'owner');
  const enabled = await h.cleanup.handle({
    type: 'auto-toggle', id: state.config.rules[0].id, enabled: true,
    revision: state.config.revision, previewId: preview.previewId,
  }, 'owner');
  assert.equal(enabled.config.rules[0].enabled, true);
  assert.equal(enabled.config.nextRunAt, now + DAY_MS);
  assert.equal(h.alarms.get(AUTO_CLEANUP_ALARM).when, now + DAY_MS);
  assert.equal(h.deleted.length, 0, 'enabling alone does not delete');
});

test('stale previews, changed protection, fully protected rules and overlapping scopes are rejected', async () => {
  const h = harness({ items: [old(now - 8 * DAY_MS)], protectedSites: ['example.com'] });
  const protectedPreview = await h.cleanup.handle({ type: 'auto-preview', rule: rule(), owner: 'ignored' }, 'owner');
  assert.equal(protectedPreview.fullyProtected, true);
  const fullyProtected = await h.cleanup.handle({
    type: 'auto-save', revision: 0, rule: rule(), enabled: true, previewId: protectedPreview.previewId,
  }, 'owner').then(() => null, error => error.message);
  assert.equal(fullyProtected, 'AUTO_FULLY_PROTECTED');

  const h2 = harness();
  await saveRule(h2, { includeSubdomains: true, enabled: false });
  const state = await h2.state();
  const overlapping = await h2.cleanup.handle({
    type: 'auto-preview', rule: rule('shop.example.com', true), revision: state.config.revision,
  }, 'owner').then(() => null, error => error.message);
  assert.equal(overlapping, 'AUTO_CONFLICT');
  const pending = await h2.cleanup.handle({ type: 'auto-preview', rule: rule('another.com'), revision: state.config.revision }, 'owner');
  await h2.cleanup.handle({ type: 'auto-pause', paused: true, revision: state.config.revision }, 'owner');
  const stale = await h2.cleanup.handle({
    type: 'auto-save', rule: rule('another.com'), enabled: true, previewId: pending.previewId, revision: 1,
  }, 'owner').then(() => null, error => error.message);
  assert.equal(stale, 'AUTO_STALE');

  const protectionChange = harness();
  const proof = await protectionChange.cleanup.handle({ type: 'auto-preview', rule: rule() }, 'owner');
  protectionChange.setProtectedSites(['example.com']);
  const changedProtection = await protectionChange.cleanup.handle({
    type: 'auto-save', revision: 0, rule: rule(), enabled: true, previewId: proof.previewId,
  }, 'owner').then(() => null, error => error.message);
  assert.equal(changedProtection, 'AUTO_STALE');
});

test('due alarms catch up once and expiration preserves protected, recent, future and unknown visits', async () => {
  const keep = 'https://protected.example.com/page';
  const recent = 'https://example.com/recent';
  const future = 'https://example.com/future';
  const unknown = 'https://example.com/unknown';
  const target = 'https://example.com/old';
  const items = [
    { url: target, lastVisitTime: now - 8 * DAY_MS },
    { url: keep, lastVisitTime: now - 8 * DAY_MS },
    { url: recent, lastVisitTime: now - 3 * DAY_MS },
    { url: future, lastVisitTime: now + DAY_MS },
    { url: unknown },
  ];
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'rule1', ...rule('example.com', true), enabled: true }], nextRunAt: now - DAY_MS, revision: 1 } },
    protectedSites: ['protected.example.com'], items,
    visits: items.filter(item => item.lastVisitTime).map(item => [item.url, [{ visitTime: item.lastVisitTime }]]),
  });
  await h.cleanup.initialize();
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [target]);
  assert.equal(h.searchCalls.length, 1);
  assert.equal(h.saved.autoCleanup.nextRunAt, now + DAY_MS);
  assert.equal(h.activities.length, 1);
  assert.equal(h.activities[0][0], 1);
  await h.cleanup.checkDue();
  assert.equal(h.searchCalls.length, 1, 'future schedule does not rerun');
});

test('a visit refreshed after scanning is skipped at the final eligibility check', async () => {
  const url = 'https://example.com/revisited';
  let visitRead = 0;
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [{ url, lastVisitTime: now - 8 * DAY_MS }],
    getVisits: () => { visitRead++; return [{ visitTime: now - DAY_MS }]; },
  });
  await h.cleanup.checkDue();
  await waitFor(() => !h.cleanup.busy());
  assert.equal(visitRead, 1);
  assert.deepEqual(h.deleted, []);
  assert.deepEqual(h.activities, []);
});

test('history results at the API limit block all deletion', async () => {
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: () => Array.from({ length: 100000 }, (_, index) => ({ url: `https://example.com/${index}`, lastVisitTime: now - 8 * DAY_MS })),
  });
  await h.cleanup.checkDue();
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, []);
  assert.equal(h.saved.autoCleanupRuntime.error, 'AUTO_SCAN_INCOMPLETE');
  assert.deepEqual(h.activities, []);
});

test('pausing during a deletion stops submitting subsequent URLs', async () => {
  let beginDelete;
  let releaseDelete;
  const deleting = new Promise(resolve => { releaseDelete = resolve; });
  const first = 'https://example.com/first';
  const second = 'https://example.com/second';
  const items = [first, second].map(url => ({ url, lastVisitTime: now - 8 * DAY_MS }));
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items, visits: items.map(item => [item.url, [{ visitTime: item.lastVisitTime }]]),
    deleteUrl: async url => { if (url === first) { beginDelete?.(); await deleting; } },
  });
  const started = new Promise(resolve => { beginDelete = resolve; });
  await h.cleanup.checkDue();
  await started;
  await h.cleanup.handle({ type: 'auto-pause', paused: true, revision: 1 }, 'owner');
  releaseDelete();
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [first]);
  assert.equal(h.saved.autoCleanup.paused, true);
});

test('failed verification and no-op runs do not create activity entries', async () => {
  const url = 'https://example.com/unverifiable';
  let reads = 0;
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [{ url, lastVisitTime: now - 8 * DAY_MS }],
    getVisits: () => { if (++reads === 1) return [{ visitTime: now - 8 * DAY_MS }]; throw new Error('verification unavailable'); },
  });
  await h.cleanup.checkDue();
  await waitFor(() => !h.cleanup.busy());
  assert.equal(h.deleted.length, 1);
  assert.deepEqual(h.activities, []);
  assert.equal(h.saved.autoCleanupRuntime.result.phase, 'verifyFailed');
  assert.equal(h.saved.autoCleanupRuntime.result.removed, 0);

  const empty = harness({ saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } } });
  await empty.cleanup.checkDue();
  await waitFor(() => !empty.cleanup.busy());
  assert.deepEqual(empty.activities, []);
});

test('private cleanup omits activity and completed result, and runtime state never stores URLs', async () => {
  const url = 'https://example.com/private-path?secret=value';
  const h = harness({
    saved: { privateCleanup: true, autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [{ url, lastVisitTime: now - 8 * DAY_MS }], visits: [[url, [{ visitTime: now - 8 * DAY_MS }]]],
  });
  await h.cleanup.checkDue();
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.activities, []);
  assert.equal(h.saved.autoCleanupRuntime.result, undefined);
  assert.doesNotMatch(JSON.stringify(h.saved.autoCleanupRuntime), /https:|secret=value/);
});

test('startup recovery discards interrupted URL snapshots and rescans current history', async () => {
  const current = 'https://example.com/current-after-restart';
  const stale = 'https://example.com/stale-recovery-url';
  const h = harness({
    saved: {
      autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 },
      autoCleanupRuntime: { inProgress: true, urls: [stale] },
    },
    items: [{ url: current, lastVisitTime: now - 8 * DAY_MS }],
    visits: [[current, [{ visitTime: now - 8 * DAY_MS }]]],
  });
  await h.cleanup.initialize();
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [current]);
  assert.equal(h.searchCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(h.saved.autoCleanupRuntime), /https:|stale-recovery-url/);
  assert.equal(h.saved.autoCleanupRuntime.result.phase, 'done');
  assert.equal(h.saved.autoCleanupRuntime.result.incomplete, true);
});

test('preview returns the normalized scope and cannot authorize a different rule or a different owner', async () => {
  const h = harness();
  const preview = await h.cleanup.handle({ type: 'auto-preview', rule: rule('食狮.com.cn') }, 'owner');
  assert.equal(preview.rule.domain, 'xn--85x722f.com.cn');
  await assert.rejects(h.cleanup.handle({ type: 'auto-save', rule: rule('another.com'), enabled: true, revision: 0, previewId: preview.previewId }, 'owner'), { message: 'AUTO_STALE' });
  await assert.rejects(h.cleanup.handle({ type: 'auto-save', rule: rule('食狮.com.cn'), enabled: true, revision: 0, previewId: preview.previewId }, 'another-owner'), { message: 'AUTO_STALE' });
});

test('pausing an individual rule while the final visit check is pending prevents deletion', async () => {
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [old(now - 8 * DAY_MS)],
    getVisits: async () => { entered(); await gate; return [{ visitTime: now - 8 * DAY_MS }]; },
  });
  await h.cleanup.checkDue(); await started;
  await h.cleanup.handle({ type: 'auto-toggle', id: 'r', enabled: false, revision: 1 }, 'owner');
  release(); await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, []);
  assert.equal(h.saved.autoCleanup.nextRunAt, null);
});

test('a pause received during failed-delete retry stops the retry', async () => {
  let entered, release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [old(now - 8 * DAY_MS)],
    getVisits: async () => { if (++reads === 2) { entered(); await gate; } return [{ visitTime: now - 8 * DAY_MS }]; },
    deleteUrl: () => { throw new Error('synthetic failure'); },
  });
  await h.cleanup.checkDue(); await started;
  await h.cleanup.handle({ type: 'auto-pause', paused: true, revision: 1 }, 'owner');
  release(); await waitFor(() => !h.cleanup.busy());
  assert.equal(h.deleted.length, 1);
  assert.equal(h.saved.autoCleanupRuntime.result.phase, 'stopped');
});

test('switching private cleanup on and off during a run suppresses its completion history', async () => {
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const url = old().url;
  const h = harness({
    saved: { autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 } },
    items: [old(now - 8 * DAY_MS)], visits: [[url, [{ visitTime: now - 8 * DAY_MS }]]],
    deleteUrl: async () => { entered(); await gate; },
  });
  await h.cleanup.checkDue(); await started;
  h.saved.privateCleanup = true; await h.cleanup.privacyChanged(true);
  h.saved.privateCleanup = false; await h.cleanup.privacyChanged(false);
  release(); await waitFor(() => !h.cleanup.busy());
  assert.equal(h.deleted.length, 1);
  assert.deepEqual(h.activities, []);
  assert.equal(h.saved.autoCleanupRuntime.result, undefined);
});

test('a private interrupted run stays private during recovery even after the setting is disabled', async () => {
  const h = harness({ saved: {
    autoCleanup: { version: 1, paused: false, rules: [{ id: 'r', ...rule(), enabled: true }], nextRunAt: now, revision: 1 },
    autoCleanupRuntime: { inProgress: true, privateCleanup: true },
  } });
  await h.cleanup.initialize(); await waitFor(() => !h.cleanup.busy());
  assert.equal(h.saved.autoCleanupRuntime.result, undefined);
  assert.deepEqual(h.activities, []);
});

test('resuming preserves enabled rules and schedules 24 hours later without immediately deleting', async () => {
  const h = harness();
  await saveRule(h);
  await h.cleanup.handle({ type: 'auto-pause', paused: true, revision: 1 }, 'owner');
  assert.equal((await h.state()).config.rules[0].enabled, true);
  const resumed = await h.cleanup.handle({ type: 'auto-pause', paused: false, revision: 2 }, 'owner');
  assert.equal(resumed.config.nextRunAt, now + DAY_MS);
  assert.deepEqual(h.deleted, []);
});

test('enabling each supported schedule persists its own next local occurrence', async () => {
  const schedules = [
    { type: 'once', at: now + 123456 },
    { type: 'daily', time: '09:15' },
    { type: 'weekly', weekday: 0, time: '08:30' },
    { type: 'monthly', day: 31, time: '07:00' },
  ];
  for (const [index, schedule] of schedules.entries()) {
    const h = harness();
    const { state } = await saveRule(h, { domain: `task${index}.example.com`, schedule });
    const saved = state.config.rules[0];
    assert.deepEqual(saved.schedule, schedule);
    assert.equal(saved.nextRunAt, nextOccurrence(schedule, now));
    assert.equal(state.config.nextRunAt, saved.nextRunAt);
    assert.equal(h.alarms.get(AUTO_CLEANUP_ALARM).when, saved.nextRunAt);
  }
});

test('a due alarm runs only due tasks and leaves future tasks on their own schedules', async () => {
  const dueUrl = 'https://due.example.com/old';
  const futureUrl = 'https://future.example.com/old';
  const futureTime = now + DAY_MS;
  const h = harness({
    saved: { autoCleanup: { version: 2, paused: false, nextRunAt: now, revision: 4, rules: [
      { id: 'due', ...rule('due.example.com'), schedule: { type: 'once', at: now - 1 }, enabled: true, nextRunAt: now, completed: false },
      { id: 'future', ...rule('future.example.com'), schedule: { type: 'daily', time: '09:00' }, enabled: true, nextRunAt: futureTime, completed: false },
    ] } },
    items: [{ url: dueUrl, lastVisitTime: now - 8 * DAY_MS }, { url: futureUrl, lastVisitTime: now - 8 * DAY_MS }],
    visits: [[dueUrl, [{ visitTime: now - 8 * DAY_MS }]], [futureUrl, [{ visitTime: now - 8 * DAY_MS }]]],
  });
  await h.cleanup.checkDue(); await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [dueUrl]);
  const config = h.saved.autoCleanup;
  assert.equal(config.rules.find(task => task.id === 'due').completed, true);
  assert.equal(config.rules.find(task => task.id === 'due').enabled, false);
  assert.equal(config.rules.find(task => task.id === 'future').nextRunAt, futureTime);
  assert.equal(config.nextRunAt, futureTime);
});

test('a one-time task completes after its due attempt and never runs again', async () => {
  const url = 'https://example.com/once';
  const h = harness({ items: [{ url, lastVisitTime: now - 8 * DAY_MS }], visits: [[url, [{ visitTime: now - 8 * DAY_MS }]]] });
  await saveRule(h, { schedule: { type: 'once', at: now + 1000 } });
  h.setNow(now + 1000);
  await h.cleanup.checkDue(); await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [url]);
  let task = (await h.state()).config.rules[0];
  assert.equal(task.completed, true);
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);
  const searches = h.searchCalls.length;
  await h.cleanup.checkDue();
  assert.equal(h.searchCalls.length, searches);
});

test('manual cleanup keeps once and recurring schedules unchanged', async () => {
  const firstUrl = 'https://once.example.com/old';
  const secondUrl = 'https://daily.example.com/old';
  const onceAt = now + 1000;
  const daily = { type: 'daily', time: '09:00' };
  const h = harness({ items: [
    { url: firstUrl, lastVisitTime: now - 8 * DAY_MS }, { url: secondUrl, lastVisitTime: now - 8 * DAY_MS },
  ], visits: [[firstUrl, [{ visitTime: now - 8 * DAY_MS }]], [secondUrl, [{ visitTime: now - 8 * DAY_MS }]]] });
  await saveRule(h, { domain: 'once.example.com', schedule: { type: 'once', at: onceAt } });
  await saveRule(h, { domain: 'daily.example.com', schedule: daily });
  const before = (await h.state()).config.rules.map(task => task.nextRunAt);
  const preview = await h.cleanup.handle({ type: 'auto-preview', all: true }, 'owner');
  await h.cleanup.handle({ type: 'auto-run', previewId: preview.previewId, revision: 2 }, 'owner');
  await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [firstUrl, secondUrl]);
  const after = (await h.state()).config.rules;
  assert.deepEqual(after.map(task => task.nextRunAt), before);
  assert.ok(after.every(task => task.enabled && !task.completed));
});

test('no-retention tasks delete known past visits but keep unknown, future and protected pages', async () => {
  const recent = 'https://example.com/recent';
  const unknown = 'https://example.com/unknown';
  const future = 'https://example.com/future';
  const protectedUrl = 'https://protected.example.com/private';
  const h = harness({
    saved: { autoCleanup: { version: 2, paused: false, nextRunAt: now, revision: 1, rules: [
      { id: 'all', domain: 'example.com', includeSubdomains: true, days: null, schedule: { type: 'once', at: now - 1 }, enabled: true, nextRunAt: now, completed: false },
    ] } },
    protectedSites: ['protected.example.com'],
    items: [
      { url: recent, lastVisitTime: now - 60_000 }, { url: unknown },
      { url: future, lastVisitTime: now + 60_000 }, { url: protectedUrl, lastVisitTime: now - 60_000 },
    ],
    visits: [[recent, [{ visitTime: now - 60_000 }]], [future, [{ visitTime: now + 60_000 }]], [protectedUrl, [{ visitTime: now - 60_000 }]]],
  });
  await h.cleanup.checkDue(); await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [recent]);
});

test('schedule changes invalidate previews and malformed or past one-time schedules are rejected', async () => {
  const h = harness();
  const daily = { ...rule(), schedule: { type: 'daily', time: '09:00' } };
  const proof = await h.cleanup.handle({ type: 'auto-preview', rule: daily }, 'owner');
  await assert.rejects(h.cleanup.handle({
    type: 'auto-save', revision: 0, rule: { ...daily, schedule: { type: 'weekly', weekday: 1, time: '09:00' } },
    enabled: true, previewId: proof.previewId,
  }, 'owner'), { message: 'AUTO_STALE' });

  const invalid = await h.cleanup.handle({ type: 'auto-preview', rule: { ...rule(), schedule: { type: 'daily', time: '25:00' } } }, 'owner')
    .then(() => null, error => error.message);
  assert.equal(invalid, 'AUTO_INVALID_SCHEDULE');
  const pastSchedule = { ...rule(), schedule: { type: 'once', at: now - 1 } };
  const pastProof = await h.cleanup.handle({ type: 'auto-preview', rule: pastSchedule }, 'owner');
  await assert.rejects(h.cleanup.handle({ type: 'auto-save', revision: 0, rule: pastSchedule, enabled: true, previewId: pastProof.previewId }, 'owner'),
    { message: 'AUTO_SCHEDULE_PAST' });
});

test('version one settings migrate with their exact shared due time', async () => {
  const sharedTime = now + 4567;
  const h = harness({ saved: { autoCleanup: { version: 1, paused: false, nextRunAt: sharedTime, revision: 3, rules: [
    { id: 'old-a', ...rule('a.example.com'), enabled: true },
    { id: 'old-b', ...rule('b.example.com'), enabled: true },
    { id: 'disabled', ...rule('disabled.example.com'), enabled: false },
  ] } } });
  await h.cleanup.initialize();
  const config = h.saved.autoCleanup;
  assert.equal(config.version, 2);
  assert.equal(config.nextRunAt, sharedTime);
  assert.equal(config.rules.find(task => task.id === 'old-a').nextRunAt, sharedTime);
  assert.equal(config.rules.find(task => task.id === 'old-b').nextRunAt, sharedTime);
  assert.equal(config.rules.find(task => task.id === 'disabled').nextRunAt, null);

  const paused = harness({ saved: { autoCleanup: { version: 1, paused: true, nextRunAt: null, revision: 0,
    rules: [{ id: 'paused-old', ...rule(), enabled: true }] } } });
  await paused.cleanup.initialize();
  assert.equal(paused.saved.autoCleanup.rules[0].nextRunAt, now + DAY_MS);
});

test('disabled tasks stay idle, while resuming an overdue global schedule catches up once', async () => {
  const url = 'https://example.com/resume';
  const h = harness({ items: [{ url, lastVisitTime: now - 8 * DAY_MS }], visits: [[url, [{ visitTime: now - 8 * DAY_MS }]]] });
  await saveRule(h, { schedule: { type: 'once', at: now + 1000 } });
  let state = await h.state();
  await h.cleanup.handle({ type: 'auto-toggle', id: state.config.rules[0].id, enabled: false, revision: state.config.revision }, 'owner');
  h.setNow(now + DAY_MS);
  await h.cleanup.checkDue();
  assert.deepEqual(h.deleted, []);

  const overdue = harness({ saved: { autoCleanup: { version: 2, paused: true, nextRunAt: null, revision: 1, rules: [
    { id: 'overdue', ...rule(), schedule: { type: 'once', at: now - 1000 }, enabled: true, nextRunAt: now - 1000, completed: false },
  ] } }, items: [{ url, lastVisitTime: now - 8 * DAY_MS }], visits: [[url, [{ visitTime: now - 8 * DAY_MS }]]] });
  await overdue.cleanup.handle({ type: 'auto-pause', paused: false, revision: 1 }, 'owner');
  await overdue.cleanup.checkDue(); await waitFor(() => !overdue.cleanup.busy());
  assert.deepEqual(overdue.deleted, [url]);
  assert.equal(overdue.saved.autoCleanup.rules[0].completed, true);
});

test('interrupted one-time runs rescan current history and never replay stored URLs', async () => {
  const current = 'https://example.com/current-once';
  const stale = 'https://example.com/stale-once-url';
  const h = harness({ saved: {
    autoCleanup: { version: 2, paused: false, nextRunAt: now, revision: 1, rules: [
      { id: 'once', ...rule(), schedule: { type: 'once', at: now - 10 }, enabled: true, nextRunAt: now, completed: false },
    ] },
    autoCleanupRuntime: { inProgress: true, urls: [stale] },
  }, items: [{ url: current, lastVisitTime: now - 8 * DAY_MS }], visits: [[current, [{ visitTime: now - 8 * DAY_MS }]]] });
  await h.cleanup.initialize(); await waitFor(() => !h.cleanup.busy());
  assert.deepEqual(h.deleted, [current]);
  assert.doesNotMatch(JSON.stringify(h.saved.autoCleanupRuntime), /https:|stale-once-url/);
  assert.equal(h.saved.autoCleanup.rules[0].completed, true);
});
