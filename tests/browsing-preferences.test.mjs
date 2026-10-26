import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowsingPreferences, saveBrowsingPreferences } from '../extension/browsing-preferences.mjs';

test('first use opens websites for the past week; explicit defaults survive reopening', async () => {
  const values = {};
  const storage = { get: async () => structuredClone(values), set: async data => Object.assign(values, structuredClone(data)) };
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'website', range: '7days', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] });
  await saveBrowsingPreferences(storage, { view: 'date', range: '30days' });
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'date', range: '30days', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] });
  await saveBrowsingPreferences(storage, { view: 'frequency', range: 'all' });
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'frequency', range: 'all', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] });
});

test('custom fixed dates are not stored as a rolling default; failures are explicit', async () => {
  let writes = 0;
  await assert.rejects(saveBrowsingPreferences({ set: async () => writes++ }, { view: 'date', range: 'custom' }), /INVALID_BROWSING_PREFERENCES/);
  assert.equal(writes, 0);
  await assert.rejects(readBrowsingPreferences({ get: async () => ({ browsingPreferences: { view: 'unknown', range: '7days' } }) }), /INVALID_BROWSING_PREFERENCES/);
  await assert.rejects(readBrowsingPreferences({ get: async () => { throw Error('unavailable'); } }), /unavailable/);
  await assert.rejects(saveBrowsingPreferences({ set: async () => { throw Error('save failed'); } }, { view: 'date', range: 'today' }), /save failed/);
});


test('legacy preferences retain all views; custom order and visibility survive reopening', async () => {
  let saved = { browsingPreferences: { view: 'date', range: 'today' } };
  const storage = { get: async () => structuredClone(saved), set: async data => { saved = structuredClone(data); } };
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'date', range: 'today', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] });
  const preference = { view: 'frequency', range: '7days', viewOrder: ['frequency', 'date', 'website'], hiddenViews: ['website', 'date'] };
  await saveBrowsingPreferences(storage, preference);
  assert.deepEqual(await readBrowsingPreferences(storage), preference);
});

test('invalid tab orders and hidden defaults are rejected without writing', async () => {
  const base = { view: 'date', range: '7days', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] };
  let writes = 0;
  const storage = { set: async () => { writes++; } };
  for (const changes of [
    { viewOrder: ['date', 'website'] }, { viewOrder: ['date', 'date', 'frequency'] },
    { viewOrder: ['date', 'website', 'unknown'] }, { viewOrder: null },
    { hiddenViews: ['date'] }, { hiddenViews: ['date', 'website', 'frequency'] },
    { hiddenViews: ['unknown'] }, { hiddenViews: ['website', 'website'] }, { hiddenViews: null },
  ]) await assert.rejects(saveBrowsingPreferences(storage, { ...base, ...changes }), /INVALID_BROWSING_PREFERENCES/);
  assert.equal(writes, 0);
});
