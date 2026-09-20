#!/bin/sh
# Install /usr/local/bin/opencode-acp, the executable every Verity component names
# when it starts an OpenCode turn.
#
# OpenCode speaks ACP as a SUBCOMMAND of its own CLI (`opencode acp`) rather than
# through a separate adapter package the way Claude and Codex do, so there is no
# `opencode-acp` executable for anything to name. Give it one: the spawn broker maps
# a fixed command name to a fixed absolute path and passes no shell, so the
# subcommand has to be baked in on this side of that boundary.
#
# Its own file rather than a block inside `install.sh` because there are two images
# that need it and only one definition of it may exist. The devcontainer Feature
# builds project Sandboxes; `deploy/Dockerfile` builds the Server image, which also
# runs the control-plane Runner — and a Runner without this wrapper fails every
# OpenCode turn at spawn with an ENOENT nobody can act on from the chat. Same
# pattern as `verity-claude-acp-harden.mjs`, which both callers already share.
#
# Root-owned and written with the interpreter's real path resolved here, not looked
# up at run time: the child's PATH comes from the broker, so a wrapper that searched
# it would answer to whatever that PATH happens to resolve first. That is about
# determinism, not integrity — the resolved target is usually the root-owned npm
# global, but on an image where opencode came from a user-writable prefix the
# wrapper faithfully execs that. Pinning the path removes the lookup, not the
# question of who owns what it finds, which is the same posture as the symlinks the
# Feature writes for the other agent CLIs.
#
# Two consequences worth stating rather than discovering. The root-owned
# `/usr/local/bin/opencode` symlink is written inside the Feature's supervisor block,
# so only supervisor images have a stable name to resolve to; elsewhere this bakes in
# whatever prefix npm used, commonly an nvm path under the dev user. And an nvm path
# is node-version-scoped: a derived layer that bumps node moves it, and the wrapper
# then fails at spawn. Neither is specific to the wrapper — the same bump takes the
# `opencode` shim the agent's own PATH resolves with it — and both are fixed the same
# way, by re-running this script against the new layer, which re-resolves the path.
#
# The subcommand is pinned here, and the trailing argv is refused on the other side:
# the broker appends a request's `args` after the executable for every agent command,
# and it rejects a non-empty argv for `opencode-acp` specifically. Measured against
# opencode 1.18.21, `opencode acp` accepts --print-logs, --log-level, --pure, --port,
# --hostname, --mdns, --mdns-domain, --cors and --cwd — no config-path flag, so argv
# cannot reach the provider or MCP configuration the way a `--config` would, but
# `--cwd` would move the working directory the broker had just validated against the
# worktree roots. Verity's OpenCode profile passes no arguments, so refusing them
# outright costs nothing; see the comment on that check in
# verity-agent-spawn-broker.mjs.
#
# Written unconditionally rather than skipped when something already answers to the
# name. The broker execs ONE absolute path, so a PATH-based "already there" check
# asks the wrong question: an `opencode-acp` further down the path satisfies it while
# leaving `/usr/local/bin/opencode-acp` missing, and a re-run after the `opencode`
# binary moved would keep a wrapper pointing at the old location. Overwriting is
# cheap and makes the file a function of this run's resolution.
#
# `LIFECYCLE_PATH`, when the caller exports it, is searched before the ambient PATH.
# The Feature sets it to the PATH an agent turn will actually have; the Server image
# has no such distinction and leaves it unset.
set -eu

OPENCODE_ACP_TMP=
cleanup_staging() {
  if [ -n "$OPENCODE_ACP_TMP" ]; then
    rm -f "$OPENCODE_ACP_TMP"
  fi
}
trap cleanup_staging EXIT

OPENCODE_BIN="$(PATH="${LIFECYCLE_PATH:-$PATH}" command -v opencode || command -v opencode || true)"
if [ -z "$OPENCODE_BIN" ] && command -v npm >/dev/null 2>&1; then
  # Ask npm where it put it before concluding it is not there. The install that
  # precedes this call succeeded — `set -e` would have stopped the build otherwise —
  # so a miss here means the global bin directory is simply not on either PATH this
  # script searched, which is a property of the image, not of the install.
  NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_GLOBAL_BIN" ] && [ -x "$NPM_GLOBAL_BIN/bin/opencode" ]; then
    OPENCODE_BIN="$NPM_GLOBAL_BIN/bin/opencode"
  fi
fi
if [ -z "$OPENCODE_BIN" ]; then
  # Fail the build, not the first turn. Nothing has a fallback for a missing
  # executable, so without this the image ships looking complete and every OpenCode
  # turn dies at spawn with an ENOENT nobody can act on from the chat.
  echo '!! verity-opencode-acp-install: opencode not found; cannot build opencode-acp' >&2
  exit 1
fi
# The path is interpolated into a shell script, so anything needing quoting is
# refused rather than escaped: `command -v` on these images returns a plain path, and
# a build that somehow produced another one should stop here rather than emit a
# wrapper whose meaning depends on getting the escaping right.
case "$OPENCODE_BIN" in
  *[!A-Za-z0-9/._-]*)
    echo "!! verity-opencode-acp-install: refusing to wrap unquotable opencode path: $OPENCODE_BIN" >&2
    exit 1
    ;;
esac
# Staged and installed rather than redirected into place: `install` sets owner and
# mode atomically, so the file is never briefly present at the umask default.
# Assigning this arms the EXIT trap for it, so a failing `install` cannot bake the
# staged copy into the layer.
OPENCODE_ACP_TMP="$(mktemp)"
printf '#!/bin/sh\nexec %s acp "$@"\n' "$OPENCODE_BIN" > "$OPENCODE_ACP_TMP"
install -o root -g root -m 0755 "$OPENCODE_ACP_TMP" /usr/local/bin/opencode-acp
rm -f "$OPENCODE_ACP_TMP"
OPENCODE_ACP_TMP=
# Deliberately left root-owned: the Feature's ownership pass hands its written paths
# to the dev user, and handing this file to the identity the agent runs as would undo
# that — the wrapper is what pins which binary an agent turn starts, so an agent that
# can rewrite it can pick that binary itself. Callers must not add it to that list.
