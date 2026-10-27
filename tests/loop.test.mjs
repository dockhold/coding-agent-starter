// End-to-end tests of the loop in agent/main.mjs, with fakes: a fake GitHub
// API on the loopback address, a fake `claude` first on PATH, and a local
// bare git repository as the remote. Exercises the real claim, checkout,
// commit, push, pull request, comment, stop and crash-recovery paths.
// Needs node 22 and git. Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = 'sk-ant-api03-LOOPTESTKEY000000000000';
const GH = 'github_pat_LOOPTESTTOKEN0000000000000';
const OWNER_REPO = 'octo-org/website';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(dir, 'last-call.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt }));
  out({ type: 'system', subtype: 'init', model: 'fake-model', mcp_servers: [] });
  if (mode === 'slow') {
    process.on('SIGINT', () => { fs.writeFileSync(path.join(dir, 'got-sigint'), '1'); process.exit(130); });
    fs.writeFileSync(path.join(dir, 'started'), String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'edit') {
    fs.writeFileSync('hello.txt', 'hello from the agent\\n');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { content: 'TOOL-INPUT-NOT-LOGGED' } }] } });
  }
  if (mode === 'leak') fs.writeFileSync('leak.txt', 'key=' + process.env.ANTHROPIC_API_KEY + '\\n');
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'Added hello.txt.', total_cost_usd: 0.1234 });
});
`;

function fakeGitHub() {
  const db = { issues: [], labels: new Map(), comments: [], pulls: [], auth: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      db.auth.add(req.headers.authorization);
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const p = url.pathname.replace(`/repos/${OWNER_REPO}`, '');
      let m;
      if (req.method === 'GET' && p === '') return send(200, { default_branch: 'main' });
      if (req.method === 'GET' && p === '/issues') {
        const label = url.searchParams.get('labels');
        return send(200, db.issues.filter((i) => db.labels.get(i.number)?.has(label)));
      }
      if ((m = p.match(/^\/issues\/(\d+)\/labels\/(.+)$/)) && req.method === 'DELETE') {
        const set = db.labels.get(Number(m[1]));
        if (!set?.delete(decodeURIComponent(m[2]))) return send(404, { message: 'Label does not exist' });
        return send(200, []);
      }
      if ((m = p.match(/^\/issues\/(\d+)\/labels$/)) && req.method === 'POST') {
        for (const l of body.labels) db.labels.get(Number(m[1])).add(l);
        return send(200, []);
      }
      if ((m = p.match(/^\/issues\/(\d+)\/comments$/)) && req.method === 'POST') {
        db.comments.push({ issue: Number(m[1]), body: body.body });
        return send(201, {});
      }
      if (p === '/pulls' && req.method === 'GET') {
        return send(200, db.pulls.filter((pr) => `octo-org:${pr.head}` === url.searchParams.get('head')));
      }
      if (p === '/pulls' && req.method === 'POST') {
        const pr = { ...body, number: 100 + db.pulls.length, html_url: `https://github.com/${OWNER_REPO}/pull/${100 + db.pulls.length}` };
        db.pulls.push(pr);
        return send(201, pr);
      }
      if ((m = p.match(/^\/pulls\/(\d+)$/)) && req.method === 'PATCH') {
        Object.assign(db.pulls.find((pr) => pr.number === Number(m[1])), body);
        return send(200, {});
      }
      return send(404, { message: 'Not Found' });
    });
  });
  return { db, server };
}

const issue = (number, title, author = 'OWNER', extra = {}) => ({
  number, title, body: `Body of ${number}`, author_association: author, created_at: `2026-10-${String(number).padStart(2, '0')}T00:00:00Z`, ...extra,
});

async function until(fn, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the loop, end to end with fakes', () => {
  let tmp; let bin; let remote; let gh; let apiBase;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    remote = path.join(tmp, 'remote.git');
    const g = (...a) => execFileSync('git', a, { cwd: tmp, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
    g('init', '--quiet', '--bare', '-b', 'main', remote);
    g('init', '--quiet', '-b', 'main', 'seed');
    fs.writeFileSync(path.join(tmp, 'seed', 'README.md'), 'seed\n');
    fs.writeFileSync(path.join(tmp, 'seed', 'CLAUDE.md'), 'House rules.\n');
    g('-C', 'seed', 'add', '-A');
    g('-C', 'seed', 'commit', '--quiet', '-m', 'seed');
    g('-C', 'seed', 'push', '--quiet', remote, 'main');
    gh = fakeGitHub();
    await new Promise((r) => gh.server.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${gh.server.address().port}`;
  });

  after(() => {
    gh.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function start(dataDir, mode, extraEnv = {}) {
    fs.writeFileSync(path.join(bin, 'mode'), mode);
    for (const f of ['started', 'got-sigint', 'last-call.json']) fs.rmSync(path.join(bin, f), { force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(ROOT, 'agent/main.mjs')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, PORT: String(port), DATA_DIR: dataDir,
        ANTHROPIC_API_KEY: KEY, GITHUB_TOKEN: GH, AGENT_REPO: OWNER_REPO, AGENT_POLL_MINUTES: '1',
        CODING_AGENT_TEST_GITHUB_API: apiBase, CODING_AGENT_TEST_GIT_URL: `file://${remote}`, ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proc = { child, port, log: '', exit: null };
    child.stdout.on('data', (d) => { proc.log += d; });
    child.stderr.on('data', (d) => { proc.log += d; });
    proc.exited = new Promise((r) => child.on('exit', (code, signal) => { proc.exit = { code, signal }; r(proc.exit); }));
    return proc;
  }
  const get = (port, p, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method });
  const gitOut = (...a) => execFileSync('git', ['--git-dir', remote, ...a]).toString();

  it('turns a labelled issue into a pull request and skips outsiders and pull requests', async () => {
    gh.db.issues.push(issue(1, 'Fix the greeting'), issue(2, 'Outsider request', 'NONE'), issue(3, 'A PR', 'OWNER', { pull_request: {} }));
    for (const n of [1, 2, 3]) gh.db.labels.set(n, new Set(['agent']));
    const data = path.join(tmp, 'data1');
    const app = start(data, 'edit');
    await until(() => gh.db.comments.find((c) => c.issue === 1), 20_000, 'the comment on #1');

    const pr = gh.db.pulls[0];
    assert.equal(pr.head, 'agent/issue-1');
    assert.equal(pr.base, 'main');
    assert.equal(pr.title, 'Fix the greeting (#1)');
    assert.match(pr.body, /Added hello\.txt\./);
    assert.match(pr.body, /Closes #1/);
    assert.match(pr.body, /\$0\.12/);
    assert.match(gh.db.comments.find((c) => c.issue === 1).body, /opened a pull request.*pull\/100/);
    assert.equal(gitOut('log', '-1', '--format=%s', 'agent/issue-1').trim(), 'Fix the greeting (#1)');
    assert.equal(gitOut('show', 'agent/issue-1:hello.txt'), 'hello from the agent\n');
    assert.equal(gitOut('rev-list', '--count', 'main').trim(), '1', 'the default branch is untouched');
    assert.equal(gh.db.labels.get(1).has('agent'), false, 'the label was removed when the issue was claimed');
    assert.equal(gh.db.labels.get(2).has('agent'), true, 'the outsider issue is untouched');
    assert.equal(gh.db.comments.filter((c) => c.issue !== 1).length, 0);
    assert.deepEqual([...gh.db.auth], [`Bearer ${GH}`]);

    const call = JSON.parse(fs.readFileSync(path.join(bin, 'last-call.json'), 'utf8'));
    assert.deepEqual(call.argv.slice(0, 2), ['--bare', '-p']);
    assert.ok(call.argv.includes('--permission-prompts'));
    assert.equal(call.argv[call.argv.indexOf('--append-system-prompt-file') + 1], path.join(data, 'repo', 'CLAUDE.md'));
    assert.equal(call.prompt, 'Fix the greeting\n\nBody of 1\n');
    assert.equal(call.cwd, path.join(data, 'repo'));
    assert.equal(call.env.HOME, path.join(data, 'home'));
    assert.equal(call.env.ANTHROPIC_API_KEY, KEY);
    assert.equal(call.env.GITHUB_TOKEN, undefined, 'the agent never gets the GitHub token');
    assert.ok(!JSON.stringify(call.env).includes(GH));
    const gitConfig = fs.readFileSync(path.join(data, 'repo', '.git', 'config'), 'utf8');
    assert.ok(!gitConfig.includes(GH) && !gitConfig.includes('extraheader'), 'the token is never written to .git/config');

    const logLine = JSON.parse(fs.readFileSync(path.join(data, 'tasks.jsonl'), 'utf8').trim());
    assert.equal(logLine.issue, 1);
    assert.equal(logLine.outcome, 'pr');
    assert.equal(logLine.pr_url, `https://github.com/${OWNER_REPO}/pull/100`);
    assert.equal(logLine.cost_usd, 0.1234);

    const page = await (await get(app.port, '/')).text();
    assert.ok(page.includes(OWNER_REPO) && page.includes('/pull/100'));
    assert.ok(!page.includes(KEY) && !page.includes(GH));
    assert.equal((await get(app.port, '/health')).status, 200);
    assert.deepEqual(await (await get(app.port, '/health')).json(), { status: 'ok' });
    assert.equal((await get(app.port, '/nope')).status, 404);
    assert.equal((await get(app.port, '/', 'POST')).status, 405);

    assert.match(app.log, /#1: tool Write/);
    assert.match(app.log, /#2: skipped, opened by someone without write access \(NONE\)/);
    assert.ok(!app.log.includes('TOOL-INPUT-NOT-LOGGED'), 'tool input is never logged');
    assert.ok(!app.log.includes(KEY) && !app.log.includes(GH), 'no secret in the log');

    app.child.kill('SIGTERM');
    assert.deepEqual(await app.exited, { code: 0, signal: null });
  });

  it('refuses to push a change that carries a secret value', async () => {
    gh.db.issues.push(issue(4, 'Leaky change'));
    gh.db.labels.set(4, new Set(['agent']));
    const app = start(path.join(tmp, 'data2'), 'leak');
    const c = await until(() => gh.db.comments.find((x) => x.issue === 4), 20_000, 'the comment on #4');
    assert.match(c.body, /run failed: leak\.txt contains one of this app's secret values; nothing was pushed/);
    assert.ok(!c.body.includes(KEY));
    assert.throws(() => gitOut('rev-parse', '--verify', '--quiet', 'agent/issue-4'));
    app.child.kill('SIGTERM');
    assert.equal((await app.exited).code, 0);
  });

  it('on SIGTERM mid-task: stops the agent with SIGINT, puts the label back, exits 0 quickly', async () => {
    gh.db.issues.push(issue(5, 'Slow task'));
    gh.db.labels.set(5, new Set(['agent']));
    const data = path.join(tmp, 'data3');
    const app = start(data, 'slow');
    await until(() => fs.existsSync(path.join(bin, 'started')), 20_000, 'the agent to start');
    assert.equal(gh.db.labels.get(5).has('agent'), false);
    assert.ok(fs.existsSync(path.join(data, 'current.json')));
    const t0 = Date.now();
    app.child.kill('SIGTERM');
    assert.deepEqual(await app.exited, { code: 0, signal: null });
    assert.ok(Date.now() - t0 < 10_000, `stopped in ${Date.now() - t0} ms`);
    assert.ok(fs.existsSync(path.join(bin, 'got-sigint')), 'the agent got SIGINT');
    assert.equal(gh.db.labels.get(5).has('agent'), true, 'the label is back');
    assert.equal(fs.existsSync(path.join(data, 'current.json')), false);
    assert.equal(gh.db.comments.filter((x) => x.issue === 5).length, 0);
  });

  it('after a crash mid-task: the next start puts the label back and runs the issue', async () => {
    gh.db.issues.push(issue(6, 'Crash task'));
    gh.db.labels.set(6, new Set(['agent']));
    gh.db.labels.get(5).clear();
    const data = path.join(tmp, 'data4');
    const app = start(data, 'slow');
    const agentPid = Number(await until(() => fs.existsSync(path.join(bin, 'started')) && fs.readFileSync(path.join(bin, 'started'), 'utf8'), 20_000, 'the agent to start'));
    app.child.kill('SIGKILL');
    await app.exited;
    try { process.kill(-agentPid, 'SIGKILL'); } catch { /* gone */ }
    assert.equal(gh.db.labels.get(6).has('agent'), false);
    const again = start(data, 'edit');
    await until(() => gh.db.comments.find((x) => x.issue === 6), 20_000, 'the comment on #6');
    assert.match(again.log, /#6: the app stopped during this task; the label is back/);
    assert.ok(gh.db.pulls.some((pr) => pr.head === 'agent/issue-6'));
    again.child.kill('SIGTERM');
    assert.equal((await again.exited).code, 0);
  });
});
