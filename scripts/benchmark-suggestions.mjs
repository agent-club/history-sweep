import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSuggestionIndex } from '../extension/history-suggestions.mjs';

const count = 100000;
const items = Array.from({ length: count }, (_, i) => ({
  url: `https://site${i % 10000}.example.com/page/${i}`,
  title: `歷史記錄 browser notes ${i}`, lastVisitTime: 1700000000000 - i, visitCount: i % 10,
}));
global.gc?.(); const before = process.memoryUsage().heapUsed;
const started = performance.now(); const index = await createSuggestionIndex(items);
const buildMs = performance.now() - started;
global.gc?.(); const heapMiB = (process.memoryUsage().heapUsed - before) / 1024 ** 2;
const scenarios = [['site9999', 'host-exact'], ['記錄', 'contains'], ['browser notes 98765', 'contains'], ['b', 'contains']];
const results = [];
for (const [query, mode] of scenarios) {
  const timings = []; let examined;
  for (let run = 0; run < 30; run++) {
    const start = performance.now(); const result = index.suggest(query, mode);
    timings.push(performance.now() - start); examined = result.examined;
    assert.ok(result.suggestions.length <= 10);
  }
  timings.sort((a,b) => a-b);
  results.push({ query, mode, examined, p50Ms: +timings[15].toFixed(2), p95Ms: +timings[28].toFixed(2) });
}
console.log(JSON.stringify({ count, buildMs: +buildMs.toFixed(2), retainedHeapMiB: +heapMiB.toFixed(2), results }, null, 2));
