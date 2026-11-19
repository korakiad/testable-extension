// API keys for one or more Testable organizations. Names live in globalState and
// keys in SecretStorage. Each workspace remembers which key it uses: the one the
// user picked, or the one whose test case linked to the workspace's git remote
// ran last, since the same repo can end up in more than one organization.
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { redactSecrets } from './client';
import { SessionKey, SessionOrg, SignInCancelled, SignInResult, signIn, webHost } from './session';
import * as testable from './testable';

export interface Account extends testable.AccountRef {
  /** Organization the key belongs to, read from its test cases when it was added. */
  orgId?: number;
}

/** What one API key's organization has linked to the workspace's git remote. */
export interface AccountLink {
  account: Account;
  link?: testable.RepoLink;
  error?: string;
}

interface WorkspacePick {
  id: string;
  /** Detected from the git remote rather than picked by the user. */
  auto?: boolean;
}

const LIST = 'testable.accounts';
const PICK = 'testable.account';
const LEGACY_SECRET = 'testable.apiKey';
const secretName = (id: string) => `testable.apiKey.${id}`;
const NO_KEY = 'No Testable API key is set. Ask the user to run the "Testable: Add API Key" command.';

export class Accounts {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private detecting?: Promise<Account>;
  private migrated?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: () => Promise<testable.RepoInfo[]>,
    private readonly log: vscode.LogOutputChannel
  ) {}

  list(): Account[] {
    return this.context.globalState.get<Account[]>(LIST, []);
  }

  /** The account this workspace is set to, if it still exists. */
  picked(): (Account & { auto: boolean }) | undefined {
    const pick = this.context.workspaceState.get<WorkspacePick>(PICK);
    const account = pick && this.list().find((a) => a.id === pick.id);
    return account && { ...account, auto: !!pick.auto };
  }

  /** The workspace's account: the one set for it, else the only one, else detected from the git remote. */
  async current(): Promise<Account> {
    await this.migrate();
    const picked = this.picked();
    if (picked) return picked;
    const all = this.list();
    if (!all.length) {
      const added = await this.add();
      if (!added) throw new Error(NO_KEY);
      return added;
    }
    if (all.length === 1) return all[0];
    this.detecting ??= this.detect().finally(() => (this.detecting = undefined));
    return this.detecting;
  }

  /**
   * The account a call uses: the one a tool's apiKey argument names, the one a page was
   * opened with (a page keeps using it), or the workspace's. apiKey "all" starts with the
   * workspace's; the tools try the others themselves.
   */
  async resolve(opts: { accountId?: string; apiKey?: string } = {}): Promise<Account> {
    await this.migrate();
    if (opts.apiKey && !testable.isEveryKey(opts.apiKey)) return this.named(opts.apiKey);
    return opts.accountId ? this.get(opts.accountId) : this.current();
  }

  /** The account named by a tool's apiKey argument; the error lists the names for the model. */
  named(name: string): Account {
    const account = testable.findAccount(this.list(), name);
    if (account) return account;
    const all = this.list().map((a) => `"${a.name}"${a.orgId ? ` (org ${a.orgId})` : ''}`);
    throw new Error(
      all.length
        ? `No Testable API key is named "${name}". The user's API keys: ${all.join(', ')}. Pass one of these names as apiKey, "${testable.EVERY_KEY}" to look in every organization, or leave apiKey out to use this workspace's key.`
        : NO_KEY
    );
  }

  async client(opts: { accountId?: string; apiKey?: string; token?: vscode.CancellationToken } = {}): Promise<testable.Testable> {
    const account = await this.resolve(opts);
    const abort = new AbortController();
    opts.token?.onCancellationRequested(() => abort.abort());
    return this.connect(account, abort.signal);
  }

  async key(account: Account): Promise<string> {
    const key = await this.context.secrets.get(secretName(account.id));
    if (!key) throw new Error(`The Testable API key "${account.name}" is missing from secret storage. Ask the user to remove it and add it again.`);
    return key;
  }

  async use(id: string, auto = false) {
    await this.context.workspaceState.update(PICK, { id, auto } satisfies WorkspacePick);
    this.changed.fire();
  }

  /** Looks up, with every API key, the test cases linked to this workspace's git remote. */
  async scan(opts: { skip?: string } = {}): Promise<AccountLink[]> {
    const repos = await this.repos();
    const accounts = this.list().filter((a) => a.id !== opts.skip);
    return Promise.all(
      accounts.map(async (account) => {
        try {
          return { account, link: await testable.findLinks(await this.connect(account), repos) };
        } catch (err) {
          return { account, error: redactSecrets(String((err as Error).message ?? err)) };
        }
      })
    );
  }

  async add(): Promise<Account | undefined> {
    const key = (
      await vscode.window.showInputBox({
        title: 'Add Testable API Key',
        prompt: 'Found under Settings → API Keys in Testable. Stored in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!key) return undefined;
    const same = (await this.stored()).get(key);
    if (same) {
      vscode.window.showInformationMessage(`This API key is already added as "${same.name}".`);
      return same;
    }

    let orgId: number | undefined;
    try {
      orgId = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking the Testable API key…' }, () =>
        testable.organizationId(new testable.Testable(key, apiUrl()))
      );
    } catch (err) {
      const choice = await vscode.window.showWarningMessage(
        'Testable did not accept this API key.',
        { modal: true, detail: `${redactSecrets((err as Error).message)}\n\nAdd it anyway?` },
        'Add Anyway'
      );
      if (choice !== 'Add Anyway') return undefined;
    }

    const sameOrg = orgId && this.list().find((a) => a.orgId === orgId);
    const name = await this.askName({
      value: orgId ? `Org ${orgId}` : `Testable ${this.list().length + 1}`,
      prompt: sameOrg ? `This key is for the same organization as "${sameOrg.name}".` : 'Shown when choosing the key a workspace uses, e.g. the organization name.',
    });
    if (!name) return undefined;
    const account: Account = { id: randomUUID(), name, orgId };
    await this.context.secrets.store(secretName(account.id), key);
    await this.save([...this.list(), account]);
    return account;
  }

  /**
   * Opens the Testable login page in a private browser window, then lists the API keys of every
   * organization the user belongs to and saves the ones they tick, named after the organization.
   * Returns what was saved and what the login found; no key leaves this class. Reached only
   * through the testable_signIn tool, which the /testable-sign-in skill calls.
   */
  async signIn(token?: vscode.CancellationToken): Promise<{ saved: Account[]; orgs: SessionOrg[] } | undefined> {
    const host = await this.webAddress();
    if (!host) return undefined;
    let found: SignInResult;
    try {
      found = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Waiting for you to log in at ${host} in the private browser window…`, cancellable: true },
        (_progress, cancel) => {
          const abort = new AbortController();
          cancel.onCancellationRequested(() => abort.abort());
          token?.onCancellationRequested(() => abort.abort());
          return signIn({
            host,
            profileRoot: path.join(this.context.globalStorageUri.fsPath, 'login-browser'),
            browserPath: vscode.workspace.getConfiguration('testable').get<string>('loginBrowser'),
            signal: abort.signal,
          });
        }
      );
    } catch (err) {
      if (err instanceof SignInCancelled) return undefined;
      throw err;
    }

    const { orgs } = found;
    const stored = await this.stored();
    const notes = [
      ...orgs.filter((o) => o.error).map((o) => `Could not read the API keys of "${o.name}": ${o.error}.`),
      ...orgs.filter((o) => !o.error && !o.keys.length).map((o) => `"${o.name}" has no API key yet.`),
    ];
    this.log.info(`Signed in at ${host}: ${orgs.length} organizations, ${orgs.reduce((n, o) => n + o.keys.length, 0)} API keys. ${notes.join(' ')}`);
    if (!orgs.some((o) => o.keys.length)) {
      vscode.window.showWarningMessage(
        orgs.length
          ? `No API key to save. ${notes.join(' ')} Create one under Settings → API Keys in Testable, then sign in again.`
          : 'This Testable login belongs to no organization.'
      );
      return { saved: [], orgs };
    }

    type Item = vscode.QuickPickItem & { org?: SessionOrg; key?: SessionKey };
    const items: Item[] = orgs
      .filter((o) => o.keys.length)
      .flatMap((org) => {
        // One key is enough for an organization, so its first Regular key (a Viewer key cannot
        // change anything) starts ticked, unless the organization already has a saved key.
        const covered = this.list().some((a) => a.orgId === org.id) || org.keys.some((k) => stored.has(k.key));
        const suggested = covered ? undefined : org.keys.find((k) => k.accessType?.toLowerCase() === 'regular');
        return [
          { label: [org.name, `org ${org.id}`, org.role].filter(Boolean).join(' · '), kind: vscode.QuickPickItemKind.Separator },
          ...org.keys.map((key) => {
            const have = stored.get(key.key);
            return {
              label: `$(key) ${key.description || 'API key'}`,
              // The separator above each group names the organization, so a row has only what tells its keys apart.
              description: [key.accessType, `…${key.key.slice(-4)}`, have && `already saved as "${have.name}"`].filter(Boolean).join(' · '),
              picked: key === suggested,
              org,
              key,
            };
          }),
        ];
      });
    const suggestions = items.filter((i) => i.picked).length;
    const picked = await vscode.window.showQuickPick(items, {
      title: `Save Testable API keys${found.user.email ? ` of ${found.user.email}` : ''}`,
      placeHolder: suggestions
        ? 'One Regular key per organization is ticked; change if needed'
        : 'Tick the API keys to save in VS Code secret storage',
      canPickMany: true,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;

    const fresh = picked.filter((p) => p.org && p.key && !stored.has(p.key.key));
    const list = this.list();
    const saved: Account[] = [];
    for (const { org, key } of fresh) {
      const several = fresh.filter((p) => p.org === org).length > 1;
      const name = this.freeName(several && key!.description ? `${org!.name} · ${key!.description}` : org!.name, [...list, ...saved]);
      const account: Account = { id: randomUUID(), name, orgId: org!.id };
      await this.context.secrets.store(secretName(account.id), key!.key);
      saved.push(account);
    }
    if (saved.length) await this.save([...list, ...saved]);
    const skipped = picked.length - fresh.length;
    vscode.window.showInformationMessage(
      [
        saved.length ? `Saved ${saved.length} Testable API key${saved.length > 1 ? 's' : ''}: ${saved.map((a) => `"${a.name}"`).join(', ')}.` : 'No new Testable API key was saved.',
        skipped ? `${skipped} already saved.` : '',
        ...notes,
      ]
        .filter(Boolean)
        .join(' ')
    );
    return { saved, orgs };
  }

  async remove(account: Account) {
    await this.context.secrets.delete(secretName(account.id));
    await this.save(this.list().filter((a) => a.id !== account.id));
  }

  async rename(account: Account) {
    const name = await this.askName({ value: account.name, prompt: 'New name for this API key.' }, account);
    if (name) await this.save(this.list().map((a) => (a.id === account.id ? { ...a, name } : a)));
  }

  /**
   * Lets the user choose the workspace's key. Each entry says which test cases its
   * organization links to this repo and when they last ran, so a repo that was set up
   * in the wrong organization stands out. Returns the chosen account.
   */
  async select(links?: AccountLink[]): Promise<Account | undefined> {
    await this.migrate();
    type Item = vscode.QuickPickItem & { account?: Account; add?: boolean };
    const rename = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename' };
    const remove = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Testable API key for this workspace';
    qp.matchOnDetail = true;
    const render = () => {
      const all = this.list();
      const picked = this.picked();
      const inUse = picked?.id ?? (all.length === 1 ? all[0].id : undefined);
      const active = qp.activeItems[0]?.account?.id ?? inUse;
      const latest = all.length > 1 && links ? testable.latestLink(links) : undefined;
      const items: Item[] = all.map((account) => {
        const entry = links?.find((l) => l.account.id === account.id);
        const notes = [
          account.id === inUse && (picked?.auto ? 'in use, detected' : 'in use'),
          account.id === latest?.account.id && latest.link?.lastRunAt && 'most recent run',
        ];
        return {
          label: `${account.id === inUse ? '$(check) ' : ''}${account.name}`,
          description: notes.filter(Boolean).join(' · ') || undefined,
          detail: links ? describeLink(entry) : 'Checking this repo…',
          buttons: [rename, remove],
          account,
        };
      });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) Add API Key…', add: true });
      qp.items = items;
      qp.activeItems = items.filter((i) => i.account && i.account.id === active);
    };
    render();
    qp.busy = !links;
    qp.show();
    let open = true;
    if (!links) {
      void this.scan().then((found) => {
        links = found;
        if (!open) return;
        qp.busy = false;
        render();
      });
    }

    const choice = await new Promise<Item | { button: 'rename' | 'remove'; account: Account } | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidTriggerItemButton((e) => e.item.account && resolve({ button: e.button === rename ? 'rename' : 'remove', account: e.item.account }));
      qp.onDidHide(() => resolve(undefined));
    });
    open = false;
    qp.dispose();

    if (!choice) return undefined;
    if ('button' in choice) {
      if (choice.button === 'rename') await this.rename(choice.account);
      else await this.remove(choice.account);
      return this.select(links);
    }
    const account = choice.add ? await this.add() : choice.account;
    if (account) await this.use(account.id);
    return account;
  }

  /** Moves the single key of earlier versions into the list, once; current() waits for it. */
  migrate(): Promise<void> {
    this.migrated ??= (async () => {
      const key = await this.context.secrets.get(LEGACY_SECRET);
      if (!key) return;
      if (!this.list().length) {
        const account: Account = { id: randomUUID(), name: 'Default' };
        await this.context.secrets.store(secretName(account.id), key);
        await this.save([account]);
      }
      await this.context.secrets.delete(LEGACY_SECRET);
    })().catch((err) => this.log.warn(`Could not move the old API key: ${err}`));
    return this.migrated;
  }

  /** The saved accounts by their key, to spot a key that is already saved. */
  private async stored(): Promise<Map<string, Account>> {
    const keys = await Promise.all(this.list().map(async (a) => [await this.context.secrets.get(secretName(a.id)), a] as const));
    return new Map(keys.filter((entry): entry is [string, Account] => !!entry[0]));
  }

  /** `wanted`, or with a number added when another key has the name or it is the reserved one. */
  private freeName(wanted: string, taken: Account[]): string {
    const free = (name: string) => !testable.isEveryKey(name) && !taken.some((a) => a.name === name);
    for (let n = 1; ; n++) {
      const name = n === 1 ? wanted : `${wanted} ${n}`;
      if (free(name)) return name;
    }
  }

  /** The host the user opens Testable at (a company login has its own); asked once and kept in the settings. */
  private async webAddress(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('testable');
    const set = webHost(config.get<string>('webUrl', ''));
    if (set) return set;
    const answer = await vscode.window.showInputBox({
      title: 'Testable web address',
      prompt: 'The address you open Testable at. A company login (SSO) has its own, e.g. yourcompany.testable.io. Saved as the testable.webUrl setting.',
      value: 'a.testable.io',
      ignoreFocusOut: true,
      validateInput: (v) => (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(webHost(v)) ? undefined : 'Enter a host name such as yourcompany.testable.io.'),
    });
    if (!answer) return undefined;
    await config.update('webUrl', webHost(answer), vscode.ConfigurationTarget.Global);
    return webHost(answer);
  }

  private get(id: string): Account {
    const account = this.list().find((a) => a.id === id);
    if (!account) throw new Error('The API key this page used has been removed. Choose another one with "Testable: Select API Key".');
    return account;
  }

  private async connect(account: Account, signal?: AbortSignal) {
    return new testable.Testable(await this.key(account), apiUrl(), signal, { id: account.id, name: account.name });
  }

  /** Picks the account whose test case linked to the workspace's git remote ran last, and remembers it. */
  private async detect(): Promise<Account> {
    const links = await this.scan();
    const best = testable.latestLink(links);
    const account = best?.account ?? this.list()[0];
    await this.use(account.id, true);
    const testCase = best?.link?.testCases[0];
    const message = testCase
      ? `Testable: this workspace uses the API key "${account.name}". Its test case "${testCase.path}" is linked to this repo and ${testCase.lastRunAt ? `last ran ${formatDate(testCase.lastRunAt)}` : 'has not run yet'}.`
      : links.some((l) => l.link?.status === 'norepo')
        ? `Testable: this workspace has no git remote to match test cases against, so it uses the API key "${account.name}".`
        : `Testable: none of your API keys has a test case linked to this repo, so this workspace uses "${account.name}".`;
    this.log.info(message);
    void vscode.window.showInformationMessage(message, 'Change…').then((choice) => choice && this.select(links));
    return account;
  }

  private async askName(opts: { value: string; prompt: string }, except?: Account) {
    const name = await vscode.window.showInputBox({
      title: 'Name the Testable API key',
      ignoreFocusOut: true,
      ...opts,
      validateInput: (v) =>
        !v.trim()
          ? 'Enter a name.'
          : testable.isEveryKey(v)
            ? `"${testable.EVERY_KEY}" is reserved: the chat uses it to mean every key.`
            : this.list().some((a) => a.name === v.trim() && a.id !== except?.id)
              ? 'Another key already has this name.'
              : undefined,
    });
    return name?.trim() || undefined;
  }

  private async save(list: Account[]) {
    await this.context.globalState.update(LIST, list);
    this.changed.fire();
  }
}

/** Registers the API key commands and a status bar item naming the workspace's key once there is more than one. */
export function registerAccounts(context: vscode.ExtensionContext, accounts: Accounts) {
  const item = vscode.window.createStatusBarItem('testable.account', vscode.StatusBarAlignment.Left, 0);
  item.name = 'Testable API Key';
  item.command = 'testable.selectApiKey';
  const update = () => {
    const picked = accounts.picked();
    if (accounts.list().length < 2) return item.hide();
    item.text = `$(beaker) ${picked?.name ?? 'Testable'}`;
    item.tooltip = picked
      ? `Testable API key for this workspace${picked.auto ? ', detected from the git remote' : ''}. Click to change.`
      : 'Testable picks an API key for this workspace on first use. Click to choose one now.';
    item.show();
  };
  update();

  context.subscriptions.push(
    item,
    accounts.onDidChange(update),
    vscode.commands.registerCommand('testable.addApiKey', () => accounts.add()),
    vscode.commands.registerCommand('testable.selectApiKey', () => accounts.select()),
    vscode.commands.registerCommand('testable.removeApiKey', async () => {
      const items = accounts.list().map((account) => ({ label: account.name, description: account.orgId ? `org ${account.orgId}` : undefined, account }));
      if (!items.length) return vscode.window.showInformationMessage('No Testable API key is set.');
      const choice = await vscode.window.showQuickPick(items, { title: 'Remove a Testable API key' });
      if (!choice) return;
      await accounts.remove(choice.account);
      vscode.window.showInformationMessage(`Removed the Testable API key "${choice.account.name}".`);
    })
  );
  void accounts.migrate();
}

/** One line on what an account links to this repo, for the quick pick. */
function describeLink(entry: AccountLink | undefined): string {
  if (!entry) return '';
  if (entry.error) return `Error: ${entry.error}`;
  const link = entry.link!;
  if (link.status === 'norepo') return 'No git remote in this workspace';
  if (link.status === 'unavailable') return 'Cannot read VCS roots with this key';
  if (link.status === 'nomatch') return 'No test case linked to this repo';
  const names = link.testCases.map((c) => c.path.replace(/^\/+/, ''));
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return `${link.lastRunAt ? `last run ${formatDate(link.lastRunAt)}` : 'never run'} · ${shown}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function apiUrl() {
  return vscode.workspace.getConfiguration('testable').get<string>('apiUrl', 'https://api.testable.io');
}
