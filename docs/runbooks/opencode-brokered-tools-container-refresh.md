# Recreate project containers for OpenCode brokered tools

ADR 0014 Amendment 4 admitted `opencode-acp` to the brokered Verity tools. The
Server now mints a per-turn MCP gateway bearer for every OpenCode turn. A project
container provisioned before that release carries a supervisor whose
`ACP_WORKER_BACKENDS` predates the decision, and it refuses that bearer.

The refusal is correct — the old boundary fails closed — but it is not
recoverable at runtime: **every OpenCode turn attributed to a session** in such a
project fails at start-turn. Turns with no session to attribute to
(`sessionId: null` — the ephemeral/meta-query path) mint no bearer and are
unaffected, as are Claude and Codex sessions in the same project and OpenCode
sessions on a container created after the release.

## Recognize it

The turn fails to start with a message containing:

```
invalid mcpGatewayToken — this Sandbox predates OpenCode's admission to the
brokered Verity tools (ADR 0014 Amendment 4) …
```

That sentence is the Server's own diagnosis
(`explainStaleGatewayRefusal`, `packages/session/src/runner-supervisor-client.ts`),
and it is specific: a current supervisor emits the same bare
`invalid mcpGatewayToken` when the Server mints an **empty** bearer, which is a
Server composition defect and not a stale container. The Server distinguishes the
two itself — it minted the bearer, so it knows which it sent — and says
`Server composition defect` instead when that is the case. This runbook applies
only to the first message. Do not recreate a container for the second; nothing
about reprovisioning changes it.

## Recover

Recreate the project container on a current toolkit. There is no in-place fix:
the supervisor is a boundary binary shipped with `verity-sandbox-toolkit` and
attested by ADR 0006 D9, so it is replaced by reprovisioning, not by updating the
Server.

**The project worktree survives this.** `/work` is not container storage — it is
a named-volume mount (or host bind) whose source is the Server's own data volume,
mounted read-write so sessions can commit (`provisioner.ts`). Recreating the
container replaces the container only; the clone, including uncommitted changes
and session worktrees, is on the volume and is remounted as it was. What is lost
is process state: anything running in the container at the time stops.

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
