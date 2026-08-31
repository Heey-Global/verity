#!/usr/bin/env bash
# verity-sandbox-toolkit Feature installer — the SINGLE SOURCE OF TRUTH for Verity
# agent-container tooling. Runs as root at devcontainer-feature install time
# (and, identically, from deploy/verity-sandbox.Dockerfile's RUN — same script,
# same result). Home-agnostic: everything is written under the resolved
# $_REMOTE_USER_HOME, never a hard-coded /home/dev.
#
# Options arrive as devcontainer-injected env vars (uppercased option ids):
#   TZ, INSTALLCLAUDE, CLAUDECODEVERSION, GHVERSION, DOPPLERVERSION,
#   GITLEAKSVERSION, SSHSIGNINGKEY, SSHSIGNINGKEYPRIVATE, CLAUDECONFIGDIR,
#   HOOKSPATH
# Each falls back to the pinned default (kept in lock-step with
# devcontainer-feature.json) so the script is runnable standalone too.
#
# The fixed-neutral-path options (ghTokenFile, sshSigningKey, …) are RUNTIME
# bind targets. install.sh only writes CONFIG that references them; it never
# creates the secrets themselves — the provisioner (PR-B) binds real files
# there at container start.

set -euo pipefail

# Resolved up here because two sections need it: F10 installs the helper scripts
# from here, and the Claude ACP hardening below runs one of them straight out of
# the Feature dir.
FEATURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Apply the Feature option to the container itself. Merely receiving `TZ` during
# this build step does not persist it into later shells or processes.
TIMEZONE="${TZ:-UTC}"
[ -f "/usr/share/zoneinfo/$TIMEZONE" ] || {
  echo "!! verity-sandbox-toolkit: unknown timezone '$TIMEZONE'." >&2
  exit 1
}
ln -snf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime
printf '%s\n' "$TIMEZONE" > /etc/timezone

# ─── Version pins (defaults mirror devcontainer-feature.json) ─────────────
# renovate: datasource=npm depName=@anthropic-ai/claude-code
CLAUDE_CODE_VERSION="${CLAUDECODEVERSION:-2.1.241}"
# renovate: datasource=npm depName=@agentclientprotocol/claude-agent-acp
CLAUDE_ACP_VERSION="${CLAUDEACPVERSION:-0.70.0}"
# renovate: datasource=github-releases depName=cli/cli
GH_VERSION="${GHVERSION:-2.98.0}"
# renovate: datasource=github-releases depName=DopplerHQ/cli
DOPPLER_VERSION="${DOPPLERVERSION:-3.76.5}"
# renovate: datasource=github-releases depName=gitleaks/gitleaks
GITLEAKS_VERSION="${GITLEAKSVERSION:-8.30.1}"
# renovate: datasource=npm depName=@openai/codex
CODEX_VERSION="${CODEXVERSION:-0.149.0}"
# renovate: datasource=npm depName=@agentclientprotocol/codex-acp
CODEX_ACP_VERSION="${CODEXACPVERSION:-1.6.2}"
# renovate: datasource=npm depName=opencode-ai
OPENCODE_VERSION="${OPENCODEVERSION:-1.18.21}"
# renovate: datasource=npm depName=@earendil-works/pi-coding-agent
PI_VERSION="${PIVERSION:-0.84.2}"
RUNNER_UID="${RUNNERUID:-1101}"
RUNTIME_GID="${RUNTIMEGID:-1101}"
INSTALL_RUNNER_SUPERVISOR="${INSTALLRUNNERSUPERVISOR:-false}"
case "$RUNNER_UID" in
  ''|*[!0-9]*)
    echo "!! runnerUid/runtimeGid must be numeric" >&2
    exit 1
    ;;
esac
case "$RUNTIME_GID" in
  ''|*[!0-9]*)
    echo "!! runnerUid/runtimeGid must be numeric" >&2
    exit 1
    ;;
esac

INSTALL_CLAUDE="${INSTALLCLAUDE:-true}"
INSTALL_CLAUDE_ACP="$INSTALL_CLAUDE"
INSTALL_CODEX="${INSTALLCODEX:-true}"
INSTALL_CODEX_ACP="$INSTALL_CODEX"
INSTALL_OPENCODE="${INSTALLOPENCODE:-true}"
INSTALL_PI="${INSTALLPI:-true}"
TZ_VALUE="${TZ:-UTC}"

# Fixed-neutral runtime bind paths (config references only).
SSH_SIGNING_KEY="${SSHSIGNINGKEY:-/run/verity/ssh/id_ed25519.pub}"
SSH_SIGNING_KEY_PRIVATE="${SSHSIGNINGKEYPRIVATE:-/run/verity/ssh/id_ed25519}"
CLAUDE_CONFIG_DIR_VALUE="${CLAUDECONFIGDIR:-/run/verity/claude}"
HOOKS_PATH="${HOOKSPATH:-/opt/agent-seed/hooks}"

# ─── Resolve target user + home (home-agnostic, D3) ───────────────────────
# _REMOTE_USER / _REMOTE_USER_HOME are injected by the devcontainer feature
# runtime. Standalone (verity-sandbox RUN) sets them explicitly. Fall back to
# root, and resolve home from passwd if _REMOTE_USER_HOME is unset.
REMOTE_USER="${_REMOTE_USER:-root}"
if [ -n "${_REMOTE_USER_HOME:-}" ]; then
  REMOTE_HOME="$_REMOTE_USER_HOME"
elif [ "$REMOTE_USER" = "root" ]; then
  REMOTE_HOME="/root"
else
  REMOTE_HOME="$(getent passwd "$REMOTE_USER" | cut -d: -f6)"
  REMOTE_HOME="${REMOTE_HOME:-/home/$REMOTE_USER}"
fi

echo ">> verity-sandbox-toolkit: installing for user '$REMOTE_USER' (home '$REMOTE_HOME')"

# Dedicated supervisor identity (ADR 0006 D1). The agent user never receives
# this UID or the verity-runtime GID, so project code cannot forge event/control
# files in the protected runtime mount. Runtime activation remains opt-in until
# remote attach and production routing land.
if [ "$INSTALL_RUNNER_SUPERVISOR" = 'true' ] && command -v groupadd >/dev/null 2>&1 && command -v useradd >/dev/null 2>&1; then
  if getent group "$RUNTIME_GID" >/dev/null 2>&1; then
    [ "$(getent group "$RUNTIME_GID" | cut -d: -f1)" = 'verity-runtime' ] || {
      echo "!! runtime GID $RUNTIME_GID is already owned by another group" >&2
      exit 1
    }
  else
    groupadd --gid "$RUNTIME_GID" verity-runtime
  fi
  if getent passwd "$RUNNER_UID" >/dev/null 2>&1; then
    runner_passwd="$(getent passwd "$RUNNER_UID")"
    [ "$(printf '%s' "$runner_passwd" | cut -d: -f1)" = 'verity-runner' ] || {
      echo "!! runner UID $RUNNER_UID is already owned by another user" >&2
      exit 1
    }
    [ "$(printf '%s' "$runner_passwd" | cut -d: -f4)" = "$RUNTIME_GID" ] || {
      echo "!! existing verity-runner does not use runtime GID $RUNTIME_GID" >&2
      exit 1
    }
  else
    useradd --uid "$RUNNER_UID" --gid "$RUNTIME_GID" --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin verity-runner
  fi
elif [ "$INSTALL_RUNNER_SUPERVISOR" = 'true' ]; then
  echo "!! groupadd/useradd unavailable; restart-surviving Runner mode cannot be enabled." >&2
  exit 1
fi

# Track every path we write so the chown at the end is precise (never a
# giant recursive tree over the whole home).
WRITTEN_PATHS=()

ARCH="$(dpkg --print-architecture 2>/dev/null)" || {
  echo "!! verity-sandbox-toolkit: could not determine the Debian architecture." >&2
  exit 1
}
if [ "$ARCH" != "amd64" ] && [ "$ARCH" != "arm64" ]; then
  echo "!! verity-sandbox-toolkit: unsupported architecture '$ARCH'." >&2
  exit 1
fi
case "$ARCH" in
  amd64)
    GH_ARCH=amd64; DOPPLER_ARCH=amd64; GITLEAKS_ARCH=x64
    GH_SHA256=3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de
    DOPPLER_SHA256=1b2f412d984920d665daf233ab6c15b364df9339b5c5b5224d5e8ee4e0a70154
    GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  arm64)
    GH_ARCH=arm64; DOPPLER_ARCH=arm64; GITLEAKS_ARCH=arm64
    GH_SHA256=cf689084f3a3618f7eae4a2420d335d74626d65f5e594b9828d125d69f800d86
    DOPPLER_SHA256=567f051c4c334b79a37ee44c9373671c451dd8a4945ed49288a8f3fd0b73ec89
    GITLEAKS_SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
    ;;
esac

# ─── F1. apt packages ─────────────────────────────────────────────────────
# Core tooling shared by every agent container. GUARD on apt-get so a
# non-Debian base warns + continues rather than hard-failing.
#
# `bubblewrap` is absent ON PURPOSE and must stay absent. Codex logs
# "Codex could not find bubblewrap on PATH." at ERROR level on every start,
# which reads like a missing prerequisite and is not one: Verity always runs
# Codex with --dangerously-bypass-approvals-and-sandbox / sandbox
# 'danger-full-access', so it never uses bwrap. That line has already once been
# mistaken for the cause of a turn that died on a broken egress route.
#
# Installing the package WOULD silence that line — and would trade it for a
# worse failure mode. It switches on Claude's inner bwrap sandbox, which spawns
# before every command wherever bwrap is on PATH, regardless of the IS_SANDBOX=1
# hint. That sandbox is redundant: this container already IS the isolation
# boundary — and it does not stay merely redundant.
# An inner bwrap sandbox either fails the unprivileged user-namespace clone or
# loses the container's injected /etc/resolv.conf, taking DNS with it. In a
# Verity-provisioned sandbox only the second one bites: that container is started
# with seccomp/AppArmor unconfined precisely so the clone succeeds. So installing
# bubblewrap here does not reproduce the loud failure — it buys the quiet one.
# See the env and securityOpt comments in packages/server/src/provisioner.ts.
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  APT_PACKAGES=(tmux git curl ca-certificates less ripgrep gnupg wget jq openssh-client openssl util-linux)
  apt-get update
  apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
  rm -rf /var/lib/apt/lists/*
else
  echo "!! verity-sandbox-toolkit: apt-get not found — skipping OS package install." >&2
  echo "!!                 Ensure tmux/git/curl/jq/openssh-client/openssl exist on this base." >&2
fi

# Extracted release tarballs carry the ownership their publisher's CI recorded
# (both gh and doppler ship uid/gid 1001), and GNU tar RESTORES it when it runs
# as root — which is exactly how this Feature runs. A non-root-owned executable
# is one the agent's own user could replace between an operator's approval and
# the exec, so `validateTrustedCliExecutable` in verity-agent-spawn-broker.mjs
# refuses to run it with an injected secret. Left as published, these binaries
# are silently unusable through `verity_secret_run`. Extract without the
# archive's ownership and pin it to root explicitly — `--no-same-owner` alone
# depends on the tar implementation, the chown does not.
install_trusted_cli_ownership() {
  chown root:root "$1"
  chmod 0755 "$1"
}

# Release tarballs are staged to disk before they are unpacked, never piped
# straight into `tar`. A retry restarts the transfer from byte zero, so through a
# pipe the decompressor has already been fed the truncated prefix of the attempt
# that died and the next one arrives behind it — the pipeline fails on
# "unexpected end of file" however many attempts were left, which is how one
# dropped connection to the release CDN takes the whole image build with it.
# Downloading to a file makes those retries mean what they say, and `tar` only
# ever sees a transfer that finished. `--retry-all-errors` is what covers the
# case actually seen in CI: a connection that dies mid-body (curl exit 56) is
# not in curl's default transient set. It also retries a 404, so a bad version
# pin takes the full backoff before it fails — a slower no, still a no.
DOWNLOAD_DIR="$(mktemp -d)"
# One EXIT trap owns every staged temp path this script creates, rather than each
# use site cleaning up after itself: under `set -e` any failing command between the
# stage and its `rm` skips that `rm`, and what leaks is baked into the image layer.
# Later stages announce themselves by setting their variable; it starts empty because
# `set -u` makes an unset one fail the trap.
OPENCODE_ACP_TMP=
cleanup_staging() {
  rm -rf "$DOWNLOAD_DIR"
  if [ -n "$OPENCODE_ACP_TMP" ]; then
    rm -f "$OPENCODE_ACP_TMP"
  fi
}
trap cleanup_staging EXIT
fetch_release_tarball() {
  local url="$1" dest="$2"
  curl -fsSL --retry 5 --retry-delay 3 --retry-connrefused --retry-all-errors \
    -o "$dest" "$url"
}
verify_release_tarball() {
  local expected="$1" archive="$2"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --strict
}

# ─── F2. GitHub CLI (pinned tarball) ──────────────────────────────────────
# The tarball nests the binary under its architecture-specific directory.
echo ">> verity-sandbox-toolkit: installing gh $GH_VERSION"
install -d /usr/local/lib/verity
fetch_release_tarball \
  "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
  "$DOWNLOAD_DIR/gh.tar.gz"
verify_release_tarball "$GH_SHA256" "$DOWNLOAD_DIR/gh.tar.gz"
tar --no-same-owner -xzf "$DOWNLOAD_DIR/gh.tar.gz" -C /usr/local/lib/verity \
  --strip-components=2 "gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh"
mv /usr/local/lib/verity/gh /usr/local/lib/verity/gh-real
install_trusted_cli_ownership /usr/local/lib/verity/gh-real
/usr/local/lib/verity/gh-real --version

# ─── F3. Doppler CLI (pinned tarball) ─────────────────────────────────────
# The tarball ships `doppler` at its root.
echo ">> verity-sandbox-toolkit: installing doppler $DOPPLER_VERSION"
fetch_release_tarball \
  "https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_VERSION}/doppler_${DOPPLER_VERSION}_linux_${DOPPLER_ARCH}.tar.gz" \
  "$DOWNLOAD_DIR/doppler.tar.gz"
verify_release_tarball "$DOPPLER_SHA256" "$DOWNLOAD_DIR/doppler.tar.gz"
tar --no-same-owner -xzf "$DOWNLOAD_DIR/doppler.tar.gz" -C /usr/local/bin doppler
install_trusted_cli_ownership /usr/local/bin/doppler
doppler --version

# ─── F3b. gitleaks (pinned tarball) ───────────────────────────────────────
# Secret-scan engine behind the agent-seed pre-commit/pre-push gates. The org
# ruleset runs gitleaks in CI for main/staging, but that only reports a secret
# AFTER it reached GitHub — by then the credential is burned and must be rotated.
# Scanning in the sandbox keeps it local. The tarball ships `gitleaks` at its
# root; releases are tagged `v<version>` while the pin stays bare, matching the
# gh/doppler managers. gitleaks names its amd64 asset `linux_x64`.
echo ">> verity-sandbox-toolkit: installing gitleaks $GITLEAKS_VERSION"
fetch_release_tarball \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" \
  "$DOWNLOAD_DIR/gitleaks.tar.gz"
verify_release_tarball "$GITLEAKS_SHA256" "$DOWNLOAD_DIR/gitleaks.tar.gz"
tar --no-same-owner -xzf "$DOWNLOAD_DIR/gitleaks.tar.gz" -C /usr/local/bin gitleaks
install_trusted_cli_ownership /usr/local/bin/gitleaks
gitleaks version

# Harden npm before the first root-owned global install. Individual pinned agent
# packages opt into lifecycle scripts explicitly below when their installation
# requires them; unreviewed installs inherit the fail-closed defaults.
if command -v npm >/dev/null 2>&1; then
  NPM_GLOBALCONFIG="$(npm config get globalconfig)"
  [ -n "$NPM_GLOBALCONFIG" ] && [ "$NPM_GLOBALCONFIG" != "undefined" ] || {
    echo "!! verity-sandbox-toolkit: could not resolve npm globalconfig path." >&2
    exit 1
  }
  mkdir -p "$(dirname "$NPM_GLOBALCONFIG")"
  printf '%s\n' 'ignore-scripts=true' 'allow-git=none' 'save-exact=true' 'fund=false' > "$NPM_GLOBALCONFIG"
  chmod 0644 "$NPM_GLOBALCONFIG"
fi

# ─── F4. Claude Code CLI (optional, pinned) ───────────────────────────────
# Needs node on PATH — this Feature declares installsAfter the node Feature.
if [ "$INSTALL_CLAUDE" = "true" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo ">> verity-sandbox-toolkit: installing @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
    npm install -g --ignore-scripts=false "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
  else
    echo "!! verity-sandbox-toolkit: installClaude=true but npm not on PATH — skipping claude-code." >&2
    echo "!!                 Add the node Feature (installsAfter) or a node base image." >&2
  fi
fi

# ACP is a separately pinned transport adapter. It still delegates model/tool
# execution to the globally pinned Claude Code CLI above.
if [ "$INSTALL_CLAUDE_ACP" = "true" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo ">> verity-sandbox-toolkit: installing @agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION"
    npm install -g --ignore-scripts=false "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}"
    # Upstream (through 0.66.0) renders tool-call titles from unvalidated model
    # input; one wrong-typed field throws, kills the agent process, and — since
    # loadSession replays history through the same renderer — bricks the session
    # for good. Harden the install, don't just pin it. The script no-ops on a
    # fixed upstream and fails the build if it can no longer be applied, so this
    # cannot silently lapse on a Renovate bump. See docs/adr/0012.
    node "$FEATURE_DIR/bin/verity-claude-acp-harden.mjs"
    node "$FEATURE_DIR/bin/verity-claude-acp-lifecycle.mjs"
  else
    echo "!! verity-sandbox-toolkit: installClaudeAcp=true but npm not on PATH — skipping Claude ACP." >&2
  fi
fi

# ─── F4b. Disable the Claude Code runtime auto-updater (managed setting) ───
# The global npm install is root-owned, so the in-container auto-updater — which
# runs as the unprivileged user — can't write and fails on every launch with
# `no_permissions`. It also fights the Renovate-pinned build-time version,
# undermining reproducibility. Renovate owns the pin (renovate.json); the
# runtime updater is disabled fleet-wide.
#
# Do this HERE, not via the manifest's `containerEnv` / a Dockerfile `ENV`: this
# install.sh is the single source BOTH consumers run — the baked verity-sandbox
# (`RUN install.sh`) and user devcontainers (`--additional-features`). By
# contrast `containerEnv` is honoured ONLY on the devcontainer-CLI path, so it
# would silently miss the baked base. A system-level managed setting is read at
# highest precedence, is root-owned (users can't re-enable it), and lives
# outside CLAUDE_CONFIG_DIR so the runtime config bind-mount never shadows it.
if [ "$INSTALL_CLAUDE" = "true" ]; then
  echo ">> verity-sandbox-toolkit: disabling Claude Code auto-updater via managed settings"
  mkdir -p /etc/claude-code
  printf '{\n  "autoUpdates": false\n}\n' > /etc/claude-code/managed-settings.json
  chmod 0644 /etc/claude-code/managed-settings.json
fi

# ─── F4c. Additional agent CLIs (optional, pinned) ────────────────────────
# codex / opencode / pi were previously provided only by the legacy dev-base
# image. Ported here so verity-sandbox-toolkit is the SINGLE source for every agent CLI
# as dev-base is retired. Same model as claude: pinned + Renovate-driven bumps
# (renovate.json); no runtime self-update — new versions arrive via image
# rebuild / Feature republish, never in-place (which would collide with the F5
# `ignore-scripts` hardening anyway).
if command -v npm >/dev/null 2>&1; then
  if [ "$INSTALL_CODEX" = "true" ]; then
    echo ">> verity-sandbox-toolkit: installing @openai/codex@$CODEX_VERSION"
    npm install -g --ignore-scripts=false "@openai/codex@${CODEX_VERSION}"
  fi
  # ACP is a separately pinned transport adapter. It ships its own @openai/codex
  # dependency, so the spawn broker pins CODEX_PATH to the root-owned binary
  # installed above — otherwise two Codex versions run in the same image.
  if [ "$INSTALL_CODEX_ACP" = "true" ]; then
    echo ">> verity-sandbox-toolkit: installing @agentclientprotocol/codex-acp@$CODEX_ACP_VERSION"
    npm install -g --ignore-scripts=false "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}"
  fi
  if [ "$INSTALL_OPENCODE" = "true" ]; then
    echo ">> verity-sandbox-toolkit: installing opencode-ai@$OPENCODE_VERSION"
    npm install -g --ignore-scripts=false "opencode-ai@${OPENCODE_VERSION}"
    # opencode's updater can target a user-writable dir (unlike the root-owned
    # npm global), so root-ownership alone doesn't stop it. Pin it off via its
    # own config file — persists across both consume paths, chowned to the user
    # by the F11 ownership pass (WRITTEN_PATHS).
    mkdir -p "$REMOTE_HOME/.config/opencode"
    printf '{\n  "autoupdate": false\n}\n' > "$REMOTE_HOME/.config/opencode/opencode.json"
    WRITTEN_PATHS+=("$REMOTE_HOME/.config/opencode")
  fi
  if [ "$INSTALL_PI" = "true" ]; then
    echo ">> verity-sandbox-toolkit: installing @earendil-works/pi-coding-agent@$PI_VERSION"
    npm install -g --ignore-scripts=false "@earendil-works/pi-coding-agent@${PI_VERSION}"
  fi
else
  echo "!! verity-sandbox-toolkit: npm not on PATH — skipping codex/opencode/pi." >&2
  # Make the skip real state, not just a message: F10 below still reads
  # INSTALL_OPENCODE, and left at `true` it would treat a CLI that was never
  # installed as one that should be there and abort the build.
  #
  # A skip rather than an abort, deliberately. This Feature is installed into
  # project devcontainers as well as the base image, and a project whose image is
  # not Node-based has no npm while still carrying this option's `true` default —
  # failing here would break every such devcontainer over agents it was never
  # going to run. So F10's fail-closed guarantee is scoped to what it can actually
  # speak to: npm was there, the install ran, and the binary is still missing.
  # An image with no npm at all is an image without any agent CLI — codex and
  # claude-acp are equally absent — and that is a pre-existing property of such
  # images, not something the opencode wrapper can repair.
  #
  # Only INSTALL_OPENCODE is read past this point; the other three flags would be
  # dead assignments and are left alone.
  INSTALL_OPENCODE=false
fi

# ─── F5. npm supply-chain hardening ───────────────────────────────────────
# Baked global npm defaults for every install/ci/npx in this container,
# unless a project-root .npmrc opts back in (project .npmrc > globalconfig).
#
#   ignore-scripts=true  Closes the biggest npm supply-chain vector —
#                        malicious pre/post-install lifecycle scripts
#                        (ua-parser-js 2021, event-stream 2018, …).
#                        Packages that legitimately need postinstall
#                        (esbuild, sharp, prisma, husky) opt back in via a
#                        project .npmrc `ignore-scripts=false` or
#                        `npm rebuild <pkg>`.
#   allow-git=none       Forbids git:// / github: package specs — blocks
#                        registry-bypass via a malicious transitive git-dep.
#   save-exact=true      `npm install <pkg>` writes "1.2.3" not "^1.2.3";
#                        Renovate drives bumps, floating ranges only widen
#                        the window. (npm ci is unaffected — reads the lock.)
#   fund=false           Suppresses the funding footer — CI log noise only.
#
# The globalconfig path is $prefix/etc/npmrc, NOT /etc/npmrc — writing the
# wrong file is a SILENT no-op (defaults stay unsafe). Resolve it at install
# time via `npm config get globalconfig` instead of hard-coding, then re-run
# the four `npm config get` asserts so a future prefix move fails loudly.
if command -v npm >/dev/null 2>&1; then
  echo ">> verity-sandbox-toolkit: hardening npm global config"
  NPM_GLOBALCONFIG="$(npm config get globalconfig)"
  if [ -z "$NPM_GLOBALCONFIG" ] || [ "$NPM_GLOBALCONFIG" = "undefined" ]; then
    echo "!! verity-sandbox-toolkit: could not resolve npm globalconfig path — refusing to guess." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$NPM_GLOBALCONFIG")"
  {
    echo "ignore-scripts=true"
    echo "allow-git=none"
    echo "save-exact=true"
    echo "fund=false"
  } > "$NPM_GLOBALCONFIG"
  chmod 0644 "$NPM_GLOBALCONFIG"
  test "$(npm config get ignore-scripts)" = "true"
  test "$(npm config get allow-git)" = "none"
  test "$(npm config get save-exact)" = "true"
  test "$(npm config get fund)" = "false"
  echo ">> verity-sandbox-toolkit: npm hardening verified at $NPM_GLOBALCONFIG"
else
  echo "!! verity-sandbox-toolkit: npm not on PATH — skipping npm hardening." >&2
fi

# ─── F6. git config (into the target user's ~/.gitconfig) ─────────────────
# D4: NO credential helper, NO GH_TOKEN profile hook. Transport auth is the
# agent-seed `gh` wrapper / provisioner's concern. We keep ONLY the insteadOf
# HTTPS rewrites (so SSH-form origins route through HTTPS) plus SSH signing.
GITCONFIG="$REMOTE_HOME/.gitconfig"
gc() { git config --file "$GITCONFIG" "$@"; }

gc --add safe.directory /work
gc --add safe.directory '/work/.worktrees/*'
gc gpg.format ssh
gc user.signingkey "$SSH_SIGNING_KEY"
gc commit.gpgsign true
gc tag.gpgsign true
# `--replace-all` on the first of the pair, not a plain set: this Feature is
# baked into `verity-sandbox` AND injected again on top of any devcontainer that
# builds FROM it, so install.sh runs twice on those images. The second run met a
# key that already carried both values, and a plain `git config` refuses that
# with "cannot overwrite multiple values with a single value" — which failed the
# whole Feature (exit 5) and left the repo with no sandbox at all. Replace-all
# then --add is idempotent: it lands on exactly these two values from any
# starting state, including none.
gc --replace-all url."https://github.com/".insteadOf "git@github.com:"
gc --add url."https://github.com/".insteadOf "ssh://git@github.com/"
# NB: core.hooksPath is set LATER (F10b), AFTER the bundled agent-seed hook is
# installed, and only when the hook is actually present — so it can never point
# at a dead path (the bug this Feature previously shipped).
WRITTEN_PATHS+=("$GITCONFIG")

# ─── F7. Global gitignore ─────────────────────────────────────────────────
# Container-environment artifacts that never belong in a project's own
# .gitignore. Git auto-loads ~/.config/git/ignore (no core.excludesFile).
GIT_IGNORE_DIR="$REMOTE_HOME/.config/git"
mkdir -p "$GIT_IGNORE_DIR"
printf '%s\n' '.gh-token' '.env' '.agents/.last-code-review-sha' > "$GIT_IGNORE_DIR/ignore"
# Chown only the git subdir we own — NOT the `.config` parent, which on an
# arbitrary base (python:3.12 etc.) may already hold other tooling whose
# ownership a recursive chown would silently clobber.
WRITTEN_PATHS+=("$GIT_IGNORE_DIR" "$GIT_IGNORE_DIR/ignore")

# ─── F8. Neutral runtime dirs + SSH config ────────────────────────────────
# IdentityFile → the runtime-bound private signing/auth key. Signing-only key;
# github.com transport goes over HTTPS via the insteadOf rewrite above.
install -d \
  /run/verity/ssh \
  /run/verity/claude \
  /run/verity/codex \
  /run/verity/xdg/opencode \
  /run/verity/pi
WRITTEN_PATHS+=(
  "/run/verity/claude"
  "/run/verity/codex"
  "/run/verity/xdg/opencode"
  "/run/verity/pi"
)
SSH_DIR="$REMOTE_HOME/.ssh"
mkdir -p "$SSH_DIR"
chmod 0700 "$SSH_DIR"
printf '%s\n' \
  'Host github.com' \
  "  IdentityFile $SSH_SIGNING_KEY_PRIVATE" \
  '  UserKnownHostsFile /run/verity/ssh/known_hosts' \
  '  StrictHostKeyChecking yes' \
  '  IdentitiesOnly yes' \
  > "$SSH_DIR/config"
chmod 0600 "$SSH_DIR/config"
WRITTEN_PATHS+=("$SSH_DIR" "$SSH_DIR/config")

# ─── F9. tmux config ──────────────────────────────────────────────────────
# Mobile niceties (Blink/Termius/iOS Claude RC): mouse + large scrollback.
printf '%s\n' 'set -g mouse on' 'set -g history-limit 50000' > "$REMOTE_HOME/.tmux.conf"
WRITTEN_PATHS+=("$REMOTE_HOME/.tmux.conf")

# ─── F10. Helper scripts → /usr/local/bin ─────────────────────────────────
# FEATURE_DIR is resolved at the top of this script.
install -m 0755 "$FEATURE_DIR/bin/wt" /usr/local/bin/wt
install -m 0755 "$FEATURE_DIR/bin/verity-agent-run" /usr/local/bin/verity-agent-run
# The PATH a root-owned launcher sees: no nvm, no shell profile. Used both by the
# supervisor block below, which must resolve every binary the broker execs by
# absolute path, and by the opencode-acp wrapper after it.
LIFECYCLE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
if [ "$INSTALL_RUNNER_SUPERVISOR" = 'true' ]; then
  case "$ARCH" in
    amd64) SANDBOX_ARCH=amd64 ;;
    arm64) SANDBOX_ARCH=arm64 ;;
    *) echo "!! no attested verity-script-sandbox for architecture '$ARCH'" >&2; exit 1 ;;
  esac
  SANDBOX_ARTIFACT="$FEATURE_DIR/prebuilt/linux-$SANDBOX_ARCH/verity-script-sandbox"
  SANDBOX_HASHES="$FEATURE_DIR/prebuilt/sha256sums.txt"
  [ -f "$SANDBOX_ARTIFACT" ] && [ -f "$SANDBOX_HASHES" ] || {
    echo "!! attested verity-script-sandbox artifacts are missing" >&2
    exit 1
  }
  (cd "$FEATURE_DIR/prebuilt" && sha256sum --check --strict --ignore-missing sha256sums.txt)
  expected_line="$(grep "  linux-$SANDBOX_ARCH/verity-script-sandbox\$" "$SANDBOX_HASHES" || true)"
  [ -n "$expected_line" ] || {
    echo "!! no attested verity-script-sandbox hash for architecture '$SANDBOX_ARCH'" >&2
    exit 1
  }
  install -m 0755 "$SANDBOX_ARTIFACT" /usr/local/bin/verity-script-sandbox
  install -m 0755 "$FEATURE_DIR/bin/verity-runner-supervisor.mjs" \
    /usr/local/bin/verity-runner-supervisor
  install -m 0755 "$FEATURE_DIR/bin/verity-runner-supervisor-start" \
    /usr/local/bin/verity-runner-supervisor-start
  install -m 0755 "$FEATURE_DIR/bin/verity-runner-stack-start" \
    /usr/local/bin/verity-runner-stack-start
  install -m 0755 "$FEATURE_DIR/bin/verity-runner-worker.mjs" \
    /usr/local/bin/verity-runner-worker
  install -m 0755 "$FEATURE_DIR/bin/verity-agent-spawn-broker.mjs" \
    /usr/local/bin/verity-agent-spawn-broker
  install -m 0755 "$FEATURE_DIR/bin/verity-egress-connector.mjs" \
    /usr/local/bin/verity-egress-connector
  install -m 0755 "$FEATURE_DIR/bin/verity-egress-connector-start" \
    /usr/local/bin/verity-egress-connector-start
  # Every binary above starts with `#!/usr/bin/env node`, and the server runs
  # lifecycle commands with a deliberately fixed PATH so they cannot depend on a
  # shell profile. A devcontainer image normally keeps node under nvm, which that
  # PATH does not contain: the spawn broker then dies with
  # "env: 'node': No such file or directory", the supervisor never starts, and the
  # project silently falls back to the loopback runner with no native tools.
  # Publish a root-owned copy where the fixed PATH can see it — but never shadow
  # a node that is already reachable there. Do not symlink into nvm: that tree is
  # commonly writable by the dev user, while the spawn broker runs as root.
  if ! PATH="$LIFECYCLE_PATH" command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node || true)"
    if [ -z "$NODE_BIN" ]; then
      echo '!! verity-sandbox-toolkit: node not found; the Runner supervisor cannot start' >&2
      exit 1
    fi
    install -o root -g root -m 0755 "$NODE_BIN" /usr/local/bin/node
  fi
  # Same gap one level up: the spawn broker execs the agent CLI by absolute path
  # (`/usr/local/bin/codex`, `/usr/local/bin/claude`, and their `*-acp`
  # transport adapters — see
  # verity-agent-spawn-broker.mjs), because there is deliberately no shell in that
  # path. A devcontainer installs those through npm, so they sit under nvm too and
  # the turn dies with "setpriv: failed to execute /usr/local/bin/codex".
  #
  # These are symlinked, not copied: an npm CLI is a shim that resolves its own
  # package relative to where it lives, so a copy would find no modules. That is
  # also why nvm ownership is not a new exposure here — the broker drops to the
  # agent identity before exec, and the agent already runs this same CLI.
  # Only link what the image actually installs, and never shadow an existing one.
  for AGENT_CLI in codex codex-acp claude claude-agent-acp opencode; do
    if PATH="$LIFECYCLE_PATH" command -v "$AGENT_CLI" >/dev/null 2>&1; then continue; fi
    CLI_BIN="$(command -v "$AGENT_CLI" || true)"
    if [ -n "$CLI_BIN" ]; then ln -sfn "$CLI_BIN" "/usr/local/bin/$AGENT_CLI"; fi
  done
fi
# OpenCode speaks ACP as a SUBCOMMAND of its own CLI (`opencode acp`) rather than
# through a separate adapter package the way Claude and Codex do, so there is no
# `opencode-acp` executable for anything to name. Give it one: the spawn broker maps
# a fixed command name to a fixed absolute path and passes no shell, so the
# subcommand has to be baked in on this side of that boundary.
#
# Outside the supervisor block on purpose, unlike the symlink loop above. Those
# symlinks exist only because the broker execs absolute paths, but `opencode-acp` is
# the name the session backend spawns whichever runner carries the turn — an image
# that installed opencode without the supervisor still needs the executable, exactly
# as it gets `claude-agent-acp` and `codex-acp` from their npm packages ungated.
#
# Root-owned and written with the interpreter's real path resolved here, not looked
# up at run time: the child's PATH comes from the broker, so a wrapper that searched
# it would answer to whatever that PATH happens to resolve first. That is about
# determinism, not integrity — the resolved target is usually the root-owned npm
# global, but on an image where opencode came from a user-writable prefix the
# wrapper faithfully execs that. Pinning the path removes the lookup, not the
# question of who owns what it finds, which is the same posture as the symlinks.
#
# Two consequences worth stating rather than discovering. The root-owned
# `/usr/local/bin/opencode` symlink is written inside the supervisor block above, so
# only supervisor images have a stable name to resolve to; elsewhere this bakes in
# whatever prefix npm used, commonly an nvm path under the dev user. And an nvm path
# is node-version-scoped: a derived layer that bumps node moves it, and the wrapper
# then fails at spawn. Neither is specific to the wrapper — the same bump takes the
# `opencode` shim the agent's own PATH resolves with it — and both are fixed the same
# way, by re-running this Feature against the new layer, which re-resolves the path.
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
if [ "$INSTALL_OPENCODE" = 'true' ]; then
  OPENCODE_BIN="$(PATH="$LIFECYCLE_PATH" command -v opencode || command -v opencode || true)"
  if [ -z "$OPENCODE_BIN" ] && command -v npm >/dev/null 2>&1; then
    # Ask npm where it put it before concluding it is not there. The install above
    # succeeded — `set -e` would have stopped the build otherwise — so a miss here
    # means the global bin directory is simply not on either PATH this script
    # searched, which is a property of the image, not of the install.
    NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$NPM_GLOBAL_BIN" ] && [ -x "$NPM_GLOBAL_BIN/bin/opencode" ]; then
      OPENCODE_BIN="$NPM_GLOBAL_BIN/bin/opencode"
    fi
  fi
  if [ -z "$OPENCODE_BIN" ]; then
    # Fail the build, not the first turn. Nothing has a fallback for a missing
    # executable, so without this the image ships looking complete and every
    # OpenCode turn dies at spawn with an ENOENT nobody can act on from the chat.
    #
    # Reachable only when opencode was requested AND npm was present AND the
    # install returned success AND the binary is nowhere either PATH or npm's own
    # prefix names — a broken image, not a configuration choice. The npm-absent
    # case set INSTALL_OPENCODE=false further up and never arrives here.
    echo '!! verity-sandbox-toolkit: opencode requested but not found; cannot build opencode-acp' >&2
    exit 1
  fi
  # The path is interpolated into a shell script, so anything needing quoting is
  # refused rather than escaped: `command -v` on this image returns a plain path, and
  # a build that somehow produced another one should stop here rather than emit a
  # wrapper whose meaning depends on getting the escaping right.
  case "$OPENCODE_BIN" in
    *[!A-Za-z0-9/._-]*)
      echo "!! verity-sandbox-toolkit: refusing to wrap unquotable opencode path: $OPENCODE_BIN" >&2
      exit 1
      ;;
  esac
  # Staged and installed rather than redirected into place: `install` sets owner and
  # mode atomically, so the file is never briefly present at the umask default.
  # Assigning this arms the EXIT trap for it (see `cleanup_staging`), so a failing
  # `install` cannot bake the staged copy into the layer.
  OPENCODE_ACP_TMP="$(mktemp)"
  printf '#!/bin/sh\nexec %s acp "$@"\n' "$OPENCODE_BIN" > "$OPENCODE_ACP_TMP"
  install -o root -g root -m 0755 "$OPENCODE_ACP_TMP" /usr/local/bin/opencode-acp
  rm -f "$OPENCODE_ACP_TMP"
  OPENCODE_ACP_TMP=
  # Deliberately NOT added to WRITTEN_PATHS: that array drives the F11 chown to the
  # dev user, and handing this file to the identity the agent runs as would undo the
  # root ownership two lines above — the wrapper is what pins which binary an agent
  # turn starts, so an agent that can rewrite it can pick that binary itself.
fi
install -d /usr/local/share/verity-sandbox-toolkit/lifecycle
install -m 0755 "$FEATURE_DIR/lifecycle/on-create.sh" \
  /usr/local/share/verity-sandbox-toolkit/lifecycle/on-create.sh
install -m 0755 "$FEATURE_DIR/lifecycle/post-start.sh" \
  /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh

# ─── F10a. Bundled agent-seed → /opt/agent-seed ───────────────────────────
# The code review tooling is BUNDLED into this Feature (single source of truth,
# CI-guarded against drift from the repo-root agent-seed/), so it is present on
# BOTH consume paths — the baked verity-sandbox image (`RUN install.sh`) and a
# user devcontainer (`--additional-features`). Root-owned, read-only tooling:
# NOT added to WRITTEN_PATHS (that array drives the dev-user home chown).
#
# The pre-push hook is installed at "$HOOKS_PATH" — the SAME variable F10b guards
# on and sets core.hooksPath to — so an operator-overridden HOOKSPATH can never
# decouple the install target from the guard (which would silently skip the gate).
install -d "$HOOKS_PATH" /opt/agent-seed/bin
install -m 0755 "$FEATURE_DIR/agent-seed/hooks/pre-push" "$HOOKS_PATH/pre-push"
# Secret gate: pre-commit scans the staged diff, pre-push re-scans the branch
# range. Both delegate to verity-secret-scan (gitleaks wrapper, installed below),
# so the policy exists once.
install -m 0755 "$FEATURE_DIR/agent-seed/hooks/pre-commit" "$HOOKS_PATH/pre-commit"
install -m 0755 "$FEATURE_DIR/agent-seed/bin/gh" /opt/agent-seed/bin/gh
# git wrapper: refuses `git worktree remove` on a Verity session worktree (a
# session must not delete the tree it runs in). Transparent for every other git
# invocation, so baking it first on PATH is inert on all other operations.
install -m 0755 "$FEATURE_DIR/agent-seed/bin/git" /opt/agent-seed/bin/git
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-code-review" /opt/agent-seed/bin/verity-code-review
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-secret-scan" /opt/agent-seed/bin/verity-secret-scan
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-tasks" /opt/agent-seed/bin/verity-tasks
# Commit-signing broker wrapper (audit H1). git is pointed at it via GIT_CONFIG_*
# env only in broker mode; without the broker env it is transparently ssh-keygen,
# so baking it here is inert on non-broker deployments.
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-git-sign" /opt/agent-seed/bin/verity-git-sign
# GitHub-token broker client + git credential helper (security review). They
# redeem the container capability for a fresh repo-scoped token on demand; inert
# without the broker env (VERITY_GH_TOKEN_URL + capability file), so baking them
# here is harmless on non-broker deployments.
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-gh-token" /opt/agent-seed/bin/verity-gh-token
install -m 0755 "$FEATURE_DIR/agent-seed/bin/verity-gh-cred" /opt/agent-seed/bin/verity-gh-cred
install -m 0644 "$FEATURE_DIR/agent-seed/code-review-prompt.md" /opt/agent-seed/code-review-prompt.md
# The gh wrapper redeems the container capability for a fresh token per invocation
# (verity-gh-token), then execs the pinned binary at /usr/local/lib/verity/gh-real.
# This keeps stale ambient GH_TOKEN values out of child gh calls and stores no
# GitHub token in the sandbox.
ln -sf /opt/agent-seed/bin/gh /usr/local/bin/gh
# Put the marker tool on PATH so `verity-code-review mark` works from any cwd.
ln -sf /opt/agent-seed/bin/verity-code-review /usr/local/bin/verity-code-review
# Same for the secret scanner, so it can be run by hand ("is this branch clean?")
# and so the hooks resolve it through PATH even under a custom hooks path.
ln -sf /opt/agent-seed/bin/verity-secret-scan /usr/local/bin/verity-secret-scan
# The task-board CLI (ADR 0007) so an agent can run `verity-tasks …` from any cwd.
ln -sf /opt/agent-seed/bin/verity-tasks /usr/local/bin/verity-tasks
# The token-broker client + credential helper on PATH so the gh wrapper and git's
# `!verity-gh-cred` helper resolve from any cwd.
ln -sf /opt/agent-seed/bin/verity-gh-token /usr/local/bin/verity-gh-token
ln -sf /opt/agent-seed/bin/verity-gh-cred /usr/local/bin/verity-gh-cred

# ─── F10b. git core.hooksPath (guarded — never a dead path) ────────────────
# Set the hooks path ONLY when the pre-push hook is actually installed and
# executable there. If it's missing, warn loudly and skip rather than pointing
# git at a dead directory (which would silently disable the code review gate —
# the exact regression this Feature previously shipped).
if [ -x "$HOOKS_PATH/pre-push" ]; then
  gc core.hooksPath "$HOOKS_PATH"
  # pre-push carries the same secret scan as a backstop, so a missing pre-commit
  # degrades the gate (a secret can still be committed locally) without opening
  # the push path. Warn instead of refusing to set the hooks path.
  if [ ! -x "$HOOKS_PATH/pre-commit" ]; then
    echo "!! verity-sandbox-toolkit: no executable pre-commit hook at '$HOOKS_PATH' —" >&2
    echo "!!                 secrets are only caught at push time." >&2
  fi
else
  echo "!! verity-sandbox-toolkit: no executable pre-push hook at '$HOOKS_PATH' —" >&2
  echo "!!                 skipping core.hooksPath so it is never a dead path." >&2
fi

# ─── F11. Ownership (precise — only the paths we wrote) ────────────────────
# Skip the chown when the target IS root (root already owns /root) or when
# the user doesn't exist yet (shouldn't happen, but stay defensive).
if [ "$REMOTE_USER" != "root" ] && id "$REMOTE_USER" >/dev/null 2>&1; then
  # De-duplicate the written paths before chowning.
  mapfile -t UNIQUE_PATHS < <(printf '%s\n' "${WRITTEN_PATHS[@]}" | sort -u)
  for p in "${UNIQUE_PATHS[@]}"; do
    [ -e "$p" ] && chown -R "$REMOTE_USER:$REMOTE_USER" "$p"
  done
fi

echo ">> verity-sandbox-toolkit: install complete."
echo ">>   config dir (runtime): $CLAUDE_CONFIG_DIR_VALUE"
echo ">>   gh auth (runtime):     token broker (VERITY_GH_TOKEN_URL + capability)"
echo ">>   TZ:                    $TZ_VALUE"
