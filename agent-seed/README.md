# Verity Agent Seed

Runtime-neutral helper files for Verity agent containers.

The shared dev-base image should install this directory at `/opt/agent-seed` and
configure Git to use:

```sh
git config --global core.hooksPath /opt/agent-seed/hooks
```

Project containers mount `/opt/agent-seed` read-only and prepend
`/opt/agent-seed/bin` to `PATH`.

- `bin/gh` runs the pinned GitHub CLI through the Verity forge proxy. It hands
  the child `gh` process only a placeholder derived from the capability mounted
  at `/run/verity/gh-token-capability` (via `verity-gh-token`); the proxy swaps
  it for the real repository-scoped credential on the server side. No reusable
  GitHub credential is mounted in the sandbox or exported to the ambient shell.
- `bin/verity-repo` opens and readies pull requests and reads and comments on
  issues for code hosts without a CLI in the sandbox (Forgejo today). Each
  command goes to `POST /internal/project/repo` with the same capability; the
  server resolves the project, its repository and its code host and executes
  the action with server-held credentials, so the command never names a
  repository and never sees a token. Failures are reported on stderr with a
  non-zero exit code.
- `bin/git` is a thin wrapper that refuses `git worktree remove` on a Verity
  session worktree (`.verity-sessions/agent-<id>`) — self-removal would delete
  the tree the session runs in and permanently break it ("workspace no longer
  exists"). It also refuses `git push --no-verify` (abbreviations included)
  and a push that overrides `core.hooksPath` through `-c`, `--config-env` or
  the equivalent `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_KEY_n` variables. That
  is a guard against the shortcut an agent reaches for, not an enumeration of
  every way git can be pointed at other configuration; the enforced boundary
  is branch protection on the code host. Every other git invocation execs the
  real git verbatim.
  Set `VERITY_GIT_GUARD_DISABLE=1` for operator-directed removals and pushes.
- `code-review-prompt.md` is the reviewer prompt used by
  `verity-code-review run`. Keep the full prompt out of the main chat
  transcript; the parent should only receive concise findings.
- `bin/verity-code-review` runs the gate: `run` hands the branch diff to an
  isolated reviewer and prints only its findings, `mark` then records the
  reviewed HEAD in `.agents/.last-code-review-sha`. The reviewer starts a fresh
  context on the current session backend (Claude Opus or the prioritized Codex
  default). Codex may inspect the repository through its read-only sandbox;
  Claude receives the fenced diff without filesystem tools. Agents must not improvise
  a backend-specific sub-agent for this — no backend registers a `code_review`
  agent, so improvising hangs the turn on a tool call that never returns.
- `hooks/pre-push` gates every ref being pushed, on every branch: the secret
  scan first, then the repository's `lint` and `format` scripts where it
  declares them, then the review marker — the push is blocked until the pushed
  tip is covered by that marker or each pending commit is explicitly tagged
  `[skip review]`. When the repository declares lint or format checks but
  `node_modules` is missing, the hook stops and asks instead of installing:
  installing runs code from the registry, so the operator chooses between
  `npm ci --ignore-scripts` (or `npm install --ignore-scripts` without a
  lockfile) and skipping the two checks for the session.
- `bin/verity-local-checks` records that skip: `skip` writes
  `.agents/.local-checks-skip` with a fingerprint of `package.json` and the
  lockfile, `reset` forgets it, `status` reports whether it still applies. The
  hook honours the marker only while `node_modules` is missing and only while
  the fingerprint matches; a changed manifest or lockfile makes it ask again.
  Secret scan and code review are never skipped.

  The gate is a local early warning, not the enforced boundary. It runs inside
  the sandbox, and an operator can disable the wrapper. What enforces the rules
  is the code host: branch protection with required status checks on the
  protected branches, and the organisation's gitleaks ruleset in CI. Keep those
  in place; the hook only saves the round trip.

- `bin/verity-review-base.sh` resolves the common ancestor used by review and
  push checks. If it is missing in a shallow clone, it fetches only the configured
  base branch and a remote-tracking ancestor of the pushed tip, in up to three
  requests of 128 additional commits each. Each request has a ten-second timeout
  plus one second to terminate. Recovery requires `timeout`; it never changes local commits or
  loads the entire history. Lint and formatting fall back to full checks when
  recovery fails, and shared configuration changes still require full checks.
  Review requires a usable boundary and reports how to restore one when missing.
- `hooks/pre-commit` refuses a commit whose staged diff contains a secret. Both
  hooks delegate to `bin/verity-secret-scan`, which wraps the pinned `gitleaks`
  binary: findings are redacted, the reported fingerprint is what goes into
  `.gitleaksignore`. Wherever `gitleaks` is available the scan runs, in every
  repository. A repository's own gitleaks config only decides what a _missing_
  scanner means: fail closed where the repo declares scanning, stay silent in a
  container that was never provisioned for it. `git commit --no-verify` remains
  possible for a commit; the push scan catches it again, and the git wrapper
  refuses `git push --no-verify`.

- `bin/verity-dev-server` manages dev servers that Verity runs for the agent.
  `add`, `update` and `remove` maintain a project-wide entry (name, command,
  subdirectory); `start`, `stop`, `restart`, `status` and `logs` act on the
  entry in the current session. The command receives its port in `$PORT` or
  through a `{port}` placeholder. The operator approves an entry's command once
  before it is published on the network. `announce --port <port> --name <name>`
  labels a server started outside Verity, and `scan` requests an immediate
  refresh for post-tool hooks.
