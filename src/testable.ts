// Workflows behind the chat tools and the chat UI: test cases for the current
// repo, execution logs and artifacts, scenario file sync, scenario settings,
// scenario params and VCS roots. Kept free of the vscode module so it can be
// exercised from plain Node (see test/smoke.mjs).
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildRequest, findOperation, redactSecrets, sendRequest } from './client';

const TIMEOUT_MS = 60_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Which of the user's API keys a client uses; set by the extension, absent in plain Node. */
export interface AccountRef {
  id: string;
  name: string;
}

/** Thin wrapper over the catalog operations that parses JSON and throws on HTTP errors. */
export class Testable {
  constructor(
    private readonly apiKey: string,
    private readonly apiUrl: string,
    private readonly signal?: AbortSignal,
    readonly account?: AccountRef
  ) {}

  async run<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const op = findOperation(name);
    if (!op) throw new Error(`Unknown Testable operation ${name}`);
    const res = await sendRequest(buildRequest(op, args, this.apiUrl), this.apiKey, this.timeout());
    if (!res.ok) throw new HttpError(res.status, `${name} returned HTTP ${res.status}: ${errorMessage(res.text)}`);
    if (res.text === undefined) return res.bytes as T;
    try {
      return JSON.parse(res.text) as T;
    } catch {
      return res.text as T;
    }
  }

  /** Downloads a file endpoint such as /data-stores/:id/download as raw bytes. */
  async download(pathAndQuery: string): Promise<{ bytes: Uint8Array; contentType: string; fileName?: string }> {
    const res = await fetch(`${this.apiUrl.replace(/\/+$/, '')}${pathAndQuery}`, {
      headers: { 'X-Testable-Key': this.apiKey },
      signal: this.timeout(),
    });
    if (!res.ok) throw new HttpError(res.status, `GET ${pathAndQuery} returned HTTP ${res.status}`);
    const disposition = res.headers.get('content-disposition') ?? '';
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? '',
      fileName: disposition.match(/filename="?([^";]+)"?/)?.[1],
    };
  }

  private timeout(): AbortSignal {
    const limit = AbortSignal.timeout(TIMEOUT_MS);
    return this.signal ? AbortSignal.any([this.signal, limit]) : limit;
  }
}

/** Testable errors look like {"error":{"code":500,"message":"..."}}; anything else is shown as is. */
function errorMessage(text = ''): string {
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string') return redactSecrets(message);
  } catch {
    // Not JSON.
  }
  return redactSecrets(text).slice(0, 300);
}

// --- shared shapes ------------------------------------------------------------

export interface ScenarioParam {
  name: string;
  required?: boolean;
  defaultValue?: string;
}

export interface ScenarioRow {
  id: number;
  name: string;
  type: string;
  source?: string;
  repositoryId?: number;
  /** Branch the scenario checks out; VCS scenarios carry their own, separate from the root's default. */
  branch?: string;
  params: ScenarioParam[];
}

export interface ConfRow {
  id: number;
  name: string;
  testType: string;
  scenarioId?: number;
  params: Record<string, string>;
  lastRunAt?: string;
}

export interface TestCaseRow {
  id: number;
  name: string;
  path: string;
  lastRunAt?: string;
  lastExecutionId?: number;
  counts?: { pass: number; fail: number; notRun: number };
  scenarios: ScenarioRow[];
  /** Undefined when not loaded, to keep large orgs fast. */
  confs?: ConfRow[];
}

export interface RepoInfo {
  remote: string;
  branch?: string;
}

/** The test cases of one organization whose scenarios use one of the workspace's git remotes. */
export interface RepoLink {
  status: 'matched' | 'nomatch' | 'norepo' | 'unavailable';
  testCases: { id: number; path: string; lastRunAt?: string; lastExecutionId?: number }[];
  /** Latest run among those test cases. */
  lastRunAt?: string;
}

export interface TestsView {
  repos: RepoInfo[];
  /** How the list was narrowed to the workspace's git remote. */
  match: { status: 'matched' | 'nomatch' | 'norepo' | 'unavailable' | 'all'; note?: string };
  link: RepoLink;
  query?: string;
  total: number;
  testCases: TestCaseRow[];
}

const MAX_CONF_LOADS = 30;

// --- test cases ---------------------------------------------------------------

export async function listTests(t: Testable, repos: RepoInfo[], opts: { query?: string; allRepos?: boolean } = {}): Promise<TestsView> {
  let rows = await loadTestCases(t);
  const total = rows.length;
  const ids = repos.length ? await linkedIds(t, repos, rows) : undefined;
  const link = repoLink(repos, rows, ids);

  let match: TestsView['match'];
  if (opts.allRepos) match = { status: 'all' };
  else if (link.status === 'norepo') match = { status: 'norepo', note: 'No git remote found in this workspace, showing every test case.' };
  else if (link.status === 'unavailable') match = { status: 'unavailable', note: 'Could not read VCS roots with this API key, so the list is not narrowed to this repo.' };
  else if (link.status === 'nomatch') match = { status: 'nomatch', note: 'No scenario is linked to this repo, showing every test case.' };
  else {
    match = { status: 'matched' };
    rows = rows.filter((r) => ids?.has(r.id));
  }

  const q = opts.query?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => `${r.path} ${r.scenarios.map((s) => s.name).join(' ')}`.toLowerCase().includes(q));

  if (rows.length <= MAX_CONF_LOADS) {
    await mapLimit(rows, 4, async (row) => {
      row.confs = await loadTestCaseConfs(t, row.id);
    });
  }
  return { repos, match, link, query: opts.query, total, testCases: rows };
}

/** Which test cases of this API key's organization use one of the workspace's git remotes, and when they last ran. */
export async function findLinks(t: Testable, repos: RepoInfo[]): Promise<RepoLink> {
  if (!repos.length) return repoLink(repos, [], undefined);
  const rows = await loadTestCases(t);
  return repoLink(repos, rows, await linkedIds(t, repos, rows));
}

/** The entry whose linked test cases ran last; a linked test case that never ran still beats no link. */
export function latestLink<T extends { link?: RepoLink }>(entries: T[]): T | undefined {
  return entries
    .filter((e) => e.link?.status === 'matched')
    .sort((a, b) => time(b.link?.lastRunAt) - time(a.link?.lastRunAt))[0];
}

/** The apiKey value that asks a read to look in every organization; no key may be named it. */
export const EVERY_KEY = 'all';

export function isEveryKey(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === EVERY_KEY;
}

/** The account a tool's apiKey argument names: an exact match, else the only one that matches ignoring case. */
export function findAccount<T extends AccountRef>(accounts: T[], name: string): T | undefined {
  const wanted = name.trim();
  const loose = accounts.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
  return accounts.find((a) => a.name === wanted) ?? (loose.length === 1 ? loose[0] : undefined);
}

/** The ID of the organization an API key belongs to, or undefined when it has no test cases yet. */
export async function organizationId(t: Testable): Promise<number | undefined> {
  const cases = asList(await t.run('getAllTestCases'));
  return cases.find((c) => c.organizationId)?.organizationId;
}

async function loadTestCases(t: Testable): Promise<TestCaseRow[]> {
  const [cases, summary] = await Promise.all([
    t.run<any[]>('getAllTestCases'),
    t.run<any>('getOrgTestCaseSummary').catch(() => undefined),
  ]);
  return cases.filter((c) => !c.isFolder).map((c) => testCaseRow(c, summary?.testCases?.[c.id]));
}

/** IDs of the test cases with a scenario on one of the workspace's remotes, or undefined if VCS roots cannot be read. */
async function linkedIds(t: Testable, repos: RepoInfo[], rows: TestCaseRow[]): Promise<Set<number> | undefined> {
  const roots = await reposLinkedTo(t, repos, rows);
  return roots && new Set(rows.filter((r) => r.scenarios.some((s) => s.repositoryId && roots.has(s.repositoryId))).map((r) => r.id));
}

function repoLink(repos: RepoInfo[], rows: TestCaseRow[], ids: Set<number> | undefined): RepoLink {
  if (!repos.length) return { status: 'norepo', testCases: [] };
  if (!ids) return { status: 'unavailable', testCases: [] };
  const testCases = rows
    .filter((r) => ids.has(r.id))
    .map((r) => ({ id: r.id, path: r.path, lastRunAt: r.lastRunAt, lastExecutionId: r.lastExecutionId }))
    .sort((a, b) => time(b.lastRunAt) - time(a.lastRunAt));
  return { status: testCases.length ? 'matched' : 'nomatch', testCases, lastRunAt: testCases.find((c) => c.lastRunAt)?.lastRunAt };
}

/** IDs of the VCS roots that point at one of the workspace's remotes, or undefined if they cannot be read. */
async function reposLinkedTo(t: Testable, repos: RepoInfo[], rows: TestCaseRow[]): Promise<Set<number> | undefined> {
  let roots: { id: number; url?: string }[];
  try {
    roots = asList(await t.run('listVcsRoots'));
  } catch {
    // API keys get 401 on the list but can read each root, so look up the ones scenarios use.
    const ids = [...new Set(rows.flatMap((r) => r.scenarios.map((s) => s.repositoryId)).filter((id): id is number => !!id))];
    roots = (await Promise.all(ids.map((id) => getRepository(t, id)))).filter((r) => !r.error);
    if (ids.length && !roots.length) return undefined;
  }
  const wanted = new Set(repos.map((r) => normalizeGitUrl(r.remote)));
  return new Set(roots.filter((r) => wanted.has(normalizeGitUrl(r.url ?? ''))).map((r) => r.id));
}

function testCaseRow(c: any, summary: any): TestCaseRow {
  return {
    id: c.id,
    name: c.name,
    path: c.displayPath ?? c.path ?? c.name,
    lastRunAt: summary?.lastRunAt,
    lastExecutionId: summary?.lastRunExecutionId,
    counts: summary?.success && {
      pass: num(summary.success.pass),
      fail: num(summary.success.fail),
      notRun: num(summary.success.notRun),
    },
    scenarios: (c.scripts ?? []).map(scenarioRow),
  };
}

function scenarioRow(s: any): ScenarioRow {
  const repositoryId = Number(s.metadata?.repositoryId);
  return {
    id: s.id,
    name: s.name,
    type: s.scriptType,
    source: s.metadata?.sourceType,
    repositoryId: repositoryId > 0 ? repositoryId : undefined,
    branch: repositoryId > 0 ? s.metadata?.branch : undefined,
    params: s.paramsConfig ?? [],
  };
}

function confRow(c: any): ConfRow {
  return {
    id: c.id,
    name: c.name,
    testType: c.testType,
    scenarioId: c.script?.id ?? c.scriptId,
    params: parseParams(c.scriptParams),
    lastRunAt: c.lastRunAt,
  };
}

export async function loadTestCaseConfs(t: Testable, testCaseId: number): Promise<ConfRow[]> {
  return asList(await t.run('getTestCaseConfs', { path_testCaseId: testCaseId })).map(confRow);
}

/** Reduces https, ssh and scp-style git URLs to host/owner/repo for comparison. */
export function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/^([^/:]+):\d+\//, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// --- scenarios ----------------------------------------------------------------

export interface ScenarioFile {
  id: number;
  path: string;
  size?: number;
  contentType?: string;
  updatedAt?: string;
}

export interface Repository {
  id: number;
  url?: string;
  branch?: string;
  authType?: string;
  username?: string;
  error?: string;
}

export interface ScenarioDetail extends ScenarioRow {
  testCase?: { id: number; name: string };
  settings: Record<string, unknown>;
  files: ScenarioFile[];
  repository?: Repository;
  confs: ConfRow[];
  localDir: string;
}

export async function getScenario(t: Testable, scenarioId: number, root: string): Promise<ScenarioDetail> {
  const [s, confs] = await Promise.all([
    t.run('getScenario', { path_scriptId: scenarioId }),
    t.run('getScriptConfs', { path_scriptId: scenarioId }).then(asList, () => []),
  ]);
  const row = scenarioRow(s);
  return {
    ...row,
    testCase: s.testCase && { id: s.testCase.id, name: s.testCase.name },
    settings: s.metadata ?? {},
    files: (s.dataStores ?? []).filter((f: any) => !f.isFolder).map(scenarioFile),
    repository: row.repositoryId ? await getRepository(t, row.repositoryId) : undefined,
    confs: confs.map(confRow),
    localDir: scenarioDir(root, s),
  };
}

function scenarioFile(f: any): ScenarioFile {
  return { id: f.id, path: f.path ?? `/${f.name}`, size: f.size, contentType: f.type, updatedAt: f.updatedAt };
}

export function scenarioDir(root: string, s: { id: number; name: string }): string {
  return path.join(root, 'scenarios', `${s.id}-${slug(s.name)}`);
}

// --- scenario settings (metadata) ----------------------------------------------

export interface Change {
  key: string;
  from: unknown;
  to: unknown;
}

/**
 * Applies `changes` (keys may be dotted, e.g. "browsers.chrome") to a copy of
 * the scenario metadata. Keys that do not exist yet are rejected unless
 * allowNewKeys is set, so a typo such as "chrome_driver_only" cannot slip in.
 */
export function planSettings(current: Record<string, unknown>, changes: Record<string, unknown>, allowNewKeys = false) {
  const next = structuredClone(current);
  const diff: Change[] = [];
  const unknownKeys: string[] = [];
  for (const [key, to] of Object.entries(changes)) {
    const from = getPath(current, key);
    if (from === undefined && !allowNewKeys) {
      unknownKeys.push(key);
      continue;
    }
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    setPath(next, key, to);
    diff.push({ key, from, to });
  }
  return { next, diff, unknownKeys };
}

export async function updateScenarioSettings(t: Testable, scenarioId: number, changes: Record<string, unknown>, allowNewKeys = false) {
  const s = await t.run('getScenario', { path_scriptId: scenarioId });
  const plan = planSettings(s.metadata ?? {}, changes, allowNewKeys);
  if (plan.unknownKeys.length) {
    throw new Error(
      `Unknown setting(s) ${plan.unknownKeys.join(', ')} for scenario ${scenarioId}. Existing settings: ${Object.keys(s.metadata ?? {}).join(', ')}`
    );
  }
  if (plan.diff.length) await t.run('updateScript', { path_scriptId: scenarioId, metadata: plan.next });
  return plan.diff;
}

export async function previewScenarioSettings(t: Testable, scenarioId: number, changes: Record<string, unknown>, allowNewKeys = false) {
  const s = await t.run('getScenario', { path_scriptId: scenarioId });
  return { scenario: { id: s.id, name: s.name }, ...planSettings(s.metadata ?? {}, changes, allowNewKeys) };
}

// --- scenario params (configuration scriptParams) -------------------------------

export interface ConfDetail extends ConfRow {
  testCase?: { id: number; name: string };
  scenario?: { id: number; name: string; type: string; params: ScenarioParam[] };
  executions: ExecutionRow[];
}

export interface ExecutionRow {
  id: number;
  createdAt?: string;
  completed?: boolean;
  running?: boolean;
  success?: boolean;
}

export async function getConf(t: Testable, confId: number): Promise<ConfDetail> {
  const [c, executions] = await Promise.all([
    t.run('getTestConf', { path_conf: confId }),
    recentExecutions(t, confId, 10).catch(() => []),
  ]);
  return {
    ...confRow(c),
    testCase: c.testCase && { id: c.testCase.id, name: c.testCase.name },
    scenario: c.script && { id: c.script.id, name: c.script.name, type: c.script.scriptType, params: c.script.paramsConfig ?? [] },
    executions,
  };
}

export function planParams(current: Record<string, string>, set: Record<string, unknown> = {}, unset: string[] = []) {
  const next = { ...current };
  const diff: Change[] = [];
  for (const [key, value] of Object.entries(set)) {
    const to = String(value);
    if (next[key] === to) continue;
    diff.push({ key, from: next[key], to });
    next[key] = to;
  }
  for (const key of unset) {
    if (!(key in next)) continue;
    diff.push({ key, from: next[key], to: undefined });
    delete next[key];
  }
  return { next, diff };
}

export async function previewParams(t: Testable, confId: number, set?: Record<string, unknown>, unset?: string[]) {
  const c = await t.run('getTestConf', { path_conf: confId });
  return { conf: { id: c.id, name: c.name }, ...planParams(parseParams(c.scriptParams), set, unset) };
}

export async function setParams(t: Testable, confId: number, set?: Record<string, unknown>, unset?: string[]) {
  const { next, diff } = await previewParams(t, confId, set, unset);
  if (diff.length) await t.run('updateTestConf', { path_conf: confId, scriptParams: JSON.stringify(next) });
  return diff;
}

function parseParams(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return parseParams(JSON.parse(raw));
  } catch {
    return {};
  }
}

// --- VCS roots ------------------------------------------------------------------

export async function getRepository(t: Testable, id: number): Promise<Repository> {
  try {
    const r = await t.run('getVcsRoot', { path_id: id });
    return { id, url: r.url, branch: r.branch, authType: r.vcsAuthType, username: r.username };
  } catch (err) {
    return { id, error: err instanceof HttpError ? `Could not read VCS root ${id} (HTTP ${err.status}).` : String(err) };
  }
}

export async function listBranches(t: Testable, repositoryId: number): Promise<string[]> {
  const refs = asList(await t.run('getVcsRefs', { path_id: repositoryId }));
  return refs
    .map((r: any) => (typeof r === 'string' ? r : r.name ?? r.ref ?? ''))
    .map((r: string) => r.replace(/^refs\/(heads|tags)\//, ''))
    .filter(Boolean);
}

/** Points a scenario at another branch of its VCS root (the scenario's own `branch` setting). */
export async function setScenarioBranch(t: Testable, scenarioId: number, branch: string) {
  return updateScenarioSettings(t, scenarioId, { branch }, true);
}

/** Changes a VCS root's default branch, which every scenario on that root sees. */
export async function setRootBranch(t: Testable, repositoryId: number, branch: string) {
  await t.run('updateVcsRoot', { path_id: repositoryId, branch });
}

/**
 * Lists the repository's refs with the new token without saving anything, so a
 * typo does not break the scenarios. Throws with Testable's message on failure.
 */
export async function checkToken(t: Testable, repositoryId: number, token: string) {
  const root = await tokenRoot(t, repositoryId);
  await t.run('testVcsRefs', {
    path_id: repositoryId,
    vcsType: root.vcsType ?? 'Git',
    url: root.url,
    branch: root.branch,
    vcsAuthType: root.vcsAuthType,
    username: root.username,
    password: token,
  });
}

export async function saveToken(t: Testable, repositoryId: number, token: string) {
  await tokenRoot(t, repositoryId);
  // Only the password: resending vcsAuthType would make Testable clear the stored credentials.
  await t.run('updateVcsRoot', { path_id: repositoryId, password: token });
}

async function tokenRoot(t: Testable, repositoryId: number) {
  const root = await t.run('getVcsRoot', { path_id: repositoryId });
  if (root.vcsAuthType !== 'Username') {
    throw new Error(`VCS root ${repositoryId} uses ${root.vcsAuthType} authentication, not a username and token.`);
  }
  return root;
}

// --- executions -------------------------------------------------------------------

async function recentExecutions(t: Testable, confId: number, limit: number): Promise<ExecutionRow[]> {
  const list = asList(await t.run('searchOrgExecutionsWithFilter', { configurations: [confId], query_limit: limit }));
  return list.map(executionRow);
}

export function executionRow(e: any): ExecutionRow {
  return { id: e.id, createdAt: e.createdAt, completed: e.completed, running: e.running, success: e.success };
}

export interface DownloadedFile {
  path: string;
  kind: 'log' | 'output' | 'meta';
  size: number;
  contentType?: string;
}

export interface FailedTest {
  suite: string;
  test: string;
  error: string;
  trace?: string;
}

export interface ExecutionArtifacts extends ExecutionRow {
  testCase?: { id: number; name: string };
  conf?: { id: number; name: string };
  dir: string;
  files: DownloadedFile[];
  failedTests: FailedTest[];
  errors: string[];
}

export async function downloadExecution(
  t: Testable,
  target: { executionId?: number; confId?: number },
  root: string,
  opts: { outputFiles?: boolean; contentType?: string; failuresOnly?: boolean } = {}
): Promise<ExecutionArtifacts> {
  let executionId = target.executionId;
  if (!executionId && target.confId) {
    executionId = (await recentExecutions(t, target.confId, 1))[0]?.id;
    if (!executionId) throw new Error(`Configuration ${target.confId} has no executions.`);
  }
  if (!executionId) throw new Error('Pass executionId or confId.');

  const e = await t.run('getExecution', { path_executionId: executionId, query_includeSummary: false });
  await prepareRoot(root);
  const dir = path.join(root, 'executions', String(executionId));
  await mkdir(dir, { recursive: true });
  const files: DownloadedFile[] = [];
  const errors: string[] = [];
  const save = async (rel: string, bytes: Uint8Array, kind: DownloadedFile['kind'], contentType?: string) => {
    const file = path.join(dir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    files.push({ path: file, kind, size: bytes.length, contentType });
  };
  const text = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  await save('execution.json', text(redactSecrets(JSON.stringify(e, null, 2))), 'meta', 'application/json');

  try {
    await save('logs.txt', await executionLogs(t, executionId), 'log', 'text/plain');
  } catch (err) {
    errors.push(`logs: ${(err as Error).message}`);
  }
  try {
    // Request-level failures, which load tests produce.
    const failed = await t.run('getExecutionFailedResults', { path_executionId: executionId });
    if (asList(failed).length) await save('failed-results.json', text(redactSecrets(JSON.stringify(failed, null, 2))), 'meta', 'application/json');
  } catch (err) {
    errors.push(`failed results: ${(err as Error).message}`);
  }
  let failedTests: FailedTest[] = [];
  try {
    // Test-framework failures (Mocha, WebdriverIO, Playwright...) are stored as suite results instead.
    const suites = asList(await t.run('getExecutionFailedSuiteResults', { path_executionId: executionId }));
    failedTests = suites.flatMap((s: any) =>
      (s.testResults ?? [])
        .filter((r: any) => r.state === 'Failed' || r.error)
        .map((r: any) => ({ suite: s.suite?.name ?? '', test: r.suiteTest?.name ?? '', error: [r.errorType, r.error].filter(Boolean).join(': '), trace: r.errorTrace }))
    );
    if (suites.length) {
      await save('failed-tests.json', text(redactSecrets(JSON.stringify(suites, null, 2))), 'meta', 'application/json');
      const summary = failedTests.map((f) => `✗ ${f.suite} › ${f.test}\n${f.trace ?? f.error}\n`).join('\n');
      await save('failures.txt', text(summary), 'log', 'text/plain');
    }
  } catch (err) {
    errors.push(`failed tests: ${(err as Error).message}`);
  }

  if (opts.outputFiles !== false) {
    try {
      const outputs = asList(
        await t.run('getExecutionOutputFiles', {
          path_executionId: executionId,
          query_limit: 500,
          ...(opts.contentType && { query_contentType: opts.contentType }),
          ...(opts.failuresOnly && { query_failuresOnly: true }),
        })
      );
      const taken = new Set<string>();
      await mapLimit(outputs, 4, async (o: any) => {
        try {
          const d = await t.download(`/output-files/${o.id}/download`);
          const name = uniqueName(taken, safeName(o.name ?? o.fileName ?? d.fileName ?? `file-${o.id}`));
          await save(path.join('files', name), d.bytes, 'output', o.contentType ?? o.type ?? d.contentType);
        } catch (err) {
          errors.push(`output file ${o.id}: ${(err as Error).message}`);
        }
      });
    } catch (err) {
      errors.push(`output files: ${(err as Error).message}`);
    }
  }

  return {
    ...executionRow(e),
    // Executions carry flat testCaseId/testCaseName and confId/confName.
    testCase: e.testCaseId ? { id: e.testCaseId, name: e.testCaseName } : undefined,
    conf: e.confId ? { id: e.confId, name: e.confName } : undefined,
    dir,
    files,
    failedTests,
    errors,
  };
}

/** Prefers the plain-text log download; falls back to formatting the JSON log entries. */
async function executionLogs(t: Testable, executionId: number): Promise<Uint8Array> {
  try {
    return (await t.download(`/executions/${executionId}/logs.txt?level=Debug&limit=-1&asc=true`)).bytes;
  } catch {
    const entries = asList(await t.run('getExecutionLogs', { path_executionId: executionId, query_limit: -1, query_level: 'Debug', query_asc: true }));
    const lines = entries.map((l: any) =>
      typeof l === 'string' ? l : [l.loggedAt ?? l.timestamp ?? l.createdAt, l.level ?? l.logLevel, l.msg ?? l.message ?? JSON.stringify(l)].filter(Boolean).join(' ')
    );
    return new TextEncoder().encode(lines.join('\n'));
  }
}

// --- scenario file sync ---------------------------------------------------------

const MANIFEST = '.testable-sync.json';

interface Manifest {
  scenarioId: number;
  files: Record<string, { id: number; sha1: string; updatedAt?: string }>;
}

export interface SyncEntry {
  path: string;
  action: 'download' | 'keep-local' | 'create' | 'update' | 'unchanged' | 'conflict';
  fileId?: number;
}

export interface SyncResult {
  scenarioId: number;
  dir: string;
  entries: SyncEntry[];
  errors: string[];
}

export async function pullScenarioFiles(t: Testable, scenarioId: number, root: string, force = false): Promise<SyncResult> {
  const s = await t.run('getScenario', { path_scriptId: scenarioId });
  const dir = scenarioDir(root, s);
  const remote: ScenarioFile[] = asList(await t.run('getScenarioFiles', { path_scriptId: scenarioId })).filter((f: any) => !f.isFolder).map(scenarioFile);
  const manifest = await readManifest(dir, scenarioId);
  await prepareRoot(root);
  const next: Manifest = { scenarioId, files: {} };
  const entries: SyncEntry[] = [];
  const errors: string[] = [];

  await mapLimit(remote, 4, async (f) => {
    const rel = relPath(f.path);
    const file = path.join(dir, rel);
    try {
      const local = await sha1File(file);
      const known = manifest.files[rel];
      if (!force && local && local !== known?.sha1) {
        // Edited locally since the last pull (or never pulled): do not clobber it.
        entries.push({ path: rel, action: 'keep-local', fileId: f.id });
        if (known) next.files[rel] = known;
        return;
      }
      const { bytes } = await t.download(`/data-stores/${f.id}/download`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      next.files[rel] = { id: f.id, sha1: sha1(bytes), updatedAt: f.updatedAt };
      entries.push({ path: rel, action: 'download', fileId: f.id });
    } catch (err) {
      errors.push(`${rel}: ${(err as Error).message}`);
    }
  });

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, MANIFEST), JSON.stringify(next, null, 2));
  return { scenarioId, dir, entries: entries.sort(byPath), errors };
}

export async function planPush(t: Testable, scenarioId: number, root: string, only?: string[]) {
  const s = await t.run('getScenario', { path_scriptId: scenarioId });
  const dir = scenarioDir(root, s);
  const remote = new Map<string, ScenarioFile>(
    asList(await t.run('getScenarioFiles', { path_scriptId: scenarioId }))
      .filter((f: any) => !f.isFolder)
      .map((f: any) => [relPath(scenarioFile(f).path), scenarioFile(f)])
  );
  const manifest = await readManifest(dir, scenarioId);
  const wanted = only?.map((p) => relPath(p));
  const entries: (SyncEntry & { file: string; sha1: string })[] = [];
  for (const rel of await listFiles(dir)) {
    if (wanted && !wanted.includes(rel)) continue;
    const file = path.join(dir, rel);
    const hash = (await sha1File(file))!;
    const known = manifest.files[rel];
    const theirs = remote.get(rel);
    let action: SyncEntry['action'];
    if (!theirs) action = 'create';
    else if (known && known.sha1 === hash) action = 'unchanged';
    else if (known?.updatedAt && theirs.updatedAt && known.updatedAt !== theirs.updatedAt) action = 'conflict';
    else action = 'update';
    entries.push({ path: rel, action, fileId: theirs?.id, file, sha1: hash });
  }
  return { scenario: { id: s.id, name: s.name }, dir, entries: entries.sort(byPath) };
}

export async function pushScenarioFiles(t: Testable, scenarioId: number, root: string, opts: { only?: string[]; force?: boolean } = {}): Promise<SyncResult> {
  const plan = await planPush(t, scenarioId, root, opts.only);
  const manifest = await readManifest(plan.dir, scenarioId);
  const errors: string[] = [];
  const entries: SyncEntry[] = [];
  for (const e of plan.entries) {
    const action = e.action === 'conflict' && opts.force ? 'update' : e.action;
    if (action === 'unchanged' || action === 'conflict') {
      entries.push({ path: e.path, action, fileId: e.fileId });
      continue;
    }
    try {
      const contents = Buffer.from(await readFile(e.file)).toString('base64');
      const name = path.posix.basename(e.path);
      const res =
        action === 'create'
          ? await t.run('createScenarioFileFromContents', { path_scriptId: scenarioId, name, path: `/${e.path}`, contents })
          : await t.run('updateScenarioFileContents', { path_scenarioFileId: e.fileId, name, path: `/${e.path}`, contents });
      manifest.files[e.path] = { id: res?.id ?? e.fileId, sha1: e.sha1, updatedAt: res?.updatedAt };
      entries.push({ path: e.path, action, fileId: res?.id ?? e.fileId });
    } catch (err) {
      errors.push(`${e.path}: ${(err as Error).message}`);
    }
  }
  await writeFile(path.join(plan.dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return { scenarioId, dir: plan.dir, entries, errors };
}

/** Creates the download folder with a .gitignore, so pulled files and logs never end up in a commit. */
async function prepareRoot(root: string) {
  await mkdir(root, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!(await sha1File(ignore))) await writeFile(ignore, '*\n');
}

async function readManifest(dir: string, scenarioId: number): Promise<Manifest> {
  try {
    const m = JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8')) as Manifest;
    if (m.scenarioId === scenarioId) return m;
  } catch {
    // No manifest yet: everything counts as new.
  }
  return { scenarioId, files: {} };
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of names) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (d.isFile() && rel !== MANIFEST) out.push(rel);
  }
  return out;
}

// --- helpers --------------------------------------------------------------------

/** Testable returns lists either bare or wrapped, e.g. {count, results}, {files} or {size, logs}. */
export function asList(value: any): any[] {
  if (Array.isArray(value)) return value;
  return value?.results ?? value?.content ?? value?.items ?? value?.files ?? value?.logs ?? [];
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

function relPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

async function sha1File(file: string): Promise<string | undefined> {
  try {
    return sha1(await readFile(file));
  } catch {
    return undefined;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scenario';
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

function uniqueName(taken: Set<string>, name: string): string {
  let candidate = name;
  for (let i = 1; taken.has(candidate.toLowerCase()); i++) candidate = name.replace(/(\.[^.]*)?$/, `-${i}$1`);
  taken.add(candidate.toLowerCase());
  return candidate;
}

function byPath(a: { path: string }, b: { path: string }) {
  return a.path.localeCompare(b.path);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function time(iso: string | undefined): number {
  return (iso && Date.parse(iso)) || 0;
}

function getPath(obj: any, key: string): unknown {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj: any, key: string, value: unknown) {
  const parts = key.split('.');
  const last = parts.pop()!;
  let o = obj;
  for (const p of parts) o = o[p] && typeof o[p] === 'object' ? o[p] : (o[p] = {});
  o[last] = value;
}
