import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCalendar, browsingActivity, browsingActivityAsync, activitySummary } from '../extension/activity-calendar.mjs';
import { createActivityLog } from '../extension/activity-log.mjs';

test('annual grids contain each real date once, align weeks on Monday, and mark future dates', () => {
  for (const [year, count] of [[2024, 366], [2026, 365], [2028, 366]]) {
    const grid = activityCalendar(year, 'year', new Date(year, 9, 17));
    const dates = grid.cells.filter(Boolean);
    assert.equal(dates.length, count); assert.equal(new Set(dates.map(cell => cell.date)).size, count);
    assert.equal(grid.cells.length % 7, 0);
    const jan1 = grid.cells.findIndex(cell => cell?.date === `${year}-01-01`);
    assert.equal(jan1 % 7, (new Date(year, 0, 1).getDay() + 6) % 7);
    assert.equal(dates.find(cell => cell.date === `${year}-10-17`).future, false);
    assert.equal(dates.find(cell => cell.date === `${year}-10-18`).future, true);
  }
});

test('three-month view spans year boundaries and past-year views end in December', () => {
  const january = activityCalendar(2026, 'quarter', new Date(2026, 0, 17));
  assert.equal(january.start, '2025-11-01'); assert.equal(january.end, '2026-01-31');
  assert.deepEqual(january.months.map(month => month.month), [10, 11, 0]);
  const past = activityCalendar(2024, 'quarter', new Date(2026, 9, 17));
  assert.equal(past.start, '2024-10-01'); assert.equal(past.end, '2024-12-31');
});

test('browsing counts distinct retained URLs on their last local visit date, not visitCount', () => {
  const time = new Date(2026, 9, 17, 9).getTime();
  const days = browsingActivity([
    { url: 'https://example.org/a', lastVisitTime: time, visitCount: 100 },
    { url: 'https://example.org/a', lastVisitTime: time },
    { url: 'https://example.org/b', lastVisitTime: time },
    { url: 'https://docs.example.net/a', lastVisitTime: time },
    { url: 'https://example.org/unknown' },
  ]);
  assert.equal(days['2026-10-17'].pages, 3);
  assert.deepEqual(activitySummary(days, '2026-10-01', '2026-10-31', '2026-10-17'), { operations: 0, pages: 3, activeDays: 1, sites: 2 });
});

test('chunked activity yields to input and deduplicates records across batches', async () => {
  const time = new Date(2026, 9, 17, 12).getTime();
  const items = Array.from({ length: 1500 }, (_, index) => ({
    url: `https://example.org/page-${index % 600}`, title: `Page ${index}`, lastVisitTime: time - index,
  }));
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 0);
  try {
    const days = await browsingActivityAsync(items);
    assert.equal(heartbeat, true);
    assert.equal(days['2026-10-17'].pages, 600);
    assert.deepEqual(days['2026-10-17'].websites, [{ domain: 'example.org', title: 'Page 0', lastVisitTime: time }]);
  } finally { clearTimeout(timer); }
});

test('obsolete activity loads stop at the next batch without returning partial data', async () => {
  const items = Array.from({ length: 1500 }, (_, index) => ({ url: `https://example.org/${index}`, lastVisitTime: 1 }));
  let current = true;
  const timer = setTimeout(() => { current = false; }, 0);
  try { assert.equal(await browsingActivityAsync(items, () => current), null); }
  finally { clearTimeout(timer); }
});

function fixture() {
  const saved = {}; let fail = false;
  const storage = {
    get: async () => structuredClone(saved),
    set: async data => { if (fail) throw new Error('storage unavailable'); Object.assign(saved, structuredClone(data)); },
  };
  return { saved, storage, fail: value => { fail = value; } };
}

test('concurrent completed tasks accumulate once and survive a new worker without URLs or titles', async () => {
  const f = fixture(); const now = () => new Date(2026, 9, 17, 14, 32);
  const log = createActivityLog(f.storage, now);
  await Promise.all([log.record(72), log.record(38), log.record(16)]);
  const resumed = await createActivityLog(f.storage, now).read();
  assert.deepEqual(resumed.log, { version: 1, startedOn: '2026-10-17', days: { '2026-10-17': { operations: 3, pages: 126 } } });
  assert.equal(resumed.recordingFailed, false);
  assert.deepEqual(Object.keys(f.saved), ['localActivity']);
  assert.equal(JSON.stringify(f.saved).includes('http'), false);
});

test('local midnight starts a new daily aggregate and empty tasks remain valid zero-page operations', async () => {
  const f = fixture(); let now = new Date(2026, 11, 31, 23, 59);
  const log = createActivityLog(f.storage, () => now);
  await log.record(1); now = new Date(2027, 0, 1, 0, 1); await log.record(0);
  assert.deepEqual((await log.read()).log.days, { '2026-12-31': { operations: 1, pages: 1 }, '2027-01-01': { operations: 1, pages: 0 } });
});

test('failed writes preserve the existing log, report incompleteness, and do not poison the queue', async () => {
  const f = fixture(); const log = createActivityLog(f.storage, () => new Date(2026, 9, 17));
  await log.record(2); f.fail(true); await assert.rejects(log.record(3));
  assert.equal((await log.read()).recordingFailed, true);
  assert.equal(f.saved.localActivity.days['2026-10-17'].pages, 2);
  f.fail(false); await log.record(5);
  assert.equal((await log.read()).recordingFailed, false);
  assert.equal(f.saved.localActivity.days['2026-10-17'].pages, 7);
});

test('daily website summaries deduplicate hosts, keep the latest title, sort by visit time and omit missing titles', () => {
  const time = new Date(2026, 9, 17, 12).getTime();
  const day = browsingActivity([
    { url: 'https://example.org/older', title: 'Older title', lastVisitTime: time - 10 },
    { url: 'https://example.net/first', title: 'Other site', lastVisitTime: time - 5 },
    { url: 'https://example.org/latest', title: 'Latest title', lastVisitTime: time },
    { url: 'https://docs.example.org/untitled', lastVisitTime: time - 20 },
  ])['2026-10-17'];
  assert.equal(day.pages, 4); assert.equal(day.sites.size, 3);
  assert.deepEqual(day.websites, [
    { domain: 'example.org', title: 'Latest title', lastVisitTime: time },
    { domain: 'example.net', title: 'Other site', lastVisitTime: time - 5 },
    { domain: 'docs.example.org', lastVisitTime: time - 20 },
  ]);
});

test('cleanup stores only daily hostname, title and visit-time summaries and merges across worker restarts', async () => {
  const f = fixture(); const now = () => new Date(2026, 9, 17, 12); const time = now().getTime();
  await createActivityLog(f.storage, now).record(2, [
    { url: 'https://example.org/private/path?synthetic=yes', title: 'Newest', lastVisitTime: time },
    { url: 'https://example.net/other', lastVisitTime: time - 5 },
  ]);
  const resumed = createActivityLog(f.storage, now);
  await resumed.record(2, [
    { url: 'https://example.org/old', title: 'Old', lastVisitTime: time - 10 },
    { url: 'https://example.net/new', title: 'Latest other', lastVisitTime: time + 10 },
  ]);
  const day = (await resumed.read()).log.days['2026-10-17'];
  assert.equal(day.operations, 2); assert.equal(day.pages, 4); assert.equal(day.websitesComplete, true);
  assert.deepEqual(day.websites, [
    { domain: 'example.net', title: 'Latest other', lastVisitTime: time + 10 },
    { domain: 'example.org', title: 'Newest', lastVisitTime: time },
  ]);
  assert.doesNotMatch(JSON.stringify(f.saved), /https:|private\/path|synthetic=yes|"url"/);
});

test('legacy days stay incomplete when new summaries are added, with no invented metadata', async () => {
  const f = fixture(); const now = () => new Date(2026, 9, 17, 12);
  f.saved.localActivity = { version: 1, startedOn: '2026-10-16', days: { '2026-10-16': { operations: 1, pages: 3 }, '2026-10-17': { operations: 1, pages: 2 } } };
  const log = createActivityLog(f.storage, now);
  await log.record(1, [{ url: 'https://new.example.org/page' }]);
  const { days } = (await log.read()).log;
  assert.deepEqual(days['2026-10-16'], { operations: 1, pages: 3 });
  assert.deepEqual(days['2026-10-17'], { operations: 2, pages: 3, websites: [{ domain: 'new.example.org' }], websitesComplete: false });
});
