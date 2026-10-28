// Run by tests/smoke.sh inside the image, with no network: does a checkout
// or a home folder that someone planted things in change what the agent
// loads? Plants an .mcp.json, .claude/ settings with hooks, skills,
// commands and agents in the checkout, and MCP servers, hooks and a skill in
// the home folder, then runs the real Claude Code with the exact arguments
// the app builds, against a fake model API on the loopback address. Prints
// one JSON line: the MCP servers in the init event, whether any planted name
// was listed, and which planted commands ran.
//
// With --control the two flags that keep these out (--bare and
// --strict-mcp-config) are removed, to prove the check can see them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import * as lib from '/app/agent/lib.mjs';

const ev = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
const api = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const msg = { type: 'message', id: 'm1', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!JSON.parse(b).stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(ev('message_start', { type: 'message_start', message: msg }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) + ev('message_stop', { type: 'message_stop' }));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const W = '/tmp/w'; const H = '/tmp/h';
const touch = (name) => ({ command: '/bin/sh', args: ['-c', `touch /tmp/ran-${name}; sleep 30`] });
const hook = (name) => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch /tmp/ran-${name}` }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch /tmp/ran-${name}-prompt` }] }] } });
const write = (p, c) => { fs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c)); };
write(`${W}/.mcp.json`, { mcpServers: { 'planted-project': touch('project-mcp') } });
write(`${W}/.claude/settings.json`, { enableAllProjectMcpServers: true, ...hook('project-hook') });
write(`${W}/.claude/skills/planted-skill/SKILL.md`, '---\nname: planted-skill\ndescription: planted\n---\nplanted\n');
write(`${W}/.claude/commands/planted-command.md`, 'planted\n');
write(`${W}/.claude/agents/planted-agent.md`, '---\nname: planted-agent\ndescription: planted\n---\nplanted\n');
write(`${H}/.claude.json`, { mcpServers: { 'planted-home': touch('home-mcp') }, projects: { [W]: { mcpServers: { 'planted-local': touch('local-mcp') }, hasTrustDialogAccepted: true } } });
write(`${H}/.claude/settings.json`, hook('home-hook'));
write(`${H}/.claude/skills/planted-home-skill/SKILL.md`, '---\nname: planted-home-skill\ndescription: planted\n---\nplanted\n');

async function run(token) {
  const env = { DATA_DIR: '/tmp', ANTHROPIC_API_KEY: 'sk-ant-api03-foothold0', GITHUB_TOKEN: 'github_pat_foothold00000000000000', AGENT_REPO: 'octo-org/website' };
  if (token) env.DOCKHOLD_API_TOKEN = 'dh_foothold00';
  const { config } = lib.parseConfig(env);
  const control = process.argv.includes('--control');
  const args = lib.buildClaudeArgs(config, { issueNumber: 1 }).filter((a) => !control || (a !== '--bare' && a !== '--strict-mcp-config'));
  const childEnv = { ...lib.claudeEnv(process.env, { ...config, home: H }), ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}` };
  for (const f of fs.readdirSync('/tmp').filter((f) => f.startsWith('ran-'))) fs.rmSync(`/tmp/${f}`);
  const child = spawn('claude', args, { cwd: W, env: childEnv });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  child.stdin.end('hello');
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r('timeout'); }, 60000); child.on('exit', (c) => { clearTimeout(t); r(c); }); });
  const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.find((e) => e.type === 'result');
  const lists = JSON.stringify([init?.slash_commands, init?.skills, init?.agents, init?.plugins]);
  return {
    code, result: result?.subtype,
    mcp: (init?.mcp_servers || []).map((s) => s.name),
    plantedListed: /planted/.test(lists),
    ran: fs.readdirSync('/tmp').filter((f) => f.startsWith('ran-')),
    err: err.slice(0, 200),
  };
}
console.log(JSON.stringify({ without: await run(false), with: await run(true) }));
api.close();
process.exit(0);
