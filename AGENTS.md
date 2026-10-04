# Verity contributor instructions

## Repository

Verity is an npm-workspaces monorepo using Node.js 24 or newer and TypeScript
with NodeNext module resolution.

Run verification commands from the repository root. These are the full checks;
use the scoped local checks below when the impact is localized:

- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Format check: `npm run format`
- Format write: `npm run format:write`

## Dependencies

Install dependencies with `npm install`. The root `.npmrc` refuses to resolve
any npm release younger than three days, which is the same window Renovate
applies through the org preset `renovate.json` extends. `npm ci` is unaffected —
it installs what the lockfile already pins — so CI and image builds do not see
the floor. To take a security fix that must land inside the window, bypass it
deliberately: `npm install <pkg> --min-release-age=0`.

That file also sets `engine-strict=true`, so `engines` is enforced rather than
warned about: an npm older than `engines.npm` would ignore the floor silently,
and a warning nobody reads is not a supply-chain control. A dependency whose own
`engines` excludes the pinned Node now fails the install too — `npm install
--engine-strict=false` is the deliberate way past that while it is sorted out.
Renovate does not see the setting, since it overrides this file for its own
lockfile runs, so that failure surfaces first on its pull request rather than in
the branch that added the dependency. That is where it belongs; expect it there.

The file is tracked, so a checkout will collide with an untracked root `.npmrc`
of your own. Move yours rather than merging the two: registry credentials belong
in `~/.npmrc`, which npm reads as well and which nothing here overrides, and a
token pasted into the tracked file is one `git add` from being published.

## Running the checks

For localized changes, pass explicit file paths to
`npm run format:changed -- <files>` and, for JavaScript/TypeScript files, to
`npm run lint:changed -- <files>`. These scripts do not select files themselves.
Include all relevant branch changes, not just the most recent commit. Use the
full format or lint check when shared configuration changes affect the tree.
When types or shared APIs change, also lint affected unchanged consumers with
`npx eslint --no-warn-ignored --no-cache -- <files>`: ESLint's file cache does not
invalidate unchanged files when an imported type changes.

For TypeScript changes, build the affected projects and consumers, for example
`npx tsc -b packages/server`. Build mode includes referenced dependencies, but
does not discover downstream consumers; include those projects explicitly when
changing shared APIs. Use the workspace's own build/typecheck script for
projects outside the root TypeScript references. Run `npm run build` when root
TypeScript configuration or broad/unclear dependency changes affect the build.
Documentation-only changes do not require a build or code lint.

One root Vitest configuration owns every workspace's suite
(`packages/*/src/**/*.test.ts` and `scripts/**/*.test.ts`), so `npm test` runs
all of it and the packages have no `test` script of their own. Scope local runs
with paths — `npx vitest run packages/server/src/auth.test.ts`, or
`npx vitest run packages/server` for one package. Before pushing, run the tests
for changed behavior and affected consumers/integration paths, including guards
for changed scripts, fixtures, or configuration. Record the commands and scope
in the PR description. Do not repeat passing checks unless subsequent changes
or unresolved failures invalidate them.

The CI workflow owns the full suite for runtime changes; a full local run is
not required for every push. Run it locally when changes have broad or unclear
impact, such as shared test infrastructure, root dependency/configuration
changes, or cross-cutting runtime contracts. Documentation-only changes need
formatting checks, plus any repository guards that read the changed documents.
Do not rely solely on `vitest --changed` or `vitest related`: tests also launch
child processes and read fixtures/resources by path, outside the import graph.

`apps/mobile` is outside the root glob and runs Jest, via
`npm test --workspace @verity/mobile-app`; select affected suites with Jest's
path filters when the change is localized. `packages/mobile` also has its own
Vitest configuration and is excluded from the root suite; run its affected
tests with `npm test --workspace @verity/mobile`.

Sandboxes run under a container memory limit shared with other sessions.
Treat the checked-in `maxWorkers` / `-j` / `--parallel` values as an upper
bound, never a target; when a run exhausts memory, narrow it to fewer files
rather than giving it more heap.

Pushing runs the gate in `agent-seed/hooks/pre-push`: a gitleaks scan on every
branch, then a code review whose receipt is `.agents/.last-code-review-sha` — a
per-checkout marker, never committed. Run `verity-code-review run` and
`verity-code-review mark` rather than reaching for `--no-verify`. The scan is
the last point at which a leaked credential is still local; once pushed it is
burned and has to be rotated, whoever force-updates the branch afterwards. Do
not commit credentials, private deployment data, generated local state, or
`.env` files in the first place.

In the final reply, briefly state what changed, which checks passed, and any
relevant verification gaps. Describe scoped checks accurately; do not imply
that the full suite ran when only affected tests were selected.

## Changes

Write repository artifacts, code comments, commit messages, and pull request
descriptions in English. Use Conventional Commits. Keep changes focused, add
tests for changed behavior, and run verification proportional to the change.

Never push directly to the protected default branch. Work on a branch and open
a review-ready pull request.

## Tests

Derive expectations from the artifact under guard instead of restating it.
`scripts/renovate-config.test.ts` reads the extraction regex out of
`renovate.json` and applies it to the Dockerfile the rule names;
`packages/server/src/route-scopes.test.ts` scans the server sources for route
registrations rather than listing them. A restated value keeps passing after
the thing it was meant to protect has moved.

Write the comment that names the silent failure, not one that narrates the
assertion. The guards worth having are the ones catching a break that leaves
everything green.

Before trusting a new guard, break what it guards and watch it fail. A guard
that still passes against a deliberately broken tree is anchored on the wrong
thing.

## Product boundary

This repository contains the self-hosted Verity core, mobile app, and the open
Uplink client, connector, transport, and protocols. It does not contain the
paid hosted Uplink service, billing, entitlements, sharing brokerage, remote
control brokerage, or managed operations.
