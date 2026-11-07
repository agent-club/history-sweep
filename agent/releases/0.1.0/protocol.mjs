import { endianness, homedir } from 'node:os';
import { join } from 'node:path';

export const dataDirectory = () => process.env.HISTORY_SWEEP_AGENT_HOME || join(homedir(), '.history-sweep', 'agents');
export const profilePattern = /^[0-9a-f-]{36}$/;
export const maxBytes = 1024 * 1024;

export function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBytes) throw new Error('AGENT_MESSAGE_TOO_LARGE');
  const length = Buffer.alloc(4);
  if (endianness() === 'LE') length.writeUInt32LE(body.length); else length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
export function readNative(stream, receive, invalid) {
  let pending = Buffer.alloc(0);
  stream.on('data', chunk => {
    try {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = endianness() === 'LE' ? pending.readUInt32LE() : pending.readUInt32BE();
        if (!size || size > maxBytes) throw new Error('AGENT_MESSAGE_TOO_LARGE');
        if (pending.length < size + 4) break;
        const value = JSON.parse(pending.subarray(4, size + 4).toString('utf8'));
        pending = pending.subarray(size + 4);
        receive(value);
      }
    } catch { invalid(); }
  });
  stream.on('end', () => { if (pending.length) invalid(); });
}
export function readLines(stream, receive, invalid) {
  let pending = Buffer.alloc(0);
  stream.on('data', chunk => {
    try {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > maxBytes) throw new Error('AGENT_MESSAGE_TOO_LARGE');
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        if (line.trim()) receive(JSON.parse(line));
      }
      if (pending.length > maxBytes) throw new Error('AGENT_MESSAGE_TOO_LARGE');
    } catch { pending = Buffer.alloc(0); invalid(); }
  });
}
