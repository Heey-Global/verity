# Verity Agent Seed

Runtime-neutral helper files for Verity agent containers.

The shared dev-base image should install this directory at `/opt/agent-seed` and
configure Git to use:

```sh
git config --global core.hooksPath /opt/agent-seed/hooks
```

Project containers mount `/opt/agent-seed` read-only and prepend
`/opt/agent-seed/bin` to `PATH`.

- `bin/gh` reads the mounted token file (`VERITY_GH_TOKEN_FILE`, default
  `/run/verity/gh-token`) only for the child `gh`
  process, so GitHub CLI auth works without exporting `GH_TOKEN` into the
  ambient shell.
- `bin/git` is a thin wrapper that refuses `git worktree remove` on a Verity
  session worktree (`.verity-sessions/agent-<id>`) — self-removal would delete
  the tree the session runs in and permanently break it ("workspace no longer
  exists"). Every other git invocation execs the real git verbatim. Set
  `VERITY_GIT_GUARD_DISABLE=1` for operator-directed removals.
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
- `hooks/pre-push` blocks feature-branch pushes until the current HEAD is covered
  by that marker or each pending commit is explicitly tagged `[skip review]`. It
  also runs the secret gate over every ref being pushed, before any other check
  and on protected branches too, where the review gate itself is skipped.
- `hooks/pre-commit` refuses a commit whose staged diff contains a secret. Both
  hooks delegate to `bin/verity-secret-scan`, which wraps the pinned `gitleaks`
  binary: findings are redacted, the reported fingerprint is what goes into
  `.gitleaksignore`. Wherever `gitleaks` is available the scan runs, in every
  repository. A repository's own gitleaks config only decides what a _missing_
  scanner means: fail closed where the repo declares scanning, stay silent in a
  container that was never provisioned for it. Bypass in a real emergency with
  `git commit --no-verify` / `git push --no-verify`.
