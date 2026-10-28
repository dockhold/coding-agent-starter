# Changelog

Each entry names the Claude Code version this starter pins and says whether
moving to it changes anything on App storage.

## 2.1.311 (2026-10-27)

Initial release. Pins Claude Code 2.1.311 on Node 22 (Debian bookworm slim,
pinned by digest). App storage layout: `repo/` (the checkout), `home/` (the
agent's home folder, emptied at the start of every task), `tasks.jsonl`
(the task log) and, during a task, `current.json`.
