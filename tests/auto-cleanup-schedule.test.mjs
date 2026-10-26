import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nextOccurrence, normalizeSchedule } from '../extension/auto-cleanup-schedule.mjs';

const inTimezone = (tz, source) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TZ: tz },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('normalizes supported schedule shapes and rejects malformed schedules', () => {
  assert.deepEqual(normalizeSchedule({ type: 'once', at: 1 }), { type: 'once', at: 1 });
  assert.deepEqual(normalizeSchedule({ type: 'daily', time: '02:05' }), { type: 'daily', time: '02:05' });
  assert.deepEqual(normalizeSchedule({ type: 'weekly', weekday: 0, time: '23:59' }), { type: 'weekly', weekday: 0, time: '23:59' });
  assert.deepEqual(normalizeSchedule({ type: 'monthly', day: 31, time: '00:00' }), { type: 'monthly', day: 31, time: '00:00' });
  for (const value of [null, [], {}, { type: 'once', at: 0 }, { type: 'once', at: 1.5 },
    { type: 'daily', time: '24:00' }, { type: 'daily', time: '2:00' },
    { type: 'weekly', weekday: 7, time: '12:00' }, { type: 'weekly', weekday: 1.2, time: '12:00' },
    { type: 'monthly', day: 0, time: '12:00' }, { type: 'monthly', day: 32, time: '12:00' }]) {
    assert.throws(() => normalizeSchedule(value), { message: 'AUTO_INVALID_SCHEDULE' });
  }
});

test('one-time schedules are strictly after the reference time', () => {
  assert.equal(nextOccurrence({ type: 'once', at: 1000 }, 999), 1000);
  assert.equal(nextOccurrence({ type: 'once', at: 1000 }, 1000), null);
  assert.equal(nextOccurrence({ type: 'once', at: 1000 }, 1001), null);
  assert.throws(() => nextOccurrence({ type: 'daily', time: '12:00' }, Infinity), { message: 'AUTO_INVALID_SCHEDULE' });
});

test('daily, Sunday-based weekly and monthly schedules use local calendar dates', () => {
  const values = inTimezone('UTC', `
    import { nextOccurrence } from './extension/auto-cleanup-schedule.mjs';
    const ts = value => new Date(value).getTime();
    const out = {
      daily: new Date(nextOccurrence({type:'daily',time:'09:30'}, ts('2026-01-01T10:00:00Z'))).toISOString(),
      weeklySunday: new Date(nextOccurrence({type:'weekly',weekday:0,time:'08:00'}, ts('2026-01-03T09:00:00Z'))).toISOString(),
      monthly31Jan: new Date(nextOccurrence({type:'monthly',day:31,time:'08:00'}, ts('2025-01-30T09:00:00Z'))).toISOString(),
      monthly31Leap: new Date(nextOccurrence({type:'monthly',day:31,time:'08:00'}, ts('2024-02-01T00:00:00Z'))).toISOString(),
    };
    console.log(JSON.stringify(out));
  `);
  assert.deepEqual(values, {
    daily: '2026-01-02T09:30:00.000Z',
    weeklySunday: '2026-01-04T08:00:00.000Z',
    monthly31Jan: '2025-01-31T08:00:00.000Z',
    monthly31Leap: '2024-02-29T08:00:00.000Z',
  });
});

test('monthly schedules clamp to the last day of short months', () => {
  const values = inTimezone('UTC', `
    import { nextOccurrence } from './extension/auto-cleanup-schedule.mjs';
    const after = new Date('2025-01-31T09:00:00Z').getTime();
    console.log(JSON.stringify(new Date(nextOccurrence({type:'monthly',day:31,time:'08:00'}, after)).toISOString()));
  `);
  assert.equal(values, '2025-02-28T08:00:00.000Z');
});

test('DST gaps advance to the next valid wall time and repeated wall times run once per date', () => {
  const values = inTimezone('America/New_York', `
    import { nextOccurrence } from './extension/auto-cleanup-schedule.mjs';
    const afterGap = new Date('2025-03-09T03:00:00-04:00').getTime();
    const gap = new Date(nextOccurrence({type:'daily',time:'02:30'}, afterGap)).toString();
    const afterRepeat = new Date('2025-11-02T01:45:00-05:00').getTime();
    const repeat = new Date(nextOccurrence({type:'daily',time:'01:30'}, afterRepeat)).toString();
    console.log(JSON.stringify({gap, repeat}));
  `);
  assert.match(values.gap, /Sun Mar 09 2025 03:30:00 GMT-0400/);
  assert.match(values.repeat, /Mon Nov 03 2025 01:30:00 GMT-0500/);
});
