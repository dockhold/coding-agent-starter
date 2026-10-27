# Coding agent starter for Dockhold.
#
# Runs Claude Code, Anthropic's coding agent, headless with your own API key.
# Claude Code is Anthropic's software, installed here at build time from npm
# under Anthropic's terms (see README). This repo holds only the glue: a
# start script and a small Node program with no npm dependencies.
#
# Upgrading: change CLAUDE_CODE_VERSION. The weekly upstream check opens an
# issue when a newer version is out. The build fails if the installed CLI
# does not report the pinned version.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
ARG CLAUDE_CODE_VERSION=2.1.311

# git for the checkout, ca-certificates for HTTPS to GitHub and Anthropic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version | grep -F "${CLAUDE_CODE_VERSION}"

# The processes that hold your GitHub token are node (this starter's
# program) and git (fetch and push). Both binaries are made executable but
# not readable for user 1001. Linux marks a process started from a binary
# its user cannot read as not dumpable, which hides that process's
# environment and memory (/proc/<pid>/environ, /proc/<pid>/mem) from every
# other process of the same user, the agent included. Running node and git
# is unaffected. Claude Code is its own native binary and is left as it is.
RUN chmod 0711 /usr/local/bin/node /usr/bin/git \
 && find /usr/lib/git-core -maxdepth 1 -type f -perm -u+x -exec chmod 0711 {} +

COPY agent /app/agent
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh /app/agent \
 && chmod 0644 /app/agent/*.mjs

# One flat layer. Changing node's mode above copies the 120 MB binary into a
# new layer; copying the finished file system into an empty image keeps a
# single copy, so the image is no bigger than the parts it is made of.
FROM scratch
COPY --from=build / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1001:1001
# The start script execs the program, so it is the main process and gets the
# stop signal directly.
ENTRYPOINT ["/app/entrypoint.sh"]
