/**
 * The backend-neutral permission contract.
 *
 * These two types were lifted off the Claude Code stdio control protocol, which
 * this package used to speak in full: `parsePermissionRequest`, the `initialize`
 * handshake, and the `control_response` builders framed the mid-turn approve/deny
 * loop for a natively spawned `claude` (issue #27). ACP replaced that transport
 * (ADR 0012) and the native one is gone, so the wire half of the protocol went
 * with it — but the SHAPE it introduced outlived it: ACP, Codex, the runner
 * transport, and the approval card all still describe a prompt and a decision in
 * exactly these terms.
 *
 * What remains here is therefore a vocabulary, not an adapter. It keeps living in
 * a leaf package so that every consumer — the session layer, the Server, the
 * runner protocol — depends on the contract rather than on each other.
 */

/** A permission prompt raised mid-turn: the agent wants to run a tool and the
 *  turn blocks until the operator decides. */
export interface PermissionRequest {
  /** Correlates the {@link PermissionDecision} back to this prompt. */
  requestId: string;
  /** The tool the agent wants to run (e.g. `Bash`, `Write`). */
  toolName: string;
  /** The tool's argument object as the agent proposes it. */
  input: Record<string, unknown>;
  /** Correlates this prompt with the `tool_use` block on the event stream (#26). */
  toolUseId: string;
}

/** Operator decision for a {@link PermissionRequest}: allow the tool (optionally
 *  with edited input) or deny it (with a reason shown to the model). */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
