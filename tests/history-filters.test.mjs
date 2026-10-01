import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTimeFilter, resolveTimeRange, filterByTime, parseProtectedSites, isProtectedUrl } from '../extension/history-filters.mjs';

test('date ranges include complete local calendar days and exclude the next midnight', () => {
  const now = new Date(2026, 9, 1, 16);
  assert.equal(resolveTimeRange(defaultTimeFilter(), now), null);
  for (const [range, first] of [['today', new Date(2026, 9, 1)], ['7days', new Date(2026, 8, 25)], ['30days', new Date(2026, 8, 2)]]) {
    const window = resolveTimeRange({ ...defaultTimeFilter(), range }, now);
    assert.equal(window.startTime, first.getTime());
    assert.equal(window.endTime, new Date(2026, 9, 2).getTime());
    assert.deepEqual(filterByTime([
      { id: 'before', lastVisitTime: window.startTime - 1 }, { id: 'first', lastVisitTime: window.startTime },
      { id: 'last', lastVisitTime: window.endTime - 1 }, { id: 'next', lastVisitTime: window.endTime }, { id: 'unknown' },
    ], window).map(item => item.id), ['first', 'last']);
  }
  const sameDay = resolveTimeRange({ range: 'custom', startDate: '2026-10-01', endDate: '2026-10-01' });
  assert.equal(sameDay.endTime, new Date(2026, 9, 2).getTime());
});

test('invalid dates and reversed ranges are rejected instead of broadening the search', () => {
  for (const [startDate, endDate] of [['', ''], ['2026-02-30', '2026-03-01'], ['2026-10-02', '2026-10-01'], ['2026-10-01', 'invalid']]) {
    assert.throws(() => resolveTimeRange({ range: 'custom', startDate, endDate }), /INVALID_TIME_RANGE/);
  }
  assert.throws(() => resolveTimeRange({ range: 'unknown', startDate: '', endDate: '' }));
  assert.deepEqual(filterByTime([{ lastVisitTime: 0 }, {}], { startTime: 0, endTime: 1 }), [{ lastVisitTime: 0 }]);
});

test('kept sites match exact hostname boundaries, subdomains and internationalized domains', () => {
  const sites = parseProtectedSites('Example.ORG, docs.example.net\nexample.org；例子.测试');
  assert.equal(sites.length, 3);
  for (const url of ['https://example.org/a', 'https://news.example.org/a', 'http://example.org:8080/a', 'https://例子.测试/a', 'https://docs.example.net/a']) assert.ok(isProtectedUrl(url, sites), url);
  for (const url of ['https://notexample.org', 'https://example.org.evil.test', 'https://example.net', 'invalid']) assert.equal(isProtectedUrl(url, sites), false, url);
  assert.deepEqual(parseProtectedSites(''), []);
  for (const input of ['*.example.org', 'example.org/path', 'example.org:8080', 'example..org', '-example.org', 'https://example.org']) assert.throws(() => parseProtectedSites(input), /INVALID_PROTECTED_SITES/);
});
