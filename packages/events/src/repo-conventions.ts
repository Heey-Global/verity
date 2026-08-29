/**
 * Branch naming and Conventional Commit titles — the two repository conventions
 * that nothing in Verity enforces mechanically.
 *
 * Both have a consequence the agent cannot see from inside the worktree. The
 * branch name is parsed by the session header for the issue number
 * (`packages/mobile/src/ui/branchRef.ts`), so a branch that does not match
 * silently costs the operator the Issue chip — no error, just a missing chip.
 * The commit/PR title feeds release automation, so the type prefix decides the
 * SemVer bump; a `feat` that should have been breaking ships as a minor.
 *
 * Stated here rather than left to `AGENTS.md` for the same reason as
 * `LANGUAGE_SYSTEM_PROMPT` in `./language.ts`: a checked-in doc only reaches
 * sessions whose repository carries one. The last sentence yields to the
 * repository, so a project that genuinely uses another convention is not talked
 * out of it.
 *
 * The branch examples below are asserted against the real parser in
 * `packages/mobile/src/ui/branchRef.test.ts` — see the note there before
 * changing them.
 */
export const REPO_CONVENTIONS_SYSTEM_PROMPT = `# Branch and commit conventions (Verity)

Name a branch you create for work on a GitHub issue \`<type>/<issue>-<slug>\` — for example \`feat/122-preview-branches\` or \`fix/130-keyboard-gap\`. Verity reads that leading issue number to show the session's Issue chip before a PR exists, so a differently-named branch loses the chip without any error. Branches not tied to an issue may omit the number. Branch types: \`feat\`, \`fix\`, \`chore\`, \`refactor\`, \`docs\`, \`style\`, \`test\`.

Write commit messages and pull request titles as Conventional Commits — \`feat(scope): …\`, \`fix(scope): …\`, \`chore(scope): …\` — using the full Conventional Commits type set, which is wider than the branch types above (\`perf\`, \`ci\`, \`build\`, \`revert\` are all valid commit types). Mark a breaking change with \`!\` after the type/scope or a \`BREAKING CHANGE:\` footer. Release automation derives version numbers from these titles, so pick the type by the user-facing effect of the change rather than by how much code moved, and mark a doubtful break as breaking rather than hiding it in a \`feat\`. If the repository's own instructions or its git history clearly follow a different convention, follow the repository.`;
