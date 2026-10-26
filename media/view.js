// Single-page UI shared by the chat output renderer and the dashboard panel.
// The extension embeds the first view as JSON; everything after that goes
// through rpc(), which the extension answers in ui.ts.
(() => {
  // @ts-ignore provided by the webview host
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const boot = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('initial')).textContent || '{}');
  if (boot.panel) document.body.classList.add('panel');

  // --- state ----------------------------------------------------------------

  const restored = vscode.getState();
  /** @type {{ id: string, stack: any[], open: Record<string, boolean>, filter: string, settingsFilter: string, drafts: Record<string, any>, polling: number[] }} */
  const state =
    restored && restored.id === boot.id
      ? restored
      : { id: boot.id, stack: [boot.view], open: {}, filter: '', settingsFilter: '', drafts: {}, polling: [] };
  let busy = 0;

  const top = () => state.stack[state.stack.length - 1];
  const save = () => vscode.setState(state);

  function go(view) {
    state.stack.push(view);
    render();
  }
  function replace(view) {
    state.stack[state.stack.length - 1] = view;
    render();
  }
  function back() {
    if (state.stack.length > 1) state.stack.pop();
    render();
  }

  // --- rpc ------------------------------------------------------------------

  let seq = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();

  function rpc(method, params = {}) {
    const id = ++seq;
    busy++;
    paintProgress();
    // The page keeps using the API key its view was loaded with, even if the workspace switches to another.
    vscode.postMessage({ type: 'rpc', id, method, params, account: top().account?.id });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject })).finally(() => {
      busy--;
      paintProgress();
    });
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m?.type !== 'rpc' || !pending.has(m.id)) return;
    const p = /** @type {any} */ (pending.get(m.id));
    pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { cancelled: m.cancelled }));
    else p.resolve(m.result);
  });

  /** Runs an rpc and shows its failure as a banner on the current view; cancellations stay silent. */
  async function act(method, params, onResult) {
    try {
      const result = await rpc(method, params);
      if (onResult) onResult(result);
      return result;
    } catch (err) {
      if (!(/** @type {any} */ (err).cancelled)) {
        top().banner = { kind: 'error', text: /** @type {Error} */ (err).message };
        render();
      }
    }
  }

  // --- formatting -------------------------------------------------------------

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

  function ago(iso) {
    if (!iso) return '';
    const minutes = (Date.now() - new Date(iso).getTime()) / 60000;
    if (!isFinite(minutes)) return '';
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${Math.floor(minutes)}m ago`;
    const days = minutes / 1440;
    if (days < 1) return `${Math.floor(minutes / 60)}h ago`;
    if (days < 30) return `${Math.floor(days)}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  /** Date and time plus how long ago, e.g. "24 Oct 2026, 13:05 (2d ago)". */
  function when(iso) {
    const date = new Date(iso);
    if (!iso || isNaN(date.getTime())) return '';
    return `${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${ago(iso)})`;
  }

  const time = (iso) => (iso && Date.parse(iso)) || 0;

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function status(e) {
    if (e.running) return 'running';
    if (e.completed) return e.success === false ? 'failed' : e.success ? 'passed' : 'finished';
    return 'queued';
  }

  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

  // --- icons (16x16) ------------------------------------------------------------

  const paths = {
    back: 'M7.4 3 2.4 8l5 5 .7-.7L4.3 8.5H14v-1H4.3l3.8-3.8z',
    refresh: 'M13.5 2v3.5H10v-1h1.9A5 5 0 1 0 13 8h1a6 6 0 1 1-1.5-4V2z',
    play: 'M4 2.5v11l9-5.5z',
    download: 'M7.5 1h1v8.3l2.6-2.6.7.7L8 11.2 4.2 7.4l.7-.7 2.6 2.6zM2 12h1v2h10v-2h1v3H2z',
    upload: 'M8 1.8 11.8 5.6l-.7.7-2.6-2.6V12h-1V3.7L4.9 6.3l-.7-.7zM2 12h1v2h10v-2h1v3H2z',
    folder: 'M1.5 3h4.7l1.5 1.5h6.8v8.5h-13zm1 1v8h11V5.5H7.3L5.8 4z',
    file: 'M3 1h6.7L13 4.3V15H3zm1 1v12h8V5H9V2zm6 .7V4h1.3z',
    open: 'M9 2h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9zM2 4h5v1H3v8h8V9h1v5H2z',
    chev: 'M6 3.3 10.7 8 6 12.7l-.7-.7 4-4-4-4z',
    edit: 'M11.2 1.8 14.2 4.8 5.5 13.5 2 14l.5-3.5zm0 1.4L3.4 11l-.3 1.9 1.9-.3 7.8-7.8z',
    x: 'M8 7.3 12.6 2.7l.7.7L8.7 8l4.6 4.6-.7.7L8 8.7l-4.6 4.6-.7-.7L7.3 8 2.7 3.4l.7-.7z',
    plus: 'M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z',
    key: 'M10 1.5a4.5 4.5 0 0 0-4.3 5.8L1.5 11.5V14.5h3v-1.5H6V11.5h1.5l1.2-1.2A4.5 4.5 0 1 0 10 1.5zm1 2.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2z',
    sparkle: 'M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z',
  };
  const icon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
  const iconBtn = (name, label, data) =>
    `<button class="btn icon" title="${esc(label)}" aria-label="${esc(label)}" ${data}>${icon(name)}</button>`;
  const btn = (label, data, opts = {}) =>
    `<button class="btn${opts.primary ? ' primary' : ''}" ${data}${opts.disabled ? ' disabled' : ''}>${opts.icon ? icon(opts.icon) : ''}${esc(label)}</button>`;
  const data = (o) =>
    Object.entries(o)
      .map(([k, v]) => `data-${k}="${esc(v)}"`)
      .join(' ');

  function header(title, sub, tools = '') {
    const backBtn = state.stack.length > 1 ? iconBtn('back', 'Back', data({ act: 'back' })) : '';
    return `<div class="head">${backBtn}<div class="titles"><h1 title="${esc(title)}">${esc(title)}</h1><div class="sub">${sub}</div></div><div class="tools">${tools}</div></div>
      <div class="progress${busy ? ' on' : ''}" id="progress"></div>${bannerHtml(top().banner)}`;
  }

  function bannerHtml(b) {
    if (!b) return '';
    const list = b.items?.length ? `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
    return `<div class="banner ${b.kind ?? ''}" role="status">${esc(b.text)}${list}</div>`;
  }

  function paintProgress() {
    document.getElementById('progress')?.classList.toggle('on', busy > 0);
  }

  // --- views ----------------------------------------------------------------------

  const views = {
    tests: renderTests,
    scenario: renderScenario,
    conf: renderConf,
    execution: renderExecution,
    loading: () => header('Testable', 'Loading…'),
  };

  function render() {
    const view = top();
    app.innerHTML = (views[view.kind] ?? views.loading)(view);
    save();
  }

  // Tests -------------------------------------------------------------------------

  function renderTests(view) {
    const d = view.data;
    const repo = d.repos?.[0];
    const sub = [
      view.accounts && view.account ? `<span title="API key">${icon('key')} ${esc(view.account.name)}</span>` : '',
      repo ? `<span title="${esc(repo.remote)}">${esc(shortRepo(repo.remote))}${repo.branch ? ` · ${esc(repo.branch)}` : ''}</span>` : '',
      `<span>${d.testCases.length} of ${d.total} test cases</span>`,
    ].join('');
    const tools =
      (d.match.status === 'matched' ? btn('All', data({ act: 'tests', all: 1 })) : '') +
      iconBtn('key', 'API keys', data({ act: 'selectAccount' })) +
      iconBtn('refresh', 'Refresh', data({ act: 'tests' }));
    const note = d.match.note && !view.banner ? bannerHtml({ kind: d.match.status === 'unavailable' ? 'warn' : '', text: d.match.note }) : '';
    return `${header('Testable', sub, tools)}${note}${accountsHtml(view)}
      <input type="search" class="search" id="filter" placeholder="Filter test cases, scenarios, configurations" value="${esc(state.filter)}">
      <div id="cases">${casesHtml(d)}</div>`;
  }

  /**
   * What each API key's organization links to this repo and when it last ran, so a repo
   * that was set up in another organization (or the wrong one) stands out.
   */
  function accountsHtml(view) {
    if (!view.accounts || !view.data.repos?.length) return '';
    const inUse = view.accounts.find((a) => a.account.id === view.account?.id);
    const linked = (a) => a?.link?.status === 'matched';
    // Another organization is worth a look when it ran this repo's tests more recently, or when the key in use has none.
    const other = view.accounts
      .filter((a) => a !== inUse && linked(a))
      .sort((a, b) => time(b.link.lastRunAt) - time(a.link.lastRunAt))
      .find((a) => !linked(inUse) || time(a.link.lastRunAt) > time(inUse.link.lastRunAt));
    const lastRun = other?.link.lastRunAt ? when(other.link.lastRunAt) : '';
    const warn = other
      ? bannerHtml({
          kind: 'warn',
          text: linked(inUse)
            ? `"${other.account.name}" has a test case for this repo that ran more recently: ${lastRun}. If the repo belongs to that organization, click Use.`
            : `"${other.account.name}" has a test case for this repo${lastRun ? `, last run ${lastRun}` : ''}. If the repo belongs to that organization, click Use.`,
        })
      : '';
    const rows = view.accounts
      .map((a) => {
        const current = a === inUse;
        return `<div class="row">
          <div class="main"><div class="name">${esc(a.account.name)}${current ? ' <span class="tag">in use</span>' : ''}</div><div class="meta${a.error ? ' error-text' : ''}">${esc(linkText(a))}</div></div>
          <div class="actions">${current ? '' : btn('Use', data({ act: 'useAccount', id: a.account.id }))}</div>
        </div>`;
      })
      .join('');
    return `<div class="section accounts"><div class="label">API keys · this repo</div>${warn}<div class="list">${rows}</div></div>`;
  }

  function linkText(a) {
    if (a.error) return a.error;
    const link = a.link;
    if (link.status === 'unavailable') return 'Cannot read VCS roots with this key';
    if (link.status !== 'matched') return 'No test case linked to this repo';
    const names = link.testCases.map((c) => c.path.replace(/^\/+/, ''));
    const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    return `${link.lastRunAt ? `last run ${when(link.lastRunAt)}` : 'never run'} · ${shown}`;
  }

  function casesHtml(d) {
    const q = state.filter.trim().toLowerCase();
    const cases = d.testCases.filter(
      (tc) =>
        !q ||
        [tc.path, ...tc.scenarios.map((s) => s.name), ...(tc.confs ?? []).map((c) => c.name)].join(' ').toLowerCase().includes(q)
    );
    if (!cases.length) return `<div class="empty">No test cases${q ? ' match the filter' : ''}.</div>`;
    const autoOpen = cases.length <= 3;
    return cases.map((tc) => caseHtml(tc, state.open[`tc:${tc.id}`] ?? autoOpen)).join('');
  }

  function caseHtml(tc, open) {
    const counts = tc.counts
      ? `<span class="counts" title="Configurations: passed / failed / not run"><span class="p">✓ ${tc.counts.pass}</span><span class="f">✗ ${tc.counts.fail}</span><span class="n">○ ${tc.counts.notRun}</span></span>`
      : '';
    const scenarios = tc.scenarios.length
      ? `<div class="list">${tc.scenarios
          .map(
            (s) => `<div class="row click" tabindex="0" ${data({ act: 'scenario', id: s.id })}>
              <span class="tag">${esc(s.type)}</span>
              <div class="main"><div class="name">${esc(s.name)}</div><div class="meta">${esc([s.source, s.branch, s.params.length ? `${s.params.length} params` : ''].filter(Boolean).join(' · '))} <span class="id">#${s.id}</span></div></div>
            </div>`
          )
          .join('')}</div>`
      : '<div class="empty">No scenarios.</div>';
    const confs = !tc.confs
      ? btn('Load configurations', data({ act: 'confs', id: tc.id }))
      : tc.confs.length
        ? `<div class="list">${tc.confs.map(confRowHtml).join('')}</div>`
        : '<div class="empty">No configurations.</div>';
    return `<div class="case${open ? ' open' : ''}">
      <div class="row click" tabindex="0" ${data({ act: 'toggle', key: `tc:${tc.id}` })} aria-expanded="${open}">
        <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="${paths.chev}"/></svg>
        <div class="main"><div class="name">${esc(tc.name)}</div><div class="meta">${esc(caseMeta(tc))}</div></div>
        ${counts}
      </div>
      <div class="body">
        <div class="section"><div class="label">Scenarios</div>${scenarios}</div>
        <div class="section"><div class="label">Configurations</div>${confs}</div>
      </div>
    </div>`;
  }

  function caseMeta(tc) {
    const path = tc.path.replace(/^\/+/, '');
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return [folder, tc.lastRunAt ? `last run ${ago(tc.lastRunAt)}` : 'never run'].filter(Boolean).join(' · ');
  }

  function confRowHtml(c) {
    const params = Object.entries(c.params ?? {});
    const chips = params.length
      ? `<div class="chips">${params.map(([k, v]) => `<span class="chip" title="${esc(`${k}=${v}`)}">${esc(k)}=${esc(v)}</span>`).join('')}</div>`
      : '';
    return `<div class="row click" tabindex="0" ${data({ act: 'conf', id: c.id })}>
      <span class="tag">${esc(c.testType)}</span>
      <div class="main"><div class="name">${esc(c.name)} <span class="id">#${c.id}</span></div>${chips}</div>
      <div class="actions">
        ${iconBtn('download', 'Download logs and files of the latest run', data({ act: 'download', conf: c.id }))}
        ${iconBtn('play', 'Run this configuration', data({ act: 'run', id: c.id }))}
      </div>
    </div>`;
  }

  function shortRepo(url) {
    return url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '');
  }

  // Scenario ----------------------------------------------------------------------

  function renderScenario(view) {
    const s = view.data;
    const sub = [s.testCase?.name, s.type, s.source].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('') + `<span class="id">#${s.id}</span>`;
    const tools = iconBtn('refresh', 'Refresh', data({ act: 'scenario', id: s.id, replace: 1 }));
    return `${header(s.name, sub, tools)}
      ${repositoryHtml(s)}
      ${filesHtml(s, view.sync)}
      ${settingsHtml(s)}
      ${declaredParamsHtml(s)}
      ${s.confs.length ? `<div class="section"><div class="label">Configurations</div><div class="list">${s.confs.map(confRowHtml).join('')}</div></div>` : ''}`;
  }

  function repositoryHtml(s) {
    const r = s.repository;
    if (!r) return '';
    if (r.error) return `<div class="section"><div class="label">Repository</div>${bannerHtml({ kind: 'warn', text: r.error })}</div>`;
    const current = s.branch ?? r.branch;
    // Undefined until "Change" is clicked; then the repo's branches, or the error that stopped listing them.
    const refs = state.drafts[`branches:${s.id}`];
    let control = `<span>${esc(current ?? '(default)')}</span>`;
    let action = btn('Change', data({ act: 'branches', scenario: s.id, repo: r.id }));
    if (refs?.list?.length) {
      control = `<select id="branch" ${data({ scenario: s.id })} aria-label="Branch">${[...new Set([current, ...refs.list])]
        .filter(Boolean)
        .map((b) => `<option${b === current ? ' selected' : ''}>${esc(b)}</option>`)
        .join('')}</select>`;
      action = '';
    } else if (refs) {
      control = `<input type="text" id="branchInput" value="${esc(current ?? '')}" aria-label="Branch">`;
      action = btn('Switch', data({ act: 'switchBranch', scenario: s.id }));
    }
    const hint = [r.branch && r.branch !== current ? `repo default: ${r.branch}` : '', refs?.error ? `Could not list branches: ${refs.error}` : '']
      .filter(Boolean)
      .map((h) => `<div class="hint">${esc(h)}</div>`)
      .join('');
    return `<div class="section"><div class="label">Repository</div>
      <div class="grid">
        <div class="key first">url</div><div class="first path">${esc(r.url)}</div><div class="first"></div>
        <div class="key">branch</div><div class="stack">${control}${hint}</div><div>${action}</div>
        <div class="key">auth</div><div class="hint">${esc(r.authType ?? '')}${r.username ? ` · ${esc(r.username)}` : ''}</div><div>${btn('Update token', data({ act: 'token', repo: r.id }), { icon: 'key' })}</div>
      </div></div>`;
  }

  function filesHtml(s, sync) {
    const local = new Map((sync?.entries ?? []).map((e) => [e.path, e.action]));
    const rows = s.files.length
      ? s.files
          .map((f) => {
            const rel = f.path.replace(/^\/+/, '');
            const action = local.get(rel);
            return `<div class="row">
              ${icon('file')}
              <div class="main"><div class="name" title="${esc(f.path)}">${esc(rel)}</div><div class="meta">${esc([bytes(f.size), f.updatedAt && `updated ${ago(f.updatedAt)}`, action && action !== 'download' ? action : ''].filter(Boolean).join(' · '))}</div></div>
              <div class="actions">${iconBtn('open', 'Open the local copy', data({ act: 'openLocal', dir: s.localDir, rel }))}</div>
            </div>`;
          })
          .join('')
      : '<div class="empty">No files in this scenario.</div>';
    return `<div class="section"><div class="label"><span class="grow">Files (${s.files.length})</span>
        ${btn('Pull', data({ act: 'pull', id: s.id }), { icon: 'download' })}
        ${btn('Push', data({ act: 'push', id: s.id }), { icon: 'upload' })}
        ${iconBtn('folder', 'Reveal the local folder', data({ act: 'reveal', path: s.localDir }))}
      </div><div class="list">${rows}</div><div class="path">${esc(s.localDir)}</div></div>`;
  }

  /** Flattens one level of nested objects so browsers.chrome and device.width get their own fields. */
  function flatten(settings) {
    const out = [];
    for (const [k, v] of Object.entries(settings)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== 'object')) {
        for (const [k2, v2] of Object.entries(v)) out.push([`${k}.${k2}`, v2]);
      } else out.push([k, v]);
    }
    return out;
  }

  function settingsDraft(s) {
    return (state.drafts[`settings:${s.id}`] ??= {});
  }

  function settingsHtml(s) {
    return `<div class="section"><div class="label">Settings</div>
      <input type="search" class="search" id="settingsFilter" placeholder="Filter settings" value="${esc(state.settingsFilter)}">
      <div id="settings">${settingsGrid(s)}</div>
      <div id="savebar">${saveBar(Object.keys(settingsDraft(s)).length, 'saveSettings', s.id)}</div></div>`;
  }

  // Changing these would detach the scenario from its source, so they are shown but not editable
  // here; the branch is switched in the Repository section.
  const READ_ONLY_SETTINGS = new Set(['sourceType', 'repositoryId', 'branch']);

  function settingsGrid(s) {
    const draft = settingsDraft(s);
    const q = state.settingsFilter.trim().toLowerCase();
    const items = flatten(s.settings).filter(([k]) => !q || k.toLowerCase().includes(q));
    if (!items.length) return '<div class="empty">No settings match.</div>';
    const current = (key, value) => (key in draft ? draft[key] : value);
    const changed = (key) => (key in draft ? ' changed' : '');

    const toggles = items.filter(([, v]) => typeof v === 'boolean');
    const values = items.filter(([, v]) => typeof v !== 'boolean');
    const toggleHtml = toggles.length
      ? `<div class="toggles">${toggles
          .map(
            ([key, value]) => `<label class="toggle${changed(key)}" title="${esc(key)}">
              <input type="checkbox" ${data({ setting: key, type: 'boolean' })}${current(key, value) ? ' checked' : ''}><span>${esc(key)}</span></label>`
          )
          .join('')}</div>`
      : '';
    const valueHtml = values.length
      ? `<div class="grid">${values
          .map(([key, value], i) => {
            const first = i === 0 ? ' first' : '';
            const cls = `${first}${changed(key)}`;
            const v = current(key, value);
            const type = Array.isArray(value) || (value && typeof value === 'object') ? 'json' : typeof value;
            let control;
            if (READ_ONLY_SETTINGS.has(key)) control = `<span class="hint">${esc(show(v))}</span>`;
            else if (type === 'number') control = `<input type="number" ${data({ setting: key, type })} value="${esc(v)}" aria-label="${esc(key)}">`;
            else control = `<input type="text" ${data({ setting: key, type })} value="${esc(typeof v === 'string' ? v : show(v))}" aria-label="${esc(key)}">`;
            const reset = key in draft ? iconBtn('x', 'Undo this change', data({ act: 'undoSetting', key })) : '';
            return `<div class="key${cls}" title="${esc(key)}">${esc(key)}</div><div class="${cls}">${control}</div><div class="${cls}">${reset}</div>`;
          })
          .join('')}</div>`
      : '';
    return toggleHtml + valueHtml;
  }

  function saveBar(count, act, id) {
    if (!count) return '';
    return `<div class="savebar"><span class="grow">${count} unsaved change${count > 1 ? 's' : ''}</span>
      ${btn('Discard', data({ act: 'discard', what: act, id }))}${btn('Save', data({ act, id }), { primary: true })}</div>`;
  }

  function declaredParamsHtml(s) {
    if (!s.params.length) return '';
    return `<div class="section"><div class="label">Declared params</div><div class="grid">${s.params
      .map((p, i) => {
        const first = i === 0 ? ' first' : '';
        return `<div class="key${first}">${esc(p.name)}</div><div class="hint${first}">${p.defaultValue !== undefined && p.defaultValue !== '' ? `default ${esc(p.defaultValue)}` : 'no default'}</div><div class="hint${first}">${p.required ? 'required' : ''}</div>`;
      })
      .join('')}</div></div>`;
  }

  // Configuration -----------------------------------------------------------------

  function paramsDraft(c) {
    return (state.drafts[`params:${c.id}`] ??= { ...c.params });
  }

  function paramsDiff(c) {
    const draft = paramsDraft(c);
    const set = {};
    for (const [k, v] of Object.entries(draft)) if (c.params[k] !== v) set[k] = v;
    const unset = Object.keys(c.params).filter((k) => !(k in draft));
    return { set, unset, count: Object.keys(set).length + unset.length };
  }

  function renderConf(view) {
    const c = view.data;
    const sub = [c.testCase?.name, c.testType, c.scenario?.name].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('') + `<span class="id">#${c.id}</span>`;
    const tools = btn('Run', data({ act: 'run', id: c.id }), { icon: 'play' }) + iconBtn('refresh', 'Refresh', data({ act: 'conf', id: c.id, replace: 1 }));
    return `${header(c.name, sub, tools)}
      <div class="section"><div class="label">Scenario params</div><div id="params">${paramsGrid(c)}</div>
      <div id="savebar">${saveBar(paramsDiff(c).count, 'saveParams', c.id)}</div></div>
      <div class="section" id="executions"><div class="label">Executions</div>${executionsHtml(c)}</div>`;
  }

  function paramsGrid(c) {
    const draft = paramsDraft(c);
    const declared = new Map((c.scenario?.params ?? []).map((p) => [p.name, p]));
    const keys = [...new Set([...declared.keys(), ...Object.keys(c.params), ...Object.keys(draft)])];
    const rows = keys.map((k, i) => {
      const first = i === 0 ? ' first' : '';
      const changed = draft[k] !== c.params[k] ? ' changed' : '';
      const p = declared.get(k);
      const placeholder = p?.defaultValue ? `default: ${p.defaultValue}` : p ? 'not set' : '';
      const value = k in draft ? draft[k] : '';
      const remove = k in draft ? iconBtn('x', `Remove ${k}`, data({ act: 'removeParam', key: k })) : '';
      return `<div class="key${first}${changed}" title="${esc(k)}">${esc(k)}${p?.required ? ' *' : ''}</div>
        <div class="${first}${changed}"><input type="text" ${data({ param: k })} value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(k)}"></div>
        <div class="${first}${changed}">${remove}</div>`;
    });
    const addFirst = keys.length ? '' : ' first';
    rows.push(`<div class="${addFirst}"><input type="text" id="newKey" placeholder="NEW_PARAM" aria-label="New param name"></div>
      <div class="${addFirst}"><input type="text" id="newValue" placeholder="value" aria-label="New param value"></div>
      <div class="${addFirst}">${iconBtn('plus', 'Add param', data({ act: 'addParam' }))}</div>`);
    return `<div class="grid">${rows.join('')}</div>`;
  }

  function executionsHtml(c) {
    if (!c.executions.length) return '<div class="empty">No executions yet.</div>';
    return `<div class="list">${c.executions
      .map((e) => {
        const st = status(e);
        return `<div class="row">
          <span class="pill ${st}">${st}</span>
          <div class="main"><div class="name">Execution <span class="id">#${e.id}</span></div><div class="meta">${esc(ago(e.createdAt))}</div></div>
          <div class="actions">${iconBtn('download', 'Download logs and files', data({ act: 'download', execution: e.id }))}</div>
        </div>`;
      })
      .join('')}</div>`;
  }

  // Execution ---------------------------------------------------------------------

  function renderExecution(view) {
    const e = view.data;
    const st = status(e);
    const sub = [e.testCase?.name, e.conf?.name].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('') + `<span class="pill ${st}">${st}</span>`;
    const tools = btn('Ask agent', data({ act: 'ask', id: e.id, dir: e.dir }), { icon: 'sparkle' });
    const errors = e.errors.length ? bannerHtml({ kind: 'warn', text: 'Some items could not be downloaded:', items: e.errors }) : '';
    const rel = (p) => p.slice(e.dir.length + 1).replace(/\\/g, '/');
    const images = e.files.filter((f) => f.src);
    const failed = e.failedTests ?? [];
    const failures = failed.length
      ? `<div class="section"><div class="label">Failed tests (${failed.length})</div><div class="list">${failed
          .map(
            (f) => `<div class="row"><span class="fail-mark" aria-hidden="true">✗</span>
              <div class="main"><div class="name" title="${esc(`${f.suite} › ${f.test}`)}">${esc(f.suite)} › ${esc(f.test)}</div><div class="meta error-text" title="${esc(f.trace ?? f.error)}">${esc(f.error)}</div></div></div>`
          )
          .join('')}</div></div>`
      : '';
    return `${header(`Execution #${e.id}`, sub, tools)}${errors}${failures}
      <div class="section"><div class="label"><span class="grow">Downloaded (${e.files.length})</span>${iconBtn('folder', 'Reveal the folder', data({ act: 'reveal', path: e.dir }))}</div>
      <div class="list">${e.files
        .map(
          (f) => `<div class="row click" tabindex="0" ${data({ act: 'open', path: f.path })}>
            <span class="tag">${esc(f.kind)}</span>
            <div class="main"><div class="name">${esc(rel(f.path))}</div><div class="meta">${esc([bytes(f.size), f.contentType].filter(Boolean).join(' · '))}</div></div>
          </div>`
        )
        .join('')}</div>
      ${images.length ? `<div class="thumbs">${images.map((f) => `<button ${data({ act: 'open', path: f.path })} title="${esc(rel(f.path))}"><img src="${esc(f.src)}" alt="${esc(rel(f.path))}"></button>`).join('')}</div>` : ''}
      <div class="path">${esc(e.dir)}</div></div>`;
  }

  // --- interactions ----------------------------------------------------------------

  const handlers = {
    back,
    toggle(d) {
      const el = /** @type {HTMLElement} */ (document.querySelector(`[data-key="${d.key}"]`)?.parentElement);
      const open = !el.classList.contains('open');
      state.open[d.key] = open;
      el.classList.toggle('open', open);
      el.firstElementChild?.setAttribute('aria-expanded', String(open));
      save();
    },
    tests(d) {
      act('load', { kind: 'tests', allRepos: !!d.all }, (v) => replace(v));
    },
    useAccount(d) {
      act('useAccount', { id: d.id }, replace);
    },
    selectAccount() {
      act('selectAccount', {}, replace);
    },
    confs(d) {
      act('confs', { testCaseId: Number(d.id) }, (confs) => {
        const tc = top().data.testCases.find((t) => t.id === Number(d.id));
        tc.confs = confs;
        render();
      });
    },
    scenario(d) {
      act('load', { kind: 'scenario', id: Number(d.id) }, (v) => (d.replace ? replace(v) : go(v)));
    },
    conf(d) {
      act('load', { kind: 'conf', id: Number(d.id) }, (v) => {
        delete state.drafts[`params:${d.id}`];
        d.replace ? replace(v) : go(v);
      });
    },
    download(d) {
      act('download', d.execution ? { executionId: Number(d.execution) } : { confId: Number(d.conf) }, go);
    },
    run(d) {
      act('run', { confId: Number(d.id) }, (execution) => {
        const view = top();
        if (view.kind === 'conf' && view.data.id === Number(d.id)) view.data.executions.unshift(execution);
        view.banner = { kind: 'ok', text: `Started execution #${execution.id}.` };
        render();
        poll(execution.id);
      });
    },
    pull(d) {
      act('pull', { scenarioId: Number(d.id) }, replace);
    },
    push(d) {
      act('push', { scenarioId: Number(d.id) }, replace);
    },
    reveal(d) {
      rpc('reveal', { path: d.path }).catch(showError);
    },
    open(d) {
      rpc('open', { path: d.path }).catch(showError);
    },
    openLocal(d) {
      rpc('open', { path: `${d.dir}/${d.rel}`, hint: 'Pull the scenario files first.' }).catch(showError);
    },
    ask(d) {
      rpc('ask', { prompt: `Analyze Testable execution #${d.id}. Its logs and output files are in ${d.dir}. Find why it failed and suggest a fix.` }).catch(showError);
    },
    branches(d) {
      rpc('branches', { repositoryId: Number(d.repo) })
        .then((list) => ({ list }), (err) => ({ list: [], error: err.message }))
        .then((refs) => {
          state.drafts[`branches:${d.scenario}`] = refs;
          render();
        });
    },
    switchBranch(d) {
      const branch = /** @type {HTMLInputElement} */ (document.getElementById('branchInput')).value.trim();
      if (branch) setBranch(Number(d.scenario), branch);
    },
    token(d) {
      act('token', { repositoryId: Number(d.repo) }, () => {
        top().banner = { kind: 'ok', text: 'Token updated.' };
        render();
      });
    },
    undoSetting(d) {
      delete settingsDraft(top().data)[d.key];
      repaintSettings();
    },
    discard(d) {
      delete state.drafts[`${d.what === 'saveSettings' ? 'settings' : 'params'}:${d.id}`];
      render();
    },
    saveSettings() {
      const s = top().data;
      act('saveSettings', { scenarioId: s.id, changes: settingsDraft(s) }, (v) => {
        delete state.drafts[`settings:${s.id}`];
        replace(v);
      });
    },
    removeParam(d) {
      delete paramsDraft(top().data)[d.key];
      repaintParams();
    },
    addParam() {
      const key = /** @type {HTMLInputElement} */ (document.getElementById('newKey')).value.trim();
      const value = /** @type {HTMLInputElement} */ (document.getElementById('newValue')).value;
      if (!key) return;
      paramsDraft(top().data)[key] = value;
      repaintParams();
    },
    saveParams() {
      const c = top().data;
      const { set, unset } = paramsDiff(c);
      act('saveParams', { confId: c.id, set, unset }, (v) => {
        delete state.drafts[`params:${c.id}`];
        replace(v);
      });
    },
  };

  function setBranch(scenarioId, branch) {
    act('setBranch', { scenarioId, branch }, (v) => {
      delete state.drafts[`branches:${scenarioId}`];
      replace(v);
    });
  }

  function showError(err) {
    if (err.cancelled) return;
    top().banner = { kind: 'error', text: err.message };
    render();
  }

  function repaintSettings() {
    const s = top().data;
    /** @type {HTMLElement} */ (document.getElementById('settings')).innerHTML = settingsGrid(s);
    /** @type {HTMLElement} */ (document.getElementById('savebar')).innerHTML = saveBar(Object.keys(settingsDraft(s)).length, 'saveSettings', s.id);
    save();
  }

  function repaintParams() {
    const c = top().data;
    /** @type {HTMLElement} */ (document.getElementById('params')).innerHTML = paramsGrid(c);
    /** @type {HTMLElement} */ (document.getElementById('savebar')).innerHTML = saveBar(paramsDiff(c).count, 'saveParams', c.id);
    save();
  }

  /** Follows a started execution until it completes, updating whichever view lists it. */
  function poll(executionId) {
    if (state.polling.includes(executionId)) return;
    state.polling.push(executionId);
    const tick = async () => {
      let e;
      try {
        e = await rpc('status', { executionId });
      } catch {
        e = undefined;
      }
      for (const view of state.stack) {
        const row = view.kind === 'conf' && view.data.executions.find((x) => x.id === executionId);
        if (row && e) Object.assign(row, e);
      }
      const list = document.getElementById('executions');
      if (list && top().kind === 'conf') list.innerHTML = `<div class="label">Executions</div>${executionsHtml(top().data)}`;
      if (e && !e.completed) setTimeout(tick, 5000);
      else state.polling = state.polling.filter((id) => id !== executionId);
      save();
    };
    setTimeout(tick, 3000);
  }

  app.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target).closest('[data-act]');
    if (!(target instanceof HTMLElement) || target.hasAttribute('disabled')) return;
    handlers[target.dataset.act ?? '']?.(target.dataset);
  });

  app.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if ((event.key === 'Enter' || event.key === ' ') && target.classList.contains('click')) {
      event.preventDefault();
      target.click();
    }
    if (event.key === 'Enter' && (target.id === 'newKey' || target.id === 'newValue')) handlers.addParam();
    if (event.key === 'Enter' && target.id === 'branchInput') document.querySelector('[data-act=switchBranch]')?.click();
  });

  app.addEventListener('input', (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    const view = top();
    if (el.id === 'filter') {
      state.filter = el.value;
      /** @type {HTMLElement} */ (document.getElementById('cases')).innerHTML = casesHtml(view.data);
      save();
    } else if (el.id === 'settingsFilter') {
      state.settingsFilter = el.value;
      /** @type {HTMLElement} */ (document.getElementById('settings')).innerHTML = settingsGrid(view.data);
      save();
    } else if (el.dataset.param !== undefined) {
      paramsDraft(view.data)[el.dataset.param] = el.value;
      el.parentElement?.classList.toggle('changed', el.value !== view.data.params[el.dataset.param]);
      /** @type {HTMLElement} */ (document.getElementById('savebar')).innerHTML = saveBar(paramsDiff(view.data).count, 'saveParams', view.data.id);
      save();
    }
  });

  app.addEventListener('change', (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    const view = top();
    if (el.dataset.setting !== undefined) {
      const key = el.dataset.setting;
      const original = flatten(view.data.settings).find(([k]) => k === key)?.[1];
      let value;
      try {
        value = el.dataset.type === 'boolean' ? el.checked : el.dataset.type === 'number' ? Number(el.value) : el.dataset.type === 'json' ? JSON.parse(el.value) : el.value;
      } catch {
        view.banner = { kind: 'error', text: `${key} must be valid JSON.` };
        render();
        return;
      }
      const draft = settingsDraft(view.data);
      if (JSON.stringify(value) === JSON.stringify(original)) delete draft[key];
      else draft[key] = value;
      repaintSettings();
    } else if (el.id === 'branch') {
      setBranch(Number(el.dataset.scenario), el.value);
    }
  });

  render();
  for (const id of state.polling.splice(0)) poll(id);
  // The dashboard panel opens empty and fetches its first view.
  if (top().kind === 'loading') act('load', { kind: 'tests' }, replace);
})();
