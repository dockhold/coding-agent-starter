# Changelog

Each entry names the Claude Code version this starter pins and says whether
moving to it changes anything on App storage.

## 2.1.311 (2026-10-27)

Initial release. Pins Claude Code 2.1.311 on Node 22.23.4, the official
release checked against a pinned sha256, on Debian bookworm slim pinned by
digest, with tini as process 1. App storage layout: `repo/` (the checkout),
`home/` (the agent's home folder, emptied at the start of every task),
`tasks.jsonl` (the task log) and, during a task, `current.json`.

Image change, same version, no change on App storage: the image is built
in one stage from Debian bookworm slim instead of from the Node image. Node
is installed from its official release in the same step that sets the
modes of node, git and tini, so the image no longer copies a whole file
system from one build stage into another, a step some image builds refuse.

Prompt change, no change on App storage: the agent is told that the app
commits for it and that its reply becomes the pull request description, so
the description no longer says the agent did not commit.
