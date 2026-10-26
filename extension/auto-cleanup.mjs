import { DAY_MS, normalizeRule, ruleMatches, rulesOverlap, isExpired } from './auto-cleanup-model.mjs';
import { isProtectedUrl } from './history-filters.mjs';
import { nextOccurrence } from './auto-cleanup-schedule.mjs';

export const AUTO_CLEANUP_ALARM = 'history-sweep-auto-cleanup';
const autoConfigStorage = 'autoCleanup';
const autoRuntimeStorage = 'autoCleanupRuntime';
const scanLimit = 100000;
const previewLifetime = 5 * 60000;
const autoError = code => new Error(code);
const freshConfig = () => ({ version: 2, paused: false, rules: [], nextRunAt: null, revision: 0 });

// Recovery rescans browser history instead of replaying a stored URL list.
export function createAutoCleanup(api, { readProtectedSites, recordActivity, runExclusive, isBusy, onStateChange = () => {}, now = () => Date.now() }) {
  let mutationQueue = Promise.resolve();
  let active = false;
  let stopping = false;
  let generation = 0;
  let privacyGeneration = 0;
  let privateDuringRun = false;
  let recoveryIncomplete = false;
  let recoveryPrivate = false;
  let initialization;
  const previews = new Map();
  const serial = fn => {
    const next = mutationQueue.then(fn);
    mutationQueue = next.catch(() => {});
    return next;
  };
  const enabledRules = config => config.rules.filter(rule => rule.enabled);
  const runnable = config => !config.paused && enabledRules(config).length > 0;
  const validTime = value => value === null || (Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000);
  const nextTime = (rule, after) => rule.schedule ? nextOccurrence(rule.schedule, after) : after + DAY_MS;
  function updateNextRun(config) {
    const times = enabledRules(config).map(rule => rule.nextRunAt).filter(time => time !== null);
    config.nextRunAt = config.paused || !times.length ? null : Math.min(...times);
    return config;
  }
  function validateConfig(value) {
    if (value === undefined) return freshConfig();
    if (!value || ![1, 2].includes(value.version) || typeof value.paused !== 'boolean' || !Array.isArray(value.rules) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !validTime(value.nextRunAt)) throw autoError('AUTO_UNAVAILABLE');
    const ids = new Set();
    const rules = value.rules.map(rule => {
      if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) || typeof rule.enabled !== 'boolean') throw autoError('AUTO_UNAVAILABLE');
      ids.add(rule.id);
      const normalized = normalizeRule(rule);
      if (value.version === 2 && (!validTime(rule.nextRunAt) || typeof rule.completed !== 'boolean' ||
          (rule.enabled && (rule.nextRunAt === null || rule.completed)) ||
          (rule.completed && normalized.schedule?.type !== 'once'))) throw autoError('AUTO_UNAVAILABLE');
      // Version 1 had one shared 24-hour timer. Preserve that exact occurrence on migration.
      const nextRunAt = value.version === 1 ? (rule.enabled ? value.nextRunAt : null) : rule.nextRunAt;
      if (rule.enabled && nextRunAt === null && value.version === 1) {
        return { id: rule.id, ...normalized, enabled: rule.enabled, nextRunAt: now() + DAY_MS, completed: false };
      }
      return { id: rule.id, ...normalized, enabled: rule.enabled, nextRunAt,
        completed: value.version === 1 ? false : rule.completed };
    });
    if (rules.some((rule, index) => rules.slice(index + 1).some(other => rulesOverlap(rule, other)))) throw autoError('AUTO_UNAVAILABLE');
    return updateNextRun({ version: 2, paused: value.paused, rules, nextRunAt: null, revision: value.revision });
  }
  async function readConfig() {
    return validateConfig((await api.storage.local.get(autoConfigStorage))[autoConfigStorage]);
  }
  async function readPrivacy() {
    const { privateCleanup = false, softPrivacy = false } = await api.storage.local.get(['privateCleanup', 'softPrivacy']);
    if (typeof privateCleanup !== 'boolean' || typeof softPrivacy !== 'boolean') throw autoError('AUTO_UNAVAILABLE');
    return { privateCleanup, softPrivacy };
  }
  async function schedule(config) {
    if (!api.alarms) return;
    if (!runnable(config) || config.nextRunAt === null) await api.alarms.clear(AUTO_CLEANUP_ALARM);
    else await api.alarms.create(AUTO_CLEANUP_ALARM, { when: config.nextRunAt });
  }
  async function saveConfig(before, after) {
    after.revision = before.revision + 1;
    updateNextRun(after);
    await api.storage.local.set({ [autoConfigStorage]: after });
    previews.clear();
    await schedule(after);
    return after;
  }
  async function state() {
    const config = await readConfig();
    const privacy = await readPrivacy();
    const runtime = (await api.storage.local.get(autoRuntimeStorage))[autoRuntimeStorage];
    return { config, running: active, stopping, result: privacy.privateCleanup || privacy.softPrivacy ? null : runtime?.result ?? null,
      error: runtime?.error ?? null, ...privacy };
  }
  function checkRevision(config, revision) {
    if (revision !== config.revision) throw autoError('AUTO_STALE');
  }
  function checkConflict(config, rule, id) {
    if (id !== undefined && !config.rules.some(saved => saved.id === id)) throw autoError('AUTO_STALE');
    if (config.rules.some(saved => saved.id !== id && rulesOverlap(saved, rule))) throw autoError('AUTO_CONFLICT');
  }
  const fullyProtected = (rule, sites) => isProtectedUrl(`https://${rule.domain}/`, sites);
  const ruleSnapshot = rule => JSON.stringify(normalizeRule(rule));
  async function scan(rules, sites, cutoff) {
    // Exactly hitting the API cap is ambiguous; refuse partial results before any deletion.
    const items = await api.history.search({ text: '', startTime: 0, maxResults: scanLimit });
    if (!Array.isArray(items) || items.length >= scanLimit) throw autoError('AUTO_SCAN_INCOMPLETE');
    const candidates = new Map();
    const excluded = new Set();
    for (const item of items) {
      if (!item || typeof item.url !== 'string') continue;
      const rule = rules.find(rule => ruleMatches(rule, item.url) && isExpired(item.lastVisitTime, rule.days, cutoff));
      if (!rule) continue;
      if (isProtectedUrl(item.url, sites)) { excluded.add(item.url); continue; }
      candidates.set(item.url, { url: item.url, ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}), lastVisitTime: item.lastVisitTime, ruleId: rule.id });
    }
    return { items: [...candidates.values()], excluded: excluded.size };
  }
  async function preview(message, owner) {
    const config = await readConfig();
    const sites = await readProtectedSites();
    let rules;
    if (message.all === true) rules = enabledRules(config);
    else {
      const rule = normalizeRule(message.rule);
      checkConflict(config, rule, message.id);
      rules = [{ ...rule, id: message.id }];
    }
    const result = await scan(rules, sites, now());
    const previewId = crypto.randomUUID();
    for (const [key, value] of previews) if (value.expires <= now() || value.owner === owner) previews.delete(key);
    previews.set(previewId, { owner, expires: now() + previewLifetime, revision: config.revision, sites: JSON.stringify(sites), all: message.all === true,
      ruleSnapshot: message.all === true ? null : ruleSnapshot(message.rule), id: message.id });
    return { ...result, previewId, ...(message.all !== true ? { rule: normalizeRule(rules[0]) } : {}),
      fullyProtected: message.all !== true && fullyProtected(rules[0], sites) };
  }
  async function consumePreview(message, config, owner, rule) {
    const proof = previews.get(message.previewId);
    if (!proof) throw autoError('AUTO_PREVIEW_REQUIRED');
    if (proof.expires <= now()) { previews.delete(message.previewId); throw autoError('AUTO_PREVIEW_EXPIRED'); }
    if (proof.owner !== owner || proof.revision !== config.revision || proof.all !== !rule ||
        (rule && (proof.id !== message.id || proof.ruleSnapshot !== ruleSnapshot(rule))) ||
        proof.sites !== JSON.stringify(await readProtectedSites())) throw autoError('AUTO_STALE');
    previews.delete(message.previewId);
    if (rule && fullyProtected(rule, await readProtectedSites())) throw autoError('AUTO_FULLY_PROTECTED');
  }
  async function finishSchedule(selected, scheduled, stopped) {
    await serial(async () => {
      const config = await readConfig();
      if (scheduled && !stopped && selected.length) {
        config.rules = config.rules.map(rule => {
          if (!rule.enabled || !selected.some(task => task.id === rule.id && task.nextRunAt === rule.nextRunAt)) return rule;
          const once = rule.schedule?.type === 'once';
          return { ...rule, nextRunAt: once ? null : nextTime(rule, now()), enabled: !once, completed: once };
        });
        config.revision++;
        updateNextRun(config);
        await api.storage.local.set({ [autoConfigStorage]: config });
        previews.clear();
      }
      await schedule(config);
    });
  }
  async function performRun(runGeneration, selectedIds, scheduled) {
    let privacy;
    let selected = [];
    let scanned = { items: [] };
    let runError;
    const privacyAtStart = privacyGeneration;
    const result = { phase: 'done', removed: 0, remaining: 0, skipped: 0, uncertain: 0, privateCleanup: true,
      ...(recoveryIncomplete ? { incomplete: true } : {}) };
    try {
      const config = await readConfig();
      if (!runnable(config) || runGeneration !== generation) return;
      selected = enabledRules(config).filter(rule => selectedIds.includes(rule.id));
      if (!selected.length) return;
      privacy = await readPrivacy();
      privateDuringRun ||= privacy.privateCleanup || recoveryPrivate;
      result.privateCleanup = privacy.privateCleanup;
      // Persist recovery metadata before the first destructive call, including private runs.
      await serial(() => api.storage.local.set({ [autoRuntimeStorage]: { inProgress: true, privateCleanup: privateDuringRun } }));
      const cutoff = now();
      const sites = await readProtectedSites();
      scanned = await scan(selected, sites, cutoff);
      let verificationFailed = false;
      for (const item of scanned.items) {
        if (runGeneration !== generation) { result.phase = 'stopped'; break; }
        const latestConfig = await readConfig();
        if (latestConfig.paused) { result.phase = 'stopped'; break; }
        const rule = latestConfig.rules.find(rule => rule.id === item.ruleId && rule.enabled);
        if (!rule || !ruleMatches(rule, item.url) || isProtectedUrl(item.url, await readProtectedSites())) { result.skipped++; continue; }
        let visits;
        try { visits = await api.history.getVisits({ url: item.url }); }
        catch { verificationFailed = true; result.skipped++; continue; }
        if (!visits.length) { result.skipped++; continue; }
        const times = visits.map(visit => visit.visitTime);
        // Unknown timestamps must never fall back to the older scan timestamp.
        if (times.some(time => !Number.isFinite(time) || time <= 0) || !isExpired(Math.max(...times), rule.days, cutoff)) { result.skipped++; continue; }
        let deleted = false;
        let skippedRetry = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (runGeneration !== generation) break;
          // Retry eligibility too: Chrome's deletion is URL-wide and has no atomic predicate.
          if (attempt) {
            const retryVisits = await api.history.getVisits({ url: item.url });
            if (!retryVisits.length || retryVisits.some(visit => !isExpired(visit.visitTime, rule.days, cutoff))) { skippedRetry = true; break; }
          }
          // A pause can arrive while visit details are pending, including between retries.
          const beforeDelete = await readConfig();
          const currentRule = beforeDelete.rules.find(candidate => candidate.id === item.ruleId && candidate.enabled);
          const protectedNow = isProtectedUrl(item.url, await readProtectedSites());
          if (runGeneration !== generation || beforeDelete.paused || !currentRule || protectedNow) { skippedRetry = true; break; }
          try { await api.history.deleteUrl({ url: item.url }); deleted = true; break; } catch {}
        }
        if (!deleted) { if (skippedRetry) result.skipped++; else result.remaining++; continue; }
        try {
          if ((await api.history.getVisits({ url: item.url })).length) result.remaining++;
          else { result.removed++; item.confirmed = true; }
        } catch { verificationFailed = true; result.uncertain++; }
      }
      if (runGeneration !== generation) result.phase = 'stopped';
      else if (verificationFailed) result.phase = 'verifyFailed';
      else if (result.remaining) result.phase = 'partial';
    } catch (error) {
      result.phase = 'failed';
      runError = error.message === 'AUTO_SCAN_INCOMPLETE' ? error.message : 'AUTO_UNAVAILABLE';
    } finally {
      try {
        const canRecord = async () => Boolean(privacy && !privacy.privateCleanup && !privateDuringRun &&
          privacyAtStart === privacyGeneration && !(await readPrivacy()).privateCleanup);
        if (result.removed && await canRecord()) {
          await recordActivity(result.removed, scanned.items.filter(item => item.confirmed), canRecord)
            .catch(() => { runError = 'AUTO_ACTIVITY_FAILED'; });
        }
        // Serialize the final summary with privacy changes; no URL list enters storage.
        await serial(async () => {
          const visible = await canRecord();
          await api.storage.local.set({ [autoRuntimeStorage]: { inProgress: false,
            ...(visible ? { result } : {}), ...(runError ? { error: runError } : {}) } });
          recoveryIncomplete = false;
          recoveryPrivate = false;
        });
      } catch {
        await serial(() => api.storage.local.set({ [autoRuntimeStorage]: { inProgress: false, error: 'AUTO_UNAVAILABLE' } })).catch(() => {});
      }
      // Keep this task busy until its schedule has settled, so another run cannot overtake it.
      await finishSchedule(selected, scheduled, result.phase === 'stopped' || runGeneration !== generation).catch(() => {});
      active = false;
      stopping = false;
      onStateChange();
    }
  }
  function launch(selectedIds, scheduled) {
    if (active) throw autoError('AUTO_BUSY');
    active = true;
    stopping = false;
    privateDuringRun = false;
    const runGeneration = generation;
    // Manual and scheduled jobs share one queue. Scan only once the job owns deletion.
    void runExclusive(() => performRun(runGeneration, selectedIds, scheduled)).catch(() => { active = false; stopping = false; });
    onStateChange();
  }
  async function checkDue() {
    return serial(async () => {
      if (active) return;
      const config = await readConfig();
      const due = enabledRules(config).filter(rule => rule.nextRunAt !== null && rule.nextRunAt <= now());
      if (runnable(config) && due.length) launch(due.map(rule => rule.id), true);
      else await schedule(config);
    });
  }
  async function initialize() {
    if (!api.alarms) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const stored = (await api.storage.local.get(autoConfigStorage))[autoConfigStorage];
      if (stored?.version === 1) await api.storage.local.set({ [autoConfigStorage]: validateConfig(stored) });
      const runtime = (await api.storage.local.get(autoRuntimeStorage))[autoRuntimeStorage];
      if (runtime?.inProgress) {
        const privacy = await readPrivacy();
        recoveryIncomplete = true;
        recoveryPrivate = runtime.privateCleanup === true || privacy.privateCleanup;
        // Preserve the recovery marker until the fresh scan completes, even across another restart.
        await api.storage.local.set({ [autoRuntimeStorage]: { inProgress: true, privateCleanup: recoveryPrivate,
          ...(!recoveryPrivate ? { result: { phase: 'interrupted', removed: 0, remaining: 0, skipped: 0, privateCleanup: false } } : {}) } });
      }
      await checkDue();
    })().catch(error => { initialization = undefined; throw error; });
    return initialization;
  }
  async function handle(message, owner) {
    if (message.type === 'auto-get') return state();
    if (message.type === 'auto-preview') return preview(message, owner);
    return serial(async () => {
      const config = await readConfig();
      checkRevision(config, message.revision);
      if (message.type === 'auto-pause') {
        if (typeof message.paused !== 'boolean') throw autoError('AUTO_INVALID_RULE');
        if (message.paused) { generation++; stopping = active; }
        await saveConfig(config, { ...config, paused: message.paused });
        return state();
      }
      if (message.type === 'auto-toggle' && message.enabled === false) {
        if (!config.rules.some(rule => rule.id === message.id)) throw autoError('AUTO_STALE');
        await saveConfig(config, { ...config, rules: config.rules.map(rule => rule.id === message.id ? { ...rule, enabled: false, nextRunAt: null } : rule) });
        return state();
      }
      if (active || isBusy()) throw autoError('AUTO_BUSY');
      if (message.type === 'auto-run') {
        if (!runnable(config)) throw autoError('AUTO_UNAVAILABLE');
        await consumePreview(message, config, owner);
        launch(enabledRules(config).map(rule => rule.id), false);
        return { accepted: true };
      }
      if (message.type === 'auto-remove') {
        if (!config.rules.some(rule => rule.id === message.id)) throw autoError('AUTO_STALE');
        await saveConfig(config, { ...config, rules: config.rules.filter(rule => rule.id !== message.id) });
        return state();
      }
      if (message.type === 'auto-save' || message.type === 'auto-toggle') {
        const saved = config.rules.find(rule => rule.id === message.id);
        const rule = normalizeRule(message.type === 'auto-toggle' ? saved : message.rule);
        if (typeof message.enabled !== 'boolean') throw autoError('AUTO_INVALID_RULE');
        checkConflict(config, rule, message.id);
        const nextRunAt = message.enabled ? nextTime(rule, now()) : null;
        if (message.enabled && nextRunAt === null) throw autoError('AUTO_SCHEDULE_PAST');
        if (message.enabled) await consumePreview(message, config, owner, rule);
        const next = { id: saved?.id ?? crypto.randomUUID(), ...rule, enabled: message.enabled, nextRunAt, completed: false };
        const rules = saved ? config.rules.map(rule => rule.id === saved.id ? next : rule) : [...config.rules, next];
        await saveConfig(config, { ...config, rules });
        return state();
      }
      throw autoError('AUTO_UNAVAILABLE');
    });
  }
  return { handle, initialize, checkDue, busy: () => active,
    privacyChanged: value => {
      privacyGeneration++;
      if (active && value !== false) privateDuringRun = true;
      return serial(async () => {
      if (value === true || (await readPrivacy()).privateCleanup) {
        const runtime = (await api.storage.local.get(autoRuntimeStorage))[autoRuntimeStorage];
        if (runtime) await api.storage.local.set({ [autoRuntimeStorage]: { inProgress: runtime.inProgress === true,
          ...(runtime.inProgress ? { privateCleanup: true } : {}), ...(runtime.error ? { error: runtime.error } : {}) } });
      }
    }); },
  };
}
