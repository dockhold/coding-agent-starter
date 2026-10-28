// The coding agent starter's program: one status server on PORT and one
// loop that turns labelled GitHub issues into pull requests, one at a time.
// Node 22 built-ins only. The rules live in lib.mjs; this file does the I/O.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import * as lib from './lib.mjs';

const parsed = lib.parseConfig(process.env);
if (parsed.error) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(1);
}
const config = parsed.config;
const secrets = lib.secretValues(config);
const needles = lib.secretNeedles(secrets);
// From here on the secrets live in `config` only. Every child gets an
// explicit environment, and removing them here keeps them out of any child
// that would not.
for (const name of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'DOCKHOLD_API_TOKEN']) delete process.env[name];

// Hardening limits, not settings.
const STOP_GRACE_MS = 20_000; // SIGINT first, SIGTERM after this
const KILL_AFTER_MS = 30_000; // then SIGKILL for whatever is left
const EXIT_DEADLINE_MS = 45_000; // the app exits by then whatever happens
const HTTP_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 20 * 60_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_SWEEP_PASSES = 10;
const AUTHOR = { name: 'Coding agent', email: 'coding-agent@localhost' };

const stopController = new AbortController();
let stopping = false;
let agent = null; // { child, timedOut, stopping, timers }
let taskPromise = null;
const gitChildren = new Set();
const reported = new Set();
const state = {
  repo: config.repo,
  label: config.label,
  current: null,
  last: readLastTask(),
  nextPollAt: 0,
  lastPollError: '',
};

function log(line) {
  process.stdout.write(`${lib.redact(line, secrets)}\n`);
}

function describeError(err) {
  if (err?.name === 'TimeoutError') return 'the GitHub API did not answer in time';
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return `could not reach the GitHub API (${err.cause?.code || lib.oneLine(err.cause?.message, 120) || 'network error'})`;
  }
  return lib.oneLine(err?.message || String(err), 500);
}

// ---------------------------------------------------------------- GitHub API

async function gh(method, urlPath, body, signal = stopController.signal) {
  const res = await fetch(`${config.apiBase}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'coding-agent-starter',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data?.message ? `: ${lib.oneLine(data.message, 200)}` : '';
    const err = new Error(`GitHub API ${method} ${urlPath.split('?')[0]} answered ${res.status}${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const issuePath = (n) => `/repos/${config.repo}/issues/${n}`;
const labelPath = (n) => `${issuePath(n)}/labels/${encodeURIComponent(config.label)}`;

function addLabel(n, signal) {
  return gh('POST', `${issuePath(n)}/labels`, { labels: [config.label] }, signal);
}

async function comment(n, text) {
  try {
    await gh('POST', `${issuePath(n)}/comments`, { body: lib.redact(text, secrets) });
  } catch (err) {
    log(`#${n}: could not comment on the issue: ${describeError(err)}`);
  }
}

async function openOrUpdatePr(issue, branch, defaultBranch, body) {
  const owner = config.repo.split('/')[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const open = await gh('GET', `/repos/${config.repo}/pulls?state=open&head=${head}`);
  if (Array.isArray(open) && open[0]?.number) {
    await gh('PATCH', `/repos/${config.repo}/pulls/${open[0].number}`, { body });
    return { url: String(open[0].html_url), updated: true };
  }
  const pr = await gh('POST', `/repos/${config.repo}/pulls`, {
    title: lib.commitMessage(issue),
    head: branch,
    base: defaultBranch,
    body,
  });
  return { url: String(pr?.html_url), updated: false };
}

// Whether the issue's author has write access. The owner always has; anyone
// else is asked of GitHub (needs only the token's Metadata read access).
async function authorMayRun(issue) {
  if (!lib.needsPermissionCheck(issue)) return true;
  const login = lib.authorLogin(issue);
  if (!login) return false;
  try {
    return lib.hasWriteAccess(await gh('GET', `/repos/${config.repo}/collaborators/${encodeURIComponent(login)}/permission`));
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// ---------------------------------------------------------------- state files

function readFileOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function readLastTask() {
  const lines = readFileOr(config.taskLog, '').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (Number.isInteger(e.issue)) {
        return { issue: e.issue, title: e.title, time: Date.parse(e.time) || 0, outcome: e.outcome, prUrl: e.pr_url, error: e.error };
      }
    } catch {
      // not a task line
    }
  }
  return null;
}

function appendTaskLog(entry) {
  fs.appendFileSync(config.taskLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// current.json names the issue being worked on. It exists from the claim
// until the task is logged, so a crash or a kill mid-task is noticed at the
// next start and the label goes back on.
function readCurrent() {
  try {
    const n = JSON.parse(readFileOr(config.currentFile, 'null'))?.issue;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
const writeCurrent = (n) => fs.writeFileSync(config.currentFile, JSON.stringify({ issue: n }), { mode: 0o600 });
const clearCurrent = () => fs.rmSync(config.currentFile, { force: true });

// Returns '' when nothing is pending, or the reason a pending restore could
// not be done yet. While one is pending the loop claims nothing else, so
// current.json is never overwritten.
async function restoreInterruptedLabel() {
  const n = readCurrent();
  if (!n) return '';
  const time = new Date().toISOString();
  try {
    if (lib.interruptedStreak(readFileOr(config.taskLog, ''), n) + 1 >= lib.MAX_INTERRUPTED_RUNS) {
      const error = `stopped after ${lib.MAX_INTERRUPTED_RUNS} interrupted runs`;
      await gh('POST', `${issuePath(n)}/comments`, {
        body: `The coding agent stopped working on this issue after ${lib.MAX_INTERRUPTED_RUNS} runs in a row were cut short by the app stopping, for example by running out of memory. Check the app's Activity tab, raise the app's size if memory ran out, then add the \`${config.label}\` label again to retry.`,
      });
      appendTaskLog({ issue: n, title: '', time, outcome: 'stopped', pr_url: null, cost_usd: null, error });
      clearCurrent();
      log(`#${n}: ${error}; the label stays off`);
      return '';
    }
    await addLabel(n);
    appendTaskLog({ issue: n, title: '', time, outcome: 'interrupted', pr_url: null, cost_usd: null, error: 'the app stopped during this task' });
    clearCurrent();
    log(`#${n}: the app stopped during this task; the label is back, so it runs again`);
    return '';
  } catch (err) {
    const why = `could not put the label back on #${n} yet: ${describeError(err)}`;
    if (!stopping) log(why);
    return why;
  }
}

// ---------------------------------------------------------------- processes

function run(cmd, args, { cwd, env, input = null, timeoutMs = GIT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    gitChildren.add(child);
    const out = [];
    let outBytes = 0;
    let errText = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      gitChildren.delete(child);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: errText });
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => {
      if (outBytes < MAX_CAPTURE_BYTES) out.push(d);
      outBytes += d.length;
    });
    child.stderr.on('data', (d) => {
      errText = (errText + d).slice(-4000);
    });
    child.on('error', (err) => {
      errText += err.message;
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

// git never reads a system or global config, never asks for a password, and
// is pointed at the checkout's .git folder explicitly, so a .git planted in a
// parent folder is never used. With auth, the token goes in as an HTTP
// header for github.com through git's environment, for that one command.
function gitEnv(auth) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: config.home,
    LANG: process.env.LANG || 'C.UTF-8',
    GIT_DIR: path.join(config.repoDir, '.git'),
    GIT_WORK_TREE: config.repoDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
  };
  if (auth) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = lib.gitAuthHeader(config.githubToken);
  }
  return env;
}

async function git(args, { auth = false, allowExit = [] } = {}) {
  const r = await run('git', args, { cwd: config.repoDir, env: gitEnv(auth) });
  if (r.code !== 0 && !allowExit.includes(r.code)) {
    const why = lib.oneLine(lib.redact(r.stderr, secrets), 300) || `exit code ${r.code}`;
    throw new Error(`git ${args[0]} failed: ${why}`);
  }
  return r;
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Puts a known .git/config in place and drops the files that could point git
// somewhere else. Returns false when .git is not a real folder.
function hardenCheckout() {
  const gitDir = path.join(config.repoDir, '.git');
  if (!lstatOrNull(gitDir)?.isDirectory()) return false;
  for (const name of ['config', 'commondir', 'config.worktree']) {
    fs.rmSync(path.join(gitDir, name), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(gitDir, 'config'), lib.SAFE_GIT_CONFIG, { mode: 0o600, flag: 'wx' });
  return true;
}

async function freshRepo() {
  fs.rmSync(config.repoDir, { recursive: true, force: true });
  fs.mkdirSync(config.repoDir, { recursive: true });
  await git(['init', '--quiet']);
  hardenCheckout();
}

// The agent's home folder starts empty for every task, so nothing one run
// leaves there (settings, MCP servers, hooks) reaches the next.
function freshHome() {
  fs.rmSync(config.home, { recursive: true, force: true });
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
}

async function prepareCheckout(branch, defaultBranch) {
  sweepStrays();
  freshHome();
  fs.mkdirSync(config.repoDir, { recursive: true });
  const usable = hardenCheckout() && (await git(['rev-parse', '--git-dir'], { allowExit: [128] })).code === 0;
  if (!usable) await freshRepo();
  await git(['fetch', '--quiet', '--no-tags', config.gitUrl, `refs/heads/${defaultBranch}`], { auth: true });
  const base = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();
  await git(['checkout', '--quiet', '--force', '-B', branch, base]);
  await git(['clean', '-ffdxq']);
  return base;
}

// Ends every process the agent left behind (a server it started, a process
// it detached), so nothing it ran is still around while git holds the token.
// Walks /proc for descendants of this program; when the program is the main
// process, detached processes are reparented to it and are found too. Each
// one is stopped first (SIGSTOP), so it cannot start new ones, and the walk
// repeats until a pass finds nothing new; then all of them are killed.
function descendants() {
  const parent = new Map();
  for (const name of readdirOr('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const stat = readFileOr(`/proc/${name}/stat`, '');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isInteger(ppid)) parent.set(Number(name), ppid);
  }
  const found = [];
  for (const pid of parent.keys()) {
    if (pid === process.pid || [...gitChildren].some((c) => c.pid === pid)) continue;
    let p = parent.get(pid);
    for (let hops = 0; p && p !== process.pid && hops < 64; hops += 1) p = parent.get(p);
    if (p === process.pid) found.push(pid);
  }
  return found;
}

function signalPid(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function sweepStrays(groupId = 0) {
  if (groupId) signalPid(-groupId, 'SIGKILL');
  const stopped = new Set();
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    const fresh = descendants().filter((pid) => !stopped.has(pid));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      signalPid(pid, 'SIGSTOP');
      stopped.add(pid);
    }
  }
  for (const pid of stopped) signalPid(pid, 'SIGKILL');
}

function readdirOr(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function signalAgent(sig) {
  try {
    agent?.child.kill(sig);
  } catch {
    // already gone
  }
}

// SIGINT lets the agent end its turn; SIGTERM after STOP_GRACE_MS; SIGKILL
// for the whole group after KILL_AFTER_MS.
function stopAgent() {
  const a = agent;
  if (!a || a.stopping) return;
  a.stopping = true;
  signalAgent('SIGINT');
  a.timers.push(setTimeout(() => signalAgent('SIGTERM'), STOP_GRACE_MS));
  a.timers.push(setTimeout(() => sweepStrays(a.child.pid), KILL_AFTER_MS));
}

// The repository's CLAUDE.md, read up to the prompt's limit. Only a regular
// file counts, never a link to somewhere else.
function readClaudeMd() {
  const file = path.join(config.repoDir, 'CLAUDE.md');
  if (!lstatOrNull(file)?.isFile()) return '';
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(lib.MAX_CLAUDE_MD + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function runAgent(issue) {
  const args = lib.buildClaudeArgs(config, { issueNumber: issue.number });
  const prompt = lib.taskPrompt(issue, readClaudeMd());
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: config.repoDir,
      env: lib.claudeEnv(process.env, config),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const a = { child, timedOut: false, stopping: false, timers: [] };
    agent = a;
    let result = null;
    let stderrTail = '';
    let done = false;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === 'result') result = event;
      const text = lib.describeEvent(event);
      if (text) log(`#${issue.number}: ${text}`);
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    a.timers.push(setTimeout(() => {
      a.timedOut = true;
      log(`#${issue.number}: stopping the agent after ${config.taskMinutes} minutes (AGENT_TASK_MINUTES)`);
      stopAgent();
    }, config.taskMinutes * 60_000));
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      a.timers.forEach(clearTimeout);
      sweepStrays(child.pid);
      agent = null;
      const lastErr = lib.oneLine(lib.redact(stderrTail.trim().split('\n').pop(), secrets), 200);
      resolve({ result, exitCode, timedOut: a.timedOut, lastErr });
    };
    child.on('error', (err) => {
      stderrTail += err.message;
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------- one task

// Refuses to publish a change that contains one of this app's secret values
// or its base64 form. Reads what is staged (the bytes that would be pushed),
// streamed. A guard against an accident, not against an agent set on
// leaking: the agent can read the Anthropic key, and the Dockhold token when
// it is set.
function stagedHasSecret(rel) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', `:${rel}`], { cwd: config.repoDir, env: gitEnv(false), stdio: ['ignore', 'pipe', 'pipe'] });
    gitChildren.add(child);
    const scanner = lib.createScanner(needles);
    let found = false;
    let errText = '';
    child.stdout.on('data', (d) => {
      if (!found && scanner.push(d)) {
        found = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (d) => {
      errText = (errText + d).slice(-1000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      gitChildren.delete(child);
      if (found) resolve(true);
      else if (code === 0) resolve(false);
      else reject(new Error(`git cat-file failed: ${lib.oneLine(lib.redact(errText, secrets), 200)}`));
    });
  });
}

async function checkNoSecrets(files) {
  for (const rel of files) {
    if (await stagedHasSecret(rel)) {
      throw new Error(`${lib.oneLine(rel, 200)} contains one of this app's secret values; nothing was pushed`);
    }
  }
}

// Commits whatever the agent left in the working tree as one commit on top of
// the fetched default branch, and pushes it to the agent's branch only.
// Returns false when the agent changed nothing.
async function publish(issue, base, branch, defaultBranch) {
  sweepStrays();
  if (!hardenCheckout()) throw new Error('the checkout was damaged during the run; nothing was pushed');
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  // A mixed reset rebuilds the index from the base commit, so nothing the
  // agent did to the index survives; add then stages the working tree.
  await git(['reset', '--quiet', base]);
  await git(['add', '--all']);
  const diff = await git(['diff', '--cached', '--quiet', base], { allowExit: [1] });
  if (diff.code === 0) return false;
  const names = await git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=AMT', base]);
  await checkNoSecrets(names.stdout.split('\0').filter(Boolean));
  await git(['commit', '--quiet', '--no-verify', '-m', lib.commitMessage(issue)]);
  lib.assertPushBranch(branch, defaultBranch);
  await git(['push', '--quiet', '--force', config.gitUrl, `refs/heads/${branch}:refs/heads/${branch}`], { auth: true });
  return true;
}

async function claim(n) {
  writeCurrent(n);
  try {
    await gh('DELETE', labelPath(n));
    return true;
  } catch (err) {
    clearCurrent();
    if (err.status === 404) {
      log(`#${n}: the label was already gone; skipped`);
      return false;
    }
    throw err;
  }
}

function outcomeComment(o) {
  const cost = `Agent cost: ${lib.formatCost(o.cost)}.`;
  if (o.outcome === 'pr') return `The coding agent ${o.updated ? 'updated' : 'opened'} a pull request for this issue: ${o.prUrl}\n\n${cost}`;
  if (o.outcome === 'no-changes') {
    return `The coding agent finished without changing any files. Its summary:\n\n${lib.truncate(o.summary, lib.MAX_SUMMARY) || '(none)'}\n\n${cost}`;
  }
  return `The coding agent run failed: ${o.error}\n\nNo pull request was opened. Add the \`${config.label}\` label again to retry.${o.cost === null ? '' : `\n\n${cost}`}`;
}

async function work(issue, o) {
  const repoInfo = await gh('GET', `/repos/${config.repo}`);
  const defaultBranch = lib.checkBranchName(repoInfo?.default_branch);
  const branch = lib.branchFor(issue.number);
  const base = await prepareCheckout(branch, defaultBranch);
  log(`#${issue.number}: checkout ready on ${branch}; starting the agent`);
  const ran = await runAgent(issue);
  if (stopping) return;
  o.cost = typeof ran.result?.total_cost_usd === 'number' ? ran.result.total_cost_usd : null;
  o.summary = lib.redact(ran.result?.result ?? '', secrets);
  let why = lib.failureReason({ ...ran, config });
  if (why && !ran.result && ran.lastErr) why = `${why}: ${ran.lastErr}`;
  if (why) throw new Error(why);
  if (!(await publish(issue, base, branch, defaultBranch))) {
    o.outcome = 'no-changes';
    return;
  }
  const pr = await openOrUpdatePr(issue, branch, defaultBranch, lib.redact(lib.prBody({ summary: o.summary, issueNumber: issue.number, cost: o.cost }), secrets));
  Object.assign(o, { outcome: 'pr', prUrl: pr.url, updated: pr.updated });
}

// Returns true when the issue was claimed (and so the next poll may follow
// at once), false when it was skipped.
async function runTask(issue) {
  const n = issue.number;
  const title = lib.oneLine(issue.title, 200);
  if (!(await claim(n))) return false;
  state.current = { number: n, title, startedAt: Date.now() };
  log(`#${n}: claimed "${title}"`);
  const o = { outcome: 'failed', prUrl: '', updated: false, cost: null, summary: '', error: '' };
  try {
    await work(issue, o);
  } catch (err) {
    o.error = lib.redact(describeError(err), secrets);
  }
  if (stopping) return true; // shutdown puts the label back
  // The outcome is recorded before the comment, so a stop between the two
  // never runs a finished issue again.
  const time = Date.now();
  appendTaskLog({ issue: n, title, time: new Date(time).toISOString(), outcome: o.outcome, pr_url: o.prUrl || null, cost_usd: o.cost, error: o.error || null });
  clearCurrent();
  state.last = { issue: n, title, time, outcome: o.outcome, prUrl: o.prUrl, error: o.error };
  state.current = null;
  await comment(n, outcomeComment(o));
  const said = { pr: `pull request ${o.prUrl}`, 'no-changes': 'finished with no changes' }[o.outcome] || `failed: ${o.error}`;
  log(`#${n}: ${said} (cost ${lib.formatCost(o.cost)})`);
  return true;
}

// ---------------------------------------------------------------- the loop

async function pollOnce() {
  const q = `state=open&labels=${encodeURIComponent(config.label)}&sort=created&direction=asc&per_page=100`;
  const issues = await gh('GET', `/repos/${config.repo}/issues?${q}`);
  const { eligible, skipped } = lib.selectIssues(Array.isArray(issues) ? issues : [], lib.doneIssues(readFileOr(config.taskLog, '')));
  for (const s of skipped) reportSkip(s.number, s.reason);
  for (const issue of eligible) {
    if (stopping) return null;
    if (await authorMayRun(issue)) return issue;
    reportSkip(issue.number, `opened by ${lib.authorLogin(issue) || 'an unknown account'}, who has no write access to the repository`);
  }
  return null;
}

function reportSkip(number, reason) {
  const key = `${number}:${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  log(`#${number}: skipped, ${reason}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (stopping) return resolve();
    const t = setTimeout(resolve, ms);
    stopController.signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

async function loop() {
  while (!stopping) {
    let ranTask = false;
    try {
      const pending = await restoreInterruptedLabel();
      if (pending) throw new Error(pending);
      const issue = await pollOnce();
      state.lastPollError = '';
      if (issue && !stopping) {
        taskPromise = runTask(issue);
        ranTask = await taskPromise;
        taskPromise = null;
      }
    } catch (err) {
      taskPromise = null;
      if (stopping) break;
      state.lastPollError = lib.redact(describeError(err), secrets);
      if (!state.lastPollError.startsWith('could not put the label back')) log(`poll failed: ${state.lastPollError}`);
    }
    if (ranTask) continue;
    state.nextPollAt = Date.now() + config.pollMinutes * 60_000;
    await sleep(config.pollMinutes * 60_000);
  }
}

// ---------------------------------------------------------------- status page

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

const server = http.createServer((req, res) => {
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { ...HEADERS, ...extra, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });
    return;
  }
  const route = (req.url || '/').split('?')[0];
  if (route === '/health') send(200, 'application/json', '{"status":"ok"}');
  else if (route === '/') send(200, 'text/html; charset=utf-8', lib.renderStatus(state));
  else send(404, 'text/plain; charset=utf-8', 'Not found\n');
});

// ---------------------------------------------------------------- stopping

async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`${sig} received: stopping`);
  setTimeout(() => process.exit(0), EXIT_DEADLINE_MS).unref();
  stopController.abort();
  stopAgent();
  for (const child of gitChildren) child.kill('SIGTERM');
  if (taskPromise) await Promise.race([taskPromise, new Promise((r) => setTimeout(r, KILL_AFTER_MS + 2000))]);
  const n = state.current?.number || readCurrent();
  if (n) {
    try {
      await addLabel(n, AbortSignal.timeout(10_000));
      clearCurrent();
      log(`#${n}: label put back; the issue runs again after the restart`);
    } catch (err) {
      log(`#${n}: could not put the label back now (${describeError(err)}); it is put back at the next start`);
    }
  }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
server.on('error', (err) => {
  process.stderr.write(`Could not listen on port ${config.port}: ${err.code || err.message}\n`);
  process.exit(1);
});
server.listen(config.port, '0.0.0.0', () => {
  log(`listening on port ${server.address().port}`);
  log(`watching ${config.repo} for open issues labelled "${config.label}" every ${config.pollMinutes} minutes; model ${config.model}; budget ${lib.formatCost(config.budget)} per task; Dockhold MCP server ${config.dockholdToken ? 'on' : 'off'}`);
  loop().catch((err) => {
    log(`the loop stopped: ${describeError(err)}`);
    process.exit(1);
  });
});
