const STORE_ID = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
const STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const VERSION_URL = 'https://sweep.agentclub.dev/extension-updates.json';
const CHECK_INTERVAL = 15 * 60 * 1000;

export function isNewerVersion(candidate, installed) {
  const parse = value => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.some(part => part > 65535) || parts.every(part => part === 0) ? null : parts;
  };
  const next = parse(candidate), current = parse(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 4; index++) {
    const difference = (next[index] || 0) - (current[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

export function createUpdateChecker(chrome, { fetchVersion = globalThis.fetch, now = Date.now } = {}) {
  let checking;
  async function check() {
    const self = await chrome.management.getSelf();
    // A local directory, fork or enterprise update source must not use this store channel.
    if (self.id !== STORE_ID || self.installType !== 'normal' || self.updateUrl !== STORE_UPDATE_URL) return null;
    const installedVersion = chrome.runtime.getManifest().version;
    const { extensionUpdateCheck: previous } = await chrome.storage.local.get('extensionUpdateCheck');
    const checkedAt = now();
    if (previous?.installedVersion === installedVersion && Number.isFinite(previous.checkedAt) &&
        checkedAt >= previous.checkedAt && checkedAt - previous.checkedAt < CHECK_INTERVAL) return null;
    // Persist before the request so reopening views or suspending the worker cannot cause a request loop.
    await chrome.storage.local.set({ extensionUpdateCheck: { installedVersion, checkedAt } });
    const response = await fetchVersion(VERSION_URL, {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const hint = await response.json();
    if (hint?.extensionId !== STORE_ID || !isNewerVersion(hint.version, installedVersion)) return null;
    // Remote metadata is only a hint. Only Chrome can make a downloaded update actionable.
    const result = await chrome.runtime.requestUpdateCheck();
    return result.status === 'update_available' && isNewerVersion(result.version, installedVersion) ? result.version : null;
  }
  return () => {
    if (!checking) checking = check().catch(() => null).finally(() => { checking = undefined; });
    return checking;
  };
}
