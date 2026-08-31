# verity-sandbox-toolkit (devcontainer Feature)

Shared Verity agent-container tooling, packaged as a **local/bundled** devcontainer
Feature so a single `install.sh` is the source of truth for both consume paths:

1. **`verity-sandbox` image** — `deploy/verity-sandbox.Dockerfile` `COPY`s this directory
   and runs `install.sh` directly at build time (hard `ENTRYPOINT`
   `verity-agent-run`).
2. **User devcontainers** — the same Feature is injected at build via
   `devcontainer build --additional-features` (or a `devcontainer.json`
   `features` entry). The lifecycle scripts wire the runtime; `post-start.sh`
   invokes the same `verity-agent-run` (in the background, not as PID 1).

Same script, same result — no drift between the baked base and per-user builds.

## Trusted CLI argument policies

A trusted CLI whose arguments are identifiers rather than filesystem operands
may install an optional policy beside its resolved executable. For an executable
at `/usr/local/bin/example-cli`, the policy is
`/usr/local/bin/example-cli.verity-trusted-cli-policy.json`:

```json
{
  "version": 1,
  "routes": [
    ["inspect", "item", { "kind": "identifier" }],
    ["item", { "kind": "identifier" }]
  ]
}
```

String tokens match exactly. `{ "kind": "identifier" }` matches 1–255
characters with an alphanumeric first character and only alphanumerics, `.`,
`_`, or `-` after it. It cannot match paths, options, assignments, URLs, or
shell syntax. A present policy is a complete allowlist: an argument vector that
does not match one route is refused instead of falling back to generic
filesystem interpretation.

The policy is trusted executable metadata. It must be a regular, root-owned,
non-writable file under root-owned, non-writable parents, just like the
executable itself. The broker still validates every executable search-path entry
before applying it. Product and project images own their concrete policy files;
the generic Verity toolkit contains no executable names or domain-specific
argument grammar.

## What it installs

- **apt packages** (Debian bases): `tmux git curl ca-certificates less ripgrep gnupg wget jq openssh-client openssl`. Guarded on `apt-get` — non-Debian bases warn and continue.
- **GitHub CLI** (`gh`) — pinned release tarball → `/usr/local/lib/verity/gh-real`,
  with the agent-seed wrapper on `/usr/local/bin/gh` so child `gh` calls read
  `VERITY_GH_TOKEN_FILE` fresh per invocation.
- **Doppler CLI** (`doppler`) — pinned release tarball → `/usr/local/bin/doppler`.
- **Claude Code CLI** (`@anthropic-ai/claude-code`) — pinned npm global install
  when `installClaude=true` (requires the node Feature; `installsAfter` it).
- **npm supply-chain hardening** — global `ignore-scripts=true`, `allow-git=none`,
  `save-exact=true`, `fund=false`, written to the resolved
  `npm config get globalconfig` path (not hard-coded) and re-asserted.
- **git config** into the target user's `~/.gitconfig`: `safe.directory` for
  `/work` (+ worktrees), SSH commit/tag signing (`gpg.format=ssh`,
  `user.signingkey`), the two `insteadOf` HTTPS rewrites, and
  `core.hooksPath`. **No** credential helper and **no** `GH_TOKEN` profile hook
  (dead credential plumbing dropped — the agent-seed `gh` wrapper / provisioner
  own transport auth).
- **global gitignore** (`~/.config/git/ignore`): `.gh-token`, `.env`,
  `.agents/.last-code-review-sha`.
- **bundled agent-seed** → `/opt/agent-seed`: the `gh` wrapper, the
  runtime-neutral pre-push code review gate (`hooks/pre-push`), the
  `verity-code-review` marker tool (symlinked onto `PATH`), and
  `code-review-prompt.md`. Bundled INTO the Feature (single source of truth —
  CI-guarded byte-identical against the repo-root `agent-seed/`) so it is present
  on both consume paths. `core.hooksPath` is set only when the hook is actually
  installed, never a dead path.
- **ssh config** (`~/.ssh/config`): `Host github.com` with the private signing
  key as `IdentityFile`, `StrictHostKeyChecking yes`, `IdentitiesOnly yes`.
- **tmux config** (`~/.tmux.conf`): `mouse on`, `history-limit 50000`.
- **helper scripts** → `/usr/local/bin`: `wt` (worktree manager) and
  `verity-agent-run` (agent-neutral PID-1 / background keep-alive entrypoint —
  holds the container + a tmux login shell alive; launches NO agent, since
  Verity runs agent sessions via the server's `docker exec`).
- **Runner supervisor entrypoint** → `/usr/local/bin/verity-runner-supervisor`:
  the opt-in ADR 0006 Stage 3 discovery process. It validates the protected
  runtime mount, owns a singleton Unix socket, and atomically claims immutable
  per-turn directories. The current preview is launched by provisioning for the
  managed Verity sandbox only; production turns are not routed through it and
  Sandbox-restart/watchdog integration is not enabled yet.
  - **Singleton fencing requires local advisory-lock semantics.** The single
    live supervisor is elected by an `flock(2)` held for the process lifetime on
    `supervisor.lock` in the runtime mount; the on-disk `supervisor.lock.json`
    owner file is diagnostic only and never authoritative. This is correct on
    local/overlay-backed volumes (the Verity default `verity-data`), where the
    lock is a host-kernel inode lock shared across the Server and Sandbox
    namespaces. Do **not** back the runner runtime with a network filesystem
    (NFS/CIFS) or any driver whose advisory-lock semantics differ — two
    supervisors could then both win. Keep the runtime on a local volume driver
    until turns are routed through it.
- **dedicated runtime identity**: numeric `verity-runner` UID and
  `verity-runtime` GID (defaults `1101:1101`). The normal agent user is not a
  member, so project code cannot write the supervisor mount.
- **lifecycle scripts** →
  `/usr/local/share/verity-sandbox-toolkit/lifecycle`: `on-create.sh` and
  `post-start.sh`, so server-built devcontainer images can run the same runtime
  reconciliation without relying on source-tree paths.

## Options

| Option                    | Default                          | Purpose                                               |
| ------------------------- | -------------------------------- | ----------------------------------------------------- |
| `tz`                      | `UTC`                            | IANA timezone (`TZ`).                                 |
| `installClaude`           | `true`                           | Install the claude-code CLI globally.                 |
| `claudeCodeVersion`       | pinned                           | Exact `@anthropic-ai/claude-code` npm version.        |
| `ghVersion`               | pinned                           | Exact `cli/cli` release version (no leading `v`).     |
| `dopplerVersion`          | pinned                           | Exact `DopplerHQ/cli` release version.                |
| `ghTokenFile`             | `/run/verity/gh-token`           | Runtime bind path of the gh App-installation token.   |
| `sshSigningKey`           | `/run/verity/ssh/id_ed25519.pub` | Public SSH signing key (`user.signingkey`).           |
| `sshSigningKeyPrivate`    | `/run/verity/ssh/id_ed25519`     | Private key (`ssh IdentityFile`).                     |
| `claudeConfigDir`         | `/run/verity/claude`             | Persistent Claude config dir (`CLAUDE_CONFIG_DIR`).   |
| `hooksPath`               | `/opt/agent-seed/hooks`          | git `core.hooksPath` (agent-seed pre-push gate).      |
| `installRunnerSupervisor` | `false`                          | Install and reserve identity for the Stage 3 preview. |
| `runnerUid`               | `1101`                           | Dedicated supervisor UID when enabled.                |
| `runtimeGid`              | `1101`                           | Protected runtime GID when enabled.                   |

## Fixed-neutral-path / env contract (provisioner-fulfilled, PR-B)

The `*File` / `*Key` / `*Dir` options are **runtime bind targets**. `install.sh`
only writes CONFIG that references them; it never creates the secrets. The Verity
provisioner (separate PR) binds real files at those paths when it starts a
container:

- `ghTokenFile` — a fresh GitHub App installation token file.
- `sshSigningKey` / `sshSigningKeyPrivate` — the central SSH signing keypair.
- `claudeConfigDir` — a writable persistent volume for Claude state
  (`CLAUDE_CONFIG_DIR`).

`hooksPath` is NOT a runtime bind target: the pre-push hook is bundled into the
Feature and installed to `/opt/agent-seed/hooks` at install time (see above), so
`core.hooksPath` points at a path this Feature provisions itself.

Runtime env the lifecycle scripts / entrypoint read: `GIT_USER_NAME`,
`GIT_USER_EMAIL` (operator identity — unset triggers the GH013 warning),
`WORKSPACE` (default `/work`), `TMUX_SESSION` (default `verity` — the
agent-neutral tmux session held open by the entrypoint), `CLAUDE_CONFIG_DIR`
(Claude Code's config dir; also the persistent volume the entrypoint launch log
lives under).

The supervisor additionally reads `VERITY_RUNNER_RUNTIME` (default
`/run/verity-runner`), `VERITY_RUNNER_RUNTIME_UID`, and `VERITY_RUNNER_RUNTIME_GID`
(the dedicated runtime identity, `1101:1101` — deliberately distinct from the
Server host-dir owner `VERITY_RUNNER_UID`/`VERITY_RUNNER_GID` used by
`deploy/bin/verity-compose`). Verity's
managed default Sandbox enables installation and starts it as that numeric
identity only when the Stage 3 provisioner flag is enabled. Injected project
Features leave installation off, so they do not reserve UID/GID 1101. The
runtime root must already be owned by the Runner UID/GID with mode `0770`, or
owned by the Server with clear owner bits and Runner-group access (`0070`);
validation fails closed on mismatched ownership or world access.
This Stage 3 preview survives a Verity Server restart because it runs inside the
Sandbox. The Server probes/relaunches it directly as UID/GID 1101 during startup,
project-list refresh, and on a fixed reconciliation interval. This external
watchdog works with the Sandbox's `no-new-privileges` policy: it never asks project
code to change identity. Production turns remain on the existing Runner path
until remote attach and routing land.

## Lifecycle scripts

- `lifecycle/on-create.sh` — runs once: git operator identity (+ GH013 warn) and
  the initial `settings.json` seed (idempotent REQUIRED_ALLOW jq merge).
- `lifecycle/post-start.sh` — runs every start: `.claude.json` symlink,
  settings re-ensure, and launches the agent-neutral `verity-agent-run` in the
  background by default. With `VERITY_AGENT_RUN_FOREGROUND=1`, it `exec`s the
  runner instead; Verity's server-side Docker create path uses that mode for
  derived devcontainer images. (The code review pre-push hook is installed by
  `install.sh` and wired via global `core.hooksPath`, so post-start no longer
  symlinks the seed.)

Wire them in a consuming `devcontainer.json`:

```jsonc
{
  "features": {
    "./features/verity-sandbox-toolkit": {},
  },
  "onCreateCommand": "/path/to/features/verity-sandbox-toolkit/lifecycle/on-create.sh",
  "postStartCommand": "/path/to/features/verity-sandbox-toolkit/lifecycle/post-start.sh",
}
```
