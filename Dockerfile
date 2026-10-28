# Coding agent starter for Dockhold.
#
# Runs Claude Code, Anthropic's coding agent, headless with your own API key.
# Claude Code is Anthropic's software, installed here at build time from npm
# under Anthropic's terms (see README). This repo holds only the glue: a
# start script and a small Node program with no npm dependencies.
#
# Upgrading Claude Code: change CLAUDE_CODE_VERSION. The weekly upstream
# check opens an issue when a newer version is out. The build fails if the
# installed CLI does not report the pinned version.
#
# Upgrading Node: change NODE_VERSION and NODE_SHA256 together. The sha256 is
# the node-v<version>-linux-x64.tar.gz line of SHASUMS256.txt on
# https://nodejs.org/dist/v<version>/. A wrong or stale sha256 fails the
# build. That is the point.

ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

FROM ${DEBIAN_IMAGE}
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
ARG CLAUDE_CODE_VERSION=2.1.311

# One step, so every file lands in the image once, with its final mode:
#
# * git for the checkout, ca-certificates for HTTPS to GitHub and Anthropic,
#   tini as the main process: it reaps every process the agent leaves behind
#   once the app has killed it, so none piles up during months of running,
#   and it passes the stop signal on to the app.
# * Node 22, the official release, checked against the pinned sha256. Of
#   the OpenSSL headers for twenty platforms only this one's are kept, as in
#   the official Node image.
# * The processes that hold your GitHub token are tini (it starts with the
#   app's environment), node (this starter's program) and git (fetch and
#   push). All three are made executable but not readable for user 1001.
#   Linux marks a process started from a binary its user cannot read as not
#   dumpable, which hides that process's environment and memory
#   (/proc/<pid>/environ, /proc/<pid>/mem) from every other process of the
#   same user, the agent included. Running them is unaffected. Changing a
#   mode in a later step would store a second copy of the file, so it
#   happens here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl \
 && curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE \
 && rm /tmp/node.tar.gz \
 && find /usr/local/include/node/openssl/archs -mindepth 1 -maxdepth 1 ! -name linux-x86_64 -exec rm -rf {} + \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && node --version | grep -Fx "v${NODE_VERSION}" \
 && chmod 0711 /usr/bin/tini /usr/local/bin/node /usr/bin/git \
 && find /usr/lib/git-core -maxdepth 1 -type f -perm -u+x -exec chmod 0711 {} +

# Claude Code is its own native binary and keeps its normal mode.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}"

COPY agent /app/agent
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh /app/agent \
 && chmod 0644 /app/agent/*.mjs

USER 1001:1001
# tini is process 1. The start script execs the program, so tini's one child
# is the program itself and the stop signal reaches it directly.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
