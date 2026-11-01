import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRecommendations } from '../extension/cleanup-recommendations.mjs';

const now = new Date(2026, 9, 31, 12);
const items = ['https://reading.example/a', 'https://reading.example/b', 'https://sub.reading.example/a', 'https://other.example/a'].map(url => ({ url }));
const log = days => ({ version: 1, days });
const day = (...domains) => ({ websites: domains.map(domain => ({ domain })) });

test('same exact host on two distinct local dates recommends only matching current results, preserving order', () => {
  const input = log({ '2026-10-31': day('reading.example'), '2026-10-25': day('reading.example') });
  const results = cleanupRecommendations(items, { log: input, now });
  assert.deepEqual([...results.keys()], items.slice(0, 2).map(item => item.url));
  assert.deepEqual(results.get(items[0].url), [{ type: 'frequent', days: 2, lookback: 7 }]);
  assert.deepEqual(items.map(item => item.url), ['https://reading.example/a', 'https://reading.example/b', 'https://sub.reading.example/a', 'https://other.example/a']);
});

test('repeated entries or multiple operations on one date do not satisfy the two-day rule', () => {
  const input = log({ '2026-10-31': { ...day('reading.example', 'reading.example'), operations: 9 } });
  assert.equal(cleanupRecommendations(items, { log: input, now }).size, 0);
});

test('old, future and legacy totals without hostname summaries cannot create recommendations', () => {
  const input = log({ '2026-10-31': { operations: 4, pages: 50 }, '2026-10-24': day('reading.example'), '2026-11-01': day('reading.example') });
  assert.equal(cleanupRecommendations(items, { log: input, now }).size, 0);
});

test('only protocol records returned in the current history results are suggested', () => {
  const urls = ['chrome-extension://sample/options.html', 'notes-app://open/recent', 'mailto:hello@example.test', 'chrome://settings/', 'about:blank', 'data:text/plain,test', 'file:///tmp/test', 'ftp://example.test/a', 'not a url'];
  const results = cleanupRecommendations(urls.map(url => ({ url })), { now });
  assert.deepEqual([...results], [[urls[0], [{ type: 'extension' }]], [urls[1], [{ type: 'application' }]], [urls[2], [{ type: 'application' }]]]);
});

test('soft privacy removes cleanup-derived reasons while retaining independent protocol suggestions', () => {
  const input = log({ '2026-10-31': day('reading.example'), '2026-10-30': day('reading.example') });
  const protocol = { url: 'notes-app://open/recent' };
  const results = cleanupRecommendations([...items, protocol], { log: input, now, hideCleanup: true });
  assert.deepEqual([...results], [[protocol.url, [{ type: 'application' }]]]);
});

test('a residual reason requires an explicit verified URL still present in the current result set', () => {
  const results = cleanupRecommendations(items, { now, remaining: new Set([items[2].url, 'https://absent.example/']) });
  assert.deepEqual([...results], [[items[2].url, [{ type: 'remaining' }]]]);
  assert.equal(cleanupRecommendations(items, { now }).size, 0);
});

test('the seven-date window follows local midnight across the autumn daylight-saving change', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const input = log({ '2026-11-02': day('reading.example'), '2026-10-27': day('reading.example'), '2026-10-26': day('other.example') });
    const results = cleanupRecommendations(items, { log: input, now: new Date(2026, 10, 2, 0, 5) });
    assert.deepEqual(results.get(items[0].url), [{ type: 'frequent', days: 2, lookback: 7 }]);
    assert.equal(results.has(items[3].url), false);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
