const handoffs = new Map();
const jobs = new Map();
const modes = new Set(['smart', 'host-subdomains', 'host-exact', 'contains']);

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
    // Briefly retain results for the initiating page, without persisting history.
    setTimeout(() => jobs.delete(job.id), 60000);
  }
}

async function handleMessage(message, sender, owner) {
  if (message.type === 'open-workspace') {
    if (typeof message.query !== 'string' || !modes.has(message.mode)) throw new Error('Invalid handoff');
    const handoffId = crypto.randomUUID();
    // A one-use routing ID enters the tab URL; search terms stay in memory.
    handoffs.set(handoffId, { query: message.query, mode: message.mode, expires: Date.now() + 60000 });
    try { await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html#handoff=${handoffId}`) }); }
    catch (error) { handoffs.delete(handoffId); throw error; }
    setTimeout(() => handoffs.delete(handoffId), 60000);
    return {};
  }
  if (message.type === 'claim-workspace') {
    if (new URL(sender.url).pathname !== '/manager.html') throw new Error('Invalid page');
    const handoff = handoffs.get(message.handoffId);
    handoffs.delete(message.handoffId);
    if (!handoff || handoff.expires < Date.now()) throw new Error('Expired handoff');
    return { query: handoff.query, mode: handoff.mode };
  }
  if (message.type === 'start-delete') {
    if (!Array.isArray(message.urls) || !message.urls.length || message.urls.length > 100000 ||
        !message.urls.every(url => {
          if (typeof url !== 'string') return false;
          try { new URL(url); return true; } catch { return false; }
        })) throw new Error('Invalid URLs');
    // The worker owns the operation, independent of the popup/message channel.
    const job = { id: crypto.randomUUID(), owner, total: new Set(message.urls).size, completed: 0, phase: 'deleting', remaining: [] };
    jobs.set(job.id, job);
    void runDeletion(job, [...new Set(message.urls)]);
    return snapshot(job);
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
  // Only top-level extension UI pages may invoke history operations or consume handoffs.
  let owner;
  try {
    if (!trustedPage(sender) || !message || typeof message.type !== 'string') return false;
    owner = ownerKey(message, sender);
  }
  catch { return false; }
  handleMessage(message, sender, owner).then(data => respond({ ok: true, data }), () => respond({ ok: false }));
  return true;
});
