import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { listProfiles, callProfile } from './client.mjs';
import { readLines } from './protocol.mjs';
import { VERSION } from './metadata.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const revision = { type: 'integer', minimum: 0 };
const schedule = { oneOf: [
  { type: 'object', properties: { type: { const: 'once' }, at: { type: 'integer', minimum: 1 } }, required: ['type', 'at'], additionalProperties: false },
  ...['daily', 'weekly', 'monthly'].map(type => ({ type: 'object', properties: { type: { const: type }, time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
    ...(type === 'weekly' ? { weekday: { type: 'integer', minimum: 0, maximum: 6 } } : {}), ...(type === 'monthly' ? { day: { type: 'integer', minimum: 1, maximum: 31 } } : {}) },
    required: ['type', 'time', ...(type === 'weekly' ? ['weekday'] : type === 'monthly' ? ['day'] : [])], additionalProperties: false })),
] };
const rule = { type: 'object', properties: { domain: string, includeSubdomains: boolean, days: { type: ['integer', 'null'], minimum: 1 }, schedule }, required: ['domain', 'includeSubdomains', 'days'], additionalProperties: false };
const definitions = [
  ['profiles', 'List connected browser profile IDs. Ask the user to identify the profile shown on the extension Agent access page.', {}, []],
  ['health', 'Read local companion/MCP version, installed version, managed Skill integrity, and connection health. Returns no browsing history or local configuration paths.', {}, []],
  ['check_update', 'Check the fixed History Sweep publisher for a newer MCP/Skill bundle. Downloads version metadata only; installing an update requires a user action in the extension.', {}, []],
  ['list', 'List cleanup task metadata and configuration revision. Returns no browsing history.', {}, []],
  ['preview', 'Preview a draft rule, one enabled saved task (id), or all enabled tasks. Returns aggregate counts only. No raw URLs or titles. Expires after five minutes.', { id: string, rule }, []],
  ['save', 'Request browser approval to create/update a task. Enabled tasks require a matching draft preview. Enabling schedules FUTURE deletions; it does not execute now.', { requestId: string, revision, id: string, rule, enabled: boolean, previewId: string }, ['requestId', 'revision', 'rule', 'enabled']],
  ['toggle', 'Request browser approval to enable/disable a saved task. Enabling requires a matching draft preview (same id and rule).', { requestId: string, revision, id: string, enabled: boolean, previewId: string }, ['requestId', 'revision', 'id', 'enabled']],
  ['pause', 'Request browser approval to pause/resume all tasks. Resuming enables future scheduled deletion.', { requestId: string, revision, paused: boolean }, ['requestId', 'revision', 'paused']],
  ['execute', 'Request browser approval to execute one enabled task or all enabled tasks from the matching saved-task preview. Chrome removes ALL visits to each matched URL. Pending or accepted is not completion.', { requestId: string, revision, id: string, previewId: string }, ['requestId', 'revision', 'previewId']],
  ['status', 'Read the status of a request from this MCP process. Retry the same requestId with identical arguments, never a new ID to bypass a rejection, timeout or uncertain result.', { requestId: string }, ['requestId']],
];
export const tools = definitions.map(([operation, description, properties, required]) => ({ name: `history_sweep_${operation}`, description,
  inputSchema: { type: 'object', properties: { ...(operation === 'profiles' ? {} : { profileId: string }), ...properties },
    required: [...(operation === 'profiles' ? [] : ['profileId']), ...required], additionalProperties: false },
  annotations: { readOnlyHint: ['profiles', 'list', 'preview', 'status', 'health', 'check_update'].includes(operation), destructiveHint: !['profiles', 'list', 'preview', 'status', 'health', 'check_update'].includes(operation), idempotentHint: true, openWorldHint: operation === 'check_update' } }));

export function createMcpHandler() {
  const clientId = randomUUID();
  let initialized = false;
  return async message => {
    const id = message?.id;
    const result = value => ({ jsonrpc: '2.0', id, result: value });
    const error = (code, text) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
    if (id === undefined) return;
    if (message.method === 'initialize') {
      initialized = true;
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'history-sweep', version: VERSION },
        instructions: 'Connect the browser extension first. Use explicit profile IDs. Task changes require browser approval. Task domains and aggregate counts may reach your model provider. Never read the private bridge discovery files or bypass browser approval.' });
    }
    if (!initialized) return error(-32002, 'Initialize first');
    if (message.method === 'ping') return result({});
    if (message.method === 'tools/list') return result({ tools });
    if (message.method !== 'tools/call') return error(-32601, 'Method not found');
    const tool = tools.find(tool => tool.name === message.params?.name);
    if (!tool) return error(-32602, 'Unknown tool');
    const args = message.params.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) || tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) return error(-32602, 'Invalid arguments');
    try {
      const operation = tool.name.replace('history_sweep_', '');
      const { profileId, ...fields } = args;
      const data = operation === 'profiles' ? { profiles: await listProfiles() } : await callProfile(profileId, clientId, operation, fields);
      if (operation === 'health') { data.mcpVersion = VERSION; data.mcpRestartRequired = data.installedVersion !== VERSION; }
      return result({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
    } catch (reason) {
      const code = typeof reason?.message === 'string' && /^(AUTO|AGENT)_[A-Z_]+$/.test(reason.message) ? reason.message : 'AGENT_UNAVAILABLE';
      return result({ isError: true, content: [{ type: 'text', text: code }] });
    }
  };
}
export function runMcp() {
  const handle = createMcpHandler();
  readLines(process.stdin, message => {
    void handle(message).then(response => { if (response) process.stdout.write(JSON.stringify(response) + '\n'); });
  }, () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error or oversized message' } }) + '\n'));
  process.stdout.on('error', () => process.exit(1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runMcp();
