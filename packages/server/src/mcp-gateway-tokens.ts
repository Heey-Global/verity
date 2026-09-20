import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer tokens the loopback MCP gateway authenticates its callers with (ADR 0014 D1).
 *
 * One token is minted per turn, handed to that turn's agent process and to nothing else.
 * It answers the only question the gateway cannot answer for itself: an MCP request arrives
 * over HTTP carrying no session identity, and without one there is no session to raise the
 * approval card on and no turn to run a trusted CLI in.
 *
 * The token is NOT a secret that authorizes anything on its own. Every call it admits is
 * still approval-gated (D2), and the card deliberately does not claim the model made the
 * call (D4) — precisely because anything inside the workspace can read the token out of the
 * agent's configuration and produce a byte-identical request. What the token buys is
 * attribution to a session and a turn, so the card reaches the right operator and the audit
 * record lands on the right trail.
 *
 * Tokens live in memory only. A Server restart therefore invalidates every outstanding one,
 * and the calls that follow are refused as `unauthenticated` and recorded as such. That is
 * the safe direction to fail: the alternative — a durable token surviving a restart the
 * session did not survive — would keep admitting callers to a turn that no longer exists.
 */

/** Who a presented token was minted for. */
export interface McpGatewayCaller {
  readonly sessionId: string;
  /** The turn the token was minted for. Serving a trusted CLI call needs it: the Sandbox
   *  supervisor only runs one inside a turn that asked for the capability up front. */
  readonly turnId: string;
}

export interface McpGatewayTokens {
  /** Mint this turn's bearer. Called once per turn start, on the Server side of the
   *  Sandbox boundary — the Sandbox never mints its own. */
  issue(input: { projectId: string; sessionId: string; turnId: string }): string;
  /**
   * Resolve a presented bearer within the project the connection already proved. Returns
   * undefined for an unknown, expired or foreign-project token; the caller is told the same
   * thing in every case.
   */
  resolve(input: { projectId: string; token: string }): McpGatewayCaller | undefined;
  /**
   * Retire one minted token early. Idempotent, and safe to call for a token that has already
   * expired or been released.
   *
   * Ownership is per MINT, not per turn: a caller may only retire the exact token it was
   * handed. Two start attempts for one turn therefore cannot retire each other's bearer —
   * whichever settles first would otherwise cut off a worker that is still running. Two live
   * bearers for one turn grant nothing extra: both resolve to the same session and turn, and
   * the brokered tools' at-most-once fence keys on the turn, not on the token.
   */
  release(input: { projectId: string; token: string }): void;
}

/** A token outlives its turn only as a backstop — nothing renews it, and the turn's own
 *  release is the normal end. Generous enough that a long-running turn is never cut off. */
const DEFAULT_TTL_MS = 8 * 60 * 60_000;

/** Ceiling on live tokens, so a Server that never sees a release cannot grow without bound. */
const DEFAULT_CAPACITY = 4_096;

const TOKEN_BYTES = 32;

/** Bearers are matched by digest, never by comparing the presented string against a stored
 *  one: the lookup is a hash plus a map read, so it does no work proportional to how much
 *  of a guess was correct and there is no comparison to leak a prefix through. */
function tokenDigest(token: string): string {
  return createHash('sha256').update(`verity.mcp-gateway-token.v1\0${token}`).digest('hex');
}

export function createMcpGatewayTokens(options?: {
  now?: () => number;
  ttlMs?: number;
  capacity?: number;
}): McpGatewayTokens {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const capacity = options?.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('invalid gateway token TTL');
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('invalid gateway token capacity');
  }

  interface Entry {
    readonly projectId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly expiresAt: number;
  }
  const byDigest = new Map<string, Entry>();

  const purgeExpired = (instant: number): void => {
    for (const [digest, entry] of byDigest) {
      if (entry.expiresAt <= instant) byDigest.delete(digest);
    }
  };

  return {
    issue({ projectId, sessionId, turnId }) {
      const instant = now();
      purgeExpired(instant);
      if (byDigest.size >= capacity) {
        throw new Error('MCP gateway token capacity exhausted');
      }
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      byDigest.set(tokenDigest(token), {
        projectId,
        sessionId,
        turnId,
        expiresAt: instant + ttlMs,
      });
      return token;
    },

    resolve({ projectId, token }) {
      if (token === '' || token.length > 512) return undefined;
      const instant = now();
      const entry = byDigest.get(tokenDigest(token));
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= instant) {
        purgeExpired(instant);
        return undefined;
      }
      // The project is proved by the connection, not by the body, so a token that escaped
      // into another project's container still cannot act there.
      if (entry.projectId !== projectId) return undefined;
      return { sessionId: entry.sessionId, turnId: entry.turnId };
    },

    release({ projectId, token }) {
      if (token === '' || token.length > 512) return;
      const digest = tokenDigest(token);
      // A token presented from the wrong project is not this caller's to retire, exactly
      // as it is not this caller's to use.
      if (byDigest.get(digest)?.projectId === projectId) byDigest.delete(digest);
    },
  };
}
