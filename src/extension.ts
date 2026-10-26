import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  Operation,
  buildRequest,
  describeOperations,
  findOperation,
  redactSecrets,
  runLocal,
  searchOperations,
  sendRequest,
  unavailableReason,
} from './client';
import { Accounts, registerAccounts } from './accounts';
import * as testable from './testable';
import { Cancelled, Services, View, confView, diffText, registerUi, scenarioView, syncBanner, testsView, updateToken, withView } from './ui';

const PREFIX = 'testable_';

// Hand-written tools with their own UI page; the rest are generated 1:1 wrappers.
const WORKFLOW_TOOLS = new Set([
  'testable_showTests',
  'testable_showScenario',
  'testable_downloadExecution',
  'testable_pullScenarioFiles',
  'testable_pushScenarioFiles',
  'testable_updateScenarioSettings',
  'testable_setScenarioParams',
  'testable_updateRepository',
]);

let log: vscode.LogOutputChannel;
let accounts: Accounts;

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Testable Tools', { log: true });
  accounts = new Accounts(context, workspaceRepos, log);
  registerAccounts(context, accounts);
  context.subscriptions.push(
    log,
    vscode.lm.registerTool('testable_searchTools', {
      async invoke(options: vscode.LanguageModelToolInvocationOptions<{ keywords: string[]; limit?: number }>) {
        return json(searchOperations(options.input.keywords ?? [], options.input.limit));
      },
    }),
    vscode.lm.registerTool('testable_describeTools', {
      async invoke(options: vscode.LanguageModelToolInvocationOptions<{ toolNames: string[] }>) {
        return json(describeOperations(options.input.toolNames ?? []));
      },
    }),
    vscode.lm.registerTool<{ toolName: string; arguments?: Record<string, unknown> }>('testable_callTool', {
      prepareInvocation: (options) => {
        const op = findOperation(options.input.toolName);
        // Unknown names fall through to invoke, whose error message reaches the model.
        return op ? prepare(op, options.input.arguments ?? {}) : { invocationMessage: `Testable: ${options.input.toolName}` };
      },
      invoke: (options, token) => call(context, resolve(options.input.toolName), options.input.arguments ?? {}, token),
    })
  );

  const services: Services = {
    client: (token, accountId) => accounts.client({ token, accountId }),
    root: () => localRoot(context),
    repos: workspaceRepos,
    accounts,
  };
  registerUi(context, services, log);
  registerWorkflowTools(context, services);

  // The remaining contributed tools are 1:1 wrappers named testable_<operation>.
  const meta = new Set(['testable_searchTools', 'testable_describeTools', 'testable_callTool', ...WORKFLOW_TOOLS]);
  const contributed: { name: string }[] = context.extension.packageJSON.contributes?.languageModelTools ?? [];
  for (const { name } of contributed.filter((t) => !meta.has(t.name))) {
    const op = resolve(name.slice(PREFIX.length));
    context.subscriptions.push(
      vscode.lm.registerTool<Record<string, unknown>>(name, {
        prepareInvocation: (options) => prepare(op, options.input ?? {}),
        invoke: (options, token) => call(context, op, options.input ?? {}, token),
      })
    );
  }
}

export function deactivate() {}

function resolve(name: string): Operation {
  const op = findOperation(name);
  if (op) return op;
  const reason = unavailableReason(name);
  throw new Error(
    reason
      ? `${name} is not available in this extension: ${reason}`
      : `Unknown Testable operation "${name}". Use testable_searchTools to find the right name.`
  );
}

function prepare(op: Operation, args: Record<string, unknown>): vscode.PreparedToolInvocation {
  const endpoint = `${op.method} ${op.path}`;
  if (op.access === 'read') return { invocationMessage: `Testable: ${op.name} (${endpoint})` };
  return {
    invocationMessage: `Testable: ${op.name} (${endpoint})`,
    confirmationMessages: {
      title: `Testable: ${op.name}`,
      message: new vscode.MarkdownString(
        `This changes data in Testable.\n\n\`${endpoint}\`\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
      ),
    },
  };
}

async function call(
  context: vscode.ExtensionContext,
  op: Operation,
  args: Record<string, unknown>,
  token: vscode.CancellationToken
): Promise<vscode.LanguageModelToolResult> {
  if (op.kind === 'local') return json(runLocal(op, args));

  const config = vscode.workspace.getConfiguration('testable');
  const key = await accounts.key(await accounts.current());
  const req = buildRequest(op, args, config.get<string>('apiUrl', 'https://api.testable.io'));
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    const res = await sendRequest(req, key, abort.signal);
    log.info(`${req.method} ${new URL(req.url).pathname} -> ${res.status}`);

    if (!res.ok) {
      throw new Error(
        `Testable returned HTTP ${res.status} for ${op.name} (${op.method} ${op.path}): ${redactSecrets(res.text ?? '').slice(0, 2000)}`
      );
    }
    if (res.bytes) {
      const file = await saveDownload(context, op, res.contentType, res.bytes);
      return text(`HTTP ${res.status}. Binary response (${res.contentType}, ${res.bytes.length} bytes) saved to ${file.fsPath}`);
    }

    const max = config.get<number>('maxResponseChars', 60000);
    let body = redactSecrets(compact(res.text ?? ''));
    if (body.length > max) {
      body = `${body.slice(0, max)}\n…[truncated ${body.length - max} of ${body.length} characters; narrow the request with limit/offset/filter arguments]`;
    }
    return text(`HTTP ${res.status}\n${body}`);
  } finally {
    sub.dispose();
  }
}

// --- workflow tools ----------------------------------------------------------------

function registerWorkflowTools(context: vscode.ExtensionContext, services: Services) {
  const tool = <T>(name: string, impl: vscode.LanguageModelTool<T>) => context.subscriptions.push(vscode.lm.registerTool(name, impl));

  tool<{ query?: string; allRepos?: boolean }>('testable_showTests', {
    prepareInvocation: () => ({ invocationMessage: 'Loading Testable test cases' }),
    async invoke(options, token) {
      const view = await testsView(services, await services.client(token), options.input);
      return withView(json(testsForModel(view)), view);
    },
  });

  tool<{ scenarioId: number }>('testable_showScenario', {
    prepareInvocation: (options) => ({ invocationMessage: `Loading Testable scenario ${options.input.scenarioId}` }),
    async invoke(options, token) {
      const view = await scenarioView(services, await services.client(token), options.input.scenarioId);
      return withView(json(scenarioForModel(view)), view);
    },
  });

  tool<{ executionId?: number; confId?: number; outputFiles?: boolean; contentType?: string; failuresOnly?: boolean }>('testable_downloadExecution', {
    prepareInvocation: (options) => ({
      invocationMessage: options.input.executionId
        ? `Downloading logs and files of Testable execution ${options.input.executionId}`
        : `Downloading logs and files of the latest run of configuration ${options.input.confId}`,
    }),
    async invoke(options, token) {
      const { executionId, confId, ...opts } = options.input;
      const t = await services.client(token);
      const data = await testable.downloadExecution(t, { executionId, confId }, services.root(), opts);
      const view: View = { kind: 'execution', data, account: t.account };
      return withView(
        json({
          executionId: data.id,
          status: data.running ? 'running' : data.completed ? (data.success === false ? 'failed' : 'finished') : 'queued',
          success: data.success,
          testCase: data.testCase,
          configuration: data.conf,
          folder: data.dir,
          failedTests: data.failedTests.slice(0, 10).map((f) => ({ suite: f.suite, test: f.test, error: f.error })),
          files: data.files.map((f) => ({ path: f.path, kind: f.kind, size: f.size, contentType: f.contentType })),
          errors: data.errors,
          hint: 'failures.txt has the stack trace of each failed test and logs.txt the full log; read them with your file tools. Output files (screenshots, HAR, reports) are under files/.',
        }),
        view
      );
    },
  });

  tool<{ scenarioId: number; force?: boolean }>('testable_pullScenarioFiles', {
    prepareInvocation: (options) => ({ invocationMessage: `Downloading the files of Testable scenario ${options.input.scenarioId}` }),
    async invoke(options, token) {
      const t = await services.client(token);
      const sync = await testable.pullScenarioFiles(t, options.input.scenarioId, services.root(), options.input.force);
      const view = await scenarioView(services, t, options.input.scenarioId, { sync, banner: syncBanner('Pulled', sync) });
      return withView(
        json({
          folder: sync.dir,
          files: sync.entries,
          errors: sync.errors,
          hint: 'Edit the files in this folder, then call testable_pushScenarioFiles to upload them. keep-local means the local copy was edited and was not overwritten (pass force to overwrite).',
        }),
        view
      );
    },
  });

  tool<{ scenarioId: number; paths?: string[] }>('testable_pushScenarioFiles', {
    async prepareInvocation(options, token) {
      const title = `Testable: upload files to scenario ${options.input.scenarioId}`;
      try {
        const plan = await testable.planPush(await services.client(token), options.input.scenarioId, services.root(), options.input.paths);
        const changes = plan.entries.filter((e) => e.action !== 'unchanged');
        if (!changes.length) return { invocationMessage: `No local changes to upload for scenario "${plan.scenario.name}"` };
        const lines = changes.map((e) => `- \`${e.path}\` ${e.action === 'conflict' ? '**overwrites a newer version in Testable**' : e.action}`);
        return {
          invocationMessage: `Uploading ${changes.length} file(s) to scenario "${plan.scenario.name}"`,
          confirmationMessages: { title, message: new vscode.MarkdownString(`From \`${plan.dir}\`:\n\n${lines.join('\n')}`) },
        };
      } catch (err) {
        return confirmAnyway(title, err);
      }
    },
    async invoke(options, token) {
      const t = await services.client(token);
      const sync = await testable.pushScenarioFiles(t, options.input.scenarioId, services.root(), { only: options.input.paths, force: true });
      const view = await scenarioView(services, t, options.input.scenarioId, { sync, banner: syncBanner('Pushed', sync) });
      return withView(json({ folder: sync.dir, files: sync.entries, errors: sync.errors }), view);
    },
  });

  tool<{ scenarioId: number; settings: Record<string, unknown>; allowNewKeys?: boolean }>('testable_updateScenarioSettings', {
    async prepareInvocation(options, token) {
      const { scenarioId, settings, allowNewKeys } = options.input;
      const title = `Testable: update scenario ${scenarioId} settings`;
      try {
        const plan = await testable.previewScenarioSettings(await services.client(token), scenarioId, settings ?? {}, allowNewKeys);
        // Unknown keys fail in invoke, where the error lists the valid ones for the model.
        if (plan.unknownKeys.length || !plan.diff.length) return { invocationMessage: `Checking settings of scenario "${plan.scenario.name}"` };
        return {
          invocationMessage: `Updating settings of scenario "${plan.scenario.name}"`,
          confirmationMessages: { title: `Testable: update "${plan.scenario.name}"`, message: new vscode.MarkdownString(codeBlock(diffText(plan.diff))) },
        };
      } catch (err) {
        return confirmAnyway(title, err);
      }
    },
    async invoke(options, token) {
      const { scenarioId, settings, allowNewKeys } = options.input;
      const t = await services.client(token);
      const diff = await testable.updateScenarioSettings(t, scenarioId, settings ?? {}, allowNewKeys);
      const banner = { kind: 'ok' as const, text: diff.length ? 'Settings saved.' : 'Settings already had these values.', items: diffText(diff).split('\n').filter(Boolean) };
      const view = await scenarioView(services, t, scenarioId, { banner });
      return withView(json({ scenarioId, changed: diff }), view);
    },
  });

  tool<{ confId: number; set?: Record<string, unknown>; unset?: string[] }>('testable_setScenarioParams', {
    async prepareInvocation(options, token) {
      const { confId, set, unset } = options.input;
      const title = `Testable: update scenario params of configuration ${confId}`;
      try {
        const plan = await testable.previewParams(await services.client(token), confId, set, unset);
        if (!plan.diff.length) return { invocationMessage: `Scenario params of "${plan.conf.name}" already match` };
        return {
          invocationMessage: `Updating scenario params of "${plan.conf.name}"`,
          confirmationMessages: { title: `Testable: params of "${plan.conf.name}"`, message: new vscode.MarkdownString(codeBlock(diffText(plan.diff))) },
        };
      } catch (err) {
        return confirmAnyway(title, err);
      }
    },
    async invoke(options, token) {
      const { confId, set, unset } = options.input;
      const t = await services.client(token);
      const diff = await testable.setParams(t, confId, set, unset);
      const view = await confView(t, confId, { kind: 'ok', text: diff.length ? 'Params saved.' : 'Params already had these values.', items: diffText(diff).split('\n').filter(Boolean) });
      return withView(json({ confId, changed: diff, params: view.kind === 'conf' ? view.data.params : undefined }), view);
    },
  });

  tool<{ scenarioId?: number; repositoryId?: number; branch?: string; updateToken?: boolean }>('testable_updateRepository', {
    async prepareInvocation(options, token) {
      const { scenarioId, branch, updateToken } = options.input;
      const title = 'Testable: update repository';
      try {
        const t = await services.client(token);
        const repo = await testable.getRepository(t, await repositoryIdFor(t, options.input));
        const scenario = scenarioId ? await t.run('getScenario', { path_scriptId: scenarioId }) : undefined;
        const changes = [
          branch && scenario && `- branch of scenario "${scenario.name}": \`${scenario.metadata?.branch ?? repo.branch ?? '(default)'}\` → \`${branch}\``,
          branch && !scenario && `- default branch of the repository, for every scenario that uses it: \`${repo.branch ?? '(none)'}\` → \`${branch}\``,
          updateToken && '- token: VS Code asks for the new token in a password box; it is not shared with the chat. Every scenario that uses this repository gets it.',
        ].filter(Boolean);
        return {
          invocationMessage: `Updating ${repo.url ?? `VCS root ${repo.id}`}`,
          confirmationMessages: { title, message: new vscode.MarkdownString(`\`${repo.url ?? `VCS root ${repo.id}`}\`\n\n${changes.join('\n')}`) },
        };
      } catch (err) {
        return confirmAnyway(title, err);
      }
    },
    async invoke(options, token) {
      const { scenarioId, branch, updateToken: newToken } = options.input;
      if (!branch && !newToken) throw new Error('Pass branch and/or updateToken: true.');
      const t = await services.client(token);
      const repositoryId = await repositoryIdFor(t, options.input);
      if (branch) {
        if (scenarioId) await testable.setScenarioBranch(t, scenarioId, branch);
        else await testable.setRootBranch(t, repositoryId, branch);
      }
      if (newToken) {
        try {
          await updateToken(t, repositoryId);
        } catch (err) {
          if (err instanceof Cancelled) throw new Error('The user cancelled updating the token.');
          throw err;
        }
      }
      const result = json({ repository: await testable.getRepository(t, repositoryId), branchChanged: !!branch, tokenUpdated: !!newToken });
      return scenarioId ? withView(result, await scenarioView(services, t, scenarioId)) : result;
    },
  });
}

async function repositoryIdFor(t: testable.Testable, input: { scenarioId?: number; repositoryId?: number }): Promise<number> {
  if (input.repositoryId) return input.repositoryId;
  if (!input.scenarioId) throw new Error('Pass scenarioId or repositoryId.');
  const s = await t.run('getScenario', { path_scriptId: input.scenarioId });
  const id = Number(s.metadata?.repositoryId);
  if (!(id > 0)) throw new Error(`Scenario ${input.scenarioId} is not linked to a VCS root (source: ${s.metadata?.sourceType ?? 'unknown'}).`);
  return id;
}

/** Write tools still ask the user when the preview itself fails. */
function confirmAnyway(title: string, err: unknown): vscode.PreparedToolInvocation {
  return {
    invocationMessage: title,
    confirmationMessages: { title, message: `Could not preview the change (${redactSecrets(String((err as Error).message ?? err))}). Continue anyway?` },
  };
}

function testsForModel(view: View) {
  if (view.kind !== 'tests') return view;
  const d = view.data;
  const elsewhere = (view.accounts ?? []).filter((a) => a.account.id !== view.account?.id && a.link?.status === 'matched');
  const hints = [
    d.testCases.some((tc) => !tc.confs) && 'Configurations were not loaded for this many test cases; use testable_getTestCaseConfs.',
    elsewhere.length &&
      `Other organizations (API keys) also have test cases linked to this repo; every Testable tool uses only the API key "${view.account?.name}". If the user means one of those, ask them to switch with the Use button on the page or the "Testable: Select API Key" command.`,
  ];
  return {
    apiKey: view.account?.name,
    repo: d.repos[0],
    match: d.match,
    shown: d.testCases.length,
    total: d.total,
    testCases: d.testCases.map((tc) => ({
      id: tc.id,
      path: tc.path,
      lastRunAt: tc.lastRunAt,
      lastExecutionId: tc.lastExecutionId,
      configurationResults: tc.counts,
      scenarios: tc.scenarios.map((s) => ({ id: s.id, name: s.name, type: s.type, source: s.source, repositoryId: s.repositoryId, params: s.params.map((p) => p.name) })),
      configurations: tc.confs?.map((c) => ({ id: c.id, name: c.name, testType: c.testType, scenarioId: c.scenarioId, params: c.params })),
    })),
    otherApiKeys: elsewhere.length ? elsewhere.map((a) => ({ name: a.account.name, linkedTestCases: a.link?.testCases })) : undefined,
    hint: hints.filter(Boolean).join(' ') || undefined,
  };
}

function scenarioForModel(view: View) {
  if (view.kind !== 'scenario') return view;
  const s = view.data;
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    testCase: s.testCase,
    repository: s.repository,
    settings: s.settings,
    declaredParams: s.params,
    files: s.files,
    configurations: s.confs.map((c) => ({ id: c.id, name: c.name, testType: c.testType, params: c.params })),
    localFolder: s.localDir,
  };
}

// --- services -----------------------------------------------------------------------

function localRoot(context: vscode.ExtensionContext): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return path.join(context.globalStorageUri.fsPath, 'files');
  return path.resolve(folder.uri.fsPath, vscode.workspace.getConfiguration('testable').get<string>('localFolder', '.testable'));
}

interface GitExtension {
  getAPI(version: 1): {
    repositories: { state: { HEAD?: { name?: string }; remotes: { name: string; fetchUrl?: string; pushUrl?: string }[] } }[];
  };
}

/** The workspace's git remotes (origin first) with credentials stripped, from the built-in git extension. */
async function workspaceRepos(): Promise<testable.RepoInfo[]> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return [];
  try {
    const git = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    return git.repositories.flatMap((repo) =>
      [...repo.state.remotes]
        .sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'))
        .map((r) => r.fetchUrl ?? r.pushUrl)
        .filter((url): url is string => !!url)
        .map((url) => ({ remote: url.replace(/\/\/[^@/]+@/, '//'), branch: repo.state.HEAD?.name }))
    );
  } catch (err) {
    log.warn(`Could not read git remotes: ${err}`);
    return [];
  }
}

async function saveDownload(context: vscode.ExtensionContext, op: Operation, contentType: string, bytes: Uint8Array) {
  const ext = contentType.split(';')[0].split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'downloads');
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, `${op.name}-${Date.now()}.${ext}`);
  await vscode.workspace.fs.writeFile(file, bytes);
  return file;
}

/** Re-serialises JSON without indentation to save tokens; leaves other text alone. */
function compact(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

function codeBlock(value: string) {
  return `\`\`\`\n${value}\n\`\`\``;
}

function text(value: string) {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

function json(value: unknown) {
  return text(redactSecrets(JSON.stringify(value)));
}
