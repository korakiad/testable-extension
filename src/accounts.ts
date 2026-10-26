// API keys for one or more Testable organizations. Names live in globalState and
// keys in SecretStorage. Each workspace remembers which key it uses: the one the
// user picked, or the one whose test case linked to the workspace's git remote
// ran last, since the same repo can end up in more than one organization.
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './client';
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
      if (!added) throw new Error('No Testable API key is set. Ask the user to run the "Testable: Add API Key" command.');
      return added;
    }
    if (all.length === 1) return all[0];
    this.detecting ??= this.detect().finally(() => (this.detecting = undefined));
    return this.detecting;
  }

  /** A client for the given account (a page keeps using the one it was opened with), or for the workspace's. */
  async client(opts: { accountId?: string; token?: vscode.CancellationToken } = {}): Promise<testable.Testable> {
    const account = opts.accountId ? this.get(opts.accountId) : await this.current();
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
    for (const a of this.list()) {
      if ((await this.context.secrets.get(secretName(a.id))) === key) {
        vscode.window.showInformationMessage(`This API key is already added as "${a.name}".`);
        return a;
      }
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
        !v.trim() ? 'Enter a name.' : this.list().some((a) => a.name === v.trim() && a.id !== except?.id) ? 'Another key already has this name.' : undefined,
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
