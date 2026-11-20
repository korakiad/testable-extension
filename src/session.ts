// Browser sign-in to the Testable web app, used to import API keys. Opens a private
// (incognito) Chrome window with a throwaway profile on the login page, waits for the
// session cookie the web app sets after a password or SSO login, then reads the user's
// organizations and their API keys with that session, as the web app's own "API Keys"
// page does. Nothing of the login is kept: the profile is deleted once the window closes.
// Kept free of the vscode module so it can be exercised from plain Node.
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Writable } from 'node:stream';

const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const SESSION_RECHECK_MS = 3000;

export interface SessionKey {
  key: string;
  description: string;
  /** "Regular" or "Viewer", as Testable names it. */
  accessType?: string;
}

export interface SessionOrg {
  id: number;
  name: string;
  /** The user's role in the organization. */
  role?: string;
  keys: SessionKey[];
  /** Why the keys could not be read, e.g. the role may not list them. */
  error?: string;
}

export interface SignInResult {
  user: { name?: string; email?: string };
  orgs: SessionOrg[];
}

export class SignInCancelled extends Error {
  constructor(message = 'The Testable sign-in was cancelled.') {
    super(message);
  }
}

/** "https://YourCompany.testable.io/login" → "yourcompany.testable.io". */
export function webHost(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

/** The REST API as the web app on this host calls it: a company subdomain proxies it at /api. */
export function sessionApiUrl(host: string): string {
  return host === 'a.testable.io' || host === 'testable.io' ? 'https://api.testable.io' : `https://${host}/api`;
}

const isEdge = (exe: string) => /edge/i.test(basename(exe));

/** Chrome, or Edge when there is no Chrome. */
export function findBrowser(preferred?: string): string | undefined {
  if (preferred?.trim()) return existsSync(preferred.trim()) ? preferred.trim() : undefined;
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].flatMap((dir) =>
          dir ? [`${dir}\\Microsoft\\Edge\\Application\\msedge.exe`, `${dir}\\Google\\Chrome\\Application\\chrome.exe`] : []
        )
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = candidates.filter((p) => existsSync(p));
  return found.find((p) => !isEdge(p)) ?? found[0];
}

/**
 * Opens the login page of the Testable web app at `host` in a private browser window, waits until
 * the user is logged in, closes the window and returns the user's organizations with their API keys.
 * The window gets a new profile folder inside `profileRoot`, deleted afterwards.
 */
export async function signIn(opts: { host: string; profileRoot: string; browserPath?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<SignInResult> {
  const host = webHost(opts.host);
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error(`"${opts.host}" is not a web address.`);
  const exe = findBrowser(opts.browserPath);
  if (!exe) {
    throw new Error(
      opts.browserPath?.trim() ? `No browser at "${opts.browserPath}" (the testable.loginBrowser setting).` : 'Signing in needs Google Chrome (or Microsoft Edge), and neither was found. Set testable.loginBrowser to the path of one.'
    );
  }
  if (opts.signal?.aborted) throw new SignInCancelled();
  await mkdir(opts.profileRoot, { recursive: true });
  const profileDir = await mkdtemp(join(opts.profileRoot, 'login-'));
  const api = sessionApiUrl(host);
  const browser = new Browser(exe, profileDir, `https://${host}/login`);
  let session: { sid: string; login: any };
  try {
    session = await waitForSession(browser, host, api, opts.signal, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  } finally {
    await browser.close();
    // The browser lets go of its files a moment after it exits.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
  }

  const { sid, login } = session;
  const orgs: SessionOrg[] = (login.user?.orgAssociations ?? [])
    .filter((a: any) => a?.organization?.id)
    .map((a: any) => ({ id: a.organization.id, name: String(a.organization.name ?? `Org ${a.organization.id}`), role: a.userRole, keys: [] }));
  await Promise.all(
    orgs.map(async (org) => {
      try {
        org.keys = await apiKeys(api, sid, org.id, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw new SignInCancelled();
        org.error = (err as Error).message;
      }
    })
  );
  orgs.sort((a, b) => a.name.localeCompare(b.name));
  return { user: { name: login.user?.name, email: login.user?.email }, orgs };
}

/** Polls the window's cookies for the web app's session id and checks each new one with the API. */
async function waitForSession(browser: Browser, host: string, api: string, signal: AbortSignal | undefined, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const checkAgainAt = new Map<string, number>();
  const attached = new Map<string, string>();
  let opened = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (signal?.aborted) throw new SignInCancelled();
    // On macOS the browser keeps running after its last window is closed, so look for the window too.
    const pages = await browser
      .send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets')
      .then((r) => r.targetInfos.filter((t) => t.type === 'page'))
      .catch(() => undefined);
    opened ||= !!pages?.length;
    if (browser.closed || (opened && pages?.length === 0)) throw new SignInCancelled('The browser window was closed before the login finished.');
    if (Date.now() > deadline) throw new Error('Timed out waiting for the Testable login.');
    for (const cookie of await cookies(browser, pages ?? [], attached, `https://${host}/`)) {
      if (cookie.name !== 'sid' || !cookie.value || Date.now() < (checkAgainAt.get(cookie.value) ?? 0)) continue;
      // The server may not accept this session id yet (the login is not finished, or the request
      // failed), so the same value is checked again after a pause instead of being given up on.
      const login = await get(api, '/login', cookie.value, signal).catch(() => undefined);
      if (login?.success && login.user) return { sid: String(login.sid ?? cookie.value), login };
      checkAgainAt.set(cookie.value, Date.now() + SESSION_RECHECK_MS);
    }
  }
}

/**
 * The cookies the window's tabs would send to `url`. A private window's cookies cannot be read
 * browser-wide, only through its own pages.
 */
async function cookies(browser: Browser, pages: { targetId: string }[], attached: Map<string, string>, url: string) {
  const found: { name: string; value: string }[] = [];
  for (const { targetId } of pages) {
    try {
      let session = attached.get(targetId);
      if (!session) {
        session = (await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId;
        attached.set(targetId, session);
      }
      found.push(...(await browser.send<{ cookies: { name: string; value: string }[] }>('Network.getCookies', { urls: [url] }, session)).cookies);
    } catch {
      // The tab closed; a tab that replaced it is attached on the next poll.
      attached.delete(targetId);
    }
  }
  return found;
}

async function apiKeys(api: string, sid: string, orgId: number, signal?: AbortSignal): Promise<SessionKey[]> {
  const list = await get(api, `/orgs/${orgId}/api-keys`, sid, signal);
  return (Array.isArray(list) ? list : [])
    .filter((k) => typeof k?.name === 'string' && k.name)
    .map((k) => ({ key: k.name, description: String(k.description ?? ''), accessType: k.accessType }));
}

/** GET with the session id as the web app sends it (?sid=). Errors never carry the URL, which holds the session. */
async function get(api: string, path: string, sid: string, signal?: AbortSignal): Promise<any> {
  const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${api}${path}${path.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`, {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
  } catch (err) {
    throw new Error(`GET ${path} failed: ${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`);
  }
  if (!res.ok) throw new Error(`GET ${path} returned HTTP ${res.status}`);
  return res.json();
}

/** A browser driven over the Chrome DevTools Protocol on a pipe, so no debugging port is opened. */
class Browser {
  closed = false;
  private readonly child: ChildProcess;
  private readonly input: Writable;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  private lastId = 0;
  private buffer = '';

  constructor(exe: string, profileDir: string, url: string) {
    const args = ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', isEdge(exe) ? '--inprivate' : '--incognito', '--new-window', url];
    this.child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const ended = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The browser closed.'));
      this.pending.clear();
    };
    this.child.on('exit', ended);
    this.child.on('error', ended);
    this.input = this.child.stdio[3] as Writable;
    this.input.on('error', () => undefined);
    const output = this.child.stdio[4] as Readable;
    output.setEncoding('utf8');
    // Messages are JSON, each ended by a NUL byte.
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
        const message = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        const p = this.pending.get(message.id);
        if (!p) continue;
        this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      }
    });
  }

  /** `session` addresses one tab (from Target.attachToTarget); without it the command goes to the browser. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, session?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('The browser closed.'));
      const id = ++this.lastId;
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, sessionId: session }) + '\0');
    });
  }

  async close() {
    if (this.closed) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.send('Browser.close').catch(() => undefined);
    const timer = setTimeout(() => this.child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}
