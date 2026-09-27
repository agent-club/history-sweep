import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');
const sender = { id: 'fixture', frameId: 0, documentId: 'popup-document', url: 'chrome-extension://fixture/popup.html' };
function worker(history) {
  let listener;
  const opened = [];
  const timers = [];
  const chrome = {
    history, tabs: { create: async ({ url }) => { opened.push(url); } },
    runtime: { id: 'fixture', getURL: path => 'chrome-extension://fixture/' + path, onMessage: { addListener: value => { listener = value; } } },
  };
  runInNewContext(source, { chrome, URL, crypto: { randomUUID }, setTimeout: callback => { timers.push(callback); }, Date });
  return {
    opened, timers,
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
