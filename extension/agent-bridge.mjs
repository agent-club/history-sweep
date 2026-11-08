import { createAgentAccess, agentError } from './agent-access.mjs';
import { agentWorkKey } from './agent-motion.mjs';

const reconnectAlarm = 'history-sweep-agent-reconnect';
export const isAgentMessage = message => ['agent-state', 'agent-connect', 'agent-disconnect', 'agent-decide', 'agent-monitor', 'agent-check-updates', 'agent-apply-update'].includes(message?.type);
export function installAgentBridge(api, engine) {
  let port;
  let connected = false;
  let profileId;
  let connecting;
  let connectionError;
  let maintenanceBusy = false;
  let reviewTabId;
  const pendingMaintenance = new Map();
  const activeRequests = new Set();
  let workPublication = Promise.resolve();
  function publishWork() {
    const working = activeRequests.size > 0;
    // Keep start/stop notifications ordered when a tool returns before its start is published.
    workPublication = workPublication.then(() => api.storage.session.set({ [agentWorkKey]: working })).catch(() => {});
  }
  function clearWork() {
    activeRequests.clear();
    publishWork();
  }
  publishWork();
  const approvalURL = api.runtime.getURL('agent.html');
  const access = createAgentAccess({ engine, storage: api.storage.session, openApproval: async id => {
    const url = `${approvalURL}#request=${id}`;
    // URL-filtered queries can omit our own page without broad tabs permission.
    // Track only the trusted review page that has actually contacted this worker.
    if (reviewTabId !== undefined) {
      try { await api.tabs.update(reviewTabId, { active: true, url }); return; }
      catch { reviewTabId = undefined; }
    }
    reviewTabId = (await api.tabs.create({ url })).id;
  } });
  const settings = async () => (await api.storage.local.get('agentConnection')).agentConnection;
  async function connect() {
    if (port) return;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!await api.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('AGENT_PERMISSION_REQUIRED');
      const saved = await settings();
      profileId = saved?.profileId ?? crypto.randomUUID();
      await api.storage.local.set({ agentConnection: { ...saved, enabled: true, profileId, checkUpdates: saved?.checkUpdates !== false } });
      const native = api.runtime.connectNative('dev.agentclub.history_sweep');
      port = native;
      native.onMessage.addListener(message => {
        if (port !== native) return;
        if (message?.type === 'ready') { connected = true; connectionError = undefined; return; }
        if (message?.type === 'maintenance') {
          const pending = pendingMaintenance.get(message.id);
          if (!pending || pending.native !== native) return;
          pendingMaintenance.delete(message.id); clearTimeout(pending.timer);
          if (!message.ok) pending.reject(new Error(message.code));
          else if (!message.data || typeof message.data.runningVersion !== 'string' || typeof message.data.installedVersion !== 'string' || !Number.isSafeInteger(message.data.skillCount)) pending.reject(new Error('AGENT_INVALID_RESPONSE'));
          else pending.resolve(message.data);
          return;
        }
        if (!message || typeof message.id !== 'string') return;
        // Status polls track approvals and should not animate the toolbar.
        const work = message.operation !== 'status' ? Symbol() : null;
        if (work) {
          activeRequests.add(work);
          if (activeRequests.size === 1) publishWork();
        }
        access.request(message.clientId, message.operation, message.args).then(
          data => { if (port === native) native.postMessage({ id: message.id, ok: true, data }); },
          error => { if (port === native) native.postMessage({ id: message.id, ok: false, code: agentError(error) }); },
        ).catch(() => {}).finally(() => {
          if (work && activeRequests.delete(work) && !activeRequests.size) publishWork();
        });
      });
      native.onDisconnect.addListener(() => {
        connectionError = api.runtime.lastError?.message?.includes('not found') ? 'AGENT_HOST_NOT_FOUND' : 'AGENT_CONNECT_FAILED';
        if (port === native) { port = undefined; connected = false; clearWork(); }
        for (const [id, pending] of pendingMaintenance) if (pending.native === native) {
          clearTimeout(pending.timer); pendingMaintenance.delete(id); pending.reject(new Error('AGENT_DISCONNECTED'));
        }
      });
      native.postMessage({ type: 'hello', profileId, checkUpdates: saved?.checkUpdates !== false });
      await api.alarms.create(reconnectAlarm, { periodInMinutes: 1 });
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function disconnect() {
    const saved = await settings();
    await api.storage.local.set({ agentConnection: { ...saved, enabled: false } });
    if (port) { const native = port; port = undefined; connected = false; clearWork(); native.disconnect(); }
    await api.alarms.clear(reconnectAlarm);
    await access.disconnect();
  }
  function requestMaintenance(operation) {
    if (!port || !connected) return Promise.reject(new Error('AGENT_DISCONNECTED'));
    const native = port;
    // Chrome 110 lacks Promise.withResolvers; keep the callback bridge inside its owner.
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pendingMaintenance.delete(id); reject(new Error('AGENT_TIMEOUT')); }, operation === 'update' ? 180000 : 20000);
      pendingMaintenance.set(id, { resolve, reject, timer, native });
      try { native.postMessage({ type: 'maintenance', id, operation }); }
      catch { clearTimeout(timer); pendingMaintenance.delete(id); reject(new Error('AGENT_DISCONNECTED')); }
    });
  }
  async function handle(message) {
    if (message.type === 'agent-connect') await connect();
    if (message.type === 'agent-disconnect') await disconnect();
    if (message.type === 'agent-decide') await access.decide(message.id, message.approved);
    if (message.type === 'agent-monitor') {
      if (typeof message.enabled !== 'boolean') throw new Error('AGENT_INVALID_REQUEST');
      const saved = await settings();
      await api.storage.local.set({ agentConnection: { ...saved, checkUpdates: message.enabled } });
      port?.postMessage({ type: 'monitor', enabled: message.enabled });
    }
    if (['agent-check-updates', 'agent-apply-update'].includes(message.type)) {
      if (maintenanceBusy) throw new Error('AGENT_UPDATE_BUSY');
      maintenanceBusy = true;
      try { await requestMaintenance(message.type === 'agent-check-updates' ? 'check' : 'update'); }
      finally { maintenanceBusy = false; }
    }
    const saved = await settings();
    const companion = connected ? await requestMaintenance('health').catch(() => null) : null;
    return { enabled: saved?.enabled === true, connected, connectionError, checkUpdates: saved?.checkUpdates !== false,
      companion, maintenanceBusy, profileId: saved?.profileId ?? null, approvals: await access.review() };
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    // Only the standalone review page can register its tab for subsequent requests.
    if (!isAgentMessage(message) || sender.id !== api.runtime.id || sender.frameId !== 0 || sender.url?.split('#')[0] !== approvalURL) return false;
    if (Number.isSafeInteger(sender.tab?.id)) reviewTabId = sender.tab.id;
    handle(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, code: agentError(error) }));
    return true;
  });
  const restore = async () => { if ((await settings())?.enabled) await connect(); };
  api.alarms.onAlarm.addListener(alarm => { if (alarm.name === reconnectAlarm) void restore().catch(() => {}); });
  api.runtime.onStartup.addListener(() => { void restore().catch(() => {}); });
  void restore().catch(() => {});
  return { handle, reconcile: access.reconcile };
}
