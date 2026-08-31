#!/usr/bin/env bash
# on-create.sh — one-time devcontainer lifecycle hook (runs once, at create).
#
# E1: set the git operator identity from GIT_USER_NAME / GIT_USER_EMAIL env,
#     with the GH013 loud-warn when neither is set and no prior identity
#     exists in the persistent config.
# E5: seed settings.json into $CLAUDE_CONFIG_DIR with the idempotent
#     REQUIRED_ALLOW jq merge.
#
# Home/config-dir-agnostic (D3): CLAUDE_CONFIG_DIR overrides where settings
# live; falls back to $HOME/.claude.

set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"

# ─── E1. Git operator identity ────────────────────────────────────────────
# The image is published publicly — identity must NOT be baked in. Source it
# from env (per-project docker-compose / .env). If neither is set AND no
# prior global gitconfig exists, EMIT A LOUD WARNING: Claude Code's commit-
# author logic falls back to the operator's account-email when git config is
# unset, which can be rejected with GH013 (verified-signatures) because the
# author email won't match the signing key's verified email.
if [ -n "${GIT_USER_NAME:-}" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

if [ -z "${GIT_USER_EMAIL:-}" ] && [ -z "$(git config --global --get user.email || true)" ]; then
  printf '\033[33m%s\033[0m\n' \
    "!! WARN: GIT_USER_EMAIL env var unset AND no global user.email configured." >&2
  printf '\033[33m%s\033[0m\n' \
    "!!       Claude Code commits will fall back to the operator's account-email — which may NOT match" >&2
  printf '\033[33m%s\033[0m\n' \
    "!!       the GitHub-verified signing-key email and will be rejected with GH013 on push." >&2
  printf '\033[33m%s\033[0m\n' \
    "!!       Fix: set GIT_USER_EMAIL / GIT_USER_NAME in the container environment." >&2
fi

# ─── E5. Seed settings.json (REQUIRED_ALLOW jq merge, idempotent) ─────────
# Claude Code's own settings.json: a container-local allow-list so the agent
# doesn't trip permission prompts for the common worktree / read-only git+tmux
# commands.
#
# `Read(<CLAUDE_CONFIG_DIR>/inbox/**)`: trust-anchor for handoff files, which
# are written exclusively by authenticated exec — the path is curated, not
# externally user-supplied.
REQUIRED_ALLOW=(
  "Bash(wt:*)"
  "Bash(wt)"
  "Bash(git worktree:*)"
  "Bash(git status:*)"
  "Bash(git branch:*)"
  "Bash(git diff:*)"
  "Bash(git log:*)"
  "Bash(tmux list-windows:*)"
  "Read(${CLAUDE_CONFIG_DIR}/inbox/**)"
)

if ! command -v jq >/dev/null 2>&1; then
  echo "!! on-create: jq not found — cannot seed settings.json. Ensure the Feature's apt step ran." >&2
  exit 1
fi

mkdir -p "$CLAUDE_CONFIG_DIR"

if [ ! -f "$SETTINGS" ]; then
  CONTAINER_ALLOW=$(jq -n \
    --argjson allow "$(printf '%s\n' "${REQUIRED_ALLOW[@]}" | jq -R . | jq -s .)" \
    '{permissions: {allow: $allow}}')
  echo "$CONTAINER_ALLOW" > "$SETTINGS"
fi

# Idempotent ensure-required-allows: append any missing entries, preserving
# user edits. Validate JSON once up front and bail on corruption so the merge
# loop can't silently no-op on a truncated file.
if [ -f "$SETTINGS" ]; then
  if ! jq empty "$SETTINGS" >/dev/null 2>&1; then
    echo "!! $SETTINGS is not valid JSON — refusing to ensure REQUIRED_ALLOW entries." >&2
    echo "!! Inspect / repair the file (likely truncated by a crashed write) and restart." >&2
    exit 1
  fi
  for entry in "${REQUIRED_ALLOW[@]}"; do
    if ! jq -e --arg e "$entry" '.permissions.allow // [] | index($e)' "$SETTINGS" >/dev/null 2>&1; then
      tmpfile="$(mktemp)"
      # shellcheck disable=SC2064  # intentional early-expand of $tmpfile
      trap "rm -f '$tmpfile'" EXIT
      if ! jq --arg e "$entry" \
        '.permissions.allow = ((.permissions.allow // []) + [$e])' \
        "$SETTINGS" > "$tmpfile"; then
        echo "!! jq failed adding '$entry' to $SETTINGS — leaving file unchanged." >&2
        rm -f "$tmpfile"
        trap - EXIT
        exit 1
      fi
      mv "$tmpfile" "$SETTINGS"
      trap - EXIT
    fi
  done
fi

echo ">> on-create: git identity + settings.json seeded ($SETTINGS)."
