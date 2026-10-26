import test from 'node:test';
import assert from 'node:assert/strict';
import { createNameplateStore, NAMEPLATE_VARIANTS } from '../extension/nameplate-store.mjs';

function fixture(initial = {}) {
  const saved = structuredClone(initial);
  let writes = 0;
  return { saved, get writes() { return writes; }, storage: {
    async get() { return structuredClone(saved); },
    async set(data) { writes++; Object.assign(saved, structuredClone(data)); },
  } };
}
const options = index => ({ random: () => new Uint32Array([index, 0xabcdef]), now: () => new Date(2026, 9, 25, 23, 59) });

test('all four outcomes issue their finish, local join date and decorative number', async () => {
  for (const [index, variant] of NAMEPLATE_VARIANTS.entries()) {
    const f = fixture();
    const card = await createNameplateStore(f.storage, options(index)).issue();
    assert.deepEqual(card, { version: 1, variant, number: '00ABCDEF', issuedOn: '2026-10-25' });
    assert.deepEqual(f.saved.nameplate, card);
  }
});

test('concurrent opens and a restarted worker retain the first assignment', async () => {
  const f = fixture(); let randomCalls = 0;
  const store = createNameplateStore(f.storage, { ...options(2), random() { randomCalls++; return new Uint32Array([2, 0x1234]); } });
  const cards = await Promise.all(Array.from({ length: 20 }, () => store.issue()));
  assert.ok(cards.every(card => JSON.stringify(card) === JSON.stringify(cards[0])));
  assert.equal(f.writes, 1); assert.equal(randomCalls, 1);
  assert.deepEqual(await createNameplateStore(f.storage, options(3)).issue(), cards[0]); assert.equal(f.writes, 1);
});

test('read failures and invalid existing records never replace a user’s assignment', async () => {
  const original = { version: 9, variant: 'unknown', number: '01234567', issuedOn: '2026-10-25' };
  const f = fixture({ nameplate: original });
  await assert.rejects(createNameplateStore(f.storage, options(0)).issue());
  assert.deepEqual(f.saved.nameplate, original); assert.equal(f.writes, 0);
  let failed = true;
  const storage = { get: async () => { if (failed) throw new Error('read failed'); return {}; }, set: f.storage.set };
  const store = createNameplateStore(storage, options(1));
  await assert.rejects(store.issue(), /read failed/); assert.equal(f.writes, 0);
  failed = false; assert.equal((await store.issue()).variant, 'ivory');
});

test('issuance is successful only after storage succeeds', async () => {
  const f = fixture(); let failed = true;
  const store = createNameplateStore({ get: f.storage.get, async set(data) { if (failed) throw new Error('write failed'); await f.storage.set(data); } }, options(0));
  await assert.rejects(store.issue(), /write failed/); assert.equal(f.saved.nameplate, undefined);
  failed = false; assert.equal((await store.issue()).variant, 'obsidian'); assert.equal(f.writes, 1);
});

test('only a prepared installation reveals once, including concurrent surfaces and worker restarts', async () => {
  const f = fixture();
  let store = createNameplateStore(f.storage, options(2));
  assert.equal(await store.claimReveal(), null);
  assert.equal(f.writes, 0);
  const card = await store.prepareReveal();
  store = createNameplateStore(f.storage, options(1));
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimReveal()));
  assert.deepEqual(claims.filter(Boolean), [card]);
  assert.deepEqual(await store.issue(), card);
  assert.equal(await createNameplateStore(f.storage, options(0)).claimReveal(), null);
});

test('an existing card does not trigger onboarding and a failed claim remains pending', async () => {
  const f = fixture();
  const store = createNameplateStore(f.storage, options(3));
  const card = await store.issue();
  assert.equal(await store.claimReveal(), null);
  await store.prepareReveal();
  let failed = true;
  const restarted = createNameplateStore({ get: f.storage.get, async set(data) {
    if (failed) throw new Error('write failed');
    await f.storage.set(data);
  } }, options(0));
  await assert.rejects(restarted.claimReveal(), /write failed/);
  assert.equal(f.saved.nameplateRevealPending, true);
  failed = false;
  assert.deepEqual(await restarted.claimReveal(), card);
  assert.equal(f.saved.nameplateRevealPending, false);
});
