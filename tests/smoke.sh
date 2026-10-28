#!/usr/bin/env bash
# Smoke test for the coding-agent-starter image.
#
# Dockhold's runtime, as this test reproduces it: user 1001, every capability
# dropped, no privilege escalation, 1 GB of memory and no swap, App storage
# mounted at /data owned root:1001 with mode 2770, a fixed PORT, secrets and
# variables as environment variables.
#
# Two restrictions go further than Dockhold, and apply to the start-up checks
# only: no outbound network (proves the app downloads nothing to start) and a
# read-only root file system with a tmpfs /tmp (proves it writes nothing
# outside /data and /tmp). A real task run needs the network, because the
# agent must reach its model provider and GitHub, so no real task runs here.
# One task runs against fakes on the loopback address (a fake GitHub API, a
# local repository, a fake agent that misbehaves); the loop itself is tested
# end to end with fakes in tests/loop.test.mjs.
#
# Usage: tests/smoke.sh <image>
# Needs: docker, bash 4 or newer. Exits non-zero if any case fails.
# Prints one PASS or FAIL line per case, INFO lines for measurements, and the
# container log after a failure.
set -euo pipefail

IMAGE=${1:?usage: tests/smoke.sh <image>}
CURL_IMAGE=curlimages/curl:8.16.0
HELPER_IMAGE=alpine:3.24
RUN="agentsmoke-$$-$RANDOM"
NET="$RUN-net"
APP="$RUN-app"
CURL="$RUN-curl"
PORT=8080
URL="http://agent:$PORT"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/agentsmoke.XXXXXX")
STORAGE_LINE="This app keeps its work on App storage. Turn on App storage in the Size tab; the app restarts on its own."
VARS="on this app's Variables tab and restart."

PASS_COUNT=0
FAIL_COUNT=0
HTTP_CODE=000
HTTP_BODY=""

pass() { echo "PASS  $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() {
  echo "FAIL  $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "----- container log ($APP) -----"
  docker logs "$APP" 2>&1 | tail -n 40 || true
  echo "-------------------------------"
}
report() { if [ "$2" = true ]; then pass "$1"; else fail "$1"; fi; }
info() { echo "INFO  $1"; }

cleanup() {
  docker rm -f "$APP" "$CURL" "$RUN-gh" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker run --rm -v "$BASE:/b" "$HELPER_IMAGE" sh -c 'rm -rf /b/* /b/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
  rmdir "$BASE" 2>/dev/null || true
}
trap cleanup EXIT

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# A fresh host dir shaped like the platform's App storage mount.
new_datadir() {
  local d
  d=$(mktemp -d "$BASE/data.XXXXXX")
  docker run --rm -v "$d:/data" "$HELPER_IMAGE" sh -c 'chown 0:1001 /data && chmod 2770 /data' >/dev/null
  echo "$d"
}

# start_app [docker run args...]: the fixed runtime shape, plus the two extra
# start-up restrictions (internal network, read-only root), plus whatever the
# case adds.
start_app() {
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker run -d --name "$APP" --network "$NET" --network-alias agent \
    --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --memory-swap 1g \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -e "PORT=$PORT" "$@" "$IMAGE" >/dev/null 2>"$BASE/run.err" || { cat "$BASE/run.err"; return 1; }
}

app_running() { [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" = true ]; }
app_logs() { docker logs "$APP" 2>&1 || true; }

wait_health() {
  local _
  for _ in $(seq 1 120); do
    app_running || return 1
    if docker exec "$CURL" curl -sf -m 3 -o /dev/null "$URL/health" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

# Prints the exit code once the container has exited, or "running".
wait_exit() {
  local _
  for _ in $(seq 1 80); do
    if ! app_running; then docker inspect -f '{{.State.ExitCode}}' "$APP"; return 0; fi
    sleep 0.25
  done
  echo running
}

# http METHOD PATH: sets HTTP_CODE and HTTP_BODY.
http() {
  local out
  if out=$(docker exec "$CURL" curl -s -m 10 -X "$1" -w $'\n%{http_code}' "$URL$2" 2>/dev/null); then
    HTTP_CODE=${out##*$'\n'}
    HTTP_BODY=${out%$'\n'*}
  else
    HTTP_CODE=000
    HTTP_BODY=""
  fi
}

# A refused start: the container must exit 1 with exactly the expected line.
expect_one_line_refusal() { # NAME EXPECTED_LINE [docker run args...]
  local name=$1 expected=$2
  shift 2
  start_app "$@"
  local code lines ok=true
  code=$(wait_exit)
  lines=$(app_logs | wc -l | tr -d ' ')
  [ "$code" = 1 ] || { ok=false; echo "  exit code: $code (want 1)"; }
  [ "$lines" = 1 ] || { ok=false; echo "  log lines: $lines (want 1)"; }
  [ "$(app_logs)" = "$expected" ] || { ok=false; echo "  log line differs: $(app_logs | head -n 1)"; }
  for v in "$KEY" "$GHT"; do
    if app_logs | grep -qF -- "$v"; then ok=false; echo "  the log contains a secret value"; fi
  done
  report "$name" $ok
}

# ---------------------------------------------------------------------------
echo "==== coding-agent-starter smoke test: $IMAGE"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$CURL" --network "$NET" --entrypoint sh "$CURL_IMAGE" -c 'sleep 100000' >/dev/null

KEY="sk-ant-api03-smoke$(rand_hex 16)"
GHT="github_pat_smoke$(rand_hex 16)"
DHT="dh_smoke$(rand_hex 16)"
REPO="octo-org/website"
APPENV=(-e "ANTHROPIC_API_KEY=$KEY" -e "GITHUB_TOKEN=$GHT" -e "AGENT_REPO=$REPO")
PINNED=$(sed -n 's/^ARG CLAUDE_CODE_VERSION=\([0-9][0-9.]*\)$/\1/p' "$(dirname "$0")/../Dockerfile" | head -n 1)
info "pinned Claude Code version: ${PINNED:-unknown}"
info "image size: $(( $(docker image inspect "$IMAGE" --format '{{.Size}}') / 1048576 )) MiB (uncompressed)"

# ---------------------------------------------------------------------------
echo "==== Refusals"
D_RO=$(new_datadir)
D_REF=$(new_datadir)
expect_one_line_refusal "no App storage (DATA_DIR unset): one line, exit 1" "$STORAGE_LINE" "${APPENV[@]}"
expect_one_line_refusal "App storage mounted read-only: one line, exit 1" "$STORAGE_LINE" -e DATA_DIR=/data -v "$D_RO:/data:ro" "${APPENV[@]}"
expect_one_line_refusal "no Anthropic key: one line, exit 1" \
  "ANTHROPIC_API_KEY is missing or empty. Add it as a secret $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" -e "GITHUB_TOKEN=$GHT" -e "AGENT_REPO=$REPO"
expect_one_line_refusal "no GitHub token: one line, exit 1" \
  "GITHUB_TOKEN is missing or empty. Add it as a secret $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" -e "ANTHROPIC_API_KEY=$KEY" -e "AGENT_REPO=$REPO"
expect_one_line_refusal "AGENT_REPO not owner/name: one line, exit 1" \
  "AGENT_REPO must be a repository as owner/name, for example octo-org/website. Fix it $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" "${APPENV[@]}" -e "AGENT_REPO=https://github.com/octo-org/website"
expect_one_line_refusal "AGENT_POLL_MINUTES 0: one line, exit 1" \
  "AGENT_POLL_MINUTES must be a whole number from 1 to 1440. Fix it $VARS" \
  -e DATA_DIR=/data -v "$D_REF:/data" "${APPENV[@]}" -e AGENT_POLL_MINUTES=0

# ---------------------------------------------------------------------------
echo "==== The pinned Claude Code accepts the command line the app builds"
# The exact argument list from agent/lib.mjs, with every optional part on
# (the Dockhold token). An unknown or renamed option
# makes Claude Code exit at once with "unknown option"; a valid list makes it
# start and wait for the model provider, which this network never reaches.
# So "still running after 5 seconds, no error" is the pass.
argcheck=$(docker run --rm --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
  --network none --read-only --tmpfs /tmp -e HOME=/tmp --entrypoint node "$IMAGE" --input-type=module -e "
import { spawn } from 'node:child_process';
import * as lib from '/app/agent/lib.mjs';
const { config } = lib.parseConfig({ DATA_DIR: '/tmp', ANTHROPIC_API_KEY: 'sk-ant-api03-argcheck00', GITHUB_TOKEN: 'github_pat_argcheck000000000000', AGENT_REPO: 'octo-org/website', DOCKHOLD_API_TOKEN: 'dh_argcheck00' });
const args = lib.buildClaudeArgs(config, { issueNumber: 1 });
const child = spawn('claude', args, { cwd: '/tmp', env: lib.claudeEnv(process.env, { ...config, home: '/tmp' }) });
let err = '';
child.stderr.on('data', (d) => { err += d; });
child.stdout.on('data', (d) => { err += d; });
child.stdin.end('hello');
let exited = null;
child.on('exit', (code) => { exited = code; });
setTimeout(() => {
  const bad = /unknown option|error: option|not found/i.test(err);
  console.log(exited === null && !bad ? 'ok ' + args.filter((a) => a.startsWith('-')).join(' ') : 'bad exit=' + exited + ' ' + err.slice(0, 200).replace(/\\s+/g, ' '));
  child.kill('SIGKILL');
  process.exit(0);
}, 5000);
" 2>&1 || true)
report "every option the app passes is accepted: ${argcheck#ok }" "$(case "$argcheck" in ok*) echo true ;; *) echo false ;; esac)"

# ---------------------------------------------------------------------------
echo "==== Nothing planted in the checkout or the home folder is loaded"
# tests/foothold-check.mjs runs the real Claude Code with the app's arguments
# against a fake model API on the loopback address, in a checkout and a home
# folder full of planted MCP servers, hooks, skills, commands and agents.
# The control run drops --bare and --strict-mcp-config and must see them, or
# the check proves nothing.
foothold() { # [--control]
  docker run --rm --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
    --network none --read-only --tmpfs /tmp --memory 1g --memory-swap 1g \
    -v "$(cd "$(dirname "$0")" && pwd)/foothold-check.mjs:/check/foothold-check.mjs:ro" \
    --entrypoint node "$IMAGE" /check/foothold-check.mjs "$@" 2>&1 | tail -n 1
}
FH=$(foothold)
FH_CONTROL=$(foothold --control)
info "foothold check: $FH"
info "foothold control: $FH_CONTROL"
ok=true
expect='{"without":{"code":0,"result":"success","mcp":[],"plantedListed":false,"ran":[],"err":""},"with":{"code":0,"result":"success","mcp":["dockhold"],"plantedListed":false,"ran":[],"err":""}}'
[ "$FH" = "$expect" ] || { ok=false; echo "  planted MCP servers, hooks, skills or agents were loaded"; }
case "$FH_CONTROL" in
  *planted-project*planted-home*|*planted-home*planted-project*) ;;
  *) ok=false; echo "  control: without the two flags the planted items were not seen, so the check proves nothing" ;;
esac
printf '%s' "$FH_CONTROL" | grep -q 'ran-project-hook' || { ok=false; echo "  control: the planted hook did not run"; }
report "no planted MCP server (only dockhold with the token), hook, skill, command or agent loads; the control run sees them" $ok

# ---------------------------------------------------------------------------
echo "==== Start, no outbound network, read-only root"
D_MAIN=$(new_datadir)
start_app -e DATA_DIR=/data -v "$D_MAIN:/data" "${APPENV[@]}" -e "DOCKHOLD_API_TOKEN=$DHT"
report "starts: /health answers 200" "$(wait_health && echo true || echo false)"

http GET /health
report "/health body is {\"status\":\"ok\"}" "$([ "$HTTP_CODE" = 200 ] && [ "$HTTP_BODY" = '{"status":"ok"}' ] && echo true || echo false)"

http GET /
ok=true
[ "$HTTP_CODE" = 200 ] || { ok=false; echo "  GET / returned $HTTP_CODE"; }
printf '%s' "$HTTP_BODY" | grep -qF "$REPO" || { ok=false; echo "  the page does not name the repository"; }
for v in "$KEY" "$GHT" "$DHT" "${KEY:0:20}" "${GHT:0:20}"; do
  if printf '%s' "$HTTP_BODY" | grep -qF -- "$v"; then ok=false; echo "  the page shows a secret or part of one"; fi
done
report "/ shows the repository and no secret" $ok

http GET /nope
report "unknown path: 404" "$([ "$HTTP_CODE" = 404 ] && echo true || echo false)"
http POST /
report "POST /: 405" "$([ "$HTTP_CODE" = 405 ] && echo true || echo false)"
head_code=$(docker exec "$CURL" curl -s -m 10 -I -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || echo 000)
report "HEAD /health: 200" "$([ "$head_code" = 200 ] && echo true || echo false)"

ok=true
mode=$(docker exec --user 1001:1001 "$APP" stat -c '%a %u' /data/home 2>&1) || ok=false
# 2700 when the mount is setgid, as Dockhold's is: the folder keeps the group.
case "$mode" in "700 1001"|"2700 1001") ;; *) ok=false; echo "  /data/home: $mode" ;; esac
docker exec --user 1001:1001 "$APP" sh -c 'touch /data/home/.w && rm /data/home/.w' >/dev/null 2>&1 || { ok=false; echo "  /data/home is not writable"; }
report "HOME is /data/home, mode $mode (owner only), writable" $ok

ver=$(docker exec --user 1001:1001 -e HOME=/data/home "$APP" claude --version 2>&1 || true)
report "claude --version runs as uid 1001 on the read-only root: $ver" \
  "$([ -n "$PINNED" ] && printf '%s' "$ver" | grep -qF "$PINNED" && echo true || echo false)"

report "process 1 is tini" "$([ "$(docker exec "$APP" cat /proc/1/comm)" = tini ] && echo true || echo false)"

# Both tini (process 1) and the program (its child) start with the app's
# environment. Neither may be readable by another process of user 1001.
ok=true
NODE_PID=$(docker exec "$APP" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && [ "$(cut -d" " -f4 $p/stat)" = 1 ] && echo ${p#/proc/}; done; true')
[ -n "$NODE_PID" ] || { ok=false; echo "  the program is not tini's child"; }
for pid in 1 $NODE_PID; do
  if docker exec --user 1001:1001 "$APP" sh -c "cat /proc/$pid/environ" 2>/dev/null | tr '\0' '\n' | grep -q GITHUB_TOKEN; then
    ok=false; echo "  another uid 1001 process read the environment of process $pid"
  fi
  [ "$(docker exec "$APP" stat -c %u "/proc/$pid/environ")" = 0 ] || { ok=false; echo "  /proc/$pid/environ is not hidden from uid 1001"; }
done
report "the environment (GITHUB_TOKEN) of tini and of the program is not readable by another uid 1001 process" $ok

ok=false
for _ in $(seq 1 120); do
  http GET /
  if printf '%s' "$HTTP_BODY" | grep -q 'could not reach the GitHub API'; then ok=true; break; fi
  sleep 0.25
done
app_running || { ok=false; echo "  the app exited"; }
app_logs | grep -q '^poll failed: could not reach the GitHub API' || { ok=false; echo "  no 'poll failed' log line"; }
report "no network: the first poll fails, the page shows the error, the app keeps running" $ok
report "Dockhold MCP server reported on in the start log" "$(app_logs | grep -q 'Dockhold MCP server on' && echo true || echo false)"

sleep 3
info "idle memory: $(docker stats --no-stream --format '{{.MemUsage}}' "$APP")"

t0=$(date +%s%N)
docker stop -t 30 "$APP" >/dev/null
t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
report "SIGTERM: exit code $code in $ms ms (want 0, under 10000)" "$([ "$code" = 0 ] && [ "$ms" -lt 10000 ] && echo true || echo false)"

ok=true
for v in "$KEY" "$GHT" "$DHT"; do
  if app_logs | grep -qF -- "$v"; then ok=false; echo "  the log contains a secret value"; fi
done
report "no secret value in the container log" $ok

# ---------------------------------------------------------------------------
echo "==== A process the agent leaves behind never sees the GitHub token"
# One task against fakes, with no network: a fake GitHub API (tests/fake-github.mjs)
# in a second container whose loopback address the app shares, a local
# repository as the remote, and a fake agent that detaches a scanner. The
# scanner keeps forking and reads every process's environment and command
# line, looking for the token, while the app fetches and pushes with it.
# The remote's pre-receive hook holds the push open for 2 seconds, so the
# git process that carries the token lives long enough to be seen; with the
# protections taken out of the image, the scanner does find the token.
# After the task: the scanner is gone, the token was never seen, and no
# zombie is left (tini reaps what the app kills).
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
ADV=$(mktemp -d "$BASE/adv.XXXXXX")
mkdir -p "$ADV/bin" "$ADV/gh"
cat > "$ADV/bin/claude" <<'AGENT'
#!/bin/sh
cat > /dev/null
setsid sh -c 'while :; do ( for p in /proc/[0-9]*; do tr "\0" "\n" < $p/environ 2>/dev/null | grep -E "GIT_CONFIG_VALUE|GITHUB_TOKEN" >> /data/stolen; tr "\0" " " < $p/cmdline 2>/dev/null | grep -iE "github_pat|basic " >> /data/stolen; done ) & sleep 0.05; done' > /dev/null 2>&1 < /dev/null &
echo $! > /data/scanner.pid
sleep 1
echo hello > hello.txt
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Added hello.txt.","total_cost_usd":0.01}'
AGENT
docker run --rm --user 0:0 -v "$ADV:/a" --entrypoint sh "$IMAGE" -c '
  set -e
  chmod 0755 /a /a/bin /a/bin/claude
  chown 1001:1001 /a/gh
  git init -q --bare -b main /a/remote.git
  git init -q -b main /tmp/seed && cd /tmp/seed && echo seed > README.md && git add -A
  git -c user.name=t -c user.email=t@t commit -qm seed && git push -q /a/remote.git main
  printf "#!/bin/sh\nsleep 2\n" > /a/remote.git/hooks/pre-receive
  chmod 0755 /a/remote.git/hooks/pre-receive
  chown -R 1001:1001 /a/remote.git' >/dev/null
D_ADV=$(new_datadir)
docker rm -f "$APP" "$RUN-gh" >/dev/null 2>&1 || true
docker run -d --name "$RUN-gh" --network none --user 1001:1001 \
  -v "$TESTS_DIR:/tests:ro" -v "$ADV/gh:/gh" \
  --entrypoint node "$IMAGE" /tests/fake-github.mjs serve 4010 /gh/state.json >/dev/null
docker run -d --name "$APP" --network "container:$RUN-gh" \
  --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --memory-swap 1g --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e PORT=8080 -e DATA_DIR=/data -v "$D_ADV:/data" \
  -v "$ADV/bin:/fakebin:ro" -v "$ADV/remote.git:/remote.git" \
  -e PATH=/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "${APPENV[@]}" -e CODING_AGENT_TEST_GITHUB_API=http://127.0.0.1:4010 \
  -e CODING_AGENT_TEST_GIT_URL=file:///remote.git "$IMAGE" >/dev/null
ok=false
for _ in $(seq 1 120); do
  if app_logs | grep -q '^#1: pull request '; then ok=true; break; fi
  sleep 0.5
done
report "the task ran: fetch, agent, push and pull request" $ok
sleep 1
# Every process in the app, seen from a process started with docker exec
# (which is left out, as are its own children).
PROCS=$(docker exec "$APP" node -e '
const fs = require("fs");
const rows = [];
for (const n of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(n) || Number(n) === process.pid) continue;
  try {
    const s = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    const r = s.slice(s.lastIndexOf(")") + 2).split(" ");
    rows.push(`${n}:${s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"))}:${r[0]}`);
  } catch {}
}
console.log(rows.join(" "));' 2>&1)
info "processes after the task: $PROCS"
zombies=$(printf '%s' "$PROCS" | tr ' ' '\n' | grep -c ':Z$' || true)
others=$(printf '%s' "$PROCS" | tr ' ' '\n' | grep -vcE '^1:tini:|^[0-9]+:node:' || true)
report "the scanner is gone: only tini and the program are left ($others others)" "$([ "$others" = 0 ] && echo true || echo false)"
report "no zombie left ($zombies)" "$([ "$zombies" = 0 ] && echo true || echo false)"
# Control: the scanner ran and could read command lines (it records its own,
# which name what it looks for). Without this the 0 below proves nothing.
lines=$(docker exec "$APP" sh -c 'cat /data/stolen 2>/dev/null | wc -l' || echo 0)
report "control: the scanner ran and recorded $lines lines of its own" "$([ "${lines:-0}" -gt 0 ] && echo true || echo false)"
B64=$(printf 'x-access-token:%s' "$GHT" | base64 | tr -d '\n')
seen=$(docker exec "$APP" sh -c "cat /data/stolen 2>/dev/null | grep -cF -e '$GHT' -e '$B64'" || true)
report "the scanner saw the token, or its header, ${seen:-0} times (want 0)" "$([ "${seen:-0}" = 0 ] && echo true || echo false)"
t0=$(date +%s%N)
docker stop -t 30 "$APP" >/dev/null
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
report "SIGTERM after a task: exit code $code in $ms ms (want 0, under 10000)" "$([ "$code" = 0 ] && [ "$ms" -lt 10000 ] && echo true || echo false)"

# ---------------------------------------------------------------------------
echo "==== Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
