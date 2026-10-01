import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHistoryItems } from '../extension/history-groups.mjs';

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
