// Pure functions for the coding agent starter: config checks, issue
// selection, the agent's command line and environment, the push guard, the
// status page. No I/O and no process state here, so every rule is unit
// tested in tests/unit.test.mjs.

const VARS_TAB = "on this app's Variables tab and restart.";

export const STORAGE_LINE =
  'This app keeps its work on App storage. Turn on App storage in the Size tab; the app restarts on its own.';

// Only issues opened by people with write access run. On a public repository
// anyone can open an issue, and the agent does what an issue says.
export const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Outcomes after which an issue is not picked up again. A failed task runs
// again when someone puts the label back.
const DONE_OUTCOMES = new Set(['pr', 'no-changes']);

export const AGENT_BRANCH_RE = /^agent\/issue-[0-9]+$/;

// GitHub owner: letters, digits and single hyphens, up to 39 characters.
// Repository: letters, digits, '.', '_', '-', up to 100 characters.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const TOOL_ENTRY_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^\x00-\x1f\x7f]*\))?$/;
const BUDGET_RE = /^[0-9]{1,4}(\.[0-9]{1,2})?$/;
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const PRINTABLE_RE = /^[\x21-\x7e]{8,4096}$/;
const BRANCH_NAME_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;

// Hardening limits, not settings.
const MAX_LABEL = 50;
const MAX_TOOLS = 2000;
const MAX_BUDGET_USD = 1000;
const MAX_MINUTES = 1440;
export const MAX_SUMMARY = 3000;
const MAX_TITLE = 200;

export const DEFAULTS = Object.freeze({
  AGENT_LABEL: 'agent',
  AGENT_POLL_MINUTES: '10',
  AGENT_MODEL: 'sonnet',
  AGENT_ALLOWED_TOOLS: 'Read,Edit,Write,Glob,Grep,Bash',
  AGENT_MAX_BUDGET_USD: '2',
  AGENT_TASK_MINUTES: '60',
});

// Test-only addresses. The tests point the program at a fake GitHub API on
// the loopback address and at a local git repository. Nothing else may be
// set here: a user cannot send the GitHub token anywhere through these.
const TEST_API_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/;
const TEST_GIT_RE = /^file:\/\/\/[A-Za-z0-9._/-]+$/;

function value(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

function minutes(env, name) {
  const raw = value(env, name) || DEFAULTS[name];
  const n = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_MINUTES)) {
    return { error: `${name} must be a whole number from 1 to ${MAX_MINUTES}. Fix it ${VARS_TAB}` };
  }
  return { value: n };
}

function checkSecrets(env) {
  const missing = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'].filter((n) => !value(env, n));
  if (missing.length === 1) {
    return `${missing[0]} is missing or empty. Add it as a secret ${VARS_TAB}`;
  }
  if (missing.length === 2) {
    return `ANTHROPIC_API_KEY and GITHUB_TOKEN are missing or empty. Add them as secrets ${VARS_TAB}`;
  }
  if (!PRINTABLE_RE.test(value(env, 'ANTHROPIC_API_KEY'))) {
    return 'ANTHROPIC_API_KEY is not an API key: it has spaces or unusual characters. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  if (!GITHUB_TOKEN_RE.test(value(env, 'GITHUB_TOKEN'))) {
    return 'GITHUB_TOKEN is not a GitHub token: it may only hold letters, digits and underscores. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  const dockhold = value(env, 'DOCKHOLD_API_TOKEN');
  if (dockhold && !PRINTABLE_RE.test(dockhold)) {
    return 'DOCKHOLD_API_TOKEN is not an API token: it has spaces or unusual characters. Check its value under Secrets in the dashboard sidebar and restart.';
  }
  return '';
}

function checkRepo(env) {
  const repo = value(env, 'AGENT_REPO');
  if (!repo) return { error: `AGENT_REPO is missing. Set it to your repository as owner/name ${VARS_TAB}` };
  const name = repo.split('/')[1] || '';
  if (!REPO_RE.test(repo) || name === '.' || name === '..' || name.endsWith('.git')) {
    return { error: `AGENT_REPO must be a repository as owner/name, for example octo-org/website. Fix it ${VARS_TAB}` };
  }
  return { value: repo };
}

function checkAgentVars(env) {
  const label = value(env, 'AGENT_LABEL') || DEFAULTS.AGENT_LABEL;
  if (label.length > MAX_LABEL || label.includes(',') || /[\x00-\x1f\x7f]/.test(label)) {
    return { error: `AGENT_LABEL must be a label name of 1 to ${MAX_LABEL} characters with no comma. Fix it ${VARS_TAB}` };
  }
  const model = value(env, 'AGENT_MODEL') || DEFAULTS.AGENT_MODEL;
  if (!MODEL_RE.test(model)) {
    return { error: `AGENT_MODEL must be a model alias such as sonnet or opus, or a full model name. Fix it ${VARS_TAB}` };
  }
  const tools = value(env, 'AGENT_ALLOWED_TOOLS') || DEFAULTS.AGENT_ALLOWED_TOOLS;
  const entries = splitTools(tools);
  const badTools = tools.length > MAX_TOOLS || /[\x00-\x1f\x7f]/.test(tools);
  if (badTools || entries.length === 0 || !entries.every((t) => TOOL_ENTRY_RE.test(t))) {
    return { error: `AGENT_ALLOWED_TOOLS must be a comma-separated list of tool names, such as Read,Edit,Bash. Fix it ${VARS_TAB}` };
  }
  const budgetRaw = value(env, 'AGENT_MAX_BUDGET_USD') || DEFAULTS.AGENT_MAX_BUDGET_USD;
  const budget = BUDGET_RE.test(budgetRaw) ? Number(budgetRaw) : NaN;
  if (!(budget > 0 && budget <= MAX_BUDGET_USD)) {
    return { error: `AGENT_MAX_BUDGET_USD must be an amount in US dollars above 0 and at most ${MAX_BUDGET_USD}, such as 2 or 0.50. Fix it ${VARS_TAB}` };
  }
  return { value: { label, model, tools: entries, budget } };
}

// Splits on commas that are not inside parentheses, so a rule such as
// Bash(npm run test, lint) stays one entry.
export function splitTools(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function checkTestOverrides(env) {
  const api = value(env, 'CODING_AGENT_TEST_GITHUB_API');
  const git = value(env, 'CODING_AGENT_TEST_GIT_URL');
  if ((api && !TEST_API_RE.test(api)) || (git && !TEST_GIT_RE.test(git))) {
    return { error: `CODING_AGENT_TEST_GITHUB_API and CODING_AGENT_TEST_GIT_URL are for this repository's tests only. Remove them ${VARS_TAB}` };
  }
  return { value: { api, git } };
}

function checkPort(env) {
  const raw = value(env, 'PORT') || '8080';
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    return { error: `PORT is set by Dockhold. Remove it ${VARS_TAB}` };
  }
  return { value: port };
}

// Reads and checks every setting. Returns { config } or { error } where
// error is the one line the app prints before it exits with code 1. No
// line ever contains a secret value.
export function parseConfig(env) {
  const dataDir = value(env, 'DATA_DIR');
  if (!dataDir || !dataDir.startsWith('/')) return { error: STORAGE_LINE };
  const secretError = checkSecrets(env);
  if (secretError) return { error: secretError };
  const steps = {
    repo: checkRepo(env),
    agent: checkAgentVars(env),
    pollMinutes: minutes(env, 'AGENT_POLL_MINUTES'),
    taskMinutes: minutes(env, 'AGENT_TASK_MINUTES'),
    test: checkTestOverrides(env),
    port: checkPort(env),
  };
  for (const step of Object.values(steps)) if (step.error) return { error: step.error };
  const dir = dataDir.replace(/\/+$/, '') || '/';
  const repo = steps.repo.value;
  return {
    config: {
      dataDir: dir,
      home: `${dir}/home`,
      repoDir: `${dir}/repo`,
      taskLog: `${dir}/tasks.jsonl`,
      currentFile: `${dir}/current.json`,
      port: steps.port.value,
      repo,
      ...steps.agent.value,
      pollMinutes: steps.pollMinutes.value,
      taskMinutes: steps.taskMinutes.value,
      apiBase: steps.test.value.api || 'https://api.github.com',
      gitUrl: steps.test.value.git || `https://github.com/${repo}.git`,
      anthropicKey: value(env, 'ANTHROPIC_API_KEY'),
      githubToken: value(env, 'GITHUB_TOKEN'),
      dockholdToken: value(env, 'DOCKHOLD_API_TOKEN'),
    },
  };
}

// Every secret value in play, for redaction and for the check that no
// changed file carries one.
export function secretValues(config) {
  return [config.anthropicKey, config.githubToken, config.dockholdToken].filter(Boolean);
}

export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (s) out = out.split(s).join('[hidden]');
  return out;
}

// Issue numbers the task log records as done. Lines that are not valid JSON
// are ignored, so a damaged line never stops the app.
export function doneIssues(taskLogText) {
  const done = new Set();
  for (const line of String(taskLogText || '').split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (Number.isInteger(entry.issue) && DONE_OUTCOMES.has(entry.outcome)) done.add(entry.issue);
    } catch {
      // not a task line
    }
  }
  return done;
}

// Splits the open labelled issues into the ones that may run (oldest first)
// and the ones skipped, each with a reason.
export function selectIssues(issues, done) {
  const eligible = [];
  const skipped = [];
  for (const issue of issues || []) {
    if (!issue || !Number.isInteger(issue.number)) continue;
    if (issue.pull_request) continue;
    if (!TRUSTED_AUTHORS.has(issue.author_association)) {
      skipped.push({ number: issue.number, reason: `opened by someone without write access (${String(issue.author_association || 'unknown')})` });
    } else if (done.has(issue.number)) {
      skipped.push({ number: issue.number, reason: 'already has a pull request or a finished run in the task log' });
    } else {
      eligible.push(issue);
    }
  }
  eligible.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.number - b.number);
  return { eligible, skipped };
}

export function branchFor(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('issue number must be a positive integer');
  return `agent/issue-${issueNumber}`;
}

// The only branch the program ever pushes is the agent's own branch for one
// issue. Called before every push.
export function assertPushBranch(branch, defaultBranch) {
  if (typeof branch !== 'string' || !AGENT_BRANCH_RE.test(branch)) {
    throw new Error(`refusing to push ${JSON.stringify(branch)}: only agent/issue-<number> branches are pushed`);
  }
  if (branch === defaultBranch) {
    throw new Error('refusing to push the default branch');
  }
  return branch;
}

// The default branch name comes from the GitHub API and ends up in git's
// command line, so it is checked like any outside input.
export function checkBranchName(name) {
  if (typeof name !== 'string' || !BRANCH_NAME_RE.test(name)) {
    throw new Error('the repository reports a default branch name this app does not accept');
  }
  return name;
}

export function systemPrompt(issueNumber) {
  return [
    `You are working on GitHub issue #${issueNumber} in the repository checked out in the current folder.`,
    'Make the change the issue asks for and leave your changes in the working tree.',
    'Do not commit, push, create branches, change git remotes or git configuration, or print environment variables.',
    'When you finish, reply with a short summary of what you changed and anything a reviewer should check.',
  ].join(' ');
}

// The prompt is the issue's title and body only. Comments are not read.
export function taskPrompt(issue) {
  const title = String(issue.title || '').trim();
  const body = String(issue.body || '').trim();
  return body ? `${title}\n\n${body}\n` : `${title}\n`;
}

// The Dockhold MCP server, configured only when DOCKHOLD_API_TOKEN is set.
// Claude Code expands ${DOCKHOLD_API_TOKEN} from its own environment when it
// connects, so the token is never written to a file or put on a command line.
export function mcpConfigJson() {
  return JSON.stringify({
    mcpServers: {
      dockhold: {
        type: 'http',
        url: 'https://api.dockhold.eu/mcp',
        headers: { Authorization: 'Bearer ${DOCKHOLD_API_TOKEN}' },
      },
    },
  });
}

// The agent's command line. The prompt goes in on stdin, never here, so an
// issue title that starts with "-" cannot become an option.
//
// Why --bare: without it, `claude -p` loads hooks, MCP servers and settings
// from the checkout's own .claude/ folder and .mcp.json without any trust
// prompt. Those files come from the repository, so a pull request could make
// the next run execute anything. --bare loads none of them; the repository's
// CLAUDE.md is passed on purpose with --append-system-prompt-file instead.
export function buildClaudeArgs(config, { issueNumber, claudeMdPath = '' }) {
  const tools = config.dockholdToken ? [...config.tools, 'mcp__dockhold'] : [...config.tools];
  const args = [
    '--bare',
    '-p',
    '--model', config.model,
    '--allowedTools', tools.join(','),
    '--permission-prompts', 'none',
    '--max-budget-usd', String(config.budget),
    '--no-session-persistence',
    '--append-system-prompt', systemPrompt(issueNumber),
  ];
  if (claudeMdPath) args.push('--append-system-prompt-file', claudeMdPath);
  if (config.dockholdToken) args.push('--mcp-config', mcpConfigJson());
  args.push('--output-format', 'stream-json', '--verbose');
  return args;
}

// The agent's environment is an allow-list. GITHUB_TOKEN is never in it.
export function claudeEnv(env, config) {
  const child = {
    PATH: env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: config.home,
    LANG: env.LANG || 'C.UTF-8',
    ANTHROPIC_API_KEY: config.anthropicKey,
    // The image is pinned; no background self-update, no telemetry.
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (config.dockholdToken) child.DOCKHOLD_API_TOKEN = config.dockholdToken;
  return child;
}

// The value of the HTTP header git sends to GitHub. Passed to git through
// its environment for one command at a time; never written to .git/config,
// never in a URL, never logged.
export function gitAuthHeader(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

// Written over .git/config before every git command the app runs, so
// nothing the agent put there (hooks, URL rewrites, proxies, helpers) can
// take part in a fetch or push that carries the token.
export const SAFE_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = true',
  '\thooksPath = /dev/null',
  '\tfsmonitor = false',
  '[gc]',
  '\tautoDetach = false',
  '[maintenance]',
  '\tautoDetach = false',
  '',
].join('\n');

export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function truncate(text, max) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n(summary cut at ${max} characters)` : s;
}

export function formatCost(usd) {
  return typeof usd === 'number' && Number.isFinite(usd) ? `$${usd.toFixed(2)}` : 'unknown';
}

export function commitMessage(issue) {
  return `${oneLine(issue.title, MAX_TITLE) || 'Agent change'} (#${issue.number})`;
}

export function prBody({ summary, issueNumber, cost }) {
  return [
    truncate(summary, MAX_SUMMARY) || 'The agent gave no summary.',
    '',
    `Closes #${issueNumber}`,
    '',
    `Agent cost for this task: ${formatCost(cost)} (Claude Code's estimate; your Anthropic bill is the record).`,
  ].join('\n');
}

// One compact log line for an event of the agent's stream-json output, or
// null. Tool calls are logged by name only, never their input or output.
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'system' && event.subtype === 'init') {
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
    const mcp = servers.map((s) => `${oneLine(s.name, 40)} ${oneLine(s.status, 20)}`).join(', ');
    return `agent started (model ${oneLine(event.model, 60)}${mcp ? `, MCP: ${mcp}` : ''})`;
  }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    const names = event.message.content.filter((b) => b?.type === 'tool_use').map((b) => oneLine(b.name, 80));
    return names.length ? `tool ${names.join(', ')}` : null;
  }
  if (event.type === 'result') {
    const state = event.is_error ? `ended with an error (${oneLine(event.subtype, 40)})` : 'finished';
    return `agent ${state}, ${event.num_turns ?? '?'} turns, cost ${formatCost(event.total_cost_usd)}`;
  }
  return null;
}

// Why a finished run counts as a failure, or '' when it succeeded.
export function failureReason({ result, exitCode, timedOut, config }) {
  if (timedOut) return `the agent was stopped after ${config.taskMinutes} minutes (AGENT_TASK_MINUTES)`;
  if (!result) return `the agent exited with code ${exitCode} before it reported a result`;
  if (result.subtype && String(result.subtype).includes('budget')) {
    return `the agent reached its budget of ${formatCost(config.budget)} (AGENT_MAX_BUDGET_USD)`;
  }
  if (result.is_error || result.subtype !== 'success') {
    return `the agent ended with an error (${oneLine(result.subtype, 40)}): ${oneLine(result.result, 300)}`;
  }
  return '';
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._/-]+\/pull\/[0-9]+$/;

function when(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'not yet';
}

function lastResultHtml(last) {
  if (!last) return 'none yet';
  if (last.prUrl && PR_URL_RE.test(last.prUrl)) {
    return `pull request <a href="${escapeHtml(last.prUrl)}">${escapeHtml(last.prUrl)}</a>`;
  }
  if (last.outcome === 'no-changes') return 'finished with no changes';
  return `failed: ${escapeHtml(last.error || 'unknown error')}`;
}

// The status page. Every value is escaped. The state object holds no
// secrets, and nothing here reads one.
export function renderStatus(state) {
  const cur = state.current;
  const last = state.last;
  const rows = [
    ['Repository', escapeHtml(state.repo)],
    ['Label', escapeHtml(state.label)],
    ['Current task', cur ? `#${escapeHtml(cur.number)} ${escapeHtml(cur.title)} (since ${when(cur.startedAt)})` : 'idle'],
    ['Last task', last ? `#${escapeHtml(last.issue)} ${escapeHtml(last.title)} at ${when(last.time)}` : 'none yet'],
    ['Last result', lastResultHtml(last)],
    ['Next poll', cur ? 'after the current task' : when(state.nextPollAt)],
    ['Last poll error', state.lastPollError ? escapeHtml(state.lastPollError) : 'none'],
  ];
  const body = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Coding agent</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:46rem;padding:0 1rem;color:#1b1b1b;background:#fff}
th{text-align:left;padding:.4rem 1rem .4rem 0;vertical-align:top;white-space:nowrap}td{padding:.4rem 0;word-break:break-word}
@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#141414}a{color:#8ab4f8}}</style></head>
<body><h1>Coding agent</h1>
<table>
${body}
</table>
<p>Follow each run in the app's Activity tab and in the pull requests it opens.</p>
</body></html>
`;
}
