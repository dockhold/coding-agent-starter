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
# agent must reach its model provider and GitHub, so no task runs here. The
# loop itself is tested end to end with fakes in tests/loop.test.mjs.
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
  docker rm -f "$APP" "$CURL" >/dev/null 2>&1 || true
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
# (Dockhold token, the repository's CLAUDE.md). An unknown or renamed option
# makes Claude Code exit at once with "unknown option"; a valid list makes it
# start and wait for the model provider, which this network never reaches.
# So "still running after 5 seconds, no error" is the pass.
argcheck=$(docker run --rm --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
  --network none --read-only --tmpfs /tmp -e HOME=/tmp --entrypoint node "$IMAGE" --input-type=module -e "
import { spawn } from 'node:child_process';
import * as lib from '/app/agent/lib.mjs';
const { config } = lib.parseConfig({ DATA_DIR: '/tmp', ANTHROPIC_API_KEY: 'sk-ant-api03-argcheck00', GITHUB_TOKEN: 'github_pat_argcheck000000000000', AGENT_REPO: 'octo-org/website', DOCKHOLD_API_TOKEN: 'dh_argcheck00' });
const args = lib.buildClaudeArgs(config, { issueNumber: 1, claudeMdPath: '/etc/hostname' });
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

ok=true
if docker exec --user 1001:1001 "$APP" sh -c 'cat /proc/1/environ' 2>/dev/null | tr '\0' '\n' | grep -q GITHUB_TOKEN; then
  ok=false; echo "  another uid 1001 process read the app's environment"
fi
[ "$(docker exec "$APP" sh -c 'stat -c %u /proc/1/environ')" = 0 ] || { ok=false; echo "  /proc/1/environ is not hidden from uid 1001"; }
report "the app's environment (GITHUB_TOKEN) is not readable by another uid 1001 process" $ok

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
echo "==== Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
