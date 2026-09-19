# Recreate project containers for OpenCode brokered tools

ADR 0014 Amendment 4 admitted `opencode-acp` to the brokered Verity tools. The
Server now mints a per-turn MCP gateway bearer for every OpenCode turn. A project
container provisioned before that release carries a supervisor whose
`ACP_WORKER_BACKENDS` predates the decision, and it refuses that bearer.

The refusal is correct — the old boundary fails closed — but it is not
recoverable at runtime, and it is total: **every** OpenCode turn in such a project
fails at start-turn. Claude and Codex sessions in the same project are unaffected,
as are OpenCode sessions on a container created after the release.

## Recognize it

The turn fails to start with a message containing:

```
invalid mcpGatewayToken — the Sandbox supervisor refused the per-turn gateway
bearer the Server mints for OpenCode.
```

The Server appends the likely cause and the remedy
(`explainStaleGatewayRefusal`, `packages/session/src/runner-supervisor-client.ts`).

Retry the turn once before acting on that message. A current supervisor emits the
same `invalid mcpGatewayToken` for an empty bearer, which is a Server defect
rather than a stale container, and the two cannot be told apart from the message.
A failure that repeats identically is the stale container.

## Recover

Recreate the project container on a current toolkit. There is no in-place fix:
the supervisor is a boundary binary shipped with `verity-sandbox-toolkit` and
attested by ADR 0006 D9, so it is replaced by reprovisioning, not by updating the
Server. Committed work is unaffected — the project worktree is not the container
— but uncommitted worktree state is lost with it, so check for it first.

Until the container is recreated, run affected sessions on Claude or Codex.

## Why the Server does not detect this first

The supervisor's status handshake carries `protocolVersion` and
`runnerInstanceId`, and neither names the admitted backends. Nothing this Server
can ask distinguishes a stale supervisor from a current one before the turn, so
the refusal is the first available signal. Adding a backend list to that
handshake was considered and rejected: a Server would have to infer staleness
from the field's ABSENCE, which is what the refusal already reports, and it would
mean changing a boundary binary that the affected containers, by definition, do
not have. ADR 0014 Amendment 4 records the trade under Consequences.
