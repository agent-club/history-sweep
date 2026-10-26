import { enterWorkspace } from './native-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-auto-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const day = 86400000;
const host = 'cleanup-fixture.example.test';
const urls = [`https://${host}/expired`, `https://sub.${host}/expired`, `https://keep.${host}/expired`,
  `https://${host}/recent`, 'https://unrelated.example.test/expired'];
const errors = [];
const screenshotDir = process.env.HISTORY_SWEEP_AUTO_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
async function capture(page, name) {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
}
let context;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let worker = context.serviceWorkers().find(item => item.url().endsWith('/background.mjs'));
  if (!worker) worker = await context.waitForEvent('serviceworker');
  return { worker, origin: `chrome-extension://${new URL(worker.url()).hostname}` };
}
const ready = page => page.waitForFunction(() => document.querySelector('#newRule') && !document.querySelector('#newRule').disabled);
const visits = (page, url) => page.evaluate(url => chrome.history.getVisits({ url }), url);
async function until(read, label) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    if(await read()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail(label);
}
const settled = async page => {
  await page.waitForFunction(() => !document.querySelector('#confirmDialog').open);
  await page.waitForFunction(async () => !(await chrome.runtime.sendMessage({ type: 'auto-get' })).data?.running);
};
try {
  let { origin } = await launch();
  let page = await context.newPage(); await page.goto(`${origin}/auto-cleanup.html`); await ready(page);
  // Only this disposable profile receives synthetic visits. No website is contacted.
  await page.evaluate(async urls => { for (const url of urls) await chrome.history.addUrl({ url }); }, urls);
  await context.close(); context = null;
  // Age selected native visits while Chrome is closed, leaving the recent URL untouched.
  execFileSync('python3', ['-c', `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
for url in sys.argv[3:]:
    db.execute('UPDATE urls SET last_visit_time=? WHERE url=?',(int(sys.argv[2]),url))
    db.execute('UPDATE visits SET visit_time=? WHERE url IN (SELECT id FROM urls WHERE url=?)',(int(sys.argv[2]),url))
db.commit()
db.close()`, join(profile, 'Default', 'History'), String((Date.now() - 8 * day + 11644473600000) * 1000), ...urls.filter(url => !url.endsWith('/recent'))]);
  ({ origin } = await launch());
  const manager = await context.newPage(); await manager.goto(`${origin}/manager.html`);
  await enterWorkspace(manager);
  await manager.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  assert.equal((await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'auto-get' }))).ok, true, 'owned manager can host cleanup settings');
  // Test cleanup tasks independently of the preferences discard-dialog flow.
  page = await context.newPage(); await page.goto(`${origin}/auto-cleanup.html`); await ready(page);
  await page.locator('[data-section=protection]').click();
  await page.locator('#protectedDomains').fill(`keep.${host}`); await page.locator('#saveProtection').click();
  await page.locator('[data-section=tasks]').click();
  await page.locator('#createFirst').click();
  for (const domain of ['', '   ', 'localhost', `${host}/path`, 'co.uk']) {
    await page.locator('#ruleDomain').fill(domain);
    assert.equal(await page.locator('#previewRule').isDisabled(), true, `invalid domain disables preview: ${domain}`);
    assert.equal(await page.locator('#saveDisabled').isDisabled(), true, 'invalid conditions cannot be saved paused');
  }
  await page.locator('#ruleForm').evaluate(form => form.requestSubmit());
  assert.equal(await page.locator('#ruleEditor').isVisible(), true, 'invalid submission stays in the editor');
  assert.equal(await page.locator('#previewPanel').isHidden(), true, 'invalid submission does not open preview');
  assert.equal(await page.locator('#ruleError').isVisible(), true);
  await page.locator('#ruleDomain').fill(host);
  assert.equal(await page.locator('#previewRule').isEnabled(), true, 'valid domain enables preview');
  await page.locator('#ruleDaysPreset').selectOption('custom');
  for (const days of ['', '0', '-1', '1.5', '999999999999']) {
    await page.locator('#ruleDays').fill(days);
    assert.equal(await page.locator('#previewRule').isDisabled(), true, `invalid inactivity disables preview: ${days}`);
  }
  await page.locator('#ruleDays').fill('14');
  assert.equal(await page.locator('#previewRule').isEnabled(), true, 'valid custom inactivity enables preview');
  await page.locator('#ruleDaysPreset').selectOption('all');
  assert.equal(await page.locator('#previewRule').isEnabled(), true, 'optional inactivity can be omitted');
  await page.locator('#ruleDaysPreset').selectOption('7');
  // Exercise missing-time validation even when the time picker makes the input readonly.
  await page.locator('#scheduleTime').evaluate(input => { input.value=''; input.dispatchEvent(new Event('input', { bubbles:true })); });
  assert.equal(await page.locator('#previewRule').isDisabled(), true, 'missing recurring time disables preview');
  await page.locator('#scheduleTime').evaluate(input => { input.value='02:00'; input.dispatchEvent(new Event('input', { bubbles:true })); });
  await page.locator('#scheduleType').selectOption('once');
  assert.equal(await page.locator('#previewRule').isDisabled(), true, 'missing one-time date disables preview');
  await page.locator('#scheduleAt').fill('2099-01-01T02:00');
  assert.equal(await page.locator('#previewRule').isEnabled(), true, 'valid one-time date enables preview');
  await page.locator('#scheduleType').selectOption('daily');
  await page.locator('#ruleDomain').fill(`${host.toUpperCase()}.`);
  await page.locator('input[value=subdomains]').check();
  await page.locator('#previewRule').click();
  await page.waitForFunction(() => !document.querySelector('#saveEnabled').disabled);
  assert.match(await page.locator('#previewSummary').textContent(), /2 page/);
  assert.match(await page.locator('#protectedSummary').textContent(), /1 page/);
  assert.match(await page.locator('#previewScope').textContent(), new RegExp(host.replaceAll('.', '\\.')));
  assert.equal(await page.locator('.auto-preview-host').count(), 2);
  await page.locator('.auto-preview-host summary').first().click();
  assert.match(await page.locator('.auto-preview-item').first().textContent(), /7 days without a visit/);
  await page.locator('#saveEnabled').click();
  assert.match(await page.locator('#confirmBody').textContent(), /cleanup-fixture.example.test and its subdomains/);
  await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => document.querySelectorAll('.auto-rule-card').length === 1 && !document.querySelector('#confirmDialog').open);
  assert.equal((await visits(page, urls[0])).length, 1, 'enabling does not delete');
  const scheduled = await page.evaluate(async () => ({ config: (await chrome.storage.local.get('autoCleanup')).autoCleanup, alarm: await chrome.alarms.get('history-sweep-auto-cleanup') }));
  assert.equal(scheduled.config.version, 2);
  assert.equal(scheduled.config.rules[0].schedule.type, 'daily');
  assert.ok(scheduled.config.nextRunAt > Date.now() && scheduled.config.nextRunAt <= Date.now() + 25 * 3600000);
  assert.equal(scheduled.alarm.scheduledTime, scheduled.config.nextRunAt);
  await page.locator('#newRule').click(); await page.locator('#ruleDomain').fill(`sub.${host}`);
  await page.locator('#previewRule').click(); await page.locator('#previewError button').waitFor({ state: 'visible' });
  assert.match(await page.locator('#previewError').textContent(), /overlaps/);
  await page.locator('#previewError button').click(); await page.locator('#confirmAccept').click();
  await page.waitForFunction(host => document.querySelector('#ruleDomain').value === host && !document.querySelector('#confirmDialog').open, host);
  await page.locator('#ruleDaysPreset').selectOption('1'); await page.locator('#previewRule').click();
  await page.waitForFunction(() => !document.querySelector('#saveEnabled').disabled);
  await page.locator('.auto-preview-host summary').first().click();
  assert.match(await page.locator('.auto-preview-item').first().textContent(), /1 days without a visit/, 'edited preview describes the draft rather than the old saved rule');
  await page.locator('#closePreview').click();
  await page.locator('#ruleDaysPreset').selectOption('30');
  assert.equal(await page.locator('#saveEnabled').isDisabled(), true, 'editing invalidates the preview');
  assert.equal(await page.locator('#previewPanel').isHidden(), true, 'stale preview rows are hidden');
  await page.locator('#cancelEditor').click(); await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => document.querySelector('#ruleEditor').hidden && !document.querySelector('#confirmDialog').open);
  await page.locator('#reviewAll').click();
  await page.locator('#deletePreviewNow').waitFor({ state: 'visible' });
  assert.equal((await visits(page, urls[0])).length, 1, 'review does not delete');
  await page.locator('#deletePreviewNow').click(); await page.locator('#confirmAccept').click(); await settled(page);
  assert.equal((await visits(page, urls[0])).length, 0);
  assert.equal((await visits(page, urls[1])).length, 0);
  for (const url of urls.slice(2)) assert.equal((await visits(page, url)).length, 1, `keeps ${url}`);
  const afterRun = await page.evaluate(async () => chrome.storage.local.get(['autoCleanupRuntime', 'localActivity']));
  assert.equal((await page.evaluate(async () => (await chrome.storage.local.get('autoCleanup')).autoCleanup)).rules[0].nextRunAt,
    scheduled.config.rules[0].nextRunAt, 'immediate cleanup leaves the daily task schedule unchanged');
  assert.equal(afterRun.autoCleanupRuntime.result.removed, 2);
  const activityDay = Object.values(afterRun.localActivity.days)[0];
  assert.equal(activityDay.automaticOperations, 1); assert.equal(activityDay.pages, 2);
  assert.doesNotMatch(JSON.stringify(afterRun), /https:|\/expired/);
  // A native manual deletion shares the activity aggregate without changing its automatic count.
  await manager.evaluate(async url => {
    const job = await chrome.runtime.sendMessage({ type: 'start-delete', urls: [url] });
    if (!job.ok) throw new Error('manual cleanup failed');
  }, urls[4]);
  await manager.waitForFunction(async () => Object.values((await chrome.storage.local.get('localActivity')).localActivity.days)[0].operations === 2);
  await manager.locator('#activityEntry').click(); await manager.locator('[data-activity-mode=cleanup]').click();
  await manager.locator('.activity-day[data-level]:not([data-level="0"])').first().click();
  assert.match(await manager.locator('#activityDetail').textContent(), /1 automatic \/ 1 manual/);
  await page.locator('#pauseAll').click(); await page.waitForFunction(() => document.querySelector('#statusHeading').textContent.includes('paused'));
  assert.equal(await page.evaluate(() => chrome.alarms.get('history-sweep-auto-cleanup')), undefined);
  await page.locator('#pauseAll').click(); await page.waitForFunction(() => document.querySelector('#statusHeading').textContent.includes('are on'));
  // Overdue restart catches up once using current history and no-op runs do not add activity.
  await page.evaluate(async () => {
    const { autoCleanup } = await chrome.storage.local.get('autoCleanup');
    await chrome.storage.local.set({ autoCleanup: { ...autoCleanup, nextRunAt: Date.now() - 1000, rules: autoCleanup.rules.map(rule => rule.enabled ? { ...rule, nextRunAt: Date.now() - 1000 } : rule) } });
  });
  await context.close(); context = null; ({ origin } = await launch());
  page = await context.newPage(); await page.goto(`${origin}/auto-cleanup.html`); await ready(page); await settled(page);
  const caughtUp = await page.evaluate(async () => chrome.storage.local.get(['autoCleanup', 'autoCleanupRuntime', 'localActivity']));
  assert.ok(caughtUp.autoCleanup.nextRunAt > Date.now());
  assert.equal(caughtUp.autoCleanupRuntime.result.removed, 0);
  assert.equal(Object.values(caughtUp.localActivity.days)[0].operations, 2);
  // Native private execution removes eligible history without adding counts or a completion result.
  await page.evaluate(async host => {
    await chrome.storage.local.set({ privateCleanup: true });
    const { autoCleanup } = await chrome.storage.local.get('autoCleanup');
    await chrome.storage.local.set({ autoCleanup: { ...autoCleanup, rules: autoCleanup.rules.map(rule => ({ ...rule, days: 1 })) } });
    await chrome.history.addUrl({ url: `https://${host}/private` });
  }, host);
  await context.close(); context = null;
  execFileSync('python3', ['-c', `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute('UPDATE urls SET last_visit_time=? WHERE url=?',(int(sys.argv[2]),sys.argv[3]))
db.execute('UPDATE visits SET visit_time=? WHERE url IN (SELECT id FROM urls WHERE url=?)',(int(sys.argv[2]),sys.argv[3]))
db.commit()
db.close()`, join(profile, 'Default', 'History'), String((Date.now() - 2 * day + 11644473600000) * 1000), `https://${host}/private`]);
  ({ origin } = await launch()); page = await context.newPage(); await page.goto(`${origin}/auto-cleanup.html`); await ready(page);
  assert.equal((await visits(page, `https://${host}/private`)).length, 1, 'native private fixture exists before the alarm');
  await page.evaluate(async () => {
    const { autoCleanup } = await chrome.storage.local.get('autoCleanup');
    const when=Date.now()+500;
    await chrome.storage.local.set({ autoCleanup: { ...autoCleanup, nextRunAt: when, rules: autoCleanup.rules.map(rule => rule.enabled ? { ...rule, nextRunAt: when } : rule) } });
    await chrome.alarms.create('history-sweep-auto-cleanup', { when });
  });
  await until(()=>page.evaluate(async () => {
    const { autoCleanup, autoCleanupRuntime }=await chrome.storage.local.get(['autoCleanup','autoCleanupRuntime']);
    return autoCleanup.nextRunAt>Date.now()+1000 && autoCleanupRuntime?.inProgress===false;
  }), 'native alarm should complete and schedule its next check');
  await settled(page);
  assert.equal((await visits(page, `https://${host}/private`)).length, 0);
  const privateState = await page.evaluate(async () => chrome.storage.local.get(['autoCleanupRuntime', 'localActivity']));
  assert.equal(privateState.autoCleanupRuntime.result, undefined);
  assert.equal(Object.values(privateState.localActivity.days)[0].operations, 2);
  assert.equal(await page.locator('#latestResult').isHidden(), true);
  // Create all schedule types through the real task form and round-trip their stored values.
  async function createTask(domain, type, days, fields = {}) {
    await page.locator('#newRule').click();
    await page.locator('#ruleDomain').fill(domain);
    await page.locator('#ruleDaysPreset').selectOption(days);
    if (days === 'custom') await page.locator('#ruleDays').fill('14');
    await page.locator('#scheduleType').selectOption(type);
    for (const [id, value] of Object.entries(fields)) {
      const control = page.locator(`#${id}`);
      if (id === 'scheduleTime') {
        await control.click();
        const [hour, minute] = value.split(':');
        const columns = page.locator('#scheduleTimePicker .auto-time-column');
        await columns.nth(0).locator(`[data-value="${hour}"]`).click();
        await columns.nth(1).locator(`[data-value="${minute}"]`).click();
        await page.locator('#scheduleTimePicker .auto-time-footer button').click();
      } else if (await control.evaluate(node => node.tagName === 'SELECT')) await control.selectOption(value);
      else await control.fill(value);
    }
    await page.locator('#previewRule').click();
    await page.waitForFunction(() => !document.querySelector('#saveEnabled').disabled);
    await page.locator('#saveEnabled').click();
    await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => document.querySelector('#ruleEditor').hidden && !document.querySelector('#confirmDialog').open);
    return page.evaluate(async domain => (await chrome.storage.local.get('autoCleanup')).autoCleanup.rules.find(task => task.domain === domain), domain);
  }
  const weekly = await createTask('weekly.example.test', 'weekly', 'custom', { scheduleWeekday: '5', scheduleTime: '18:30' });
  assert.deepEqual(weekly.schedule, { type: 'weekly', time: '18:30', weekday: 5 });
  assert.equal(weekly.days, 14);
  const monthly = await createTask('monthly.example.test', 'monthly', '30', { scheduleMonthDay: '31', scheduleTime: '09:15' });
  assert.deepEqual(monthly.schedule, { type: 'monthly', time: '09:15', day: 31 });
  assert.equal(monthly.days, 30);
  const onceAt = await page.evaluate(() => {
    const date = new Date(Date.now() + 2 * 86400000);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  const once = await createTask('once.example.test', 'once', 'all', { scheduleAt: onceAt });
  assert.equal(once.schedule.type, 'once'); assert.ok(once.schedule.at > Date.now()); assert.equal(once.days, null);
  for (const task of [weekly, monthly, once]) assert.ok(task.nextRunAt > Date.now());
  assert.equal(await page.locator('.auto-rule-card').count(), 4);
  // An actual native alarm runs only its due task, including newly visited pages with no age filter.
  const oneTimeUrl = 'https://once.example.test/recent';
  await page.evaluate(async ({ oneTimeUrl, onceId }) => {
    await chrome.history.addUrl({ url: oneTimeUrl });
    const { autoCleanup } = await chrome.storage.local.get('autoCleanup');
    const when = Date.now() + 500;
    autoCleanup.rules = autoCleanup.rules.map(task => task.id === onceId ? { ...task, schedule: { type: 'once', at: when }, nextRunAt: when } : task);
    autoCleanup.nextRunAt = when;
    await chrome.storage.local.set({ autoCleanup });
    await chrome.alarms.create('history-sweep-auto-cleanup', { when });
  }, { oneTimeUrl, onceId: once.id });
  await until(() => page.evaluate(async onceId => (await chrome.storage.local.get('autoCleanup')).autoCleanup.rules.find(task => task.id === onceId).completed, once.id), 'one-time alarm finishes its task');
  assert.equal((await visits(page, oneTimeUrl)).length, 0);
  const finished = await page.evaluate(async () => (await chrome.storage.local.get('autoCleanup')).autoCleanup);
  const finishedOnce = finished.rules.find(task => task.id === once.id);
  assert.equal(finishedOnce.enabled, false); assert.equal(finishedOnce.nextRunAt, null);
  for (const original of [weekly, monthly]) assert.equal(finished.rules.find(task => task.id === original.id).nextRunAt, original.nextRunAt, 'not-due tasks retain their schedule');
  await page.reload(); await ready(page);
  assert.match(await page.locator('.auto-rule-card').filter({ hasText: 'once.example.test' }).innerText(), /Finished/);
  await page.evaluate(() => { localStorage.setItem('language', 'zh-CN'); localStorage.setItem('theme', 'light'); });
  await page.reload(); await ready(page); await page.setViewportSize({ width: 1120, height: 900 });
  await capture(page, 'cleanup-tasks');
  await page.locator('.auto-rule-card').filter({ hasText: 'weekly.example.test' }).getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.locator('#scheduleWeekday').inputValue(), '5');
  assert.equal(await page.locator('#ruleDays').inputValue(), '14');
  assert.equal(await page.locator('#scheduleWeekdayField').isVisible(), true);
  await capture(page, 'cleanup-task-editor');
  for (const id of ['scheduleType', 'scheduleWeekday', 'ruleDaysPreset']) {
    await page.locator(`#${id}`).click();
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.matches(':open')), true);
    await capture(page, `cleanup-${id}-open`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(`#${id}`).evaluate(node => node === document.activeElement), true);
  }
  await page.locator('#scheduleType').selectOption('monthly');
  assert.equal(await page.locator('#scheduleWeekdayField').isHidden(), true);
  assert.equal(await page.locator('#scheduleMonthDayField').isVisible(), true);
  await page.locator('#scheduleMonthDay').click(); await capture(page, 'cleanup-monthday-open'); await page.keyboard.press('Escape');
  await page.locator('#scheduleMonthDay').focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#scheduleMonthDay').inputValue(), '2', 'native select supports keyboard selection');
  await page.locator('#cancelEditor').click();
  assert.equal(await page.locator('#confirmCancel').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#ruleEditor').isVisible(), true, 'Escape keeps the unsaved editor');
  await page.locator('#cancelEditor').click(); await page.locator('#confirmAccept').click();
  await page.waitForFunction(() => document.querySelector('#ruleEditor').hidden && !document.querySelector('#confirmDialog').open);
  for (const language of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ language, theme }) => { localStorage.setItem('language', language); localStorage.setItem('theme', theme); }, { language, theme });
    await page.reload(); await ready(page); await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language}/${theme}: no horizontal overflow`);
    assert.doesNotMatch(await page.locator('body').innerText(), /error_AUTO_|previewNextRun|handoffNotice/);
    await page.locator('#newRule').click();
    await page.locator('#ruleDomain').fill('a-very-long-website-name.for-cleanup-task-layout.example.test');
    await page.locator('#scheduleType').selectOption('once');
    await page.locator('#scheduleAt').fill(onceAt);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language}/${theme}: editor has no horizontal overflow`);
    await capture(page, `cleanup-editor-${language}-${theme}-narrow`);
    await page.locator('#cancelEditor').click(); await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => document.querySelector('#ruleEditor').hidden && !document.querySelector('#confirmDialog').open);
  }
  await page.evaluate(() => { localStorage.setItem('language', 'en'); localStorage.setItem('theme', 'light'); });
  await page.reload(); await ready(page); await page.setViewportSize({ width: 1120, height: 900 });
  if (process.env.HISTORY_SWEEP_AUTO_SCREENSHOT) await page.screenshot({ path: process.env.HISTORY_SWEEP_AUTO_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Cleanup task native browser checks passed: once/daily/weekly/monthly, optional inactivity, per-task alarm, completion, unchanged manual schedules, preview, protection, private cleanup, pause, restart catch-up, keyboard, open dropdowns, EN/ZH and responsive layout.');
} finally {
  await context?.close(); await rm(profile, { recursive: true, force: true });
}
