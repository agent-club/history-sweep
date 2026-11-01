import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceDefaults, validateWorkspaceTools, validateSavedSearch, validateConditions, matchesConditions, cleanLink, exportSelected, readVisitImpact } from '../extension/workspace-tools.mjs';
import { validateLocalBackup, pausedTaskConfig } from '../extension/local-backup.mjs';
import { encryptBackup, decryptBackup, validateConfig } from '../extension/config-sync.mjs';
import { browsingDefaults } from '../extension/browsing-preferences.mjs';
import { createActivityLog } from '../extension/activity-log.mjs';
import { LABEL_COLOR_PRESETS } from '../extension/label-appearance.mjs';

// All records below are synthetic, use reserved domains, and never contact a server.
const preset = () => ({ id: 'synthetic-preset', name: 'Reading', query: 'reading.example, notes.example', mode: 'host-subdomains', range: '7days', view: 'website', conditions: [] });
const configuration = () => ({ format: 'history-sweep-config', version: 1, preferences: { language: 'en', theme: 'system', launchMode: 'modal' }, historyTags: {}, domainLabels: {} });

test('saved searches store criteria only; fixed dates, selections and executable actions are rejected', () => {
  assert.deepEqual(validateSavedSearch(preset()), preset());
  for (const extra of [{ range: 'custom' }, { selected: ['https://reading.example/'] }, { execute: true }, { name: '' }]) assert.throws(() => validateSavedSearch({ ...preset(), ...extra }));
  const tools = workspaceDefaults(); tools.searches.push(preset());
  assert.deepEqual(validateWorkspaceTools(tools), tools);
  assert.throws(() => validateWorkspaceTools({ ...tools, searches: [preset(), preset()] }));
});

test('compound conditions are explicit AND filters', () => {
  const conditions = validateConditions([{ field: 'path', operator: 'includes', value: '/articles/' }, { field: 'text', operator: 'excludes', value: 'release-notes' }]);
  assert.equal(matchesConditions({ url: 'https://docs.example/articles/42', title: 'Guide' }, conditions), true);
  assert.equal(matchesConditions({ url: 'https://docs.example/other/42', title: 'Guide' }, conditions), false);
  assert.equal(matchesConditions({ url: 'https://docs.example/articles/release-notes', title: 'Guide' }, conditions), false);
  assert.throws(() => validateConditions([{ field: 'path', operator: 'includes', value: '' }]));
});

test('exact URL protection keeps fragment identity and manual labels do not inherit', () => {
  const tools = workspaceDefaults(); tools.protectedUrls = ['https://docs.example/synthetic-page#part'];
  tools.labels['docs.example'] = { values: ['Work'], visible: false };
  const clean = validateWorkspaceTools(tools);
  assert.equal(clean.protectedUrls.includes('https://docs.example/synthetic-page'), false);
  assert.equal(clean.labels['docs.example'].visible, false);
  assert.equal(Object.hasOwn(clean.labels, 'sub.docs.example'), false);
});

test('label appearances round-trip individually and legacy labels stay unchanged', () => {
  const tools = workspaceDefaults();
  tools.labels['docs.example'] = { values: ['Work', 'Read'], visible: true,
    styles: { Work: { foreground: '#315B49', background: '#E5F0E8', image: 'waves' } } };
  const clean = validateWorkspaceTools(tools);
  assert.deepEqual(clean.labels['docs.example'].styles, { Work: { ...LABEL_COLOR_PRESETS.sage, image: 'waves' } });
  assert.equal(Object.hasOwn(clean.labels['docs.example'].styles, 'Read'), false);
  tools.labels['docs.example'] = { values: ['Work'], visible: false };
  assert.deepEqual(validateWorkspaceTools(tools), tools);
});

test('label appearance boundary rejects remote images, SVG uploads, oversized data and unknown styles', () => {
  const tools = workspaceDefaults();
  for (const image of ['https://images.example/bg.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,' + 'A'.repeat(80000), 'missing-preset']) {
    tools.labels['docs.example'] = { values: ['Work'], visible: true, styles: { Work: { ...LABEL_COLOR_PRESETS.sage, image } } };
    assert.throws(() => validateWorkspaceTools(tools), /INVALID_WORKSPACE_SETTINGS/);
  }
  tools.labels['docs.example'] = { values: ['Work'], visible: true, styles: { Removed: LABEL_COLOR_PRESETS.sage } };
  assert.throws(() => validateWorkspaceTools(tools), /INVALID_WORKSPACE_SETTINGS/);
});

test('built-in label color pairs retain readable text contrast', () => {
  const luminance = hex => {
    const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  for (const [name, colors] of Object.entries(LABEL_COLOR_PRESETS)) {
    assert.ok((luminance(colors.background) + .05) / (luminance(colors.foreground) + .05) >= 4.5, name);
  }
});

test('clean-link copy preserves business parameter encoding and the fragment', () => {
  const original = 'https://reading.example/synthetic?business=synthetic%20value%2fpart&utm_source=synthetic-mail&utm_source=synthetic-again&keep=&utm_campaign=synthetic-weekly#part';
  const result = cleanLink(original, { hostname: 'reading.example', parameters: ['utm_source', 'utm_campaign'] });
  assert.equal(result.url, 'https://reading.example/synthetic?business=synthetic%20value%2fpart&keep=#part');
  assert.deepEqual(result.removed, ['utm_source', 'utm_campaign']);
  assert.equal(cleanLink('https://reading.example/synthetic#?utm_source=synthetic-keep', { hostname: 'reading.example', parameters: ['utm_source'] }).url, 'https://reading.example/synthetic#?utm_source=synthetic-keep');
  assert.throws(() => cleanLink(original, { hostname: 'other.example', parameters: ['business'] }));
});

test('selected export neutralizes spreadsheet formulas and retains legal zero timestamps', () => {
  const items = [{ url: 'https://reading.example/synthetic#part', title: '=SUM(1,2)', lastVisitTime: 0 }, { url: 'https://notes.example/synthetic' }];
  assert.equal(exportSelected(items, 'text'), items.map(item => item.url).join('\n'));
  const csv = exportSelected(items, 'csv');
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
  assert.ok(csv.includes('1970-01-01T00:00:00.000Z'));
  assert.ok(csv.endsWith('"https://notes.example/synthetic","",""'));
  assert.equal(exportSelected([...items, items[0]], 'text').split('\n').length, 2);
});

test('visit impact distinguishes unreadable visits and unknown timestamps from known zero', async () => {
  const history = { getVisits: async ({ url }) => {
    if (url.endsWith('failed')) throw new Error('synthetic failure');
    return [{ visitTime: 100 }, { visitTime: 200 }, {}];
  } };
  const result = await readVisitImpact(history, ['https://reading.example/synthetic', 'https://reading.example/failed'], { startTime: 100, endTime: 200 });
  assert.equal(result[0].outside, 1); assert.equal(result[0].unknownTimes, 1);
  assert.deepEqual(result[1], { url: 'https://reading.example/failed', unavailable: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readVisitImpact(history, ['https://reading.example/synthetic'], null, { signal: controller.signal }), { name: 'AbortError' });
});

test('encrypted local sections round-trip without changing the WebDAV schema or activating restored tasks', async () => {
  const local = { protection: { sites: ['reading.example'], urls: ['https://notes.example/synthetic-keep'] }, browsing: browsingDefaults(),
    tasks: [{ domain: 'reading.example', includeSubdomains: false, days: 7, schedule: { type: 'daily', time: '22:00' } }] };
  // Ephemeral test input only: it is generated at runtime, never logged, saved or sent.
  const syntheticPassphrase = crypto.randomUUID();
  const encoded = await encryptBackup(null, configuration(), syntheticPassphrase, local);
  assert.equal(JSON.parse(encoded).version, 2);
  assert.equal(encoded.includes('reading.example'), false);
  const restored = await decryptBackup(encoded, syntheticPassphrase);
  assert.deepEqual(restored.localSettings, validateLocalBackup(local));
  const tasks = pausedTaskConfig(restored.localSettings.tasks, 8);
  assert.equal(tasks.revision, 9); assert.equal(tasks.paused, true); assert.equal(tasks.nextRunAt, null);
  assert.ok(tasks.rules.every(rule => !rule.enabled && rule.nextRunAt === null && !rule.completed));
  assert.throws(() => validateLocalBackup({ ...local, history: [] }));
  assert.throws(() => validateLocalBackup({ tasks: [{ ...local.tasks[0], enabled: true }] }));
  assert.throws(() => validateConfig({ ...configuration(), localSettings: local }));
  const legacy = await encryptBackup(null, configuration(), syntheticPassphrase);
  assert.equal(Object.hasOwn(await decryptBackup(legacy, syntheticPassphrase), 'localSettings'), false);
  await assert.rejects(decryptBackup(encoded, crypto.randomUUID()), /INVALID_BACKUP/);
});

test('clearing activity serializes after recording and preserves unrelated preferences', async () => {
  const state = { protectedSites: ['reading.example'], autoCleanup: { paused: true } };
  const store = { get: async () => structuredClone(state), set: async patch => Object.assign(state, structuredClone(patch)) };
  const log = createActivityLog(store, () => new Date(2026, 10, 1));
  await Promise.all([log.record(2, [{ url: 'https://reading.example/synthetic', title: 'Synthetic page', lastVisitTime: 100 }]), log.clear()]);
  assert.deepEqual(state.localActivity.days, {});
  assert.deepEqual(state.protectedSites, ['reading.example']); assert.deepEqual(state.autoCleanup, { paused: true });
  assert.equal(JSON.stringify(state.localActivity).includes('reading.example'), false);
  await log.record(1); assert.equal(state.localActivity.days['2026-11-01'].pages, 1);
});
