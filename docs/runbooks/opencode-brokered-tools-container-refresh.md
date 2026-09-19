# Recreate project containers for OpenCode brokered tools

ADR 0014 Amendment 4 admitted `opencode-acp` to the brokered Verity tools. The
Server now mints a per-turn MCP gateway bearer for every OpenCode turn. A project
container provisioned before that release carries a supervisor whose
`ACP_WORKER_BACKENDS` predates the decision, and it refuses that bearer.

The refusal is correct — the old boundary fails closed — but it is not
recoverable at runtime: **every OpenCode turn** in such a project fails at
start-turn. Claude and Codex sessions in the same project are unaffected, as are
OpenCode sessions on a container created after the release.

Turns with no session to attribute to (`sessionId: null` — the ephemeral/meta-
query path) are **not** exempt. They mint no bearer, so they clear the bearer
gate, but the same stale backend list gates `trustedCliExecution`, which the
Server sends for every ACP turn regardless, and they are refused there instead.

## Recognize it

The turn fails to start with a message containing one of:

```
invalid mcpGatewayToken — this Sandbox predates OpenCode's admission to the
brokered Verity tools (ADR 0014 Amendment 4) …

invalid trustedCliExecution — this Sandbox predates OpenCode's admission to the
brokered Verity tools (ADR 0014 Amendment 4) …
```

Which of the two you see depends only on which gate the old supervisor reached
first; the cause and the remedy are the same. That sentence is the Server's own
diagnosis
(`explainStaleGatewayRefusal`, `packages/session/src/runner-supervisor-client.ts`),
and it is specific: a current supervisor emits the same bare
`invalid mcpGatewayToken` when the Server mints an **empty** bearer, which is a
Server composition defect and not a stale container. The Server distinguishes the
two itself — it minted the bearer, so it knows which it sent — and says
`Server composition defect` instead when that is the case, on any backend. That
message is not this runbook's: do not recreate a container for it, since nothing
about reprovisioning changes it.

## Recover

**The project worktree survives this.** `/work` is not container storage — it is
the Server's own per-project clone, mounted read-write so sessions can commit
(`provisioner.ts`). With a data volume configured it is a named-volume mount with
a subpath; without one it is a host bind of the same clone path. Either way the
source is Server-owned storage outside the container, so recreating the container
replaces the container only: the clone, including uncommitted changes and session
worktrees, is remounted as it was. What is lost is process state — anything
running in the container at the time stops.

Before recreating, so that "process state only" is all you lose:

1. Stop or finish the project's running turns. A turn killed mid-write leaves the
   worktree as it stood, not as it would have been.
2. Commit or note any uncommitted work in the affected worktrees. This is not
   required for the mount to survive; it is what makes step 1's outcome legible
   afterwards.
3. Confirm the session you are diagnosing really shows a message from "Recognize
   it" above, and not the `Server composition defect` one.

Then recreate the project container through Verity:

```
POST /concierge/projects/<projectId>/recreate-container
```

That is the supported path, and the only one this runbook asks for. It replaces
the container from the current toolkit and re-attaches the same project mounts
(`recreateContainer`, `packages/server/src/provisioner.ts`).

**Do not reach for a volume-removing teardown.** `docker compose down -v`,
`docker rm -v`, or removing the Verity data volume by hand destroys the storage
`/work` is served from — the clone, its uncommitted changes, and every session
worktree. The survival described above is survival of container replacement, not
of volume deletion. Nothing in this failure calls for touching the volume.

There is no in-place fix: the supervisor is a boundary binary shipped with
`verity-sandbox-toolkit` and attested by ADR 0006 D9, so it is replaced by
reprovisioning, not by updating the Server.

Until the container is recreated, run affected sessions on Claude or Codex.

## Why the Server does not detect this first

The supervisor's status handshake carries `protocolVersion` and
`runnerInstanceId`, and neither names the admitted backends. Nothing this Server
can ask distinguishes a stale supervisor from a current one before the turn, so
the refusal is the first available signal.

Adding a backend list to that handshake was considered and rejected: a Server
would have to infer staleness from the field's ABSENCE, which is what the refusal
already reports, and it would mean changing a boundary binary that the affected
containers, by definition, do not have.

Bumping `protocolVersion` instead was also rejected, and for a sharper reason: it
is the wire dialect, and this change alters no frame. A supervisor refuses any
Server dialect below its minimum, so bumping it would make every older container
reject **all** its turns — Claude and Codex too — rather than only the OpenCode
ones actually affected. ADR 0014 Amendment 4 records both under Consequences.
