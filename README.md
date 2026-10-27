# Coding agent starter

This template runs Claude Code, Anthropic's coding agent, headless on
[Dockhold](https://dockhold.eu) with your own Anthropic API key. You put a
label on a GitHub issue in one repository; the agent works on the issue and
opens a pull request with its change. You review and merge.

Claude Code is made by Anthropic. This template installs it unmodified from
npm when the image is built, and you use it under Anthropic's terms
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
The template is Dockhold's, not Anthropic's.

[![Deploy on Dockhold](https://dockhold.eu/button.svg)](https://app.dockhold.eu/new?repo=https://github.com/dockhold/coding-agent-starter&name=coding-agent-starter&ref=button-coding-agent)

## Deploy

1. Make two keys first.
   * **Anthropic API key.** Create one in the
     [Claude Console](https://platform.claude.com/), for this app alone, so
     you can see its spend and revoke it on its own.
   * **GitHub token.** On GitHub, open Settings, Developer settings,
     Personal access tokens, Fine-grained tokens, and generate a new token.
     Under **Repository access** pick **Only select repositories** and choose
     the one repository the agent works on. Under **Permissions** set
     **Contents**, **Issues** and **Pull requests** to **Read and write**.
     **Metadata** is read-only and added on its own.
2. Open the [Deploy link](https://app.dockhold.eu/new?repo=https://github.com/dockhold/coding-agent-starter&name=coding-agent-starter&ref=button-coding-agent)
   and sign in if asked.
3. Under **App size**, pick **1 GB**. Under **App storage**, turn it on and
   pick **10 GB**. This app needs a paid size (see Costs).
4. Under **Environment**, in the **Secrets** list, click **New secret** for
   each value, tick it, and set its **Env var name** as below. Give the
   entries names that belong to this app, for example
   `coding-agent-anthropic-key`, because secrets are shared across your apps
   by name and two apps that share an entry would share a key.

   | Secret (your name) | Env var name | Value |
   | --- | --- | --- |
   | `coding-agent-anthropic-key` | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `coding-agent-github-token` | `GITHUB_TOKEN` | The fine-grained GitHub token |
   | `coding-agent-dockhold-token` (optional) | `DOCKHOLD_API_TOKEN` | A Dockhold API token, see Security |

5. Add a plain variable `AGENT_REPO` with the repository as `owner/name`, for
   example `octo-org/website`. The other variables are optional; see
   Settings.
6. Click **Deploy** and wait until the app shows as running. Open the app's
   address: a status page shows the repository, the label and the next poll.
7. **First task.** In the repository on GitHub, create a label named `agent`
   (Issues, Labels, New label). Open an issue that describes one change, and
   add the label. Within 10 minutes the agent picks it up, removes the label,
   and works on it. Follow it on the app's **Activity** tab. When it is done,
   a pull request is open and the issue has a comment with its link.

If the app refuses to start, its page shows one line saying what is missing.
App storage is on the app's **Size** tab; secrets are attached on its
**Variables** tab and their values are edited under **Secrets** in the
dashboard sidebar. Fix it and click **Restart**.

## How it works

1. Every `AGENT_POLL_MINUTES` the app lists the open issues in `AGENT_REPO`
   that carry `AGENT_LABEL`, oldest first. It skips pull requests, issues
   opened by anyone other than the repository's owner, members and
   collaborators, and issues it already finished.
2. It claims the oldest one by removing the label.
3. It fetches the repository's default branch into App storage, resets the
   checkout to it, and creates the branch `agent/issue-<number>`.
4. It runs Claude Code in print mode on the checkout. The prompt is the
   issue's title and body; comments are not read. A `CLAUDE.md` at the
   repository root is passed to the agent as extra instructions. The
   repository's own `.claude/` settings, hooks and `.mcp.json` are not
   loaded, because in print mode they would run without asking anyone.
5. The agent may use the tools in `AGENT_ALLOWED_TOOLS` without asking.
   Anything else that would need a yes is refused, since nobody is there to
   answer, and the agent carries on without it.
6. When the agent is done, the app commits every change as one commit named
   after the issue, pushes it to `agent/issue-<number>`, and opens a pull
   request to the default branch with the agent's summary, `Closes #<number>`
   and the run's cost. If that branch already has an open pull request, it is
   updated instead. The issue gets a comment with the link.
7. If the agent changed nothing, the issue gets a comment with its summary.
   If the run failed, the issue gets a comment with the reason, and the label
   stays off: add it again to retry.

One task runs at a time. When one finishes, the app polls again at once.
If the app is stopped in the middle of a task (a restart or a redeploy), it
stops the agent, puts the label back on the issue, and the task runs again
after the start. An issue that already got a pull request or a "no changes"
comment is not picked up again, even with the label back; open a new issue
for more work.

The branch `agent/issue-<number>` belongs to the agent: a new run for the
same issue replaces it. The app never pushes any other branch, and never the
default branch.

The status page at the app's address shows the repository, the label, the
current task, the last task and its result, the next poll and the last poll
error. `GET /health` answers `{"status":"ok"}`.

## Settings

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secret | (required) | Your Anthropic API key. The agent's model use is billed to it. |
| `GITHUB_TOKEN` | Secret | (required) | Fine-grained token for one repository: Contents, Issues and Pull requests read and write. |
| `DOCKHOLD_API_TOKEN` | Secret | (none) | Optional. Gives the agent the Dockhold MCP server. See Security. |
| `AGENT_REPO` | Variable | (required) | The repository, as `owner/name`. |
| `AGENT_LABEL` | Variable | `agent` | The label that hands an issue to the agent. |
| `AGENT_POLL_MINUTES` | Variable | `10` | Minutes between polls, 1 to 1440. |
| `AGENT_MODEL` | Variable | `sonnet` | A Claude Code model alias such as `sonnet` or `opus`, or a full model name. |
| `AGENT_ALLOWED_TOOLS` | Variable | `Read,Edit,Write,Glob,Grep,Bash` | Tools the agent may use without asking, comma-separated, in Claude Code's permission rule syntax, for example `Read,Edit,Bash(npm test *)`. |
| `AGENT_MAX_BUDGET_USD` | Variable | `2` | Spend cap per task, in US dollars. |
| `AGENT_TASK_MINUTES` | Variable | `60` | Wall-clock cap per task, 1 to 1440. The agent is stopped when it runs out. |

Variables are set on the app's **Variables** tab; change one and click
**Restart**. Dockhold sets `PORT` and `DATA_DIR` itself. Do not add them.

## Security

**An agent does what an issue says.** On a public repository anyone can open
an issue, so only issues opened by the repository's owner, members and
collaborators run. Anyone else's issue is skipped with one line in the log.
Issue comments are never read. The agent also reads your repository's files,
and text in them can steer it, so review every pull request it opens the way
you would review a stranger's.

**One repository, one token, and the agent never sees it.** The GitHub token
is fine-grained and limited to one repository. It stays in the app's own
program: the agent's environment is a fixed list that does not include it,
git gets it as a request header for one command at a time, and it is never
written to disk or put in a URL. The program and git run so that the
agent's processes cannot read their memory or environment, and anything the
agent leaves running is stopped before git uses the token. The app only
pushes `agent/issue-<number>` branches. It cannot merge; you do.

**The agent can read your Anthropic key**, and the Dockhold token when you
set one. It needs the key to work, and anything it runs (your tests, your
build, a package install) runs with the same access, with internet access.
Use a key for this app alone and revoke it if in doubt. The app refuses to
push a change that contains one of its secret values, but treat that as a
guard against accidents, not against a determined agent. With `Bash` in
`AGENT_ALLOWED_TOOLS` the agent runs any command; take `Bash` out, or allow
only the commands you want, such as `Bash(npm test *)`, to narrow it.

**The Dockhold token is optional.** Without it the agent has no Dockhold
tools. With it, the agent gets the Dockhold MCP server and can use it with
the token's permissions, on every app in your account, not only this one.
Create it under **API tokens** in the dashboard sidebar as **Read & deploy**,
and leave **Also allow writing secrets** off. Such a token lets the agent
list your apps, read their status and logs, deploy a repository as a new app,
redeploy and restart apps, set variables, resize apps and databases, and add
or remove an app's storage (removing erases its files). It cannot read or
write secrets. If the agent only needs to look, a **Read-only** token is
enough.

**The status page is public.** It shows the repository name, issue titles,
pull request links and errors, never a key or token. If those titles are
private, make the app private on its **Access** tab.

## Costs

* This app needs a paid size: 1 GB is two 512 MB units, $10 a month. See
  [pricing](https://dockhold.eu/pricing).
* You pay Anthropic directly for the agent's model use, with your own API
  key. Dockhold never pays for it, resells it or adds to it.
* Each task stops once Claude Code's own cost estimate reaches
  `AGENT_MAX_BUDGET_USD` ($2 by default). Spend can go slightly past the cap,
  and the estimate can differ from your bill; your Anthropic bill is the
  record. Each pull request and issue comment shows the run's estimate.
* Use an API key, not a Claude subscription. Anthropic's terms say
  subscription limits assume ordinary individual use; an agent that runs
  unattended belongs on an API key
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  This template reads only `ANTHROPIC_API_KEY`.

**Why 1 GB.** Waiting for the model, Claude Code uses about 140 MB and the
app's own program about 10 to 25 MB. The rest is for what the agent runs in
your repository: package installs, builds, tests. That part depends on your
repository. If a task runs out of memory, raise the size on the app's
**Size** tab.

## State and backups

App storage holds the checkout (`repo/`), the agent's home folder (`home/`)
and the task log (`tasks.jsonl`, one line per task: issue, time, outcome,
pull request, cost). App storage is not backed up. If it is lost, the app
fetches the repository again and starts a new task log. The pull requests
and the issue comments on GitHub are the durable record of what the agent
did.

## Limitations

* One task at a time. Other labelled issues wait until it finishes.
* GitHub issues only, one repository per app. For a second repository,
  deploy a second app with its own token.
* Each poll reads the oldest 100 labelled issues.
* There is no terminal into the app. You follow it on the app's **Activity**
  tab (one line per step, tool names only), in the pull requests and in the
  issue comments. The agent's full transcript is not kept.
* The agent cannot ask you a question during a task. Write what it needs in
  the issue.
* Commits are authored `Coding agent <coding-agent@localhost>`. Branch rules
  that require signed commits refuse the push.
* One running copy while App storage is attached.

## Upgrading

The `Dockerfile` pins one Claude Code version (`CLAUDE_CODE_VERSION`). Your
app stays on the version it was built with; **Restart** does not pull new
code. To move to a newer version, click **Use this template** on GitHub to
make your own copy, connect that repository in Dockhold, change
`CLAUDE_CODE_VERSION` and push. The repository's checks
(`.github/workflows/check.yml`) build the image and run the tests, including
one that fails if the new version no longer accepts an option this template
passes. A weekly check (`.github/workflows/upstream.yml`) opens an issue
when a newer Claude Code is out. See [CHANGELOG.md](CHANGELOG.md).

## License

This template's glue (Dockerfile, start script, the program in `agent/`,
tests, workflows, README) is MIT licensed, see [LICENSE](LICENSE). Claude
Code is Anthropic's software. It is not in this repository: it is installed
from npm when the image is built, under Anthropic's terms
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
