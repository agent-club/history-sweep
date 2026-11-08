export const agentDanceAtlasUrl = 'https://raw.githubusercontent.com/agent-club/history-sweep/agent-dance-v1/extension/icons/agent-dance-motion.webp';
const atlasSha256 = '160f01659a89e0b894b81a7886b8fcd04696c8bc410c31d31ae251e9b41ef231';
const atlasSize = 2549306;

export async function loadAgentDanceAtlas() {
  const cache = await caches.open('history-sweep-agent-dance').catch(() => undefined);
  const cached = await cache?.match(agentDanceAtlasUrl).catch(() => undefined);
  if (cached) {
    const bitmap = await cached.blob().then(blob => createImageBitmap(blob)).catch(() => undefined);
    if (bitmap) return bitmap;
  }

  let response = await fetch(agentDanceAtlasUrl, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    signal: AbortSignal.timeout(12000),
  }).catch(() => undefined);
  if (!response || response.status === 404) {
    const installation = await chrome.management.getSelf().catch(() => undefined);
    if (installation?.installType === 'development') {
      // Source checkouts have the same pinned atlas, which release packages omit.
      const local = await fetch(new URL('./icons/agent-dance-motion.webp', import.meta.url)).catch(() => undefined);
      if (local?.ok) response = local;
    }
  }
  if (!response?.ok) throw new Error('Agent dance artwork download failed');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== atlasSize) throw new Error('Unexpected Agent dance artwork size');
  // The baked atlas must match the choreography bundled with the extension.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== atlasSha256) throw new Error('Unexpected Agent dance artwork checksum');

  const blob = new Blob([bytes], { type: 'image/webp' });
  const bitmap = await createImageBitmap(blob);
  await cache?.put(agentDanceAtlasUrl, new Response(blob)).catch(() => {});
  return bitmap;
}
