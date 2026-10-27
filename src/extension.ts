import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  ORG_WIDE,
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
import { Account, Accounts, registerAccounts } from './accounts';
import * as testable from './testable';
import { Cancelled, Services, View, confView, diffText, registerUi, scenarioView, syncBanner, testsView, updateToken, withView } from './ui';

const PREFIX = 'testable_';

// Hand-written tools with their own UI page, and whether they change data in Testable;
// the rest are generated 1:1 wrappers.
const WORKFLOW_TOOLS: Record<string, 'read' | 'write'> = {
  testable_showTests: 'read',
  testable_showScenario: 'read',
  testable_downloadExecution: 'read',
  testable_pullScenarioFiles: 'read',
  testable_pushScenarioFiles: 'write',
  testable_updateScenarioSettings: 'write',
  testable_setScenarioParams: 'write',
  testable_updateRepository: 'write',
};

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
    vscode.lm.registerTool<{ toolName: string; arguments?: Record<string, unknown> } & KeyInput>(
      'testable_callTool',
      withApiKey(
        {
          prepareInvocation: (options) => {
            const op = findOperation(options.input.toolName);
            // Unknown names fall through to invoke, whose error message reaches the model.
            return op ? prepare(op, options.input.arguments ?? {}, options.input.apiKey) : { invocationMessage: `Testable: ${options.input.toolName}` };
          },
          invoke: (options, token) => call(context, resolve(options.input.toolName), options.input.arguments ?? {}, options.input.apiKey, token),
        },
        (input) => findOperation(input.toolName)?.access === 'read'
      )
    )
  );

  const services: Services = {
    client: (opts) => accounts.client(opts),
    root: () => localRoot(context),
    repos: workspaceRepos,
    accounts,
  };
  registerUi(context, services, log);
  registerWorkflowTools(context, services);

  // The remaining contributed tools are 1:1 wrappers named testable_<operation>.
  const meta = new Set(['testable_searchTools', 'testable_describeTools', 'testable_callTool', ...Object.keys(WORKFLOW_TOOLS)]);
  const contributed: { name: string }[] = context.extension.packageJSON.contributes?.languageModelTools ?? [];
  for (const { name } of contributed.filter((t) => !meta.has(t.name))) {
    const op = resolve(name.slice(PREFIX.length));
    // apiKey sits next to the operation's own arguments; no operation has one of its own.
    const args = ({ apiKey, ...rest }: Record<string, unknown> & KeyInput = {}) => rest;
    context.subscriptions.push(
      vscode.lm.registerTool<Record<string, unknown> & KeyInput>(
        name,
        withApiKey(
          {
            prepareInvocation: (options) => prepare(op, args(options.input), options.input?.apiKey),
            invoke: (options, token) => call(context, op, args(options.input), options.input?.apiKey, token),
          },
          () => op.access === 'read'
        )
      )
    );
  }
}

export function deactivate() {}

interface KeyInput {
  /** Name of one of the user's API keys, to use instead of the workspace's. */
  apiKey?: string;
}

/**
 * Lets a tool take an apiKey argument naming one of the user's API keys, so the chat can work in
 * another organization without switching the workspace's key. The invocation message names a
 * key passed this way, and once the user has several keys every confirmation names the key the
 * write goes to. An unknown name skips the preview and confirmation; invoke then fails with the
 * list of names.
 *
 * A read without apiKey, or with "all", that gets a 401/403/404 (the ID may be another
 * organization's) tries the user's other keys and says which one found it. Writes never switch
 * keys by themselves and refuse "all": their error says which key was used and which others exist.
 */
function withApiKey<T extends KeyInput>(tool: vscode.LanguageModelTool<T>, reads: (input: T) => boolean): vscode.LanguageModelTool<T> {
  return {
    async prepareInvocation(options, token) {
      const every = testable.isEveryKey(options.input?.apiKey);
      const name = every ? undefined : options.input?.apiKey;
      const named = name ? testable.findAccount(accounts.list(), name) : undefined;
      if (name && !named) return { invocationMessage: `Testable: no API key is named "${name}"` };
      if (every && !reads(options.input)) return { invocationMessage: 'Testable: a change needs one API key' };
      const prepared = await tool.prepareInvocation?.(options, token);
      if (!prepared) return prepared;
      const { invocationMessage: message, confirmationMessages: confirm } = prepared;
      const shown = named && typeof message === 'string' ? `${message} · API key "${named.name}"` : message;
      if (!confirm || accounts.list().length < 2) return { ...prepared, invocationMessage: shown };
      const account = named ?? (await accounts.current());
      const body = typeof confirm.message === 'string' ? confirm.message : confirm.message.value;
      return {
        ...prepared,
        invocationMessage: shown,
        confirmationMessages: { ...confirm, message: new vscode.MarkdownString(`API key: **${account.name}**\n\n${body}`) },
      };
    },
    async invoke(options, token) {
      const every = testable.isEveryKey(options.input?.apiKey);
      const read = reads(options.input);
      if (every && !read) {
        throw new Error(`apiKey "${testable.EVERY_KEY}" only works for reads; a change goes to one organization. Pass the name of one API key, or leave apiKey out to use this workspace's key.`);
      }
      try {
        return await tool.invoke(options, token);
      } catch (err) {
        if (!wrongOrganization(err) || accounts.list().length < 2) throw err;
        const name = every ? undefined : options.input?.apiKey;
        const used = name ? accounts.named(name) : accounts.picked();
        const others = accounts.list().filter((a) => a.id !== used?.id);
        const names = others.map((a) => `"${a.name}"`).join(' or ');
        if (name || !read) {
          const all = read ? `, or set it to "${testable.EVERY_KEY}" to look in every organization` : '';
          throw new testable.HttpError(
            err.status,
            `${err.message}\n\nThis used the API key "${used?.name}". If it belongs to another organization, retry with apiKey set to ${names}${all}.`
          );
        }
        // One key at a time, since some reads save files.
        for (const other of others) {
          try {
            const result = await tool.invoke({ ...options, input: { ...options.input, apiKey: other.name } }, token);
            result?.content.unshift(
              new vscode.LanguageModelTextPart(
                `Found with the API key "${other.name}"${other.orgId ? ` (organization ${other.orgId})` : ''}; this workspace's key "${used?.name}" returned HTTP ${err.status}. Pass apiKey "${other.name}" to follow-up calls about it, and always to changes.`
              )
            );
            return result;
          } catch (next) {
            if (!wrongOrganization(next)) throw next;
          }
        }
        throw new testable.HttpError(err.status, `${err.message}\n\nThe user's other API keys (${names}) did not find it either.`);
      }
    },
  };
}

/** What Testable answers when an ID belongs to an organization the key cannot see. */
function wrongOrganization(err: unknown): err is testable.HttpError {
  return err instanceof testable.HttpError && [401, 403, 404].includes(err.status);
}

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

function prepare(op: Operation, args: Record<string, unknown>, apiKey?: string): vscode.PreparedToolInvocation {
  const endpoint = `${op.method} ${op.path}`;
  const everyKey = everyOrganization(op, apiKey) ? ' · every API key' : '';
  if (op.access === 'read') return { invocationMessage: `Testable: ${op.name} (${endpoint})${everyKey}` };
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
  apiKey: string | undefined,
  token: vscode.CancellationToken
): Promise<vscode.LanguageModelToolResult> {
  if (op.kind === 'local') return json(runLocal(op, args));
  // It would otherwise go out as a body field while the workspace's key is used.
  if ('apiKey' in args) throw new Error('Pass apiKey next to toolName, not inside arguments.');

  await accounts.migrate();
  const max = vscode.workspace.getConfiguration('testable').get<number>('maxResponseChars', 60000);
  const all = accounts.list();
  if (!everyOrganization(op, apiKey)) {
    const account = await accounts.resolve({ apiKey });
    const body = await request(context, op, args, account, max, token);
    // The workspace's organization is the usual one to search; say how to reach the others.
    const others = ORG_WIDE.has(op.name) && !apiKey ? all.filter((a) => a.id !== account.id).map((a) => `"${a.name}"`) : [];
    return text(
      others.length
        ? `${body}\n\n[Only this workspace's organization (API key "${account.name}") was searched. To search every organization pass apiKey "${testable.EVERY_KEY}", or ${others.length > 1 ? 'one of ' : ''}${others.join(', ')} for that organization alone.]`
        : body
    );
  }

  // Each organization's result, within its share of the size limit; one key failing does not hide the others.
  const parts = await Promise.all(
    all.map(async (account) => {
      const body = await request(context, op, args, account, Math.floor(max / all.length), token).catch((err) => redactSecrets(String(err.message ?? err)));
      return `## API key "${account.name}"${account.orgId ? ` (organization ${account.orgId})` : ''}\n${body}`;
    })
  );
  return text(`Ran with each of the user's ${all.length} API keys (organizations); pass one key's name as apiKey to query only that one.\n\n${parts.join('\n\n')}`);
}

/** Organization-wide lists and searches run with every key when apiKey is "all". */
function everyOrganization(op: Operation, apiKey?: string) {
  return testable.isEveryKey(apiKey) && ORG_WIDE.has(op.name) && accounts.list().length > 1;
}

/** Sends one operation with one account's key; returns the status line and body, or throws an HttpError. */
async function request(
  context: vscode.ExtensionContext,
  op: Operation,
  args: Record<string, unknown>,
  account: Account,
  max: number,
  token: vscode.CancellationToken
): Promise<string> {
  const key = await accounts.key(account);
  const req = buildRequest(op, args, vscode.workspace.getConfiguration('testable').get<string>('apiUrl', 'https://api.testable.io'));
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    const res = await sendRequest(req, key, abort.signal);
    log.info(`${req.method} ${new URL(req.url).pathname} -> ${res.status} (${account.name})`);

    if (!res.ok) {
      throw new testable.HttpError(
        res.status,
        `Testable returned HTTP ${res.status} for ${op.name} (${op.method} ${op.path}): ${redactSecrets(res.text ?? '').slice(0, 2000)}`
      );
    }
    if (res.bytes) {
      const file = await saveDownload(context, op, res.contentType, res.bytes);
      return `HTTP ${res.status}. Binary response (${res.contentType}, ${res.bytes.length} bytes) saved to ${file.fsPath}`;
    }

    let body = redactSecrets(compact(res.text ?? ''));
    if (body.length > max) {
      body = `${body.slice(0, max)}\n…[truncated ${body.length - max} of ${body.length} characters; narrow the request with limit/offset/filter arguments]`;
    }
    return `HTTP ${res.status}\n${body}`;
  } finally {
    sub.dispose();
  }
}

// --- workflow tools ----------------------------------------------------------------

function registerWorkflowTools(context: vscode.ExtensionContext, services: Services) {
  const tool = <T>(name: string, impl: vscode.LanguageModelTool<T & KeyInput>) =>
    context.subscriptions.push(vscode.lm.registerTool(name, withApiKey(impl, () => WORKFLOW_TOOLS[name] === 'read')));
  const client = (input: KeyInput, token: vscode.CancellationToken) => services.client({ token, apiKey: input.apiKey });

  tool<{ query?: string; allRepos?: boolean }>('testable_showTests', {
    prepareInvocation: () => ({ invocationMessage: 'Loading Testable test cases' }),
    async invoke(options, token) {
      const view = await testsView(services, await client(options.input, token), options.input);
      return withView(json(testsForModel(view)), view);
    },
  });

  tool<{ scenarioId: number }>('testable_showScenario', {
    prepareInvocation: (options) => ({ invocationMessage: `Loading Testable scenario ${options.input.scenarioId}` }),
    async invoke(options, token) {
      const view = await scenarioView(services, await client(options.input, token), options.input.scenarioId);
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
      const { executionId, confId, apiKey, ...opts } = options.input;
      const t = await client({ apiKey }, token);
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
      const t = await client(options.input, token);
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
        const plan = await testable.planPush(await client(options.input, token), options.input.scenarioId, services.root(), options.input.paths);
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
      const t = await client(options.input, token);
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
        const plan = await testable.previewScenarioSettings(await client(options.input, token), scenarioId, settings ?? {}, allowNewKeys);
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
      const t = await client(options.input, token);
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
        const plan = await testable.previewParams(await client(options.input, token), confId, set, unset);
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
      const t = await client(options.input, token);
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
        const t = await client(options.input, token);
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
      const t = await client(options.input, token);
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
      `Other organizations (API keys) also have test cases linked to this repo. To look into one of them, pass its name as apiKey to any Testable tool; to make it this workspace's key, ask the user to click Use on the page or run "Testable: Select API Key".`,
  ];
  const all = accounts.list();
  return {
    apiKey: view.account?.name,
    workspaceApiKey: view.workspaceAccountId && view.workspaceAccountId !== view.account?.id ? all.find((a) => a.id === view.workspaceAccountId)?.name : undefined,
    apiKeys: all.length > 1 ? all.map((a) => ({ name: a.name, organizationId: a.orgId })) : undefined,
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
