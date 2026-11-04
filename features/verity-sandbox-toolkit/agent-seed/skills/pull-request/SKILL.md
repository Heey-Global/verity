---
name: pull-request
description: Use before publishing code, creating a pull request or choosing branch and commit names.
---

# Pull requests

Open every pull request as a normal, review-ready PR — never a draft. Use `verity repo pr create` and `verity repo pr ready <number>` through the project's code host; these commands support GitHub and Forgejo. If using GitHub-specific tooling, do not pass `--draft` to `gh pr create` and do not create drafts through the API. If a PR you are working on already exists as a draft, mark it ready before delivery. Draft PRs hold back reviews and ready-gated workflows, and they make the session's PR status read as stalled.

# Branch and commit conventions

Keep changes and pull requests on the current session worktree branch. Before creating a pull request, verify that its repository and head branch match that session. Do not create a separate worktree to publish this session's changes; use a separate Verity session for independent branch work. If the branches differ, resolve the session assignment before creating the PR; do not switch branches with uncommitted changes just to satisfy the check.

Name a branch you create for work on an issue `<type>/<issue>-<slug>` — for example `feat/122-preview-branches` or `fix/130-keyboard-gap`. Verity reads that leading issue number to show the session's Issue chip before a PR exists, so a differently-named branch loses the chip without any error. Branches not tied to an issue may omit the number. Branch types: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`.

Write commit messages and pull request titles as Conventional Commits — `feat(scope): …`, `fix(scope): …`, `chore(scope): …` — using the full Conventional Commits type set, which is wider than the branch types above (`perf`, `ci`, `build`, `revert` are all valid commit types). Mark a breaking change with `!` after the type/scope or a `BREAKING CHANGE:` footer. Release automation derives version numbers from these titles, so pick the type by the user-facing effect of the change rather than by how much code moved, and mark a doubtful break as breaking rather than hiding it in a `feat`. If the repository's own instructions or its git history clearly follow a different convention, follow the repository.

# Dependency storage

Before installing dependencies in a session worktree, run `verity dependencies status` when available. A compatible shared project installation needs no private install; workspace links alone are not a complete install. When installation is necessary and authorized, use `verity dependencies install` to reuse compatible dependencies or install privately for different manifests/lockfiles. Never install incompatible dependencies into the shared project tree, use hardlinks for writable packages, or delete locally patched packages to save space. If the helper is unavailable, follow the repository's installation instructions.
