import type { Socket } from 'node:net';

import {
  authenticateClaudeEgressPeer,
  buildClaudeEgressPeerBindings,
  type ClaudeEgressPeerBinding,
} from './claude-egress-mtls.js';

/**
 * A live fingerprint→project binding set for the Claude-egress gateway. Unlike
 * the static {@link createClaudeEgressMtlsAuthenticator}, the map can be replaced
 * at runtime, so a newly issued project certificate authenticates immediately —
 * without restarting the gateway — and a revoked one stops authenticating on the
 * next {@link replace}. The gateway is started with {@link authenticatePeer}; the
 * server refreshes the set from the identity service after every project
 * provision/deprovision.
 */
export interface ClaudeEgressPeerRegistry {
  /** Resolve a TLS peer to its authenticated project id (or `undefined`) against
   *  the CURRENT snapshot. Reads only trusted transport state — never HTTP. A
   *  property-typed function (not a method) so it can be passed detached as the
   *  gateway's `authenticatePeer`; it closes over the map, so `this` is unused. */
  authenticatePeer: (socket: Socket) => string | undefined;
  /** Atomically swap in a new binding set. Rejects a binding with an empty
   *  project or a fingerprint bound more than once (the whole update is discarded
   *  on error, so the previous snapshot stays intact). An empty set is valid — it
   *  authenticates no one. */
  replace: (bindings: readonly ClaudeEgressPeerBinding[]) => void;
  /** Number of currently bound peers. */
  size: () => number;
}

/**
 * Build a mutable peer registry, optionally seeded with an initial binding set.
 * The swap in {@link ClaudeEgressPeerRegistry.replace} is atomic: the new map is
 * validated fully before it becomes visible, so a rejected update never leaves a
 * partially applied set and concurrent {@link authenticatePeer} calls always see
 * a consistent snapshot.
 */
export function createClaudeEgressPeerRegistry(
  initial: readonly ClaudeEgressPeerBinding[] = [],
): ClaudeEgressPeerRegistry {
  let projectsByFingerprint: ReadonlyMap<string, string> = buildClaudeEgressPeerBindings(initial);
  return {
    authenticatePeer(socket): string | undefined {
      return authenticateClaudeEgressPeer(socket, projectsByFingerprint);
    },
    replace(bindings): void {
      // Build (and validate) fully before swapping — a throw leaves the prior map.
      const next = buildClaudeEgressPeerBindings(bindings);
      projectsByFingerprint = next;
    },
    size(): number {
      return projectsByFingerprint.size;
    },
  };
}
