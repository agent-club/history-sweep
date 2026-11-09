const STORE_ID = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
const STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const VERSION_URL = 'https://sweep.agentclub.dev/extension-updates.json';
const CHECK_INTERVAL = 15 * 60 * 1000;
// Leave room for the 5-second metadata fetch within the view's 15-second deadline.
const STORE_CHECK_TIMEOUT = 8_000;
const STORE_TIMEOUT_RETRY_INTERVAL = 30_000;
const STORE_CHECK_TIMED_OUT = Symbol('store check timed out');

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.some(part => part > 65535) || parts.every(part => part === 0) ? null : parts;
}

export function isNewerVersion(candidate, installed) {
  const next = parseVersion(candidate), current = parseVersion(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 4; index++) {
    const difference = (next[index] || 0) - (current[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

export function createUpdateChecker(chrome, { fetchVersion = globalThis.fetch, now = Date.now } = {}) {
  let checking;
  async function check(manual) {
    const installedVersion = chrome.runtime.getManifest().version;
    const checkedAt = now();
    const save = data => chrome.storage.local.set({ extensionUpdateCheck: { installedVersion, checkedAt, ...data } });
    let channel = 'unknown', publishedVersion, storeCheckedAt, storeStatus, storeTimer;
    const saveDelayed = () => save({
      channel, status: 'delayed', version: publishedVersion, storeCheckedAt, storeStatus: 'timeout',
      retryAt: storeCheckedAt + STORE_TIMEOUT_RETRY_INTERVAL,
    });
    try {
      const self = await chrome.management.getSelf();
      channel = self.installType === 'development' ? 'development' : self.installType === 'admin' ? 'managed' :
        self.id === STORE_ID && self.installType === 'normal' && self.updateUrl === STORE_UPDATE_URL ? 'store' : 'other';
      // A local directory, fork or enterprise update source must not use this store channel.
      if (channel !== 'store') { await save({ channel, status: 'manual' }); return null; }
      const { extensionUpdateCheck: previous } = await chrome.storage.local.get('extensionUpdateCheck');
      if (!manual && previous?.channel === channel && previous?.installedVersion === installedVersion && Number.isFinite(previous.checkedAt) &&
          checkedAt >= previous.checkedAt && checkedAt - previous.checkedAt < CHECK_INTERVAL) {
        if (previous.status === 'checking') await save({ ...previous, status: 'error' });
        return null;
      }
      // Persist before the request so reopening views or suspending the worker cannot cause a request loop.
      const sameInstall = previous?.installedVersion === installedVersion && previous.channel === channel;
      storeCheckedAt = sameInstall ? previous.storeCheckedAt : undefined;
      storeStatus = sameInstall ? previous.storeStatus : undefined;
      publishedVersion = sameInstall && isNewerVersion(previous.version, installedVersion) ? previous.version : undefined;
      await save({ channel, status: 'checking', storeCheckedAt, storeStatus, ...(publishedVersion ? { version: publishedVersion } : {}) });
      let metadataFailed = false;
      try {
        const response = await fetchVersion(VERSION_URL, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
          cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('VERSION_UNAVAILABLE');
        const hint = await response.json();
        if (hint?.extensionId !== STORE_ID || !parseVersion(hint.version)) throw new Error('INVALID_VERSION');
        publishedVersion = isNewerVersion(hint.version, installedVersion) ? hint.version : undefined;
      } catch {
        metadataFailed = true;
        if (!manual) throw new Error('VERSION_UNAVAILABLE');
      }
      if (!publishedVersion && !manual) {
        await save({ channel, status: 'current', storeCheckedAt, storeStatus }); return null;
      }
      // A timeout leaves Chrome's request running, so still space out explicit retries.
      const retryInterval = manual && storeStatus === 'timeout' ? STORE_TIMEOUT_RETRY_INTERVAL : CHECK_INTERVAL;
      if (Number.isFinite(storeCheckedAt) && checkedAt >= storeCheckedAt && checkedAt - storeCheckedAt < retryInterval) {
        if (storeStatus === 'timeout') await saveDelayed();
        else {
          const status = metadataFailed ? 'error' : storeStatus === 'throttled' ? 'throttled' : publishedVersion ? 'published' : 'current';
          await save({ channel, status, version: publishedVersion, storeCheckedAt, storeStatus });
        }
        return null;
      }
      storeCheckedAt = now();
      storeStatus = undefined;
      await save({ channel, status: 'checking', version: publishedVersion, storeCheckedAt });
      // A manual check can reach Chrome even when the website is stale or unavailable.
      // Remote metadata is only a hint. Only Chrome can make a downloaded update actionable.
      const result = await Promise.race([
        chrome.runtime.requestUpdateCheck(),
        new Promise((_, reject) => { storeTimer = setTimeout(reject, STORE_CHECK_TIMEOUT, STORE_CHECK_TIMED_OUT); }),
      ]);
      const ready = result.status === 'update_available' && isNewerVersion(result.version, installedVersion);
      if (!ready && !['no_update', 'throttled'].includes(result.status)) throw new Error('INVALID_STORE_RESULT');
      await save({ channel, status: ready ? 'ready' : result.status === 'throttled' ? 'throttled' : metadataFailed ? 'error' : publishedVersion ? 'published' : 'current',
        version: ready ? result.version : publishedVersion, storeCheckedAt, storeStatus: result.status });
      return ready ? result.version : null;
    } catch (error) {
      // Chrome can still signal a ready update after the extension stops waiting.
      if (error === STORE_CHECK_TIMED_OUT) await saveDelayed();
      else await save({ channel, status: 'error', storeCheckedAt, storeStatus, ...(publishedVersion ? { version: publishedVersion } : {}) });
      return null;
    } finally {
      clearTimeout(storeTimer);
    }
  }
  return ({ manual = false } = {}) => {
    if (!checking) checking = check(manual).catch(() => null).finally(() => { checking = undefined; });
    return checking;
  };
}
