import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createAutoCleanup } from '../extension/auto-cleanup.mjs';
import { createAgentAccess } from '../extension/agent-access.mjs';
import { DAY_MS } from '../extension/auto-cleanup-model.mjs';
import { createMcpHandler } from '../agent/mcp.mjs';

const client = 'client-one';
const rule = { domain: 'example.test', includeSubdomains: false, days: 7 };
function fixture() {
  let clock = 2000000000000;
  let items = [{ url: 'https://example.test/old', title: 'Synthetic history title', lastVisitTime: clock - 8 * DAY_MS }];
  const deleted = [];
  let protectedSites = [];
  let searchFailure;
  const saved = {};
  const session = {};
  const storage = object => ({ get: async () => structuredClone(object), set: async fields => Object.assign(object, structuredClone(fields)) });
  const api = { storage: { local: storage(saved) }, alarms: { create: async () => {}, clear: async () => {} }, history: {
    search: async () => { if (searchFailure) throw searchFailure.reason; return items.filter(item => !deleted.includes(item.url)); },
    getVisits: async ({ url }) => deleted.includes(url) ? [] : [{ visitTime: items.find(item => item.url === url)?.lastVisitTime }],
    deleteUrl: async ({ url }) => { deleted.push(url); },
  } };
  const newEngine = () => createAutoCleanup(api, { now: () => clock, readProtectedSites: async () => protectedSites,
    recordActivity: async () => {}, runExclusive: fn => fn(), isBusy: () => false });
  let engine = newEngine();
  const createAccess = () => createAgentAccess({ engine, storage: storage(session), openApproval: async () => {}, now: () => clock });
  let access = createAccess();
  return { get access() { return access; }, get engine() { return engine; }, saved, session, deleted,
    setItems: value => { items = value; }, addItem: url => { items.push({ url, lastVisitTime: clock - 8 * DAY_MS }); },
    protect: sites => { protectedSites = sites; }, advance: value => { clock += value; },
    failSearch: reason => { searchFailure = { reason }; },
    restart: () => { engine = newEngine(); access = createAccess(); },
  };
}
async function save(f, enabled = false) {
  const preview = await f.access.request(client, 'preview', { rule });
  const args = { requestId: 'request-save', rule, enabled, revision: preview.revision, previewId: preview.previewId };
  const pending = await f.access.request(client, 'save', args);
  const done = await f.access.decide(pending.id, true);
  assert.equal(done.status, 'done');
  return (await f.access.request(client, 'list')).config.rules[0];
}
async function execute(f, id) {
  const preview = await f.access.request(client, 'preview', { id });
  const args = { requestId: 'request-execute', id, revision: preview.revision, previewId: preview.previewId };
  return { args, pending: await f.access.request(client, 'execute', args) };
}
async function settle(f, requestId = 'request-execute') {
  for (let i = 0; i < 100; i++) {
    const entry = await f.access.request(client, 'status', { requestId });
    if (!['pending', 'accepted', 'executing'].includes(entry.status)) return entry;
    await tick();
  }
  assert.fail('Execution did not settle');
}
test('agent list and aggregate preview never return raw history; native approval operations are rejected', async () => {
  const f = fixture();
  const preview = await f.access.request(client, 'preview', { rule });
  assert.equal(preview.matches, 1);
  assert.doesNotMatch(JSON.stringify(preview), /https:|Synthetic history title|lastVisitTime/);
  await assert.rejects(f.access.request(client, 'decide', { approved: true }), /AGENT_INVALID_REQUEST/);
  assert.equal(f.deleted.length, 0);
});
test('saving a task requires explicit browser approval and identical retries are idempotent', async () => {
  const f = fixture();
  const args = { requestId: 'request-create', rule, enabled: false, revision: 0 };
  const pending = await f.access.request(client, 'save', args);
  assert.equal((await f.access.request(client, 'list')).config.rules.length, 0);
  const duplicate = await f.access.request(client, 'save', args);
  assert.equal(duplicate.id, pending.id);
  await Promise.all([f.access.decide(pending.id, true), f.access.decide(pending.id, true)]);
  assert.equal((await f.access.request(client, 'list')).config.rules.length, 1);
  await assert.rejects(f.access.request(client, 'save', { ...args, enabled: true }), /AGENT_REQUEST_CONFLICT/);
});
test('rejecting or disconnecting does not mutate tasks or let a retry recreate approval', async () => {
  const f = fixture();
  const args = { requestId: 'request-create', rule, enabled: false, revision: 0 };
  const pending = await f.access.request(client, 'save', args);
  await f.access.decide(pending.id, false);
  assert.equal((await f.access.request(client, 'save', args)).status, 'rejected');
  const next = await f.access.request(client, 'save', { ...args, requestId: 'request-next' });
  await f.access.disconnect();
  assert.equal((await f.access.decide(next.id, true)).status, 'rejected');
  assert.equal((await f.access.request(client, 'list')).config.rules.length, 0);
});
test('preview authorization binds client, task scope, revision and expiry', async () => {
  const f = fixture();
  const preview = await f.access.request(client, 'preview', { rule });
  const args = { requestId: 'request-create', rule, enabled: true, revision: 0, previewId: preview.previewId };
  await assert.rejects(f.access.request('client-two', 'save', args), /AUTO_PREVIEW_REQUIRED/);
  const pending = await f.access.request(client, 'save', args);
  f.advance(5 * 60000 + 1);
  assert.equal((await f.access.decide(pending.id, true)).status, 'expired');
  assert.equal((await f.access.request(client, 'list')).config.rules.length, 0);
});
test('revision changes and protection changes invalidate a pending approval at the engine', async () => {
  const f = fixture();
  const preview = await f.access.request(client, 'preview', { rule });
  const pending = await f.access.request(client, 'save', { requestId: 'request-create', rule, enabled: true, revision: 0, previewId: preview.previewId });
  f.protect(['example.test']);
  const result = await f.access.decide(pending.id, true);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'AUTO_STALE');
  assert.equal(f.deleted.length, 0);
});
test('execute requires a saved-task preview; enabling does not execute', async () => {
  const f = fixture();
  const task = await save(f, true);
  assert.equal(f.deleted.length, 0);
  const draft = await f.access.request(client, 'preview', { id: task.id, rule });
  await assert.rejects(f.access.request(client, 'execute', { id: task.id, revision: draft.revision, previewId: draft.previewId, requestId: 'request-execute' }), /AUTO_STALE/);
});
test('exact execution detects changed matches before any deletion', async () => {
  const f = fixture();
  const task = await save(f, true);
  const { pending } = await execute(f, task.id);
  f.addItem('https://example.test/newly-matched');
  await f.access.decide(pending.id, true);
  const result = await settle(f);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'AUTO_STALE');
  assert.equal(f.saved.autoCleanupRuntime.error, 'AUTO_STALE');
  assert.equal(f.deleted.length, 0);
});
test('approved execution verifies completion, preserves privacy and never replays duplicate requests', async () => {
  const f = fixture(); f.saved.privateCleanup = true;
  const task = await save(f, true);
  const { args, pending } = await execute(f, task.id);
  const result = await f.access.decide(pending.id, true);
  assert.equal(result.status, 'accepted');
  assert.equal((await settle(f)).status, 'done');
  await f.access.request(client, 'execute', args);
  await f.access.decide(pending.id, true);
  assert.deepEqual(f.deleted, ['https://example.test/old']);
  assert.equal(f.saved.autoCleanupRuntime.result, undefined);
  assert.doesNotMatch(JSON.stringify(f.session), /https:|Synthetic history title|lastVisitTime/);
  await assert.rejects(f.access.request('client-two', 'status', { requestId: args.requestId }), /AGENT_NOT_FOUND/);
});
test('worker restart invalidates pending enabled-task previews instead of silently authorizing', async () => {
  const f = fixture();
  const preview = await f.access.request(client, 'preview', { rule });
  const pending = await f.access.request(client, 'save', { requestId: 'request-create', rule, enabled: true, revision: 0, previewId: preview.previewId });
  f.restart();
  const result = await f.access.decide(pending.id, true);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'AUTO_PREVIEW_REQUIRED');
  assert.equal(f.deleted.length, 0);
});
test('MCP handshake advertises all tools and rejects approval injection or missing profile', async () => {
  const handle = createMcpHandler();
  const request = (method, params) => handle({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal((await request('tools/list')).error.code, -32002);
  assert.equal((await request('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  assert.equal((await request('tools/list')).result.tools.length, 10);
  assert.equal((await request('tools/call', { name: 'history_sweep_execute', arguments: { approved: true } })).error.code, -32602);
});
test('worker interruption of a configuration mutation becomes interrupted without replay', async () => {
  const f = fixture();
  const pending = await f.access.request(client, 'save', { requestId: 'request-create', rule, enabled: false, revision: 0 });
  f.session.agentApprovals[0].status = 'executing';
  f.restart();
  const status = await f.access.request(client, 'status', { requestId: 'request-create' });
  assert.equal(status.status, 'interrupted');
  assert.equal((await f.access.decide(pending.id, true)).status, 'interrupted');
  assert.equal((await f.access.request(client, 'list')).config.rules.length, 0);
});
test('worker interruption of an immediate execution reports interrupted rather than replaying URLs', async () => {
  const f = fixture();
  const task = await save(f, true);
  const { pending } = await execute(f, task.id);
  const entry = f.session.agentApprovals.find(entry => entry.id === pending.id);
  entry.status = 'accepted'; entry.executionId = 'synthetic-execution';
  f.saved.autoCleanupRuntime = { inProgress: true, execution: { id: entry.executionId, phase: 'running' } };
  f.restart(); await f.engine.initialize();
  assert.equal((await settle(f)).status, 'interrupted');
  assert.equal(f.deleted.length, 0);
});
test('a non-Error browser rejection fails execution without replacing the failure with a catch error', async () => {
  const f = fixture();
  const task = await save(f, true);
  const { pending } = await execute(f, task.id);
  f.failSearch(null);
  await f.access.decide(pending.id, true);
  assert.equal((await settle(f)).status, 'failed');
  assert.equal(f.saved.autoCleanupRuntime.error, 'AUTO_UNAVAILABLE');
  assert.equal(f.deleted.length, 0);
});
