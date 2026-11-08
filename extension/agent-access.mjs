import { normalizeRule } from './auto-cleanup-model.mjs';

const key = 'agentApprovals';
const lifetime = 5 * 60000;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
const fail = code => { throw new Error(code); };
export const agentError = error => typeof error?.message === 'string' && /^(AUTO|AGENT)_[A-Z_]+$/.test(error.message) ? error.message : 'AGENT_UNAVAILABLE';

// Only the trusted extension page may call decide(); the native channel only submits requests.
export function createAgentAccess({ engine, storage, openApproval, now = () => Date.now() }) {
  let queue = Promise.resolve();
  const previews = new Map();
  const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const read = async () => (await storage.get(key))[key] ?? [];
  const write = entries => storage.set({ [key]: entries });
  const state = () => engine.handle({ type: 'auto-get' }, 'agent-state');
  const view = entry => {
    const { id, clientId, requestId, operation, summary, createdAt, expiresAt, status, error, executionId } = entry;
    return { id, clientId, requestId, operation, summary, createdAt, expiresAt, status, ...(error ? { error } : {}), ...(executionId ? { executionId } : {}) };
  };
  async function preview(args, clientId) {
    const current = await state();
    const message = args.rule !== undefined ? { type: 'auto-preview', rule: normalizeRule(args.rule), ...(args.id !== undefined ? { id: args.id } : {}) }
      : { type: 'auto-preview', all: true, ...(args.id !== undefined ? { id: args.id } : {}) };
    const result = await engine.handle({ ...message, exact: true }, `agent:${clientId}`);
    const previewId = result.previewId;
    for (const [id, proof] of previews) if (proof.expiresAt <= now() || proof.clientId === clientId) previews.delete(id);
    if (previews.size >= 64) fail('AGENT_BUSY');
    const summary = { rules: message.all ? current.config.rules.filter(rule => rule.enabled && (args.id === undefined || rule.id === args.id)).map(normalizeRule) : [result.rule],
      matches: result.items.length, protected: result.excluded, allVisits: true };
    previews.set(previewId, { clientId, message, revision: current.config.revision, expiresAt: now() + lifetime, summary });
    return { previewId, revision: current.config.revision, expiresAt: now() + lifetime, ...summary };
  }
  function action(operation, args, clientId, current) {
    if (args.revision !== current.config.revision) fail('AUTO_STALE');
    if (operation === 'pause') {
      if (typeof args.paused !== 'boolean') fail('AGENT_INVALID_REQUEST');
      return { message: { type: 'auto-pause', revision: args.revision, paused: args.paused }, summary: { paused: args.paused } };
    }
    const saved = current.config.rules.find(rule => rule.id === args.id);
    if (operation === 'save' && typeof args.enabled !== 'boolean') fail('AGENT_INVALID_REQUEST');
    if (operation === 'toggle' && (!saved || typeof args.enabled !== 'boolean')) fail('AGENT_INVALID_REQUEST');
    const rule = operation === 'save' ? normalizeRule(args.rule) : saved && normalizeRule(saved);
    const message = { type: { save: 'auto-save', toggle: 'auto-toggle', execute: 'auto-run' }[operation], revision: args.revision,
      ...(args.id !== undefined ? { id: args.id } : {}), ...(operation === 'save' ? { rule } : {}),
      ...(operation !== 'execute' ? { enabled: args.enabled } : {}) };
    if (operation !== 'execute' && !args.enabled) return { message, summary: { rules: [rule], enabled: false } };
    const proof = previews.get(args.previewId);
    if (!proof || proof.clientId !== clientId) fail('AUTO_PREVIEW_REQUIRED');
    if (proof.expiresAt <= now()) fail('AUTO_PREVIEW_EXPIRED');
    if (proof.revision !== args.revision || proof.message.id !== args.id ||
        (operation === 'execute' ? !proof.message.all : proof.message.all || JSON.stringify(proof.message.rule) !== JSON.stringify(rule))) fail('AUTO_STALE');
    return { message: { ...message, previewId: args.previewId }, summary: { ...proof.summary, ...(operation !== 'execute' ? { enabled: true } : {}) }, expiresAt: proof.expiresAt };
  }
  async function reconcile(entries) {
    const current = await state();
    let changed = false;
    for (const entry of entries) {
      if (entry.status === 'pending' && entry.expiresAt <= now()) { entry.status = 'expired'; changed = true; }
      if (entry.status === 'executing' && !entry.executionId) { entry.status = 'interrupted'; changed = true; }
      if (!entry.executionId || !['accepted', 'executing'].includes(entry.status)) continue;
      if (current.execution?.id === entry.executionId && current.execution.phase !== 'running') {
        entry.status = current.execution.phase; changed = true;
        if (current.error) entry.error = current.error;
      } else if (!current.running) {
        entry.status = 'interrupted'; changed = true;
      }
    }
    if (changed) await write(entries);
    return entries;
  }
  async function request(clientId, operation, args = {}) {
    if (!identifier(clientId) || !args || typeof args !== 'object' || Array.isArray(args)) fail('AGENT_INVALID_REQUEST');
    const fields = { list: [], preview: ['id', 'rule'], status: ['requestId'], save: ['requestId', 'revision', 'id', 'rule', 'enabled', 'previewId'],
      toggle: ['requestId', 'revision', 'id', 'enabled', 'previewId'], pause: ['requestId', 'revision', 'paused'], execute: ['requestId', 'revision', 'id', 'previewId'] }[operation];
    if (!fields || Object.keys(args).some(field => !fields.includes(field))) fail('AGENT_INVALID_REQUEST');
    if (args.rule !== undefined) args = { ...args, rule: normalizeRule(args.rule) };
    if (operation === 'list') { const current = await state(); return { config: current.config, running: current.running }; }
    if (operation === 'preview') return serial(() => preview(args, clientId));
    if (operation === 'status') return serial(async () => {
      const entries = await reconcile(await read());
      const entry = entries.find(entry => entry.clientId === clientId && entry.requestId === args.requestId);
      if (!entry) fail('AGENT_NOT_FOUND');
      return view(entry);
    });
    if (!['save', 'toggle', 'pause', 'execute'].includes(operation) || !identifier(args.requestId)) fail('AGENT_INVALID_REQUEST');
    return serial(async () => {
      const entries = await reconcile(await read());
      const fingerprint = JSON.stringify({ operation, args: Object.fromEntries(Object.keys(args).sort().map(key => [key, args[key]])) });
      const existing = entries.find(entry => entry.clientId === clientId && entry.requestId === args.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('AGENT_REQUEST_CONFLICT');
        return view(existing);
      }
      if (entries.filter(entry => entry.status === 'pending').length >= 20 || entries.length >= 256) fail('AGENT_APPROVAL_LIMIT');
      const prepared = action(operation, args, clientId, await state());
      const entry = { id: crypto.randomUUID(), clientId, requestId: args.requestId, operation, fingerprint, ...prepared,
        createdAt: now(), expiresAt: prepared.expiresAt ?? now() + lifetime, status: 'pending' };
      entries.push(entry);
      await write(entries);
      await openApproval(entry.id).catch(() => {});
      return view(entry);
    });
  }
  const review = () => serial(async () => (await reconcile(await read())).map(view));
  const decide = (id, approved) => serial(async () => {
    if (typeof approved !== 'boolean') fail('AGENT_INVALID_REQUEST');
    const entries = await reconcile(await read());
    const entry = entries.find(entry => entry.id === id);
    if (!entry) fail('AGENT_NOT_FOUND');
    if (entry.status !== 'pending') return view(entry);
    if (!approved) { entry.status = 'rejected'; await write(entries); return view(entry); }
    // Persist uncertainty before side effects: restart/retry must never execute it twice.
    entry.status = 'executing';
    if (entry.operation === 'execute') entry.executionId = crypto.randomUUID();
    await write(entries);
    try {
      const result = await engine.handle({ ...entry.message, ...(entry.executionId ? { executionId: entry.executionId } : {}) }, `agent:${entry.clientId}`);
      entry.status = entry.operation === 'execute' ? 'accepted' : 'done';
      if (entry.operation === 'save') entry.summary.savedId = result.config.rules.find(rule => rule.domain === entry.message.rule.domain)?.id;
    } catch (error) { entry.status = 'failed'; entry.error = agentError(error); }
    await write(entries);
    return view(entry);
  });
  const disconnect = () => serial(async () => {
    previews.clear();
    const entries = await read();
    for (const entry of entries) if (entry.status === 'pending') entry.status = 'rejected';
    await write(entries);
  });
  return { request, review, decide, disconnect, reconcile: () => serial(async () => { await reconcile(await read()); }) };
}
