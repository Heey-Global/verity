#!/usr/bin/env bash
# post-start.sh — devcontainer lifecycle hook that runs on every start.
#
# E2: symlink Claude Code's global-state file ($HOME/.claude.json) into the
#     persistent config dir so it survives rebuilds (genuinely Claude-owned).
# E5: re-ensure settings.json REQUIRED_ALLOW (delegated to on-create.sh,
#     which is itself idempotent).
# Launch: start verity-agent-run in the BACKGROUND (D2 — devcontainer path
#     runs the same script that is PID 1 on verity-sandbox, but detached here so
#     the devcontainer's own init keeps PID 1). verity-agent-run is agent-neutral
#     (keeps the container + tmux alive; it launches NO agent — sessions run via
#     the Verity server's `docker exec`).
#
# The code review pre-push git hook is provisioned by install.sh (F10a/F10b:
# installs /opt/agent-seed/hooks/pre-push + sets core.hooksPath there globally),
# so no per-start symlink of the seed into the config dir is needed here.
#
# Home/config-dir-agnostic (D3). Idempotent — safe to re-run every start.

set -euo pipefail

# CLAUDE_CONFIG_DIR is the env var Claude Code reads to locate its config dir;
# it also doubles as the persistent, rebuild-surviving volume that other
# per-container state (e.g. the entrypoint launch log below) lives under.
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

mkdir -p "$CLAUDE_CONFIG_DIR"

# ─── E2. Claude global-state symlink ──────────────────────────────────────
# Claude stores global state at $HOME/.claude.json — one level ABOVE the
# .claude/ (config) dir. Only the config dir is persisted, so .claude.json
# would reset on rebuild. Symlink it into the persistent dir; migrate a real
# file first if one exists.
CLAUDE_STATE_REAL="$CLAUDE_CONFIG_DIR/.claude.json"
CLAUDE_STATE_LINK="$HOME/.claude.json"
if [ ! -L "$CLAUDE_STATE_LINK" ]; then
  if [ -f "$CLAUDE_STATE_LINK" ] && [ ! -e "$CLAUDE_STATE_REAL" ]; then
    mv "$CLAUDE_STATE_LINK" "$CLAUDE_STATE_REAL"
  else
    rm -f "$CLAUDE_STATE_LINK"
  fi
  ln -s "$CLAUDE_STATE_REAL" "$CLAUDE_STATE_LINK"
fi

# ─── E5. Re-ensure settings.json (delegate to on-create, idempotent) ──────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$SCRIPT_DIR/on-create.sh" ]; then
  "$SCRIPT_DIR/on-create.sh"
elif [ -f "$SCRIPT_DIR/on-create.sh" ]; then
  bash "$SCRIPT_DIR/on-create.sh"
fi

# ─── Launch verity-agent-run ───────────────────────────────────────────────
# D2: same script that is PID 1 on verity-sandbox, detached here so the
# devcontainer's init retains PID 1. Idempotent — verity-agent-run re-attaches
# to an existing tmux session rather than starting a duplicate.
#
# Verity's server-side Docker create path sets VERITY_AGENT_RUN_FOREGROUND=1
# and uses this script as the container command. In that mode the runner must
# become PID 1 so the container stays alive after lifecycle reconciliation.
#
# The log below is the entrypoint's own launch/keep-alive output — NOT Claude
# state. It lives under CLAUDE_CONFIG_DIR only because that is the persistent,
# rebuild-surviving volume; the path is incidental, not Claude-owned.
if command -v verity-agent-run >/dev/null 2>&1; then
  if [ "${VERITY_AGENT_RUN_FOREGROUND:-}" = "1" ]; then
    echo ">> post-start: exec verity-agent-run in foreground."
    exec verity-agent-run
  else
    nohup verity-agent-run >>"$CLAUDE_CONFIG_DIR/verity-agent-run.log" 2>&1 &
    echo ">> post-start: verity-agent-run launched in background (log: $CLAUDE_CONFIG_DIR/verity-agent-run.log)."
  fi
else
  echo "!! post-start: verity-agent-run not on PATH — did the Feature install step run?" >&2
  exit 1
fi
