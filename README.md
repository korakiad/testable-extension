# Testable Tools (VS Code extension)

**English** · [ภาษาไทย](README.th.md)

This extension turns the Testable REST API into tools for Copilot agent mode. Tool names and schemas are copied from Testable's MCP server (`https://mcp.testable.io`), but it **does not use MCP or `@modelcontextprotocol/sdk`**. It has no runtime dependencies: only the VS Code Language Model Tools API and `fetch` calls to `https://api.testable.io`.

Results of the workflow tools can render as pages in the chat (similar to MCP Apps) through VS Code's chat output renderer. That is still a proposed API and has to be enabled first, see [Enable the chat UI](#enable-the-chat-ui).

## Tools Copilot sees

### Workflow (with chat UI)

| Tool | What it does |
|---|---|
| `testable_showTests` | Test cases, scenarios and configurations of this repo (filtered by git remote if the API key can read VCS roots), with which key is in use and whether other orgs also have test cases for this repo |
| `testable_showScenario` | A scenario's settings, declared params, files, repository and configurations |
| `testable_downloadExecution` | Downloads `logs.txt`, `failures.txt` (failed tests with stack traces), `failed-tests.json`, `execution.json` and output files into `.testable/executions/<id>/` for the agent to read |
| `testable_pullScenarioFiles` | Downloads a scenario's files into `.testable/scenarios/<id>-<name>/` (does not overwrite files edited locally) |
| `testable_pushScenarioFiles` | Uploads edited files back (updates existing files, creates new ones, never deletes) |
| `testable_updateScenarioSettings` | Edits scenario settings such as `chromedriverOnly`, `seleniumVersion`, `browsers.edge` (the key must already exist, to catch typos) |
| `testable_setScenarioParams` | Sets or removes a configuration's scenario params (environment variables) |
| `testable_updateRepository` | Switches the branch a scenario uses (the scenario's `branch`, not the root's) or updates an expired VCS root token |

Tools that write always show the values before and after for confirmation first. VCS tokens are typed straight into a VS Code password box, never through the chat, and are tested against the repo before saving. If the test fails (for example, the repo is behind a firewall and has to be reached through a self-hosted runner), you can choose Save Anyway.

### Generic

| Tool | What it does |
|---|---|
| `testable_searchTools` | Searches operations by keyword |
| `testable_describeTools` | Shows an operation's full schema |
| `testable_callTool` | Calls any operation in the catalog (172 of them) |
| 12 `testable_<operation>` tools | Frequently used operations, declared directly with their schemas |

Write operations (POST/PUT/DELETE) show a confirmation with the endpoint and arguments before sending.

Arguments are mapped the same way as Testable's: `path_x` fills `:x` in the path, `query_x` becomes `?x=`, and every other field goes into the JSON body.

Testable puts the API key in the URLs it returns (`...?key=...`). The extension removes it before passing the text to the model.

## Install and use

1. Install `testable-tools-<version>.vsix` from Extensions → `...` → Install from VSIX (download it from GitHub Releases or build it with `npm run package`)
2. Run **Testable: Add API Key** (the key is stored in VS Code's SecretStorage)
3. Open Copilot Chat in Agent mode and turn on the tools that start with Testable

### Multiple API keys (multiple orgs)

Add as many keys as you need with **Testable: Add API Key**. The extension checks each key with Testable and asks for a name (the default is `Org <id>`, because an API key cannot read the org's name).

Each workspace uses one key at a time. If there is more than one key and none has been chosen for this workspace, the first Testable call checks the workspace's git remote against every key and picks the org that has test cases bound to this repo with the latest run, then tells you which key it picked and why.

- The workspace's key name shows in the status bar (when there is more than one key). Click it to change
- **Testable: Select API Key** lists every key with the test cases bound to this repo and when they last ran. Choose the workspace's key, rename a key or remove one from this list
- The Testable page has an **API keys · this repo** section with the same information. If another org has test cases of this repo with a newer run (for example, ones created in the wrong org earlier), it shows a warning with a Use button
- Pages left open in the chat or the dashboard keep the key they were loaded with, even after the workspace switches to another key
- **Testable: Remove API Key** removes a key

#### Looking at other orgs from the chat

By default every tool uses the workspace's key, which is the org of the open repo. To investigate another org, ask in the chat. There is no need to switch the workspace's key.

- Lookups by ID (execution, scenario, configuration, test case and so on) try the workspace's key first. On 401/403/404 they try the other keys one at a time. When one finds it, the model is told which key, and chat pages opened from that result keep using that key. If the workspace's key finds it, it is still a single request
- Org-wide lists and searches (`getAllTestCases`, `getOrgTestCaseSummary`, `searchOrgExecutionsWithFilter`, `countOrgExecutionsWithFilter`, `getOrgReports`, `getOrgScheduledTests` and others, see `ORG_WIDE` in `src/client.ts`) use the workspace's key, and the end of the result tells the model which other keys exist. `apiKey: "all"` queries every key at once and groups the results by org. Each org gets `maxResponseChars` divided by the number of keys
- `testable_showTests` shows the test cases of one key, because the page belongs to one org, but says whether other orgs also have test cases of this repo
- Tools that write never switch keys on their own. They use the workspace's key or the given `apiKey` only, and do not accept `"all"`. On 401/403/404 they return an error that tells the model to retry with `apiKey`

Every tool that calls Testable (except `testable_searchTools` and `testable_describeTools`) accepts an `apiKey` argument with a key name, to use that org for that call only. For example, ask in the chat "show execution 123 in Org B" and the model passes `apiKey: "Org B"` to the tool. The workspace's key does not change.

- Names are case-insensitive. If no key has that name, the tool returns an error listing every key so the model can pick again. The name `all` is reserved and cannot be used for a key
- With `testable_callTool`, put `apiKey` next to `toolName`, not inside `arguments`
- `testable_showTests` tells the model which keys exist (`apiKeys`), and when it uses another key, it gives the workspace's key in `workspaceApiKey`
- With more than one key, the confirmation of a tool that writes always says which key it writes with, and the tool call message names the key passed in `apiKey`
- If `apiKey` is given and the call gets HTTP 401/403/404, the error tells the model which key was used and which other keys exist (it does not try other keys, since one was given)
- Pages opened from a tool given `apiKey` keep using that key, while **in use** on those pages still marks the workspace's key

A single key from earlier versions is moved to a key named `Default` automatically.

**Testable: Open Dashboard** opens the same page in an editor tab, without the proposed API.

Settings: `testable.apiUrl` (default `https://api.testable.io`), `testable.maxResponseChars` (default 60000) and `testable.localFolder` (default `.testable` in the first workspace folder, which gets a `.gitignore` automatically).

## Enable the chat UI

VS Code Stable allows proposed APIs only for the extensions listed explicitly, even in extension development mode.

1. Command Palette → **Preferences: Configure Runtime Arguments** (opens `argv.json`)
2. Add `"enable-proposed-api": ["local.testable-tools"]`
3. Close every VS Code window and open it again

Until then the tools still work but answer in text only, and the extension shows a one-time notification with a button that opens `argv.json`. The proposed API may change between VS Code versions. If the chat UI disappears after an update, check the log in Output → Testable Tools.

## Not available (25 tools)

These tools run inside Testable's own MCP server (`/internal/*`) and have no public REST endpoint:
`run_smoke_test`, `browser_*`, `make_http_request`, attachment/conversation tools, `resolve_openfin_version`, `describe_tools`, `search_tools`
Instead of `uploadScenarioFiles` and `replaceScenarioFiles`, use `createScenarioFileFromContents` or `updateScenarioFileContents`.
`encode_base64` and `decode_base64` run inside the extension.

Testable API keys cannot list `/vcs-roots` (HTTP 401) but can read one root at a time, so filtering by git remote goes through the VCS root each scenario is bound to. If no scenario is bound to the workspace's repo, every test case is shown.

## Update the catalog when Testable adds tools

```sh
npm run discover   # uses TESTABLE_API_KEY in .env to fetch tools/list + describe_tools -> discovery/tools.json
npm run generate   # builds src/catalog.json and languageModelTools in package.json
npm run compile
npm run smoke      # read-only GETs against the real API with the key in .env (downloaded files go to temp and are deleted)
npm run package
```

The tools declared directly are listed in `DIRECT` in `scripts/generate.mjs`. Descriptions of the workflow tools are in `workflowTools` in the same file.

## Releasing

PRs do not change `version` in `package.json`. Describe the changes under `Unreleased` in `CHANGELOG.md` instead. The version changes only when a new `.vsix` is handed out, so each version number matches one `.vsix` file. During 0.x, bump the minor version for new features or changed behavior, and the patch version for bug fixes only.

On `main`:

1. Rename the `Unreleased` heading in `CHANGELOG.md` to the new version and date, then commit (`npm version` needs a clean working tree)
2. `npm version minor` or `npm version patch` updates `package.json` and `package-lock.json`, commits, and creates the tag `v<version>`
3. `npm run package` produces `testable-tools-<version>.vsix`
4. `git push --follow-tags`, then create a GitHub Release for that tag with the `.vsix` attached
