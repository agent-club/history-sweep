import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, isExpired, normalizeRule, ruleMatches, rulesOverlap } from '../extension/auto-cleanup-model.mjs';

test('normalizes hostnames and internationalized domains', () => {
  assert.deepEqual(normalizeRule({ domain: ' EXAMPLE.COM. ', includeSubdomains: true, days: 7 }), {
    domain: 'example.com', includeSubdomains: true, days: 7,
  });
  assert.equal(normalizeRule({ domain: '食狮.com.cn', includeSubdomains: false, days: 1 }).domain, 'xn--85x722f.com.cn');
});

test('rejects incomplete domains, public suffixes, IPs and non-host input', () => {
  for (const domain of ['com', 'co.uk', 'example', 'example.com/path', 'example.com:443', '*.example.com',
    'example..com', '-bad.example', 'example-.com', '127.0.0.1']) {
    assert.throws(() => normalizeRule({ domain, includeSubdomains: false, days: 7 }), { message: 'AUTO_INVALID_RULE' });
  }
  assert.throws(() => normalizeRule({ domain: 'example.com', days: 7 }), { message: 'AUTO_INVALID_RULE' });
  assert.throws(() => normalizeRule({ domain: 'example.com', includeSubdomains: false, days: 0 }), { message: 'AUTO_INVALID_RULE' });
});

test('matches exact hosts or dot-boundary subdomains, never URL text', () => {
  const exact = { domain: 'example.com', includeSubdomains: false, days: 7 };
  const inclusive = { ...exact, includeSubdomains: true };
  assert.equal(ruleMatches(exact, 'https://example.com/path?next=shop.example.com'), true);
  assert.equal(ruleMatches(exact, 'https://shop.example.com/'), false);
  assert.equal(ruleMatches(inclusive, 'https://shop.example.com/'), true);
  assert.equal(ruleMatches(inclusive, 'https://notexample.com/'), false);
  assert.equal(ruleMatches(inclusive, 'file://example.com/file'), false);
  assert.equal(ruleMatches(inclusive, 'not a url mentioning example.com'), false);
});

test('detects overlapping scopes while allowing disjoint exact parent and child rules', () => {
  const exact = (domain, includeSubdomains = false) => ({ domain, includeSubdomains, days: 7 });
  assert.equal(rulesOverlap(exact('example.com'), exact('example.com')), true);
  assert.equal(rulesOverlap(exact('example.com'), exact('shop.example.com')), false);
  assert.equal(rulesOverlap(exact('example.com'), exact('shop.example.com', true)), false);
  assert.equal(rulesOverlap(exact('example.com', true), exact('shop.example.com')), true);
  assert.equal(rulesOverlap(exact('example.com', true), exact('another.test')), false);
});

test('expires at the retention boundary and ignores missing, future, or invalid values', () => {
  const now = DAY_MS * 20000;
  assert.equal(isExpired(now - 7 * DAY_MS, 7, now), true);
  assert.equal(isExpired(now - 7 * DAY_MS + 1, 7, now), false);
  assert.equal(isExpired(now + 1, 7, now), false);
  assert.equal(isExpired(undefined, 7, now), false);
  assert.equal(isExpired(0, 7, now), false);
  assert.equal(isExpired(now - DAY_MS, 0, now), false);
  assert.equal(DAY_MS, 86400000);
});

test('normalizes an explicit no-retention condition and preserves schedule settings', () => {
  const schedule = { type: 'weekly', weekday: 1, time: '08:30' };
  assert.deepEqual(normalizeRule({ domain: 'example.com', includeSubdomains: false, days: null, schedule }), {
    domain: 'example.com', includeSubdomains: false, days: null, schedule,
  });
  assert.equal(isExpired(100, null, 100), true);
  assert.equal(isExpired(undefined, null, 100), false);
  assert.equal(isExpired(101, null, 100), false);
});

test('rejects malformed schedules when normalizing a cleanup task', () => {
  assert.throws(() => normalizeRule({ domain: 'example.com', includeSubdomains: false, days: 7, schedule: { type: 'daily', time: '25:00' } }),
    { message: 'AUTO_INVALID_SCHEDULE' });
  assert.throws(() => normalizeRule({ domain: 'example.com', includeSubdomains: false, days: undefined }),
    { message: 'AUTO_INVALID_RULE' });
});
