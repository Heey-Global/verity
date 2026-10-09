# Verity Control API rename

The internal Concierge API is now named Verity Control. The server and first-party
clients use the new names together; this internal refactoring does not require a
breaking-change release. The old paths have no aliases.

| Former endpoint | Replacement endpoint |
| --- | --- |
| `POST /concierge/session` | `POST /verity-control/session` |
| `POST /concierge/projects/:id/refresh-token` | `POST /verity-control/projects/:id/refresh-token` |
| `POST /concierge/projects/:id/recreate-container` | `POST /verity-control/projects/:id/recreate-container` |

In the TypeScript client, `openConciergeSession()` becomes
`openVerityControlSession()`, and the exported `ConciergeTokenRefresh` type becomes
`VerityControlTokenRefresh`. The `refreshProjectToken()` and
`recreateProjectContainer()` methods retain their names and use the new paths.

Existing projectless control sessions named `Concierge` remain usable. Opening
Verity Control reuses an existing session whose worktree still exists and renames
it to `Verity Control`; capability injection also recognizes the legacy stored
name. No manual database migration is required.
