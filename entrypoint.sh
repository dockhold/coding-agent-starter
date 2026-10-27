#!/bin/sh
# Start script for the coding agent starter on Dockhold.
#
# Dockhold hands this app a port (PORT) and, when App storage is turned on, a
# folder that survives restarts (DATA_DIR). This script checks that folder
# and hands over to the agent program, which checks every other setting.
# Every check fails with one line and exit code 1. Dockhold shows that line
# on the app page, so the line is the whole error message.
set -eu

# App storage.
#
# The checkout, the agent's home folder and the task log live on App
# storage. Without it they would be gone after every restart, and an issue
# that was being worked on could be lost, so the app refuses to start. There
# is no fallback to a folder inside the image, on purpose.
storage_missing() {
  echo "This app keeps its work on App storage. Turn on App storage in the Size tab; the app restarts on its own." >&2
  exit 1
}
[ -n "${DATA_DIR:-}" ] || storage_missing
case "$DATA_DIR" in /*) ;; *) storage_missing ;; esac
[ -d "$DATA_DIR" ] || storage_missing
[ -w "$DATA_DIR" ] || storage_missing
# Permission bits can say "writable" on a folder that is mounted read-only.
# Creating and removing a file is the only check that cannot be fooled.
probe="$DATA_DIR/.dockhold-write-check.$$"
( : > "$probe" ) 2>/dev/null || storage_missing
rm -f "$probe"

# The agent's home folder: Claude Code keeps its settings there.
mkdir -p "$DATA_DIR/home"
chmod 0700 "$DATA_DIR/home"
export HOME="$DATA_DIR/home"

# exec makes the program the main process, so the stop signal reaches it
# directly and it can stop the agent and put the issue label back.
exec node /app/agent/main.mjs
