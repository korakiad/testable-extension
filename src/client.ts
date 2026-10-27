// Catalog lookup and REST calls. Kept free of the vscode module so it can be
// exercised from plain Node (see test/smoke.mjs).
import catalogJson from './catalog.json';

export interface Operation {
  name: string;
  access: 'read' | 'write';
  kind: 'rest' | 'local';
  method: string;
  path: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface Catalog {
  operations: Operation[];
  unavailable: { name: string; reason: string }[];
}

export const catalog = catalogJson as Catalog;

export function findOperation(name: string): Operation | undefined {
  return catalog.operations.find((o) => o.name === name);
}

export function unavailableReason(name: string): string | undefined {
  return catalog.unavailable.find((u) => u.name === name)?.reason;
}

/**
 * Organization-wide lists and searches. With apiKey "all" the tools run these with every API key
 * and return each organization's result; other reads look their IDs up one key at a time.
 */
export const ORG_WIDE = new Set([
  'getAllTestCases',
  'getOrgTestCaseSummary',
  'searchOrgExecutionsWithFilter',
  'countOrgExecutionsWithFilter',
  'getOrgReports',
  'getOrgScheduledTests',
  'getTestRunnerSources',
  'getOrg',
  'listIntegrations',
  'listVcsRoots',
]);

export function searchOperations(keywords: string[], limit = 20) {
  const terms = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return catalog.operations
    .map((op) => {
      // A hit in the name or path outweighs one buried in a long description.
      const title = `${op.name} ${op.path}`.toLowerCase();
      const description = op.description.toLowerCase();
      const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 0) + (description.includes(t) ? 1 : 0), 0);
      return { op, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ op }) => ({
      name: op.name,
      access: op.access,
      endpoint: `${op.method} ${op.path}`,
      summary: op.description.replace(/^\[[a-z]+\]\s+\S+\s+\S+\s*(—\s*)?/, '').split('\n')[0].slice(0, 200),
    }));
}

export function describeOperations(names: string[]) {
  const tools = [];
  const unknownTools = [];
  const unavailableTools = [];
  for (const name of names) {
    const op = findOperation(name);
    const reason = unavailableReason(name);
    if (op) tools.push({ name: op.name, access: op.access, description: op.description, inputSchema: op.inputSchema });
    else if (reason) unavailableTools.push({ name, reason });
    else unknownTools.push(name);
  }
  return { tools, unknownTools, unavailableTools };
}

/**
 * Testable embeds the caller's API key in the download and view URLs it
 * returns (`...?key=<api key>`). Strip it before text reaches the model or a log.
 */
export function redactSecrets(text: string): string {
  return text.replace(/([?&](?:key|apiKey|token)=)[^&\s"'<>\\]+/gi, '$1<redacted>');
}

export interface ApiRequest {
  method: string;
  url: string;
  body?: string;
}

/** Maps MCP-style arguments (path_*, query_*, rest = body) onto an HTTP request. */
export function buildRequest(op: Operation, args: Record<string, unknown>, apiUrl: string): ApiRequest {
  const missing = (op.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) throw new Error(`${op.name}: missing required argument(s) ${missing.join(', ')}`);

  const path = op.path.replace(/:([A-Za-z0-9_]+)/g, (_, p: string) => {
    const value = args[`path_${p}`];
    if (value === undefined || value === null || value === '') throw new Error(`${op.name}: missing path argument path_${p}`);
    return encodeURIComponent(String(value));
  });

  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || key.startsWith('path_')) continue;
    if (key.startsWith('query_')) {
      const name = key.slice('query_'.length);
      for (const v of Array.isArray(value) ? value : [value]) {
        query.append(name, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    } else {
      body[key] = value;
    }
  }

  const qs = query.toString();
  const hasBody = op.method !== 'GET' && Object.keys(body).length > 0;
  return {
    method: op.method,
    url: `${apiUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`,
    body: hasBody ? JSON.stringify(body) : undefined,
  };
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  contentType: string;
  /** Set for JSON and text responses. */
  text?: string;
  /** Set for everything else (images, archives, ...). */
  bytes?: Uint8Array;
}

const TEXTUAL = /json|text\/|csv|xml|javascript|yaml/i;

export async function sendRequest(req: ApiRequest, apiKey: string, signal?: AbortSignal): Promise<ApiResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: {
      'X-Testable-Key': apiKey,
      Accept: 'application/json, text/plain, */*',
      ...(req.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: req.body,
    signal,
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType || TEXTUAL.test(contentType)) {
    return { status: res.status, ok: res.ok, contentType, text: await res.text() };
  }
  return { status: res.status, ok: res.ok, contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** Operations the REST API has no endpoint for. */
export function runLocal(op: Operation, args: Record<string, unknown>): unknown {
  const list = (key: string) => (Array.isArray(args[key]) ? (args[key] as unknown[]).map(String) : []);
  switch (op.name) {
    case 'encode_base64':
      if (typeof args.text === 'string') return { encoded: Buffer.from(args.text, 'utf8').toString('base64') };
      return { results: list('texts').map((t) => ({ encoded: Buffer.from(t, 'utf8').toString('base64') })) };
    case 'decode_base64': {
      const decode = (s: string) =>
        /^[A-Za-z0-9+/_-]*={0,2}$/.test(s.trim())
          ? { text: Buffer.from(s.trim(), 'base64').toString('utf8') }
          : { error: 'Not a valid base64 string' };
      if (typeof args.encoded === 'string') return decode(args.encoded);
      return { results: list('encodedStrings').map(decode) };
    }
    default:
      throw new Error(`${op.name} has no local implementation`);
  }
}
