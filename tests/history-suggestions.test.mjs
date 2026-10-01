import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuggestionIndex } from '../extension/history-suggestions.mjs';
import { filterHistoryItems } from '../extension/history-utils.mjs';
import { normalizeSearchText, highlightRanges, searchWords } from '../extension/search-text.mjs';

test('simplified and traditional input match both scripts without changing source fields', () => {
  const items = [{ title: '繁體網頁與歷史記錄', url: 'https://example.com/1' }, { title: '网页与历史记录', url: 'https://example.com/2' }];
  for (const mode of ['contains', 'smart']) {
    assert.equal(filterHistoryItems(items, '历史记录', mode).length, 2);
    assert.equal(filterHistoryItems(items, '歷史記錄', mode).length, 2);
  }
  assert.equal(items[0].title, '繁體網頁與歷史記錄');
  assert.equal(normalizeSearchText('ＨＩＳＴＯＲＹ'), 'history');
});

test('highlight ranges keep original offsets, phrases and HTML-like text', () => {
  assert.deepEqual(highlightRanges('繁體網頁與历史网页', '网页'), [[2, 4], [7, 9]]);
  assert.deepEqual(highlightRanges('乾坤与乾杯', '乾坤'), [[0, 2]]);
  assert.deepEqual(highlightRanges('😀 Ｈistory <img>', 'history'), [[3, 10]]);
  assert.deepEqual(highlightRanges('Café 網頁', 'é'), [[3, 5]]);
  assert.deepEqual(highlightRanges('banana', 'ana nana'), [[1, 6]]);
  assert.deepEqual(highlightRanges('Hello', ''), []);
  assert.ok(searchWords(normalizeSearchText('歷史記錄搜尋')).includes('历史'));
});

test('rank exact words before prefixes/substrings, then recency and frequency; deduplicate top 10', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ title: `Read history ${i}`, url: `https://example.com/${i}`, lastVisitTime: i, visitCount: 1 }));
  items.push({ title: 'history', url: 'https://example.com/exact', lastVisitTime: 0 });
  items.push({ title: 'Read history 29', url: 'https://example.com/duplicate', lastVisitTime: 40 });
  items.push({ title: 'Prehistory archive', url: 'https://example.com/substring', lastVisitTime: 10000 });
  const index = await createSuggestionIndex(items);
  const { suggestions } = index.suggest('history', 'contains');
  assert.equal(suggestions.length, 10);
  assert.equal(suggestions[0].text, 'history');
  assert.equal(suggestions[1].url, 'https://example.com/duplicate');
  assert.equal(new Set(suggestions.map(row => row.query)).size, 10);
  assert.ok(!suggestions.some(row => row.url.endsWith('substring')));
  assert.equal(index.suggest('does-not-exist', 'contains').suggestions.length, 0);
});

test('domain completion indexes prefixes and labels without hostname substring false positives', async () => {
  const items = [
    { url: 'https://x.com/home', title: 'X' },
    { url: 'https://x.com/new', title: 'New X', lastVisitTime: 3 },
    { url: 'https://notx.com/x', title: 'X' },
    { url: 'https://docs.github.com/a', title: 'Docs' },
    { url: 'https://github.com/b', title: 'GitHub' },
  ];
  const index = await createSuggestionIndex(items);
  for (const mode of ['smart', 'host-exact', 'host-subdomains']) {
    const result = index.suggest('x', mode);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].query, 'x.com');
    assert.equal(result.examined, 1);
  }
  assert.equal(index.suggest('git', 'host-exact').suggestions.length, 1);
  assert.equal(index.suggest('git', 'host-subdomains').suggestions.length, 2);
  assert.equal(index.suggest('x.com, git', 'smart').suggestions[0].query, 'x.com, docs.github.com');
});

test('rarest gram lookup checks full substrings and supports one/two character input', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ url: `https://example.com/page/${i}`, title: `普通页面 ${i}` }));
  items.push({ url: 'https://example.com/special', title: '繁體關鍵詞搜尋' });
  const index = await createSuggestionIndex(items);
  for (const query of ['關', '关键', '关键词']) assert.equal(index.suggest(query, 'contains').suggestions[0].text, '繁體關鍵詞搜尋');
  assert.equal(index.suggest('关键词', 'contains').examined, 1);
  assert.equal(index.suggest('', 'smart').suggestions.length, 0);
  assert.equal(index.suggest('x, ', 'smart').suggestions.length, 0);
  assert.equal(index.suggest('%%%','host-exact').suggestions.length, 0);
});

test('missing titles, invalid URLs, equal-time visit counts and safe completions', async () => {
  const index = await createSuggestionIndex([
    { url: 'https://example.com/query', visitCount: 0 },
    { url: 'https://example.com/other', title: 'query <script>', visitCount: 2 },
    { url: 'https://example.com/frequent', title: 'query frequent', visitCount: 5 },
    { url: 'invalid URL', title: 'query' },
    { title: 'query' },
  ]);
  assert.equal(index.size, 3);
  const result = index.suggest('query', 'contains').suggestions;
  assert.equal(result[0].query, 'query frequent');
  assert.equal(result[1].query, 'query <script>');
  assert.equal(result[2].text, 'https://example.com/query');
  for (const item of result) assert.ok(filterHistoryItems([{ url: item.url, title: item.text }], item.query, 'contains').length);
});
