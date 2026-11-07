import { createServer } from 'node:net';
import { mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { dataDirectory, profilePattern, nativeFrame, readNative, readLines } from './protocol.mjs';
import { maintainCompanion, companionHealth } from './manage.mjs';

const connections = new Set();
const pending = new Map();
const instanceId = randomUUID();
const challenge = randomBytes(32).toString('hex');
let descriptor;
let server;
let starting = false;
let closing = false;
let monitor;
let mcpLastSeenAt = null;
const healthResult = data => ({ ...data, connected: true, mcpLastSeenAt });
const send = value => process.stdout.write(nativeFrame(value));
const authenticated = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(challenge) && timingSafeEqual(Buffer.from(value), Buffer.from(challenge));
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(monitor);
  for (const socket of connections) socket.destroy();
  server?.close();
  if (descriptor) await unlink(descriptor).catch(() => {});
  process.stdin.destroy();
}
async function start(message) {
  if (starting || !profilePattern.test(message.profileId)) throw new Error('AGENT_INVALID_PROFILE');
  starting = true;
  const root = dataDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(root, 0o700);
  server = createServer(socket => {
    if (connections.size >= 64) { socket.destroy(); return; }
    connections.add(socket);
    socket.setTimeout(35000, () => socket.destroy());
    let used = false;
    readLines(socket, request => {
      if (used || !request || !authenticated(request.challenge)) { socket.destroy(); return; }
      used = true;
      if (request.operation === 'ping') { socket.end(JSON.stringify({ ok: true, profileId: message.profileId }) + '\n'); return; }
      mcpLastSeenAt = new Date().toISOString();
      if (['health', 'check_update'].includes(request.operation)) {
        maintainCompanion(request.operation === 'health' ? 'health' : 'check').then(
          data => socket.end(JSON.stringify({ ok: true, data: healthResult(data) }) + '\n'),
          error => socket.end(JSON.stringify({ ok: false, code: /^AGENT_[A-Z_]+$/.test(error?.message) ? error.message : 'AGENT_UNAVAILABLE' }) + '\n'),
        ).catch(() => socket.destroy());
        return;
      }
      if (pending.size >= 64) { socket.end(JSON.stringify({ ok: false, code: 'AGENT_BUSY' }) + '\n'); return; }
      const id = randomUUID();
      pending.set(id, socket);
      socket.once('close', () => pending.delete(id));
      send({ id, clientId: request.clientId, operation: request.operation, args: request.args });
    }, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  server.on('error', () => { process.exitCode = 1; void shutdown(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  if (closing) { server.close(); return; }
  descriptor = join(root, `${message.profileId}-${instanceId}.json`);
  await writeFile(descriptor, JSON.stringify({ profileId: message.profileId, port: server.address().port, challenge }), { flag: 'wx', mode: 0o600 });
  if (closing) { await unlink(descriptor).catch(() => {}); return; }
  send({ type: 'ready' });
  monitorUpdates(message.checkUpdates !== false);
}
function monitorUpdates(enabled) {
  clearInterval(monitor);
  if (!enabled || !process.env.HISTORY_SWEEP_COMPANION_ROOT) return;
  const check = async () => {
    const health = await companionHealth();
    const checkedAt = health.update?.checkedAt && Date.parse(health.update.checkedAt);
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= 24 * 60 * 60000) await maintainCompanion('check');
  };
  monitor = setInterval(() => { void check().catch(() => {}); }, 60 * 60000);
  monitor.unref();
  void check().catch(() => {});
}
readNative(process.stdin, message => {
  if (message?.type === 'hello') { void start(message).catch(() => { process.stderr.write('AGENT_HOST_UNAVAILABLE\n'); process.exitCode = 1; return shutdown(); }); return; }
  if (message?.type === 'monitor' && typeof message.enabled === 'boolean') { monitorUpdates(message.enabled); return; }
  if (message?.type === 'maintenance' && typeof message.id === 'string') {
    maintainCompanion(message.operation).then(
      data => send({ type: 'maintenance', id: message.id, ok: true, data: healthResult(data) }),
      error => send({ type: 'maintenance', id: message.id, ok: false, code: /^AGENT_[A-Z_]+$/.test(error?.message) ? error.message : 'AGENT_UNAVAILABLE' }),
    ).catch(() => {});
    return;
  }
  const socket = pending.get(message?.id);
  if (socket) { pending.delete(message.id); socket.end(JSON.stringify(message) + '\n'); }
}, () => { void shutdown(); });
process.stdin.on('end', () => { void shutdown(); });
process.stdin.on('error', () => { void shutdown(); });
process.stdout.on('error', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
