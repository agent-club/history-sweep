import { createConnection } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory, profilePattern, readLines } from './protocol.mjs';

async function exchange(descriptor, request, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: descriptor.port });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error('AGENT_TIMEOUT')));
    socket.on('error', () => finish(new Error('AGENT_DISCONNECTED')));
    socket.on('end', () => finish(new Error('AGENT_DISCONNECTED')));
    readLines(socket, value => finish(null, value), () => finish(new Error('AGENT_INVALID_RESPONSE')));
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, challenge: descriptor.challenge }) + '\n'));
  });
}
async function liveProfiles() {
  let files;
  try { files = await readdir(dataDirectory()); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const profiles = [];
  for (const name of files.filter(name => /^[0-9a-f-]+\.json$/.test(name)).slice(0, 100)) {
    let descriptor;
    try {
      descriptor = JSON.parse(await readFile(join(dataDirectory(), name), 'utf8'));
      if (!profilePattern.test(descriptor.profileId) || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.challenge !== 'string') continue;
      const result = await exchange(descriptor, { operation: 'ping' }, 500);
      if (result.profileId === descriptor.profileId) profiles.push(descriptor);
    } catch { /* Ignore stale descriptors left by a killed browser; never select another profile. */ }
  }
  return profiles;
}
export async function listProfiles() {
  return (await liveProfiles()).map(({ profileId }) => ({ profileId }));
}
export async function callProfile(profileId, clientId, operation, args) {
  if (!profilePattern.test(profileId)) throw new Error('AGENT_INVALID_PROFILE');
  const matches = (await liveProfiles()).filter(item => item.profileId === profileId);
  if (!matches.length) throw new Error('AGENT_PROFILE_DISCONNECTED');
  if (matches.length !== 1) throw new Error('AGENT_PROFILE_AMBIGUOUS');
  const result = await exchange(matches[0], { clientId, operation, args });
  if (!result.ok) throw new Error(result.code || 'AGENT_UNAVAILABLE');
  return result.data;
}
