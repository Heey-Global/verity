# ADR 0029 — Module boundaries and a file-size limit

**Status:** Accepted · **Date:** 2026-11-14

## Context

A handful of source files keep growing because each holds one function or
class that everything new is added to:

| File                                | Construct             | Lines (approx.) |
| ----------------------------------- | --------------------- | --------------: |
| `packages/store/src/store.ts`       | `EventStore`          |           8,700 |
| `packages/server/src/server.ts`     | `buildServer`         |           5,600 |
| `packages/session/src/conductor.ts` | `Conductor`           |           5,500 |
| `packages/server/src/provisioner.ts`| `ProvisionerImpl`     |           5,500 |
| `packages/server/src/embedded.ts`   | `buildEmbeddedServer` |           5,100 |
| `packages/mobile/src/api.ts`        | `VerityClient`        |           4,500 |
| `apps/mobile/app/session/[id].tsx`  | `SessionChat`         |           4,300 |

`server.ts` has already been decomposed once. Its route handlers and domain
logic live in `*-routes.ts` and other modules. What grew back is the wiring:
`buildServer` creates services, timers and shared maps, and passes routes
large inline dependency objects whose closures contain the actual
integration logic. Nothing stopped that growth, so the file eventually became
too large to lint within the sandbox's lint memory budget (see
`scripts/lint-runner.mjs`). Type-aware lint, review and merge conflicts all
get more expensive with file size, and the failure shows up only when a file
is already too large to fix quickly.

## Decision

### Structure

- **Composition roots only wire.** `buildServer`, `buildEmbeddedServer` and
  similar entry points create shared infrastructure and call domain modules.
  They do not contain domain logic, inline route handlers or large inline
  dependency closures.
- **Each domain area owns its wiring.** A domain module exposes an entry point
  such as `install<Area>(app, ctx)` that registers its routes, creates its
  services and registers its timers and shutdown hooks. The dependency
  closures that adapt shared services to the area's routes live in that
  module, not at the call site.
- **Shared runtime state is explicit.** What several areas need (dependencies,
  shared services, maps, a lifecycle registry for timers and `onClose`
  handlers) is passed as a context object, not captured from an enclosing
  function.
- **Stores grow as sub-stores.** `EventStore` already exposes `knowledge`,
  `tasks`, `scheduling` and other sub-stores; new persistence goes into a
  sub-store for its area rather than into the `EventStore` class.
- **No imports back into a composition root.** Domain modules never import
  the file that assembles them; shared types live in dedicated modules such as
  `server-deps.ts` and `server-types.ts`.
- **Classes and components split along collaborators.** Large classes such as
  `Conductor` and `ProvisionerImpl` delegate to focused collaborators; large
  screens move state into hooks and sections into components.

### Size limit

Every TypeScript and JavaScript source file, including tests, stays at or
below **1,500 lines**. Declaration files, vendored code under `vendor/` and
the generated runner bundle (named by `scripts/build-runner-worker.mjs`) are
excluded.

Files above the limit when this decision was made are recorded with their line
counts in `scripts/file-size-debt.json`. That record may only shrink:

- a file that is not recorded must not exceed the limit;
- a recorded file must not grow;
- a recorded file that got smaller must lower its entry in the same change,
  and a file back within the limit must be removed from the record.

`scripts/file-size-guard.mjs` enforces this. It runs at the start of
`npm run lint` and `npm run lint:changed`, so it covers CI's lint job for
every source area and the local pre-push gate. `node
scripts/file-size-guard.mjs --update` lowers and removes entries after a file
shrank; it never raises or adds one.

## Consequences

- A change that needs to add code to a recorded file must move at least as
  many lines out of it, or put the new code in a module of its own. That is
  intentional: it turns each change into a small step of the decomposition.
- Parallel changes that both lower the same entry conflict on the debt file.
  The conflict is resolved by measuring the merged file.
- Line count is a proxy. The underlying limits are lint memory, review
  effort and merge conflicts, which all grow with file size; a line limit is
  simple to check and to understand.
- The decomposition proceeds one file at a time, in small pull requests that
  keep behavior and public exports unchanged. `server.ts` comes first,
  followed by the other files in the table above.

## Verification

`scripts/file-size-guard.test.ts` checks the repository against the record,
proves that growth, new oversized files and unrecorded reductions fail, and
checks that the guard still runs ahead of ESLint in both lint entry points.
