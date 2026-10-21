import test from 'node:test';
import assert from 'node:assert/strict';
import { readFrequencyHistory } from '../extension/history-frequency.mjs';
import { MAX_HISTORY_RESULTS } from '../extension/history-utils.mjs';
import { resolveTimeRange } from '../extension/history-filters.mjs';

const page = (name, lastVisitTime, visitCount = 999) => ({ url: `https://${name}.example/page`, lastVisitTime, visitCount });
function fixture(pages, visits) {
  return {
    search: async options => pages.filter(item => visits[item.url].some(time => time >= options.startTime && (options.endTime === undefined || time <= options.endTime))).slice(0, options.maxResults),
    getVisits: async ({ url }) => visits[url].map((visitTime, index) => ({ visitTime, visitId: String(index) })),
  };
}

test('counts visits with inclusive start and exclusive end, including URLs revisited afterward', async () => {
  const a = page('revisited', 400), b = page('inside', 180), c = page('outside', 400);
  const result = await readFrequencyHistory(fixture([a, b, c], { [a.url]: [99, 100, 150, 199, 200, 400], [b.url]: [180], [c.url]: [400] }), { range: { startTime: 100, endTime: 200 } });
  assert.deepEqual(result.map(item => [item.url, item.periodVisitCount, item.periodLastVisitTime]), [[a.url, 3, 199], [b.url, 1, 180]]);
  assert.equal(result[0].visitCount, 999, 'cumulative count remains a distinct field');
});

test('ties use the last visit inside the period, then URL for deterministic order', async () => {
  const a = page('a', 500), b = page('b', 400), c = page('c', 300);
  const result = await readFrequencyHistory(fixture([a, c, b], { [a.url]: [110, 500], [b.url]: [190, 400], [c.url]: [190, 300] }), { range: { startTime: 100, endTime: 200 } });
  assert.deepEqual(result.map(item => item.url), [b.url, c.url, a.url]);
});

test('fractional-millisecond visits just before the end are not lost by the candidate query', async () => {
  const a = page('fractional', 199.75);
  const result = await readFrequencyHistory(fixture([a], { [a.url]: [199.75] }), { range: { startTime: 100, endTime: 200 } });
  assert.equal(result[0].periodVisitCount, 1);
});

test('zero visits and empty results stay empty; no cumulative-count substitution', async () => {
  const a = page('a', 100);
  assert.deepEqual(await readFrequencyHistory(fixture([a], { [a.url]: [] })), []);
  assert.deepEqual(await readFrequencyHistory(fixture([], {})), []);
});

test('duplicate visit IDs count once; unknown times fail the entire scan', async () => {
  const a = page('a', 100);
  const history = fixture([a], { [a.url]: [100] });
  history.getVisits = async () => [{ visitId: '1', visitTime: 100 }, { visitId: '1', visitTime: 100 }];
  assert.equal((await readFrequencyHistory(history))[0].periodVisitCount, 1);
  history.getVisits = async () => [{ visitId: '1' }];
  await assert.rejects(readFrequencyHistory(history), /FREQUENCY_VISITS_UNAVAILABLE/);
});

test('candidate cap and API failures never produce a partial ranking', async () => {
  await assert.rejects(readFrequencyHistory({ search: async () => { throw Error('search failed'); }, getVisits: async () => [] }), /search failed/);
  await assert.rejects(readFrequencyHistory({ search: async () => Array(MAX_HISTORY_RESULTS).fill(page('a', 100)), getVisits: async () => [] }), /FREQUENCY_LIMIT/);
  await assert.rejects(readFrequencyHistory({ search: async () => [page('a', 100)], getVisits: async () => { throw Error('read failed'); } }), /read failed/);
});

test('bounds parallel reads and filters candidates before expensive visit reads', async () => {
  const pages = Array.from({ length: 1000 }, (_, index) => page(`p${index}`, 100));
  let active = 0, peak = 0, reads = 0;
  const history = { search: async () => pages, getVisits: async () => {
    active++; reads++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return [{ visitTime: 100 }];
  } };
  const result = await readFrequencyHistory(history, { include: item => item.url !== pages[0].url });
  assert.equal(reads, 999); assert.equal(result.length, 999); assert.equal(peak, 8); assert.equal(active, 0);
});

test('failure drains in-flight reads and stops scheduling remaining candidates', async () => {
  let reads = 0, active = 0;
  const history = { search: async () => Array.from({ length: 50 }, (_, i) => page(`p${i}`, 100)), getVisits: async () => {
    const index = reads++; active++;
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (index === 0) throw Error('read failed');
    return [{ visitTime: 100 }];
  } };
  await assert.rejects(readFrequencyHistory(history), /read failed/);
  assert.equal(active, 0); assert.equal(reads, 8);
});

test('week covers today plus six local dates and counts both midnight edges correctly', async () => {
  const range = resolveTimeRange({ range: '7days', startDate: '', endDate: '' }, new Date(2026, 9, 22, 12));
  assert.equal(new Date(range.startTime).getDate(), 16);
  assert.equal(new Date(range.endTime).getDate(), 23);
  const a = page('edges', range.endTime + 100);
  const result = await readFrequencyHistory(fixture([a], { [a.url]: [range.startTime - 1, range.startTime, range.endTime - 1, range.endTime] }), { range });
  assert.equal(result[0].periodVisitCount, 2);
});
