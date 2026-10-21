// Configuration only: no history or activity log access.
export const CONFIG_KEY = 'syncMetadata';
export const CONNECTION_KEY = 'syncConnection';
export const MAX_CONFIG_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const size = value => encoder.encode(value).length;

function labels(value, domains = false) {
  if (!record(value) || Object.keys(value).length > 1000) fail('INVALID_CONFIG');
  const result = {};
  for (const [key, entries] of Object.entries(value)) {
    if (!key || key.length > 253 || ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (domains ? !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(key) : !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(key)) ||
        !Array.isArray(entries) || entries.length > 30 || !entries.every(label => typeof label === 'string' && label.trim() && label.length <= 80)) fail('INVALID_CONFIG');
    result[key] = [...entries];
  }
  return result;
}

export function validateConfig(value) {
  if (!exactKeys(value, ['format', 'version', 'preferences', 'historyTags', 'domainLabels']) ||
      value.format !== 'history-sweep-config' || value.version !== 1 ||
      !exactKeys(value.preferences, ['language', 'theme', 'launchMode']) ||
      !['en', 'zh-CN'].includes(value.preferences.language) ||
      !['system', 'light', 'dark'].includes(value.preferences.theme) ||
      !['popup', 'modal', 'fullpage'].includes(value.preferences.launchMode)) fail('INVALID_CONFIG');
  const clean = { format: value.format, version: 1, preferences: { ...value.preferences },
    historyTags: labels(value.historyTags), domainLabels: labels(value.domainLabels, true) };
  if (size(JSON.stringify(clean)) > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
  return clean;
}

export function parseConfig(text) {
  if (typeof text !== 'string' || size(text) > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
  try { return validateConfig(JSON.parse(text)); } catch (error) {
    if (error.message === 'CONFIG_TOO_LARGE') throw error;
    fail('INVALID_CONFIG');
  }
}

function httpsUrl(text) {
  let url;
  try { url = new URL(text); } catch { fail('INVALID_CONNECTION'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('INVALID_CONNECTION');
  return url;
}

export function validateConnection(input) {
  if (!record(input) || size(JSON.stringify(input)) > 16 * 1024) fail('INVALID_CONNECTION');
  if (input.provider === 'webdav') {
    if (!exactKeys(input, ['provider', 'url', 'username', 'password']) ||
        !['url', 'username', 'password'].every(key => typeof input[key] === 'string') ||
        input.username.includes(':') || /[\r\n]/.test(input.username)) fail('INVALID_CONNECTION');
    const url = httpsUrl(input.url.trim());
    if (url.pathname.endsWith('/')) fail('INVALID_CONNECTION');
    return Object.fromEntries(['provider', 'url', 'username', 'password'].map(key => [key, key === 'url' ? url.href : input[key]]));
  }
  fail('INVALID_CONNECTION');
}

export function connectionUrl(input) {
  return validateConnection(input).url;
}

export const permissionOrigin = input => {
  const url = new URL(connectionUrl(input));
  // Host permissions cover ports; omit an explicit port for older supported Chrome versions.
  return `${url.protocol}//${url.hostname}/*`;
};

export function requestHeaders(input, extra = {}) {
  const config = validateConnection(input);
  const result = new Headers(extra);
  const bytes = encoder.encode(`${config.username}:${config.password}`);
  if (config.username || config.password) result.set('Authorization', `Basic ${btoa(String.fromCharCode(...bytes))}`);
  return result;
}

export function createRemote(input, { fetchImpl = globalThis.fetch, permissions = globalThis.chrome?.permissions } = {}) {
  const config = validateConnection(input);
  const url = connectionUrl(config);
  async function send(method, body = '', extra = {}) {
    if (!permissions || !await permissions.contains({ origins: [permissionOrigin(config)] })) fail('PERMISSION_REQUIRED');
    const headers = requestHeaders(config, extra);
    let response;
    try {
      response = await fetchImpl(url, { method, headers, ...(method === 'PUT' ? { body } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20_000) });
    } catch { fail('NETWORK_FAILED'); }
    if ([401, 403].includes(response.status)) fail('AUTH_FAILED');
    if ([409, 412].includes(response.status)) fail('SYNC_CONFLICT');
    if (!response.ok && response.status !== 404) fail('REMOTE_FAILED');
    return response;
  }
  return {
    async read() {
      const response = await send('GET');
      if (response.status === 404) return null;
      if (Number(response.headers.get('content-length')) > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
      // Bound responses even when the server omits Content-Length.
      const reader = response.body.getReader();
      const decoder = new TextDecoder(); let text = ''; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_CONFIG_BYTES) { await reader.cancel(); fail('CONFIG_TOO_LARGE'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) { if (error.message === 'CONFIG_TOO_LARGE') throw error; fail('NETWORK_FAILED'); }
      text += decoder.decode();
      return { config: parseConfig(text), etag: response.headers.get('etag') };
    },
    async write(value, previous) {
      const body = JSON.stringify(validateConfig(value));
      // Existing objects require a strong ETag: never replace without a condition.
      if (previous !== null && !/^"[^"\r\n]*"$/.test(previous?.etag ?? '')) fail('ETAG_REQUIRED');
      const response = await send('PUT', body, { 'Content-Type': 'application/json',
        ...(previous === null ? { 'If-None-Match': '*' } : { 'If-Match': previous.etag }) });
      if (response.status === 404) fail('REMOTE_FAILED');
    },
  };
}

const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unbase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const ITERATIONS = 310_000;
async function backupKey(password, salt, usage) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) fail('BACKUP_PASSPHRASE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function encryptBackup(connection, config, password) {
  const body = JSON.stringify({ connection: connection === null ? null : validateConnection(connection), config: validateConfig(config) });
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await backupKey(password, salt, 'encrypt'), encoder.encode(body));
  const bytes = new Uint8Array(ciphertext); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return JSON.stringify({ format: 'history-sweep-backup', version: 1, salt: base64(salt), iv: base64(iv), ciphertext: btoa(binary) });
}

export async function decryptBackup(text, password) {
  if (typeof text !== 'string' || size(text) > MAX_CONFIG_BYTES * 2) fail('INVALID_BACKUP');
  try {
    const value = JSON.parse(text);
    if (!exactKeys(value, ['format', 'version', 'salt', 'iv', 'ciphertext']) || value.format !== 'history-sweep-backup' || value.version !== 1 ||
        !['salt', 'iv', 'ciphertext'].every(key => typeof value[key] === 'string')) fail('INVALID_BACKUP');
    const salt = unbase64(value.salt); const iv = unbase64(value.iv);
    if (salt.length !== 16 || iv.length !== 12) fail('INVALID_BACKUP');
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await backupKey(password, salt, 'decrypt'), unbase64(value.ciphertext));
    const body = JSON.parse(new TextDecoder().decode(decrypted));
    if (!exactKeys(body, ['connection', 'config'])) fail('INVALID_BACKUP');
    return { connection: body.connection === null ? null : validateConnection(body.connection), config: validateConfig(body.config) };
  } catch { fail('INVALID_BACKUP'); }
}
