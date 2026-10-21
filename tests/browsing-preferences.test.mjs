import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowsingPreferences, saveBrowsingPreferences } from '../extension/browsing-preferences.mjs';

test('first use opens websites for the past week; explicit defaults survive reopening', async () => {
  const values = {};
  const storage = { get: async () => structuredClone(values), set: async data => Object.assign(values, structuredClone(data)) };
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'website', range: '7days' });
  await saveBrowsingPreferences(storage, { view: 'date', range: '30days' });
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'date', range: '30days' });
  await saveBrowsingPreferences(storage, { view: 'frequency', range: 'all' });
  assert.deepEqual(await readBrowsingPreferences(storage), { view: 'frequency', range: 'all' });
});

test('custom fixed dates are not stored as a rolling default; failures are explicit', async () => {
  let writes = 0;
  await assert.rejects(saveBrowsingPreferences({ set: async () => writes++ }, { view: 'date', range: 'custom' }), /INVALID_BROWSING_PREFERENCES/);
  assert.equal(writes, 0);
  await assert.rejects(readBrowsingPreferences({ get: async () => ({ browsingPreferences: { view: 'unknown', range: '7days' } }) }), /INVALID_BROWSING_PREFERENCES/);
  await assert.rejects(readBrowsingPreferences({ get: async () => { throw Error('unavailable'); } }), /unavailable/);
  await assert.rejects(saveBrowsingPreferences({ set: async () => { throw Error('save failed'); } }, { view: 'date', range: 'today' }), /save failed/);
});
