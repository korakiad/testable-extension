// The Testable UI: a chat output renderer that turns tool results into an
// interactive page inside the chat (proposed chatOutputRenderer API), and the
// same page in an editor tab ("Testable: Open Dashboard"). The page itself is
// media/view.js; this file serves it and answers its rpc calls.
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AccountLink, Accounts } from './accounts';
import { redactSecrets } from './client';
import * as testable from './testable';

const VIEW_MIME = 'application/vnd.testable.view+json';
const VIEW_TYPE = 'testable.view';

export interface Banner {
  kind?: 'ok' | 'warn' | 'error';
  text: string;
  items?: string[];
}

/** Every view names the API key it was loaded with, and the page keeps using that key. */
export type View = { account?: testable.AccountRef } & (
  | { kind: 'loading' }
  /**
   * accounts: what each API key's organization links to this repo, when there is more than one key.
   * workspaceAccountId: the workspace's key; account (the page's) differs from it when a tool's apiKey named
   * another key, or when the workspace switched keys after the page loaded.
   */
  | { kind: 'tests'; data: testable.TestsView; accounts?: AccountLink[]; workspaceAccountId?: string; banner?: Banner }
  | { kind: 'scenario'; data: testable.ScenarioDetail; sync?: testable.SyncResult; banner?: Banner }
  | { kind: 'conf'; data: testable.ConfDetail; banner?: Banner }
  | { kind: 'execution'; data: testable.ExecutionArtifacts; banner?: Banner }
);

export interface Services {
  /** A client for the API key a tool's apiKey argument names or a page was opened with, else the workspace's. */
  client(opts?: { token?: vscode.CancellationToken; accountId?: string; apiKey?: string }): Promise<testable.Testable>;
  /** Folder that downloads and pulled scenario files go to. */
  root(): string;
  repos(): Promise<testable.RepoInfo[]>;
  accounts: Accounts;
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

let rendererReady = false;

export function registerUi(context: vscode.ExtensionContext, services: Services, log: vscode.LogOutputChannel) {
  try {
    context.subscriptions.push(
      vscode.chat.registerChatOutputRenderer(VIEW_TYPE, {
        async renderChatOutput({ value }, output) {
          const view = JSON.parse(new TextDecoder().decode(value)) as View;
          const listener = mount(context, services, output.webview, view, { panel: false, id: hash(value) });
          output.onDidDispose(() => listener.dispose());
        },
      })
    );
    rendererReady = true;
  } catch (err) {
    // Stable VS Code only grants proposed APIs to extensions listed in argv.json.
    log.warn(`Chat UI is off, tools return text only: ${err}`);
    void suggestEnablingUi(context);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('testable.openDashboard', () => {
      const panel = vscode.window.createWebviewPanel('testable.dashboard', 'Testable', vscode.ViewColumn.Active, {
        retainContextWhenHidden: true,
      });
      panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-light.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'logo-dark.svg'),
      };
      const listener = mount(context, services, panel.webview, { kind: 'loading' }, { panel: true, id: randomUUID() });
      panel.onDidDispose(() => listener.dispose());
    })
  );
}

/** Attaches the page payload to a tool result; the model only ever sees the text parts. */
export function withView(result: vscode.LanguageModelToolResult, view: View): vscode.LanguageModelToolResult {
  if (rendererReady) {
    (result as vscode.ExtendedLanguageModelToolResult2).toolResultDetails2 = {
      mime: VIEW_MIME,
      value: new TextEncoder().encode(JSON.stringify(view)),
    };
  }
  return result;
}

async function suggestEnablingUi(context: vscode.ExtensionContext) {
  const key = 'testable.uiHintDismissed';
  if (context.globalState.get(key)) return;
  const open = 'Open argv.json';
  const never = "Don't Show Again";
  const choice = await vscode.window.showInformationMessage(
    `Testable can show its results as interactive pages in the chat. Add "enable-proposed-api": ["${context.extension.id}"] to argv.json and restart VS Code to turn it on.`,
    open,
    never
  );
  if (choice === open) await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
  if (choice === never) await context.globalState.update(key, true);
}

// --- page ------------------------------------------------------------------------

function mount(
  context: vscode.ExtensionContext,
  services: Services,
  webview: vscode.Webview,
  view: View,
  opts: { panel: boolean; id: string }
): vscode.Disposable {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.file(services.root())] };
  const nonce = randomUUID().replace(/-/g, '');
  const boot = JSON.stringify({ id: opts.id, panel: opts.panel, view: decorate(webview, view) }).replace(/</g, '\\u003c');
  webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'))}">
<title>Testable</title>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="initial" nonce="${nonce}">${boot}</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'))}"></script>
</body>
</html>`;

  return webview.onDidReceiveMessage(async (m: { type?: string; id: number; method: string; params?: any; account?: string }) => {
    if (m?.type !== 'rpc') return;
    try {
      const result = await handle(services, m.method, m.params ?? {}, m.account);
      await webview.postMessage({ type: 'rpc', id: m.id, result: decorate(webview, result) });
    } catch (err) {
      const cancelled = err instanceof Cancelled;
      await webview.postMessage({ type: 'rpc', id: m.id, error: redactSecrets((err as Error).message), cancelled });
    }
  });
}

/** Gives downloaded images a webview URL so the execution page can show thumbnails. */
function decorate<T>(webview: vscode.Webview, value: T): T {
  const view = value as View;
  if (view?.kind !== 'execution') return value;
  const files = view.data.files.map((f) =>
    /^image\/(png|jpe?g|gif|webp)/.test(f.contentType ?? '') ? { ...f, src: webview.asWebviewUri(vscode.Uri.file(f.path)).toString() } : f
  );
  return { ...view, data: { ...view.data, files } } as T;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

// --- views shared with the chat tools ------------------------------------------------

/** The test cases of the client's organization, plus what every other API key's organization links to this repo. */
export async function testsView(
  services: Services,
  t: testable.Testable,
  opts: { query?: string; allRepos?: boolean } = {}
): Promise<Extract<View, { kind: 'tests' }>> {
  const multiple = services.accounts.list().length > 1;
  const [data, others] = await Promise.all([
    testable.listTests(t, await services.repos(), opts),
    multiple ? services.accounts.scan({ skip: t.account?.id }) : [],
  ]);
  const own = services.accounts.list().find((a) => a.id === t.account?.id);
  const accounts = multiple && own ? [{ account: own, link: data.link }, ...others] : undefined;
  return { kind: 'tests', data, accounts, workspaceAccountId: services.accounts.picked()?.id, account: t.account };
}

export async function scenarioView(services: Services, t: testable.Testable, scenarioId: number, extra: { sync?: testable.SyncResult; banner?: Banner } = {}): Promise<View> {
  return { kind: 'scenario', data: await testable.getScenario(t, scenarioId, services.root()), account: t.account, ...extra };
}

export async function confView(t: testable.Testable, confId: number, banner?: Banner): Promise<View> {
  return { kind: 'conf', data: await testable.getConf(t, confId), account: t.account, banner };
}

export function syncBanner(verb: string, sync: testable.SyncResult): Banner {
  const done = sync.entries.filter((e) => e.action === 'download' || e.action === 'create' || e.action === 'update');
  const kept = sync.entries.filter((e) => e.action === 'keep-local' || e.action === 'conflict');
  const items = [
    ...kept.map((e) => (e.action === 'keep-local' ? `${e.path}: kept your local edits` : `${e.path}: changed in Testable since the last pull, not pushed`)),
    ...sync.errors,
  ];
  return {
    kind: sync.errors.length ? 'error' : kept.length ? 'warn' : 'ok',
    text: `${verb} ${done.length} file${done.length === 1 ? '' : 's'}.`,
    items,
  };
}

export function diffText(diff: testable.Change[]): string {
  const show = (v: unknown) => (v === undefined ? '(unset)' : typeof v === 'string' ? v : JSON.stringify(v));
  return diff.map((d) => `${d.key}: ${show(d.from)} → ${show(d.to)}`).join('\n');
}

// --- rpc --------------------------------------------------------------------------------

async function confirm(message: string, detail: string, action: string) {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  if (choice !== action) throw new Cancelled();
}

/**
 * Asks for a new VCS token in a password box (it never reaches the chat), checks it
 * against the repository and saves it. A failed check can still be saved, since
 * Testable may not reach a private repository that only self-hosted runners can.
 */
export async function updateToken(t: testable.Testable, repositoryId: number) {
  const repo = await testable.getRepository(t, repositoryId);
  const name = repo.url ?? `VCS root ${repo.id}`;
  const token = await vscode.window.showInputBox({
    title: `New token for ${name}`,
    prompt: `Personal access token or password${repo.username ? ` for ${repo.username}` : ''}. Sent to Testable only, never to the chat.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!token?.trim()) throw new Cancelled();
  try {
    await testable.checkToken(t, repositoryId, token.trim());
  } catch (err) {
    await confirm(
      `Testable could not reach ${name} with this token.`,
      `${redactSecrets((err as Error).message)}\n\nSave the token anyway?`,
      'Save Anyway'
    );
  }
  await testable.saveToken(t, repositoryId, token.trim());
}

async function handle(services: Services, method: string, p: any, accountId?: string): Promise<unknown> {
  // Switching keys comes first, so it works even when the page's own key has been removed.
  if (method === 'useAccount' || method === 'selectAccount') {
    const account = method === 'useAccount' ? { id: String(p.id) } : await services.accounts.select();
    if (!account) throw new Cancelled();
    const view = await testsView(services, await services.client({ accountId: account.id }));
    // Use only switches the workspace once the key has loaded; select() already did.
    if (method === 'useAccount') await services.accounts.use(account.id);
    return { ...view, workspaceAccountId: account.id };
  }

  const t = await services.client({ accountId });
  const root = services.root();
  switch (method) {
    case 'load':
      if (p.kind === 'tests') return testsView(services, t, { allRepos: p.allRepos });
      if (p.kind === 'scenario') return scenarioView(services, t, p.id);
      if (p.kind === 'conf') return confView(t, p.id);
      throw new Error(`Unknown view ${p.kind}`);

    case 'confs':
      return testable.loadTestCaseConfs(t, p.testCaseId);

    case 'download':
      return { kind: 'execution', data: await testable.downloadExecution(t, p, root), account: t.account } satisfies View;

    case 'pull': {
      const sync = await testable.pullScenarioFiles(t, p.scenarioId, root);
      return scenarioView(services, t, p.scenarioId, { sync, banner: syncBanner('Pulled', sync) });
    }

    case 'push': {
      const plan = await testable.planPush(t, p.scenarioId, root);
      const changes = plan.entries.filter((e) => e.action !== 'unchanged');
      if (!changes.length) {
        return scenarioView(services, t, p.scenarioId, { banner: { text: 'Nothing to push: the local files match Testable.' } });
      }
      const conflicts = changes.filter((e) => e.action === 'conflict').length;
      await confirm(
        `Push ${changes.length} file${changes.length === 1 ? '' : 's'} to scenario "${plan.scenario.name}"?`,
        changes.map((e) => `${e.action}  ${e.path}`).join('\n') +
          (conflicts ? `\n\n${conflicts} file(s) changed in Testable since your last pull and will be overwritten.` : ''),
        'Push'
      );
      const sync = await testable.pushScenarioFiles(t, p.scenarioId, root, { force: true });
      return scenarioView(services, t, p.scenarioId, { sync, banner: syncBanner('Pushed', sync) });
    }

    case 'saveSettings': {
      const plan = await testable.previewScenarioSettings(t, p.scenarioId, p.changes);
      if (plan.unknownKeys.length) throw new Error(`Unknown settings: ${plan.unknownKeys.join(', ')}`);
      if (plan.diff.length) {
        await confirm(`Update ${plan.diff.length} setting(s) of "${plan.scenario.name}"?`, diffText(plan.diff), 'Save');
        await testable.updateScenarioSettings(t, p.scenarioId, p.changes);
      }
      return scenarioView(services, t, p.scenarioId, { banner: { kind: 'ok', text: 'Settings saved.', items: diffText(plan.diff).split('\n').filter(Boolean) } });
    }

    case 'saveParams': {
      const plan = await testable.previewParams(t, p.confId, p.set, p.unset);
      if (plan.diff.length) {
        await confirm(`Update scenario params of "${plan.conf.name}"?`, diffText(plan.diff), 'Save');
        await testable.setParams(t, p.confId, p.set, p.unset);
      }
      return confView(t, p.confId, { kind: 'ok', text: 'Params saved.', items: diffText(plan.diff).split('\n').filter(Boolean) });
    }

    case 'branches':
      return testable.listBranches(t, p.repositoryId);

    case 'setBranch': {
      const plan = await testable.previewScenarioSettings(t, p.scenarioId, { branch: p.branch }, true);
      if (plan.diff.length) {
        await confirm(`Switch scenario "${plan.scenario.name}" to branch "${p.branch}"?`, diffText(plan.diff), 'Switch');
        await testable.setScenarioBranch(t, p.scenarioId, p.branch);
      }
      return scenarioView(services, t, p.scenarioId, { banner: { kind: 'ok', text: `Branch set to ${p.branch}.` } });
    }

    case 'token':
      await updateToken(t, p.repositoryId);
      return true;

    case 'run': {
      const conf = await t.run('getTestConf', { path_conf: p.confId });
      await confirm(`Run "${conf.name}"?`, 'This starts a new execution in Testable.', 'Run');
      return testable.executionRow(await t.run('startExecution', { path_confId: p.confId }));
    }

    case 'status':
      return testable.executionRow(await t.run('getExecution', { path_executionId: p.executionId, query_includeSummary: false }));

    case 'open': {
      const uri = vscode.Uri.file(p.path);
      if (!existsSync(uri.fsPath)) throw new Error(p.hint ?? `${p.path} does not exist.`);
      await vscode.commands.executeCommand('vscode.open', uri);
      return true;
    }

    case 'reveal': {
      const uri = vscode.Uri.file(p.path);
      if (!existsSync(uri.fsPath)) throw new Error(`${p.path} does not exist yet.`);
      await vscode.commands.executeCommand(vscode.workspace.getWorkspaceFolder(uri) ? 'revealInExplorer' : 'revealFileInOS', uri);
      return true;
    }

    case 'ask':
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: p.prompt, isPartialQuery: true });
      return true;

    default:
      throw new Error(`Unknown action ${method}`);
  }
}
