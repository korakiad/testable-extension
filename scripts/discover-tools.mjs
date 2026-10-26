// One-off discovery: asks Testable's hosted MCP server which tools it exposes,
// using plain JSON-RPC over HTTP (no MCP SDK), and saves the result to discovery/.
// Usage: node scripts/discover-tools.mjs [endpoint]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const key = env.TESTABLE_API_KEY;
if (!key) throw new Error('TESTABLE_API_KEY missing from .env');

const endpoint = process.argv[2] ?? 'https://mcp.testable.io';
let sessionId;
let nextId = 1;

async function rpc(method, params, { notification = false } = {}) {
  const body = { jsonrpc: '2.0', method, ...(params && { params }), ...(!notification && { id: nextId++ }) };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'MCP-Protocol-Version': '2025-06-18',
      ...(sessionId && { 'Mcp-Session-Id': sessionId }),
    },
    body: JSON.stringify(body),
  });
  sessionId = res.headers.get('mcp-session-id') ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  if (notification || !text) return undefined;

  // Responses arrive either as plain JSON or as an SSE stream of `data:` lines.
  const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const reply = messages.find((m) => m.id === body.id);
  if (!reply) throw new Error(`${method}: no reply in ${text.slice(0, 300)}`);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'testable-extension-discovery', version: '0.0.1' },
});
await rpc('notifications/initialized', undefined, { notification: true });

const tools = [];
let cursor;
do {
  const page = await rpc('tools/list', cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);

// tools/list only carries short descriptions and empty schemas; the server's
// describe_tools tool returns the full descriptor for each name.
const descriptors = {};
const unknown = [];
const names = tools.map((t) => t.name);
for (let i = 0; i < names.length; i += 25) {
  const result = await rpc('tools/call', { name: 'describe_tools', arguments: { toolNames: names.slice(i, i + 25) } });
  if (result.isError) throw new Error(`describe_tools: ${JSON.stringify(result.content)}`);
  const payload = result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === 'text').text);
  for (const d of payload.tools ?? payload.descriptors ?? []) descriptors[d.name] = d;
  unknown.push(...(payload.unknownTools ?? []));
}

mkdirSync(new URL('../discovery/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../discovery/tools.json', import.meta.url),
  JSON.stringify(
    {
      endpoint,
      fetchedAt: new Date().toISOString(),
      server: init.serverInfo,
      instructions: init.instructions,
      tools: tools.map((t) => descriptors[t.name] ?? t),
      undescribed: names.filter((n) => !descriptors[n]),
      unknown,
    },
    null,
    2
  )
);
console.log(`described ${Object.keys(descriptors).length}/${names.length}`);
console.log(`server: ${JSON.stringify(init.serverInfo)}  protocol: ${init.protocolVersion}`);
console.log(`${tools.length} tools -> discovery/tools.json`);
for (const t of tools) console.log(`- ${t.name}`);
