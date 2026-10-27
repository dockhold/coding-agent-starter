// Unit tests for agent/lib.mjs. Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as lib from '../agent/lib.mjs';

const KEY = 'sk-ant-api03-FAKEKEYFORTESTS0000000000';
const GH = 'github_pat_FAKETOKENFORTESTS000000000000';
const DH = 'dh_FAKEDOCKHOLDTOKEN0000';
const VARS = "on this app's Variables tab and restart.";

const base = (extra = {}) => ({
  DATA_DIR: '/data',
  ANTHROPIC_API_KEY: KEY,
  GITHUB_TOKEN: GH,
  AGENT_REPO: 'octo-org/website',
  ...extra,
});
const config = (extra = {}) => {
  const r = lib.parseConfig(base(extra));
  assert.equal(r.error, undefined, r.error);
  return r.config;
};
const refusal = (env) => {
  const r = lib.parseConfig(env);
  assert.ok(r.error, 'expected a refusal');
  assert.ok(!r.error.includes('\n'), 'a refusal is one line');
  for (const s of [KEY, GH, DH]) assert.ok(!r.error.includes(s), 'a refusal never quotes a secret');
  return r.error;
};

describe('config: refusals, one line each', () => {
  it('no App storage', () => {
    const { DATA_DIR, ...noData } = base();
    assert.equal(refusal(noData), lib.STORAGE_LINE);
    assert.equal(refusal(base({ DATA_DIR: '' })), lib.STORAGE_LINE);
    assert.equal(refusal(base({ DATA_DIR: 'data' })), lib.STORAGE_LINE);
  });
  it('no Anthropic key', () => {
    assert.equal(refusal(base({ ANTHROPIC_API_KEY: '' })), `ANTHROPIC_API_KEY is missing or empty. Add it as a secret ${VARS}`);
  });
  it('no GitHub token', () => {
    assert.equal(refusal(base({ GITHUB_TOKEN: '  ' })), `GITHUB_TOKEN is missing or empty. Add it as a secret ${VARS}`);
  });
  it('neither secret', () => {
    assert.equal(
      refusal(base({ ANTHROPIC_API_KEY: '', GITHUB_TOKEN: '' })),
      `ANTHROPIC_API_KEY and GITHUB_TOKEN are missing or empty. Add them as secrets ${VARS}`,
    );
  });
  it('malformed secrets, without quoting them', () => {
    assert.match(refusal(base({ ANTHROPIC_API_KEY: 'sk ant with spaces' })), /^ANTHROPIC_API_KEY is not an API key/);
    assert.match(refusal(base({ GITHUB_TOKEN: `${GH}-x` })), /^GITHUB_TOKEN is not a GitHub token/);
    assert.match(refusal(base({ GITHUB_TOKEN: 'short' })), /^GITHUB_TOKEN is not a GitHub token/);
    assert.match(refusal(base({ DOCKHOLD_API_TOKEN: 'has space inside' })), /^DOCKHOLD_API_TOKEN is not an API token/);
  });
  it('AGENT_REPO missing or not owner/name', () => {
    assert.equal(refusal(base({ AGENT_REPO: '' })), `AGENT_REPO is missing. Set it to your repository as owner/name ${VARS}`);
    for (const bad of ['website', 'octo-org/', '/website', 'octo-org/website/extra', 'https://github.com/a/b',
      '-octo/website', 'octo--org/website', 'octo-org/..', 'octo-org/web site', 'octo-org/website.git', 'a/b;rm']) {
      assert.match(refusal(base({ AGENT_REPO: bad })), /^AGENT_REPO must be a repository as owner\/name/, bad);
    }
  });
  it('AGENT_POLL_MINUTES and AGENT_TASK_MINUTES out of range', () => {
    for (const bad of ['0', '1441', 'ten', '1.5', '-5', '10m']) {
      assert.equal(refusal(base({ AGENT_POLL_MINUTES: bad })), `AGENT_POLL_MINUTES must be a whole number from 1 to 1440. Fix it ${VARS}`);
      assert.equal(refusal(base({ AGENT_TASK_MINUTES: bad })), `AGENT_TASK_MINUTES must be a whole number from 1 to 1440. Fix it ${VARS}`);
    }
  });
  it('AGENT_MAX_BUDGET_USD not a positive amount', () => {
    for (const bad of ['0', '0.00', '-1', 'two', '1001', '1.234', '$2']) {
      assert.match(refusal(base({ AGENT_MAX_BUDGET_USD: bad })), /^AGENT_MAX_BUDGET_USD must be an amount/, bad);
    }
  });
  it('AGENT_MODEL, AGENT_ALLOWED_TOOLS, AGENT_LABEL malformed', () => {
    assert.match(refusal(base({ AGENT_MODEL: '--dangerously-skip-permissions' })), /^AGENT_MODEL must be/);
    assert.match(refusal(base({ AGENT_MODEL: 'son net' })), /^AGENT_MODEL must be/);
    assert.match(refusal(base({ AGENT_ALLOWED_TOOLS: '--bare' })), /^AGENT_ALLOWED_TOOLS must be/);
    assert.match(refusal(base({ AGENT_ALLOWED_TOOLS: 'Read,\nBash' })), /^AGENT_ALLOWED_TOOLS must be/);
    assert.match(refusal(base({ AGENT_ALLOWED_TOOLS: ',,' })), /^AGENT_ALLOWED_TOOLS must be/);
    assert.match(refusal(base({ AGENT_LABEL: 'a,b' })), /^AGENT_LABEL must be/);
    assert.match(refusal(base({ AGENT_LABEL: 'x'.repeat(51) })), /^AGENT_LABEL must be/);
  });
  it('test-only addresses are refused unless local', () => {
    assert.match(refusal(base({ CODING_AGENT_TEST_GITHUB_API: 'https://evil.example' })), /tests only/);
    assert.match(refusal(base({ CODING_AGENT_TEST_GITHUB_API: 'http://127.0.0.1.evil.example' })), /tests only/);
    assert.match(refusal(base({ CODING_AGENT_TEST_GIT_URL: 'https://evil.example/r.git' })), /tests only/);
  });
  it('PORT that is not a port', () => {
    assert.match(refusal(base({ PORT: 'abc' })), /^PORT is set by Dockhold/);
  });
});

describe('config: defaults and accepted values', () => {
  it('defaults', () => {
    const c = config();
    assert.equal(c.label, 'agent');
    assert.equal(c.pollMinutes, 10);
    assert.equal(c.taskMinutes, 60);
    assert.equal(c.model, 'sonnet');
    assert.deepEqual(c.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
    assert.equal(c.budget, 2);
    assert.equal(c.home, '/data/home');
    assert.equal(c.repoDir, '/data/repo');
    assert.equal(c.taskLog, '/data/tasks.jsonl');
    assert.equal(c.apiBase, 'https://api.github.com');
    assert.equal(c.gitUrl, 'https://github.com/octo-org/website.git');
    assert.equal(c.dockholdToken, '');
    assert.equal(c.port, 8080);
  });
  it('values the user sets', () => {
    const c = config({
      AGENT_LABEL: 'ready for agent', AGENT_POLL_MINUTES: '1440', AGENT_TASK_MINUTES: '1', AGENT_MODEL: 'opus',
      AGENT_ALLOWED_TOOLS: 'Read, Edit, Bash(npm run test, lint), Bash(git diff *)', AGENT_MAX_BUDGET_USD: '0.50',
      DOCKHOLD_API_TOKEN: DH, PORT: '9000', DATA_DIR: '/data/',
    });
    assert.equal(c.label, 'ready for agent');
    assert.equal(c.pollMinutes, 1440);
    assert.equal(c.taskMinutes, 1);
    assert.equal(c.model, 'opus');
    assert.deepEqual(c.tools, ['Read', 'Edit', 'Bash(npm run test, lint)', 'Bash(git diff *)']);
    assert.equal(c.budget, 0.5);
    assert.equal(c.dockholdToken, DH);
    assert.equal(c.port, 9000);
    assert.equal(c.home, '/data/home');
  });
  it('full model names and test addresses on the loopback', () => {
    assert.equal(config({ AGENT_MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
    assert.equal(config({ AGENT_MODEL: 'opus[1m]' }).model, 'opus[1m]');
    const c = config({ CODING_AGENT_TEST_GITHUB_API: 'http://127.0.0.1:4010', CODING_AGENT_TEST_GIT_URL: 'file:///tmp/r.git' });
    assert.equal(c.apiBase, 'http://127.0.0.1:4010');
    assert.equal(c.gitUrl, 'file:///tmp/r.git');
  });
});

describe('issue selection', () => {
  const issue = (number, extra = {}) => ({ number, title: `t${number}`, author_association: 'OWNER', created_at: `2026-10-0${number}T00:00:00Z`, ...extra });
  it('skips pull requests silently, outsiders and done ones with a reason, oldest first', () => {
    const issues = [
      issue(5), issue(3, { author_association: 'MEMBER' }), issue(4, { author_association: 'COLLABORATOR' }),
      issue(2, { pull_request: { url: 'x' } }), issue(6, { author_association: 'NONE' }),
      issue(7, { author_association: 'CONTRIBUTOR' }), issue(8, { author_association: 'FIRST_TIME_CONTRIBUTOR' }),
      issue(1),
    ];
    const { eligible, skipped } = lib.selectIssues(issues, new Set([1]));
    assert.deepEqual(eligible.map((i) => i.number), [3, 4, 5]);
    assert.deepEqual(skipped.map((s) => s.number).sort(), [1, 6, 7, 8]);
    assert.match(skipped.find((s) => s.number === 6).reason, /without write access \(NONE\)/);
    assert.match(skipped.find((s) => s.number === 1).reason, /already/);
  });
  it('reads done issues from the task log, ignoring failures and damaged lines', () => {
    const log = [
      JSON.stringify({ issue: 1, outcome: 'pr' }),
      JSON.stringify({ issue: 2, outcome: 'no-changes' }),
      JSON.stringify({ issue: 3, outcome: 'failed' }),
      '{not json',
      JSON.stringify({ issue: '4', outcome: 'pr' }),
      '',
    ].join('\n');
    assert.deepEqual([...lib.doneIssues(log)].sort(), [1, 2]);
    assert.equal(lib.doneIssues('').size, 0);
  });
});

describe('the agent command line', () => {
  it('without the Dockhold token: no MCP server, no Dockhold tools', () => {
    const args = lib.buildClaudeArgs(config(), { issueNumber: 12 });
    assert.deepEqual(args.slice(0, 2), ['--bare', '-p']);
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after('--model'), 'sonnet');
    assert.equal(after('--allowedTools'), 'Read,Edit,Write,Glob,Grep,Bash');
    assert.equal(after('--permission-prompts'), 'none');
    assert.equal(after('--max-budget-usd'), '2');
    assert.equal(after('--output-format'), 'stream-json');
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.match(after('--append-system-prompt'), /issue #12/);
    assert.match(after('--append-system-prompt'), /Do not commit, push/);
    assert.ok(!args.includes('--mcp-config'));
    assert.ok(!args.includes('--append-system-prompt-file'));
    assert.ok(!args.join(' ').includes('mcp__dockhold'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });
  it('with the Dockhold token: MCP server by reference, never the token itself', () => {
    const c = config({ DOCKHOLD_API_TOKEN: DH, AGENT_MODEL: 'opus', AGENT_MAX_BUDGET_USD: '0.5', AGENT_ALLOWED_TOOLS: 'Read,Edit' });
    const args = lib.buildClaudeArgs(c, { issueNumber: 3, claudeMdPath: '/data/repo/CLAUDE.md' });
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after('--model'), 'opus');
    assert.equal(after('--max-budget-usd'), '0.5');
    assert.equal(after('--allowedTools'), 'Read,Edit,mcp__dockhold');
    assert.equal(after('--append-system-prompt-file'), '/data/repo/CLAUDE.md');
    const mcp = JSON.parse(after('--mcp-config'));
    assert.deepEqual(mcp, {
      mcpServers: { dockhold: { type: 'http', url: 'https://api.dockhold.eu/mcp', headers: { Authorization: 'Bearer ${DOCKHOLD_API_TOKEN}' } } },
    });
    assert.ok(!args.join(' ').includes(DH), 'the token is never on the command line');
    assert.equal(args.at(-1), '--verbose', 'a variadic option is never last, so nothing after it is swallowed');
  });
  it('the prompt is the title and body only', () => {
    assert.equal(lib.taskPrompt({ title: ' Fix footer ', body: 'Use 2026.\n' }), 'Fix footer\n\nUse 2026.\n');
    assert.equal(lib.taskPrompt({ title: '--model x', body: null }), '--model x\n');
  });
});

describe('the agent environment', () => {
  const env = { PATH: '/usr/bin', LANG: 'C.UTF-8', GITHUB_TOKEN: GH, ANTHROPIC_API_KEY: 'from-env', OTHER: 'x', AGENT_REPO: 'a/b' };
  it('is an allow-list: GITHUB_TOKEN never in it', () => {
    const child = lib.claudeEnv(env, config());
    assert.deepEqual(Object.keys(child).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'PATH']);
    assert.equal(child.ANTHROPIC_API_KEY, KEY);
    assert.equal(child.HOME, '/data/home');
    assert.ok(!Object.values(child).includes(GH));
  });
  it('carries DOCKHOLD_API_TOKEN only when it is set', () => {
    const child = lib.claudeEnv(env, config({ DOCKHOLD_API_TOKEN: DH }));
    assert.equal(child.DOCKHOLD_API_TOKEN, DH);
    assert.ok(!('GITHUB_TOKEN' in child));
  });
});

describe('the push guard', () => {
  it('allows only agent/issue-<n>, never the default branch', () => {
    assert.equal(lib.assertPushBranch('agent/issue-12', 'main'), 'agent/issue-12');
    for (const bad of ['main', 'master', 'agent/issue-', 'agent/issue-12x', 'agent/issue-1/x', 'refs/heads/main',
      'agent/issue-1:refs/heads/main', '+agent/issue-1', 'Agent/issue-1', '', null, undefined]) {
      assert.throws(() => lib.assertPushBranch(bad, 'main'), /refusing to push/, String(bad));
    }
    assert.throws(() => lib.assertPushBranch('agent/issue-7', 'agent/issue-7'), /default branch/);
  });
  it('branch names from issue numbers, and default branch names from outside', () => {
    assert.equal(lib.branchFor(42), 'agent/issue-42');
    assert.throws(() => lib.branchFor(0));
    assert.throws(() => lib.branchFor('7'));
    assert.equal(lib.checkBranchName('main'), 'main');
    assert.equal(lib.checkBranchName('release/2.x'), 'release/2.x');
    for (const bad of ['-main', 'a..b', 'main branch', '', 'x'.repeat(256), undefined]) assert.throws(() => lib.checkBranchName(bad));
  });
  it('the git auth header is basic auth for the token, and the safe config turns hooks off', () => {
    const h = lib.gitAuthHeader(GH);
    assert.equal(h, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GH}`).toString('base64')}`);
    assert.match(lib.SAFE_GIT_CONFIG, /hooksPath = \/dev\/null/);
    assert.doesNotMatch(lib.SAFE_GIT_CONFIG, /remote|url|include|credential|proxy/i);
  });
});

describe('output: escaping, redaction, summaries', () => {
  it('escapes HTML', () => {
    assert.equal(lib.escapeHtml(`<script>alert("x")</script>&'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
  });
  it('the status page escapes every value and never shows a secret', () => {
    const html = lib.renderStatus({
      repo: 'octo-org/website', label: '<b>agent</b>',
      current: { number: 4, title: '<img src=x onerror=alert(1)>', startedAt: Date.UTC(2026, 9, 27) },
      last: { issue: 3, title: 'ok', time: Date.UTC(2026, 9, 26), outcome: 'failed', error: '<i>boom</i>' },
      nextPollAt: 0, lastPollError: '"><svg onload=1>',
    });
    assert.ok(html.includes('octo-org/website'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>agent'));
    assert.ok(!html.includes('<svg'));
    assert.ok(html.includes('&lt;i&gt;boom&lt;/i&gt;'));
    for (const s of [KEY, GH, DH]) assert.ok(!html.includes(s));
  });
  it('links only a real pull request address', () => {
    const page = (prUrl) => lib.renderStatus({ repo: 'a/b', label: 'agent', current: null, last: { issue: 1, title: 't', time: 1, outcome: 'pr', prUrl }, nextPollAt: 1, lastPollError: '' });
    assert.ok(page('https://github.com/a/b/pull/9').includes('<a href="https://github.com/a/b/pull/9">'));
    assert.ok(!page('javascript:alert(1)').includes('<a href'));
  });
  it('redacts secret values', () => {
    assert.equal(lib.redact(`key ${KEY} and ${GH} twice ${KEY}`, [KEY, GH, '']), 'key [hidden] and [hidden] twice [hidden]');
    assert.deepEqual(lib.secretValues(config({ DOCKHOLD_API_TOKEN: DH })), [KEY, GH, DH]);
  });
  it('logs tool names only, never their input', () => {
    const line = lib.describeEvent({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: `echo ${KEY}` } }, { type: 'text', text: 'secret talk' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/x' } }] } });
    assert.equal(line, 'tool Bash, Edit');
    assert.equal(lib.describeEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: KEY }] } }), null);
    assert.equal(lib.describeEvent({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.1234 }), 'agent finished, 4 turns, cost $0.12');
    assert.match(lib.describeEvent({ type: 'system', subtype: 'init', model: 'm', mcp_servers: [{ name: 'dockhold', status: 'connected' }] }), /MCP: dockhold connected/);
  });
  it('names why a run failed', () => {
    const c = config();
    assert.equal(lib.failureReason({ result: { subtype: 'success', is_error: false }, exitCode: 0, timedOut: false, config: c }), '');
    assert.match(lib.failureReason({ result: null, exitCode: 0, timedOut: true, config: c }), /after 60 minutes/);
    assert.match(lib.failureReason({ result: null, exitCode: 1, timedOut: false, config: c }), /exited with code 1/);
    assert.match(lib.failureReason({ result: { subtype: 'error_max_budget_usd', is_error: true }, exitCode: 1, timedOut: false, config: c }), /budget of \$2\.00/);
    assert.match(lib.failureReason({ result: { subtype: 'error_during_execution', is_error: true, result: 'x' }, exitCode: 1, timedOut: false, config: c }), /ended with an error/);
  });
  it('pull request body and commit message', () => {
    const body = lib.prBody({ summary: 'x'.repeat(4000), issueNumber: 9, cost: 0.456 });
    assert.match(body, /Closes #9/);
    assert.match(body, /\$0\.46/);
    assert.match(body, /cut at 3000 characters/);
    assert.equal(lib.commitMessage({ title: 'Fix\nthe   footer', number: 9 }), 'Fix the footer (#9)');
    assert.equal(lib.formatCost(undefined), 'unknown');
  });
});
