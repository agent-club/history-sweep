import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationDefaults, recommendationDomain, validateRecommendationSettings, readRecommendationSettings, saveRecommendationSettings, recommendationCueDue, RECOMMENDATION_KEY } from '../extension/recommendation-settings.mjs';
import { cleanupRecommendations } from '../extension/cleanup-recommendations.mjs';

const now = new Date(2026, 9, 31, 12);
const disabled = () => ({ ...recommendationDefaults(), habit: { enabled: false, lookbackDays: 7, minimumDays: 2 }, types: { extension: false, application: false } });
const rule = (domain, condition = 'always', days = null, includeSubdomains = false) => ({ domain, condition, days, includeSubdomains, enabled: true });
const item = (url, age) => ({ url, ...(age === undefined ? {} : { lastVisitTime: now.getTime() - age * 86400000 }) });

test('absent settings use independent 7/2 defaults; malformed saved settings fail without being overwritten', async () => {
  const a = await readRecommendationSettings({ get: async () => ({}) }); a.habit.minimumDays = 5;
  assert.equal((await readRecommendationSettings({ get: async () => ({}) })).habit.minimumDays, 2);
  await assert.rejects(readRecommendationSettings({ get: async () => ({ [RECOMMENDATION_KEY]: { version: 9 } }) }), /INVALID_RECOMMENDATION_SETTINGS/);
});

test('saving normalizes domain names, persists only settings, and preserves a failed draft', async () => {
  const value = { ...disabled(), sites: [rule('READING.EXAMPLE.')] };
  let written;
  const clean = await saveRecommendationSettings({ set: async update => { written = update; } }, value);
  assert.equal(clean.sites[0].domain, 'reading.example'); assert.deepEqual(Object.keys(written), [RECOMMENDATION_KEY]);
  assert.equal(value.sites[0].domain, 'READING.EXAMPLE.');
  await assert.rejects(saveRecommendationSettings({ set: async () => { throw new Error('disk'); } }, value), /disk/);
  assert.equal(value.sites[0].enabled, true);
});

test('domain validation accepts international names but rejects URLs, ports, wildcards and multiple domains', () => {
  assert.equal(recommendationDomain('例子.测试'), 'xn--fsqu00a.xn--0zwm56d');
  for (const value of ['', 'https://reading.example/a', 'reading.example:443', '*.reading.example', 'a.example b.example', 'a.example,b.example', 'a..example']) assert.throws(() => recommendationDomain(value));
});

test('settings reject impossible thresholds, ambiguous duplicate scopes and invalid flags', () => {
  for (const minimumDays of [0, 8, 1.5, '2']) assert.throws(() => validateRecommendationSettings({ ...recommendationDefaults(), habit: { enabled: true, lookbackDays: 7, minimumDays } }));
  assert.throws(() => validateRecommendationSettings({ ...disabled(), sites: [rule('READING.EXAMPLE'), rule('reading.example')] }));
  assert.throws(() => validateRecommendationSettings({ ...disabled(), types: { extension: 0, application: false } }));
  assert.throws(() => validateRecommendationSettings({ ...disabled(), cue: 'monthly' }));
});

test('website rules match exact hosts or real subdomains and never reorder or mutate current results', () => {
  const items = ['https://reading.example/a', 'https://sub.reading.example/a', 'https://notreading.example/a', 'https://reading.example.evil.test/a'].map(url => item(url, 30));
  const exact = { ...disabled(), sites: [rule('reading.example')] };
  assert.deepEqual([...cleanupRecommendations(items, { settings: exact, now }).keys()], [items[0].url]);
  const subdomains = { ...disabled(), sites: [rule('reading.example', 'always', null, true)] };
  assert.deepEqual([...cleanupRecommendations(items, { settings: subdomains, now }).keys()], items.slice(0, 2).map(x => x.url));
  assert.equal(items.length, 4);
});

test('inactivity uses the last visit of each URL, including the threshold, and does not infer missing or future visits', () => {
  const items = [item('https://reading.example/old', 14), item('https://reading.example/recent', 13.99), item('https://reading.example/unknown'), item('https://reading.example/future', -1)];
  const settings = { ...disabled(), sites: [rule('reading.example', 'inactive', 14)] };
  assert.deepEqual([...cleanupRecommendations(items, { settings, now }).keys()], [items[0].url]);
});

test('custom cleanup thresholds use distinct local dates and merge overlapping reasons', () => {
  const settings = { ...disabled(), habit: { enabled: true, lookbackDays: 14, minimumDays: 3 }, sites: [rule('reading.example'), rule('reading.example', 'inactive', 14, true)] };
  const log = { days: Object.fromEntries(['2026-10-31', '2026-10-25', '2026-10-18'].map(date => [date, { websites: [{ domain: 'reading.example' }, { domain: 'reading.example' }] }])) };
  const current = item('https://reading.example/old', 18);
  const result = cleanupRecommendations([current], { settings, log, now });
  assert.equal(result.size, 1); assert.deepEqual(result.get(current.url), [{ type: 'frequent', days: 3, lookback: 14 }, { type: 'site' }, { type: 'inactive', days: 14 }]);
  settings.habit.minimumDays = 4;
  assert.equal(cleanupRecommendations([current], { settings, log, now }).get(current.url).some(reason => reason.type === 'frequent'), false);
});

test('kept websites override manual rules, protocols and verified residuals, including their subdomains', () => {
  const items = [item('https://reading.example/a', 20), item('https://sub.reading.example/a', 20), item('notes-app://reading.example/a')];
  const settings = { ...recommendationDefaults(), sites: [rule('reading.example', 'always', null, true)] };
  assert.equal(cleanupRecommendations(items, { settings, now, protectedSites: ['reading.example'], remaining: new Set(items.map(x => x.url)) }).size, 0);
});

test('disabling recommendation types does not hide verified residuals; privacy only suppresses cleanup-derived reasons', () => {
  const extension = item('chrome-extension://sample/options'); const app = item('notes-app://open/a'); const website = item('https://reading.example/a', 20);
  assert.equal(cleanupRecommendations([extension, app], { settings: disabled(), now }).size, 0);
  assert.deepEqual(cleanupRecommendations([extension], { settings: disabled(), now, remaining: new Set([extension.url]) }).get(extension.url), [{ type: 'remaining' }]);
  const settings = { ...recommendationDefaults(), sites: [rule('reading.example')] };
  const log = { days: { '2026-10-31': { websites: [{ domain: 'reading.example' }] }, '2026-10-30': { websites: [{ domain: 'reading.example' }] } } };
  assert.deepEqual(cleanupRecommendations([website], { settings, log, now, hideCleanup: true }).get(website.url), [{ type: 'site' }]);
});

test('animation frequency keeps recommendations independent and uses a local day or seven elapsed days', () => {
  assert.equal(recommendationCueDue('never', undefined, now), false);
  assert.equal(recommendationCueDue('new', now.getTime(), now), true);
  assert.equal(recommendationCueDue('daily', new Date(2026, 9, 31, 0, 1).getTime(), now), false);
  assert.equal(recommendationCueDue('daily', new Date(2026, 9, 30, 23, 59).getTime(), now), true);
  assert.equal(recommendationCueDue('weekly', now.getTime() - 7 * 86400000 + 1, now), false);
  assert.equal(recommendationCueDue('weekly', now.getTime() - 7 * 86400000, now), true);
});
