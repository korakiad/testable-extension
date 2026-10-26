// Live smoke test against the Testable REST API using the key in .env.
// Sends only GET requests plus the read-only POST /search (files it downloads go to
// a temp folder that is removed afterwards); write operations are
// checked with buildRequest() alone and never sent.
// Usage: npm run compile && npm run smoke
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const client = require('../dist/client.js');
const wf = require('../dist/testable.js');
const { catalog, buildRequest, sendRequest, findOperation, searchOperations, describeOperations, runLocal } = client;

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const apiKey = env.TESTABLE_API_KEY;
const apiUrl = env.TESTABLE_API_URL ?? 'https://api.testable.io';

// --- offline checks ---------------------------------------------------------
{
  const r = buildRequest(findOperation('getTestConfBucketHistory'), { path_conf: 7, query_bucket: 'b', query_metrics: [1, 2] }, apiUrl);
  assert.equal(r.url, `${apiUrl}/test-confs/7/bucket-history?bucket=b&metrics=1&metrics=2`);
  assert.equal(r.body, undefined);

  const del = buildRequest(findOperation('removeExecutionTags'), { path_executionId: 5, tagIds: [9] }, apiUrl);
  assert.equal(del.method, 'DELETE');
  assert.equal(del.url, `${apiUrl}/executions/5/tags`);
  assert.equal(del.body, '{"tagIds":[9]}');

  assert.throws(() => buildRequest(findOperation('getExecution'), {}, apiUrl), /path_executionId/);
  assert.equal(findOperation('searchOrgExecutionsWithFilter').access, 'read');
  assert.equal(findOperation('startExecution').access, 'write');

  assert.deepEqual(runLocal(findOperation('encode_base64'), { text: 'hi' }), { encoded: 'aGk=' });
  assert.deepEqual(runLocal(findOperation('decode_base64'), { encodedStrings: ['aGk=', '%%'] }), {
    results: [{ text: 'hi' }, { error: 'Not a valid base64 string' }],
  });

  assert.ok(searchOperations(['execution', 'logs'])[0].name.toLowerCase().includes('log'));
  const d = describeOperations(['getExecution', 'run_smoke_test', 'nope']);
  assert.deepEqual([d.tools.length, d.unavailableTools[0].name, d.unknownTools[0]], [1, 'run_smoke_test', 'nope']);

  assert.equal(
    client.redactSecrets('{"url":"https://api.testable.io/data-stores/1/download?key=abc123&x=1"}'),
    '{"url":"https://api.testable.io/data-stores/1/download?key=<redacted>&x=1"}'
  );

  for (const url of ['https://github.com/Org/Repo.git', 'git@github.com:org/repo.git', 'ssh://git@github.com:22/org/repo', 'https://user:tok@github.com/org/repo/']) {
    assert.equal(wf.normalizeGitUrl(url), 'github.com/org/repo', url);
  }

  const settings = { chromedriverOnly: false, seleniumVersion: '4.x', browsers: { chrome: 'Latest', edge: 'Latest' } };
  const plan = wf.planSettings(settings, { chromedriverOnly: true, 'browsers.edge': 'Stable', seleniumVersion: '4.x', chrome_driver_only: true });
  assert.deepEqual(plan.diff.map((c) => c.key), ['chromedriverOnly', 'browsers.edge']);
  assert.deepEqual(plan.unknownKeys, ['chrome_driver_only']);
  assert.deepEqual(plan.next.browsers, { chrome: 'Latest', edge: 'Stable' });
  assert.equal(settings.browsers.edge, 'Latest', 'planSettings must not mutate its input');

  const params = wf.planParams({ BASE_URL: 'a', USERS: '1' }, { BASE_URL: 'b', NEW: 2 }, ['USERS', 'MISSING']);
  assert.deepEqual(params.next, { BASE_URL: 'b', NEW: '2' });
  assert.deepEqual(params.diff.map((c) => `${c.key}:${c.from}->${c.to}`), ['BASE_URL:a->b', 'NEW:undefined->2', 'USERS:1->undefined']);

  // The workspace's API key is the one whose linked test case ran last; a linked one that never ran beats no link.
  const link = (status, lastRunAt) => ({ link: { status, testCases: [], lastRunAt } });
  const old = { name: 'old', ...link('matched', '2025-01-03T10:00:00Z') };
  const recent = { name: 'recent', ...link('matched', '2026-10-24T10:00:00Z') };
  const neverRun = { name: 'never', ...link('matched') };
  assert.equal(wf.latestLink([old, link('nomatch'), recent, { error: 'x' }]).name, 'recent');
  assert.equal(wf.latestLink([link('unavailable'), neverRun]).name, 'never');
  assert.equal(wf.latestLink([neverRun, old]).name, 'old');
  assert.equal(wf.latestLink([link('nomatch'), { error: 'x' }]), undefined);
  console.log('offline checks: ok');
}

// --- live workflows (reads from Testable, writes only to a temp folder) -------
{
  const t = new wf.Testable(apiKey, apiUrl);
  const root = mkdtempSync(join(tmpdir(), 'testable-smoke-'));
  try {
    const tests = await wf.listTests(t, [{ remote: 'https://github.com/example/not-linked.git', branch: 'main' }]);
    assert.ok(tests.testCases.length > 0, 'listTests should return test cases');
    assert.ok(['nomatch', 'unavailable'].includes(tests.match.status), `unexpected match status ${tests.match.status}`);
    assert.ok(tests.testCases.every((tc) => Array.isArray(tc.confs)), 'confs load for small orgs');
    assert.equal(tests.link.status, tests.match.status);
    console.log(`\nlistTests: ${tests.testCases.length} test cases, match=${tests.match.status}`);

    assert.deepEqual(await wf.findLinks(t, []), { status: 'norepo', testCases: [] });
    const orgId = await wf.organizationId(t);
    assert.ok(Number.isInteger(orgId), 'the key reveals its organization');
    console.log(`organizationId: ${orgId}`);

    // A scenario linked to a VCS root lets us check the git remote filter, which reads roots one by one.
    const linked = tests.testCases.flatMap((tc) => tc.scenarios).find((s) => s.repositoryId);
    if (linked) {
      const repo = await wf.getRepository(t, linked.repositoryId);
      assert.ok(!repo.error, repo.error);
      const mine = await wf.listTests(t, [{ remote: repo.url }]);
      assert.equal(mine.match.status, 'matched');
      assert.ok(mine.testCases.every((tc) => tc.scenarios.some((s) => s.repositoryId === linked.repositoryId)));
      console.log(`git remote filter: ${repo.url} -> ${mine.testCases.length} of ${mine.total} test cases, scenario branch ${linked.branch}`);

      // What the API keys section shows for this organization.
      const found = await wf.findLinks(t, [{ remote: repo.url }]);
      assert.equal(found.status, 'matched');
      assert.deepEqual(found.testCases.map((c) => c.id).sort(), mine.testCases.map((tc) => tc.id).sort());
      assert.deepEqual(found, mine.link);
      const runs = mine.testCases.map((tc) => tc.lastRunAt).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a));
      assert.equal(found.lastRunAt, runs[0]);
      console.log(`findLinks: ${found.testCases.map((c) => `${c.path} (last run ${c.lastRunAt ?? 'never'})`).join(', ')}`);
    }

    const withFiles = tests.testCases.flatMap((tc) => tc.scenarios)[0];
    const scenario = await wf.getScenario(t, withFiles.id, root);
    assert.ok(Object.keys(scenario.settings).length > 0 || scenario.type === 'Code', 'scenario settings');
    console.log(`getScenario ${scenario.id}: ${Object.keys(scenario.settings).length} settings, ${scenario.files.length} files, ${scenario.confs.length} confs, repo=${JSON.stringify(scenario.repository)}`);

    const anyKey = Object.keys(scenario.settings).find((k) => typeof scenario.settings[k] === 'boolean');
    if (anyKey) {
      const preview = await wf.previewScenarioSettings(t, scenario.id, { [anyKey]: !scenario.settings[anyKey] });
      assert.deepEqual(preview.diff.map((c) => c.key), [anyKey]);
    }

    const conf = tests.testCases.flatMap((tc) => tc.confs)[0];
    if (conf) {
      const detail = await wf.getConf(t, conf.id);
      const preview = await wf.previewParams(t, conf.id, { SMOKE_PARAM: 'x' });
      assert.deepEqual(preview.diff.map((c) => c.key), ['SMOKE_PARAM']);
      console.log(`getConf ${detail.id}: params=${JSON.stringify(detail.params)}, ${detail.executions.length} executions`);
    }

    if (scenario.files.length) {
      const pulled = await wf.pullScenarioFiles(t, scenario.id, root);
      assert.deepEqual(pulled.errors, []);
      assert.ok(existsSync(join(root, '.gitignore')), 'download root gets a .gitignore');
      let push = await wf.planPush(t, scenario.id, root);
      assert.ok(push.entries.every((e) => e.action === 'unchanged'), 'freshly pulled files are unchanged');
      const first = pulled.entries[0].path;
      writeFileSync(join(pulled.dir, first), 'edited locally\n');
      writeFileSync(join(pulled.dir, 'brand-new.txt'), 'new\n');
      push = await wf.planPush(t, scenario.id, root);
      assert.equal(push.entries.find((e) => e.path === first).action, 'update');
      assert.equal(push.entries.find((e) => e.path === 'brand-new.txt').action, 'create');
      const again = await wf.pullScenarioFiles(t, scenario.id, root);
      assert.equal(again.entries.find((e) => e.path === first).action, 'keep-local', 'pull keeps local edits');
      console.log(`pull/planPush: ${pulled.entries.length} files ok`);
    }

    // Old executions get purged, so this only runs when some configuration has a recent one.
    for (const c of tests.testCases.flatMap((tc) => tc.confs)) {
      const latest = (await wf.getConf(t, c.id)).executions.find((e) => e.completed);
      if (!latest) continue;
      const a = await wf.downloadExecution(t, { confId: c.id }, root);
      assert.deepEqual(a.errors, []);
      const log = a.files.find((f) => f.kind === 'log');
      assert.ok(log && log.size > 0, 'logs.txt is downloaded');
      assert.ok(a.testCase?.name && a.conf?.name, 'execution names are filled in');
      console.log(`downloadExecution ${a.id} (${c.name}): ${a.files.map((f) => `${f.path.slice(a.dir.length + 1)} ${f.size}B`).join(', ')}`);
      break;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- live read-only sweep ---------------------------------------------------
async function get(name, args = {}) {
  const res = await sendRequest(buildRequest(findOperation(name), args, apiUrl), apiKey);
  return { status: res.status, data: res.text && /json/.test(res.contentType) ? JSON.parse(res.text) : res.text ?? res.bytes };
}

const ids = {};
const cases = await get('getAllTestCases');
assert.equal(cases.status, 200, 'getAllTestCases should succeed');
const testCase = cases.data[0];
if (testCase) {
  ids.testCase = ids.testCaseId = testCase.id;
  ids.scriptId = testCase.scripts?.[0]?.id;
  const confs = await get('getTestCaseConfs', { path_testCaseId: testCase.id });
  ids.conf = ids.confId = wf.asList(confs.data)[0]?.id;
  if (ids.conf) {
    const execs = await get('getTestConfExecutions', { path_conf: ids.conf });
    const list = Array.isArray(execs.data) ? execs.data : execs.data?.content ?? execs.data?.executions;
    ids.executionId = list?.[0]?.id;
  }
}
console.log('discovered ids:', JSON.stringify(ids));

const results = { ok: [], failed: [], skipped: [] };
for (const op of catalog.operations.filter((o) => o.kind === 'rest' && o.access === 'read')) {
  if (op.method !== 'GET' && op.name !== 'searchOrgExecutionsWithFilter') continue;
  const args = {};
  let fillable = true;
  for (const key of op.inputSchema.required ?? []) {
    const id = key.startsWith('path_') ? ids[key.slice(5)] : undefined;
    if (id === undefined) fillable = false;
    else args[key] = id;
  }
  if (!fillable) {
    results.skipped.push(op.name);
    continue;
  }
  if (op.inputSchema.properties?.query_limit) args.query_limit = 5;
  try {
    const { status } = await get(op.name, args);
    (status >= 200 && status < 300 ? results.ok : results.failed).push(`${op.name} ${status}`);
  } catch (err) {
    results.failed.push(`${op.name} ${err.message}`);
  }
}
console.log(`\nok (${results.ok.length}): ${results.ok.join(', ')}`);
console.log(`\nfailed (${results.failed.length}): ${results.failed.join(', ')}`);
console.log(`\nskipped, no id to fill (${results.skipped.length})`);
