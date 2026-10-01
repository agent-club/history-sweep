import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { calendarDays, formatDate, moveDate, moveMonth, parseDate } from '../extension/calendar-dates.mjs';

test('strict parsing validates Gregorian dates and preserves local noon', () => {
  for (const value of ['1900-02-29', '2023-02-29', '2026-02-30', '0099-12-31', '10000-01-01', '2026-1-01', '2026-01-1']) {
    assert.equal(parseDate(value), null, value);
  }
  for (const value of ['2000-02-29', '2024-02-29', '0100-01-01', '9999-12-31']) {
    const date = parseDate(value);
    assert.ok(date, value);
    assert.equal(date.getHours(), 12);
    assert.equal(formatDate(date), value);
  }
});

test('day and month movement handles calendar transitions and clamps at supported range', () => {
  assert.equal(moveDate('2024-02-28', 1), '2024-02-29');
  assert.equal(moveDate('2024-02-29', 1), '2024-03-01');
  assert.equal(moveDate('2026-12-31', 1), '2027-01-01');
  assert.equal(moveDate('0100-01-01', -1), '0100-01-01');
  assert.equal(moveDate('9999-12-31', 1), '9999-12-31');
  assert.equal(moveMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(moveMonth('2023-01-31', 1), '2023-02-28');
  assert.equal(moveMonth('2026-12-31', 1), '2027-01-31');
  assert.equal(moveMonth('0100-01-31', -1), '0100-01-01');
  assert.equal(moveMonth('9999-12-31', 1), '9999-12-31');
  assert.throws(() => moveDate('2026-02-30', 1), /INVALID_DATE/);
  assert.throws(() => moveMonth('invalid', 1), /INVALID_DATE/);
  assert.throws(() => moveDate('2026-01-01', 0.5), /INVALID_DATE_OFFSET/);
});

test('month grid contains 42 chronological Sunday-first cells', () => {
  const grid = calendarDays('2024-02-14');
  assert.equal(grid.length, 42);
  assert.equal(grid[0], '2024-01-28');
  assert.equal(grid[1], '2024-01-29');
  assert.equal(grid[4], '2024-02-01');
  assert.equal(grid[32], '2024-02-29');
  assert.equal(grid[33], '2024-03-01');
  for (let index = 1; index < grid.length; index++) {
    const previous = parseDate(grid[index - 1]);
    const current = parseDate(grid[index]);
    previous.setDate(previous.getDate() + 1);
    assert.equal(formatDate(current), formatDate(previous));
  }
  assert.equal(calendarDays('0100-01-15')[0], null);
  assert.equal(calendarDays('9999-12-15').at(-1), null);
});

test('day stepping remains calendar based across New York daylight-saving changes', () => {
  const script = `import { moveDate } from ${JSON.stringify(new URL('../extension/calendar-dates.mjs', import.meta.url).href)};\n` +
    `console.log([moveDate('2024-03-09', 1), moveDate('2024-03-10', 1), moveDate('2024-11-02', 1)].join(','));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' },
  }).trim();
  assert.equal(result, '2024-03-10,2024-03-11,2024-11-03');
});
