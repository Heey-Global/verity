# Verity contributor instructions

## Repository

Verity is an npm-workspaces monorepo using Node.js 24 or newer and TypeScript
with NodeNext module resolution.

Run the standard verification commands from the repository root:

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

The file is tracked, so a checkout will collide with an untracked root `.npmrc`
of your own. Registry credentials belong in `~/.npmrc`, which npm reads as well
and which nothing here overrides.

## Running the checks

One root Vitest configuration owns every workspace's suite
(`packages/*/src/**/*.test.ts` and `scripts/**/*.test.ts`), so `npm test` runs
all of it and the packages have no `test` script of their own. Scope it while
iterating with a path — `npx vitest run packages/server/src/auth.test.ts`, or
`npx vitest run packages/server` for one package — and run the full suite once
before pushing. `apps/mobile` is the exception — it is outside that glob and
runs Jest, via `npm test --workspace @verity/mobile-app`.

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
