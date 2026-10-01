import { defaultTimeFilter, resolveTimeRange, parseProtectedSites, isProtectedUrl } from './history-filters.mjs';
import { createLauncher } from './launcher.mjs';

const launcher = createLauncher(chrome);
void launcher.register().catch(() => {});

const handoffs = new Map();
const jobs = new Map();
const modes = new Set(['smart', 'host-subdomains', 'host-exact', 'contains']);
let policyQueue = Promise.resolve();
let applyingUpdate = false;

function withPolicyLock(operation) {
  const result = policyQueue.then(operation);
  policyQueue = result.catch(() => {});
  return result;
}

const deletionRunning = () => [...jobs.values()].some(job => ['deleting', 'verifying'].includes(job.phase));

async function readUpdateState() {
  const { extensionUpdate } = await chrome.storage.session.get('extensionUpdate');
  // Session metadata survives worker suspension, but must not advertise an already installed version.
  if (!extensionUpdate || extensionUpdate.installedVersion !== chrome.runtime.getManifest().version ||
      typeof extensionUpdate.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(extensionUpdate.version) ||
      extensionUpdate.version === extensionUpdate.installedVersion) return { update: null };
  return { update: { version: extensionUpdate.version, busy: deletionRunning() } };
}

async function publishUpdateState() {
  const { update } = await readUpdateState();
  if (update) await chrome.storage.session.set({ extensionUpdate: { ...update, installedVersion: chrome.runtime.getManifest().version } });
}

chrome.runtime.onUpdateAvailable.addListener(({ version }) => {
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(version)) return;
  void withPolicyLock(() => chrome.storage.session.set({ extensionUpdate: {
    version, installedVersion: chrome.runtime.getManifest().version, busy: deletionRunning(),
  } })).catch(() => {});
});

async function readProtectedSites() {
  const data = await chrome.storage.local.get('protectedSites');
  if (data.protectedSites === undefined) return [];
  if (!Array.isArray(data.protectedSites) || !data.protectedSites.every(site => typeof site === 'string')) throw new Error('RULES_UNAVAILABLE');
  return parseProtectedSites(data.protectedSites.join('\n'));
}

async function openWorkspace(query, mode, filters) {
  resolveTimeRange(filters);
  const handoffId = crypto.randomUUID();
  // Only a one-use ID enters the tab URL; domains and filters stay in memory.
  handoffs.set(handoffId, { query, mode, filters, expires: Date.now() + 60000 });
  try { await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html#handoff=${handoffId}`) }); }
  catch (error) { handoffs.delete(handoffId); throw error; }
  setTimeout(() => handoffs.delete(handoffId), 60000);
}

function websiteHost(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname) return url.hostname;
  } catch {}
  throw new Error('CURRENT_SITE_UNAVAILABLE');
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'sweep-site', title: chrome.i18n.getMessage('sweepSite'), contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'sweep-site') return;
  try { void openWorkspace(websiteHost(info.pageUrl), 'host-exact', defaultTimeFilter()).catch(() => {}); } catch {}
});

function trustedPage(sender) {
  if (sender.id !== chrome.runtime.id || (sender.frameId != null && sender.frameId !== 0)) return false;
  const url = new URL(sender.url);
  return ['popup.html', 'manager.html'].some(page => `${url.protocol}//${url.host}${url.pathname}` === chrome.runtime.getURL(page));
}

function snapshot(job) {
  return { id: job.id, total: job.total, completed: job.completed, phase: job.phase, remaining: job.remaining };
}

function ownerKey(message, sender) {
  if (sender.documentId) return `document:${sender.documentId}`;
  // Chrome omits documentId/frameId/tab for real toolbar popups, unlike extension tabs.
  if (new URL(sender.url).pathname !== '/popup.html' || sender.tab != null || sender.frameId != null ||
      typeof message.clientId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(message.clientId)) {
    throw new Error('Invalid popup identity');
  }
  return `popup:${message.clientId}`;
}

async function runDeletion(job, urls) {
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
      while (cursor < urls.length) {
        const url = urls[cursor++];
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await chrome.history.deleteUrl({ url }); break; } catch {}
        }
        job.completed++;
      }
    }));
    job.phase = 'verifying';
    cursor = 0;
    const remaining = [];
    await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
      while (cursor < urls.length) {
        const url = urls[cursor++];
        if ((await chrome.history.getVisits({ url })).length) remaining.push(url);
      }
    }));
    job.remaining = remaining;
    job.phase = remaining.length ? 'partial' : 'done';
  } catch { job.phase = 'verifyFailed'; }
  finally {
    void withPolicyLock(publishUpdateState).catch(() => {});
    // Briefly retain results for the initiating page, without persisting history.
    setTimeout(() => jobs.delete(job.id), 60000);
  }
}

async function handleMessage(message, sender, owner) {
  if (message.type === 'get-update-state') return withPolicyLock(readUpdateState);
  if (message.type === 'apply-update') return withPolicyLock(async () => {
    if (applyingUpdate) throw new Error('UPDATE_RELOADING');
    const { update } = await readUpdateState();
    if (!update) throw new Error('UPDATE_UNAVAILABLE');
    if (deletionRunning()) throw new Error('UPDATE_BUSY');
    // Serialize reload with deletion acceptance, including requests from other open views.
    applyingUpdate = true;
    try { chrome.runtime.reload(); } catch (error) { applyingUpdate = false; throw error; }
    return {};
  });
  if (message.type === 'get-launch-preference') return { launchMode: await launcher.getMode() };
  if (message.type === 'set-launch-preference') return { launchMode: await launcher.setMode(message.launchMode) };
  if (message.type === 'open-workspace') {
    if (typeof message.query !== 'string' || !modes.has(message.mode)) throw new Error('Invalid handoff');
    // Older open pages may still send the original handoff shape until reloaded.
    await openWorkspace(message.query, message.mode, message.filters === undefined ? defaultTimeFilter() : message.filters);
    return {};
  }
  if (message.type === 'claim-workspace') {
    if (new URL(sender.url).pathname !== '/manager.html') throw new Error('Invalid page');
    const handoff = handoffs.get(message.handoffId);
    handoffs.delete(message.handoffId);
    if (!handoff || handoff.expires < Date.now()) throw new Error('Expired handoff');
    return { query: handoff.query, mode: handoff.mode, filters: handoff.filters };
  }
  if (message.type === 'current-site') {
    if (new URL(sender.url).pathname !== '/popup.html') throw new Error('CURRENT_SITE_UNAVAILABLE');
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return { hostname: websiteHost(tab?.url) };
  }
  if (message.type === 'get-protection') return withPolicyLock(async () => ({ sites: await readProtectedSites() }));
  if (message.type === 'save-protection') {
    const sites = parseProtectedSites(message.input);
    return withPolicyLock(async () => {
      // A newly protected site must never race a confirmed deletion already in flight.
      if ([...jobs.values()].some(job => ['deleting', 'verifying'].includes(job.phase))) throw new Error('RULES_BUSY');
      await chrome.storage.local.set({ protectedSites: sites });
      return { sites };
    });
  }
  if (message.type === 'start-delete') {
    if (!Array.isArray(message.urls) || !message.urls.length || message.urls.length > 100000 ||
        !message.urls.every(url => {
          if (typeof url !== 'string') return false;
          try { new URL(url); return true; } catch { return false; }
        })) throw new Error('Invalid URLs');
    return withPolicyLock(async () => {
      if (applyingUpdate) throw new Error('UPDATE_RELOADING');
      const sites = await readProtectedSites();
      if (message.urls.some(url => isProtectedUrl(url, sites))) throw new Error('PROTECTED_URL');
      // The worker owns the operation, independent of the popup/message channel.
      const job = { id: crypto.randomUUID(), owner, total: new Set(message.urls).size, completed: 0, phase: 'deleting', remaining: [] };
      jobs.set(job.id, job);
      // Notify every view without making history deletion depend on update UI storage.
      await publishUpdateState().catch(() => {});
      void runDeletion(job, [...new Set(message.urls)]);
      return snapshot(job);
    });
  }
  if (message.type === 'delete-status') {
    const job = jobs.get(message.id);
    if (!job || job.owner !== owner) throw new Error('Missing job');
    return snapshot(job);
  }
  if (message.type === 'release-delete') {
    const job = jobs.get(message.id);
    if (job?.owner === owner && !['deleting', 'verifying'].includes(job.phase)) jobs.delete(message.id);
    return {};
  }
  throw new Error('Unknown message');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== 'string') return false;
  // Web-accessible modal frames must claim a toolbar-created session before accessing the UI.
  if (message.type === 'claim-modal') {
    launcher.claimModal(message.token, sender).then(ok => respond({ ok }), () => respond({ ok: false }));
    return true;
  }
  let owner;
  let modal = false;
  try {
    modal = sender.id === chrome.runtime.id && sender.frameId > 0 &&
      sender.url.split('#')[0] === chrome.runtime.getURL('modal.html');
    if (!modal && !trustedPage(sender)) return false;
    owner = ownerKey(message, sender);
  }
  catch { return false; }
  const authorized = modal ? launcher.isTrustedModal(sender) : Promise.resolve(true);
  authorized.then(trusted => {
    if (!trusted) throw new Error('Invalid modal session');
    return handleMessage(message, sender, owner);
  }).then(data => respond({ ok: true, data }), error => {
    const code = ['CURRENT_SITE_UNAVAILABLE', 'INVALID_TIME_RANGE', 'INVALID_PROTECTED_SITES', 'RULES_BUSY', 'PROTECTED_URL', 'UPDATE_BUSY', 'UPDATE_UNAVAILABLE', 'UPDATE_RELOADING'].includes(error.message) ? error.message : undefined;
    respond({ ok: false, ...(code ? { code } : {}) });
  });
  return true;
});
