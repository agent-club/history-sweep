import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHistoryItems, groupHistoryByDate } from '../extension/history-groups.mjs';

test('groups exact hosts while preserving input recency order and original records', () => {
  const items = [
    { url: 'https://x.com/recent' },
    { url: 'https://github.com/x' },
    { url: 'http://X.COM/older' },
    { url: 'https://www.x.com/other' },
    { url: 'https://x.com.evil.test/x' },
  ];
  const groups = groupHistoryItems(items);
  assert.deepEqual(groups.map(group => group.label), ['x.com', 'github.com', 'www.x.com', 'x.com.evil.test']);
  assert.deepEqual(groups[0].items, [items[0], items[2]]);
  assert.equal(groups[0].items[0], items[0]);
});

test('normalizes terminal hostname dots and keeps hostless and invalid URLs selectable', () => {
  const groups = groupHistoryItems([
    { url: 'https://example.test./a' }, { url: 'https://example.test/b' },
    { url: 'file:///tmp/a' }, { url: 'file:///tmp/b' },
    { url: 'not a URL' }, { url: 'another invalid URL' }, {},
  ]);
  assert.deepEqual(groups.map(group => [group.label, group.items.length]), [
    ['example.test', 2], ['file:', 2], ['not a URL', 1], ['another invalid URL', 1],
  ]);
  assert.equal(new Set(groups.map(group => group.key)).size, groups.length);
});

test('groups history by newest local day, then exact host, preserving records and order', () => {
  const older = { url: 'https://same.example/older', lastVisitTime: new Date(2026, 9, 1, 23, 59).getTime() };
  const newest = { url: 'https://same.example/newest', lastVisitTime: new Date(2026, 9, 3, 0, 1).getTime() };
  const middle = { url: 'https://other.example/middle', lastVisitTime: new Date(2026, 9, 2, 12).getTime() };
  const newestAgain = { url: 'https://same.example/newest-again', lastVisitTime: new Date(2026, 9, 3, 8).getTime() };

  const days = groupHistoryByDate([older, newest, middle, newestAgain]);
  assert.deepEqual(days.map(day => day.key), ['2026-10-03', '2026-10-02', '2026-10-01']);
  assert.deepEqual(days.map(day => day.items), [[newest, newestAgain], [middle], [older]]);
  assert.deepEqual(days.map(day => [day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), day.date.getHours()]), [
    [2026, 9, 3, 0], [2026, 9, 2, 0], [2026, 9, 1, 0],
  ]);
  assert.deepEqual(days[0].groups.map(group => group.label), ['same.example']);
  assert.equal(days[0].groups[0].items[0], newest);
  assert.equal(days[0].groups[0].items[1], newestAgain);
});

test('keeps missing and non-finite visit timestamps together in the final unknown day', () => {
  const known = { url: 'https://known.example', lastVisitTime: new Date(2026, 9, 1).getTime() };
  const missing = { url: 'https://unknown.example/missing' };
  const notFinite = { url: 'https://unknown.example/nonfinite', lastVisitTime: NaN };
  const days = groupHistoryByDate([missing, known, notFinite]);

  assert.deepEqual(days.map(day => day.key), ['2026-10-01', 'unknown']);
  assert.equal(days[1].date, null);
  assert.deepEqual(days[1].items, [missing, notFinite]);
  assert.deepEqual(days[1].groups.map(group => group.label), ['unknown.example']);
  assert.equal(days[1].groups[0].items[0], missing);
  assert.equal(days[1].groups[0].items[1], notFinite);
});
