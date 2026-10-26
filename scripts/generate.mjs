// Turns discovery/tools.json (from discover-tools.mjs) into:
//   src/catalog.json                        every operation testable_callTool can run
//   package.json contributes.languageModelTools   the meta and workflow tools plus the DIRECT tools below
// Usage: node scripts/generate.mjs
import { readFileSync, writeFileSync } from 'node:fs';

// Declared as their own Copilot tools (full schema visible to the model up front).
// Everything else stays reachable through testable_searchTools / describeTools / callTool.
const DIRECT = [
  'getAllTestCases',
  'getTestCase',
  'getTestCaseConfs',
  'getTestConf',
  'getTestConfExecutions',
  'getExecution',
  'getExecutionSummary',
  'getExecutionLogs',
  'getExecutionFailedResults',
  'searchOrgExecutionsWithFilter',
  'startExecution',
  'stopExecution',
];

// Implemented inside the extension because the REST API has no equivalent.
const LOCAL = new Set(['encode_base64', 'decode_base64']);

const UNAVAILABLE = {
  uploadScenarioFiles:
    'The descriptor does not define the file upload format. Use createScenarioFileFromContents (new file) or updateScenarioFileContents (existing file) with base64 contents instead.',
  replaceScenarioFiles:
    'The descriptor does not define the file upload format. Use createScenarioFileFromContents (new file) or updateScenarioFileContents (existing file) with base64 contents instead.',
};
const MCP_ONLY_REASON = "Runs inside Testable's MCP server; there is no public REST endpoint for it.";
const MCP_ONLY_PATH = /^\/(internal|mcp)\/|^\/resolve-openfin-version$/;

const HEADER = /^\[(read|write)\]\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*(?:—\s*)?/;

const root = new URL('../', import.meta.url);
const discovery = JSON.parse(readFileSync(new URL('discovery/tools.json', root), 'utf8'));

const operations = [];
const unavailable = [];
for (const tool of discovery.tools) {
  const m = tool.description.match(HEADER);
  if (!m) throw new Error(`Unrecognised descriptor header for ${tool.name}: ${tool.description.slice(0, 80)}`);
  const [, label, method, path] = m;
  // The MCP server labels by HTTP verb; these POSTs only query data.
  const access = method === 'POST' && /^\/(search|count)$/.test(path) ? 'read' : label;
  const entry = {
    name: tool.name,
    access,
    method,
    path,
    description: tool.description.trim(),
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  };
  if (LOCAL.has(tool.name)) operations.push({ ...entry, kind: 'local' });
  else if (UNAVAILABLE[tool.name]) unavailable.push({ name: tool.name, reason: UNAVAILABLE[tool.name] });
  else if (MCP_ONLY_PATH.test(path)) unavailable.push({ name: tool.name, reason: MCP_ONLY_REASON });
  else operations.push({ ...entry, kind: 'rest' });
}

const missing = DIRECT.filter((n) => !operations.some((o) => o.name === n));
if (missing.length) throw new Error(`DIRECT tools not in catalog: ${missing.join(', ')}`);

writeFileSync(
  new URL('src/catalog.json', root),
  JSON.stringify({ source: discovery.endpoint, fetchedAt: discovery.fetchedAt, operations, unavailable }, null, 2) + '\n'
);

const humanize = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const unavailableNames = 'run_smoke_test, browser_*, make_http_request and the AI-chat attachment/conversation tools';

const metaTools = [
  {
    name: 'testable_searchTools',
    displayName: 'Search Testable Operations',
    toolReferenceName: 'testable_searchTools',
    canBeReferencedInPrompt: true,
    icon: '$(search)',
    tags: ['testable'],
    userDescription: 'Find Testable REST operations by keyword.',
    modelDescription:
      'Searches the catalog of Testable REST operations that testable_callTool can run: test cases, scenarios (scripts) and scenario files, test configurations, executions and their results, logs, metrics and output files, schedules, reports, runners and regions, integrations and VCS roots. Returns matching operation names with access (read/write), HTTP method and path, and a short description, ranked by the number of keyword matches. Use it to find the right operation, then call testable_describeTools for its exact parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords matched against operation names, paths and descriptions, e.g. ["execution", "logs"]. An operation matches if it contains at least one keyword.',
        },
        limit: { type: 'integer', description: 'Maximum number of operations to return. Defaults to 20.' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'testable_describeTools',
    displayName: 'Describe Testable Operations',
    toolReferenceName: 'testable_describeTools',
    canBeReferencedInPrompt: true,
    icon: '$(symbol-interface)',
    tags: ['testable'],
    userDescription: 'Show the full parameters of Testable REST operations.',
    modelDescription:
      'Returns the full descriptor (description and inputSchema with parameter types, descriptions and enums) for each requested Testable operation name. Always call this before running an operation with testable_callTool for the first time. Unknown names are listed in unknownTools; operations that exist on Testable\'s MCP server but cannot run in this extension are listed in unavailableTools with the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        toolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Operation names, e.g. from testable_searchTools.',
        },
      },
      required: ['toolNames'],
    },
  },
  {
    name: 'testable_callTool',
    displayName: 'Call Testable Operation',
    toolReferenceName: 'testable_callTool',
    canBeReferencedInPrompt: true,
    icon: '$(play)',
    tags: ['testable'],
    userDescription: 'Run any Testable REST operation by name.',
    modelDescription:
      `Runs one Testable operation by name (from testable_searchTools or testable_describeTools) and returns the HTTP status and response body. Pass arguments exactly as the operation's inputSchema defines them: properties prefixed path_ fill URL path parameters, properties prefixed query_ become query-string parameters, and every other property is sent as a top-level field of the JSON body (do not wrap them in body or content). Operation descriptions may mention other operations by name; run those through this tool too. Write operations ask the user to confirm first. Not available in this extension: ${unavailableNames}. encode_base64 and decode_base64 run locally.`,
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Operation name, e.g. getExecutionLogs.' },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: "The operation's arguments, shaped as its inputSchema from testable_describeTools.",
        },
      },
      required: ['toolName'],
    },
  },
];

// Implemented by hand in src/extension.ts; each also renders a page in the chat (src/ui.ts).
const workflowTools = [
  {
    name: 'testable_showTests',
    displayName: 'Testable: Show Tests',
    icon: '$(list-tree)',
    access: 'read',
    userDescription: "Show the test cases, scenarios and configurations of this workspace's repo.",
    modelDescription:
      "Lists Testable test cases with their scenarios (id, type, source, linked VCS root, declared params) and configurations (id, test type, scenario params). When Testable lets the API key read VCS roots, the list is narrowed to test cases whose scenarios use this workspace's git remote; the result says whether that happened. apiKey names the API key (organization) every Testable tool uses in this workspace; when the user has several, otherApiKeys lists the other organizations that also have test cases linked to this repo. Also shows an interactive page in the chat where the user can browse, change settings and params, pull or push scenario files and run configurations. Use it first when the user asks about their tests, and to find scenario and configuration IDs.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Only include test cases whose path or scenario names contain this text.' },
        allRepos: { type: 'boolean', description: "Include test cases of every repo, not only this workspace's." },
      },
    },
  },
  {
    name: 'testable_showScenario',
    displayName: 'Testable: Show Scenario',
    icon: '$(symbol-file)',
    access: 'read',
    userDescription: 'Show the settings, files, repository and configurations of a scenario.',
    modelDescription:
      'Shows one Testable scenario: its settings (the scenario metadata, e.g. chromedriverOnly, seleniumVersion, nodeVersion, browsers, wdioCliArgs, screenshots), declared params, files, the linked VCS root (url, branch, auth type) and the configurations that run it. Call it before testable_updateScenarioSettings to get the exact setting names and current values.',
    inputSchema: {
      type: 'object',
      properties: { scenarioId: { type: 'integer', description: 'Scenario (script) ID.' } },
      required: ['scenarioId'],
    },
  },
  {
    name: 'testable_downloadExecution',
    displayName: 'Testable: Download Execution Logs and Files',
    icon: '$(cloud-download)',
    access: 'read',
    userDescription: 'Download the logs and output files of an execution into the workspace.',
    modelDescription:
      'Downloads what is needed to debug a Testable execution into the workspace folder .testable/executions/<executionId>/: logs.txt (every log line at Debug level), execution.json, failed-results.json and the output files (screenshots, videos, HAR files, reports) under files/. Pass executionId, or confId to take the latest execution of a configuration. Returns the local paths; read them with your file tools to find the cause of a failure and fix the test code, or use them in a follow-up workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'integer', description: 'Execution ID.' },
        confId: { type: 'integer', description: 'Configuration ID; its most recent execution is used when executionId is omitted.' },
        outputFiles: { type: 'boolean', description: 'Also download output files. Defaults to true.' },
        contentType: { type: 'string', description: 'Only download output files of this MIME type, e.g. image/png.' },
        failuresOnly: { type: 'boolean', description: 'Only download output files from failed iterations.' },
      },
    },
  },
  {
    name: 'testable_pullScenarioFiles',
    displayName: 'Testable: Pull Scenario Files',
    icon: '$(repo-pull)',
    access: 'read',
    userDescription: 'Download the files of a scenario into the workspace.',
    modelDescription:
      'Downloads every file of a Testable scenario into .testable/scenarios/<scenarioId>-<name>/ in the workspace, keeping their paths, so they can be read and edited with your file tools. Files edited locally since the last pull are kept instead of overwritten (action keep-local) unless force is true. Upload the edits with testable_pushScenarioFiles.',
    inputSchema: {
      type: 'object',
      properties: {
        scenarioId: { type: 'integer', description: 'Scenario (script) ID.' },
        force: { type: 'boolean', description: 'Overwrite local copies even if they were edited.' },
      },
      required: ['scenarioId'],
    },
  },
  {
    name: 'testable_pushScenarioFiles',
    displayName: 'Testable: Push Scenario Files',
    icon: '$(repo-push)',
    access: 'write',
    userDescription: 'Upload edited scenario files back to Testable.',
    modelDescription:
      "Uploads the local copies of a scenario's files (the folder testable_pullScenarioFiles created) to Testable: changed files are updated and new files are created. Unchanged files are skipped and nothing is deleted in Testable. Pass paths (relative to the scenario folder) to upload only some files. The user confirms the list of files first.",
    inputSchema: {
      type: 'object',
      properties: {
        scenarioId: { type: 'integer', description: 'Scenario (script) ID.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Only upload these files, e.g. ["test/login.spec.js"].' },
      },
      required: ['scenarioId'],
    },
  },
  {
    name: 'testable_updateScenarioSettings',
    displayName: 'Testable: Update Scenario Settings',
    icon: '$(settings-gear)',
    access: 'write',
    userDescription: 'Change scenario settings such as chromedriverOnly.',
    modelDescription:
      'Changes scenario settings (the scenario metadata), e.g. {"chromedriverOnly": true}, {"seleniumVersion": "4.x"}, {"wdioCliArgs": "--spec ./test/a.js"}, or nested values with dotted keys such as {"browsers.firefox": "Latest"}. Only the given keys change and the rest of the metadata is kept. Keys must already exist on the scenario (see testable_showScenario) unless allowNewKeys is true; values keep their JSON type (boolean, number, string). The user confirms a before/after diff first.',
    inputSchema: {
      type: 'object',
      properties: {
        scenarioId: { type: 'integer', description: 'Scenario (script) ID.' },
        settings: { type: 'object', additionalProperties: true, description: 'Setting name (dotted for nested values) to new value.' },
        allowNewKeys: { type: 'boolean', description: 'Allow adding settings the scenario does not have yet.' },
      },
      required: ['scenarioId', 'settings'],
    },
  },
  {
    name: 'testable_setScenarioParams',
    displayName: 'Testable: Set Scenario Params',
    icon: '$(symbol-variable)',
    access: 'write',
    userDescription: 'Set or remove the scenario params (environment variables) of a configuration.',
    modelDescription:
      "Sets or removes scenario params, the values a test configuration passes to its scenario as environment variables (stored as the configuration's scriptParams). Only the given params change; the others are kept. A param named baseUrl reaches the script as the environment variable BASE_URL (uppercased) or as ${__P(baseUrl)} in JMeter. The user confirms a before/after diff first.",
    inputSchema: {
      type: 'object',
      properties: {
        confId: { type: 'integer', description: 'Test configuration ID.' },
        set: { type: 'object', additionalProperties: { type: 'string' }, description: 'Params to add or change, name to value.' },
        unset: { type: 'array', items: { type: 'string' }, description: 'Names of params to remove.' },
      },
      required: ['confId'],
    },
  },
  {
    name: 'testable_updateRepository',
    displayName: 'Testable: Update Repository Branch or Token',
    icon: '$(git-branch)',
    access: 'write',
    userDescription: 'Switch the branch a scenario checks out or replace its repository token.',
    modelDescription:
      'Switches the Git branch a scenario checks out and/or replaces the expired access token of its VCS root (repository). With scenarioId, branch changes only that scenario; with repositoryId alone, it changes the default branch of the VCS root. The token never goes through the chat: with updateToken true, VS Code asks the user for it in a password box, checks it against the repository and saves it (the user can save it anyway if the check fails); every scenario on that VCS root uses the new token. The user confirms first.',
    inputSchema: {
      type: 'object',
      properties: {
        scenarioId: { type: 'integer', description: 'Scenario whose branch (and linked VCS root) to change.' },
        repositoryId: { type: 'integer', description: 'VCS root ID, to change its default branch or token without a scenario.' },
        branch: { type: 'string', description: 'Branch or tag to check out.' },
        updateToken: { type: 'boolean', description: 'Ask the user for a new access token and save it.' },
      },
    },
  },
].map(({ access, ...tool }) => ({
  ...tool,
  toolReferenceName: tool.name,
  canBeReferencedInPrompt: true,
  tags: ['testable', access],
}));

const directTools = DIRECT.map((name) => {
  const op = operations.find((o) => o.name === name);
  return {
    name: `testable_${name}`,
    displayName: `Testable: ${humanize(name)}`,
    toolReferenceName: `testable_${name}`,
    canBeReferencedInPrompt: true,
    icon: op.access === 'write' ? '$(edit)' : '$(beaker)',
    tags: ['testable', op.access],
    userDescription: `[${op.access}] ${op.method} ${op.path}`,
    modelDescription: `${op.description}\n\nOther Testable operations named in this description can be run with testable_callTool, except ${unavailableNames}.`,
    inputSchema: op.inputSchema,
  };
});

const pkgUrl = new URL('package.json', root);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
pkg.contributes.languageModelTools = [...metaTools, ...workflowTools, ...directTools];
writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + '\n');

console.log(`catalog: ${operations.length} operations (${operations.filter((o) => o.kind === 'local').length} local), ${unavailable.length} unavailable`);
console.log(`package.json: ${metaTools.length} meta + ${workflowTools.length} workflow + ${directTools.length} direct tools`);
