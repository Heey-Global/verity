import type { RunGrantClaims, RunGrantRedemption, SecretEnvelope } from '@verity/secret-contracts';

/**
 * The per-job grant binding for the Brokered Secrets execution path (ADR 0009). It is the trust seam
 * between the grant broker and the gVisor sandbox channel: it associates a freshly issued grant
 * (single-use capability + claims) with a `jobId`, and hands the channel a `resolveSecretJob(jobId)`
 * binding whose `sealEnvelope` redeems exactly that job's capability through the broker.
 *
 * Why this exists as its own seam rather than passing a capability into the launcher: the capability
 * is secret-adjacent and must never enter a Docker create request. The launcher/channel only ever see
 * a `sealEnvelope` function bound to the job; the capability stays captured in this resolver's closure.
 *
 * Fail-closed guarantees:
 *   - a job with no bound grant cannot be resolved;
 *   - a grant binds to a `jobId` at most once (no capability swap onto an existing job);
 *   - `sealEnvelope` is single-use per job and rejects a redemption for a different `jobId`, so one
 *     job's capability can never be redeemed for another job or replayed. The broker independently
 *     enforces single-use on redeem; this is defense in depth that also fails fast and frees state.
 *
 * Callers should `unbind` on every job-completion/failure path, but a lost unbind cannot leak a
 * capability forever: bindings self-expire at their claims' `expiresAt` (past which the broker would
 * reject the redemption anyway), pruned lazily on bind/resolve/size so the map stays bounded by TTL.
 */

/** A freshly issued grant: the single-use capability plus the claims the broker returned with it. */
export interface SecretJobGrant {
  capability: string;
  claims: RunGrantClaims;
}

/** What the channel receives for a job: the claims plus a job-bound broker seal. */
interface SecretJobGrantBinding {
  claims: RunGrantClaims;
  sealEnvelope: (redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
}

export class SecretJobGrantResolverError extends Error {}

export interface SecretJobGrantResolver {
  /** Associate a freshly issued grant with a job. Throws if the job already has a bound grant. */
  bind(jobId: string, grant: SecretJobGrant): void;
  /** Drop a job's binding (e.g. after the job is reaped). Idempotent. */
  unbind(jobId: string): void;
  /** Resolve the per-job `{ claims, sealEnvelope }` binding for the channel. Rejects fail-closed if
   * no grant is bound for the job. */
  resolve(jobId: string): Promise<SecretJobGrantBinding>;
  /** Number of jobs with a live grant binding (bounds/observability helper). */
  size(): number;
}

export function createSecretJobGrantResolver(options: {
  /** The broker redemption: consumes the capability and returns the sealed envelope for the workload. */
  redeem: (capability: string, redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
  now?: () => Date;
}): SecretJobGrantResolver {
  const now = options.now ?? (() => new Date());
  const grants = new Map<string, SecretJobGrant>();

  // Callers are expected to unbind on every job-completion/failure path, but a lost unbind must never
  // leave a capability-bearing grant resident forever. A grant is worthless past its claims' expiry
  // (the broker rejects an expired redemption), so lazily drop expired entries on every access — this
  // bounds the map by the grant TTL even if a caller forgets to unbind.
  function pruneExpired(): void {
    const instantMs = now().getTime();
    for (const [id, grant] of grants) {
      if (Date.parse(grant.claims.expiresAt) <= instantMs) grants.delete(id);
    }
  }

  return {
    bind(jobId: string, grant: SecretJobGrant): void {
      pruneExpired();
      if (grants.has(jobId)) {
        throw new SecretJobGrantResolverError('a grant is already bound for this job');
      }
      grants.set(jobId, grant);
    },

    unbind(jobId: string): void {
      grants.delete(jobId);
    },

    resolve(jobId: string): Promise<SecretJobGrantBinding> {
      pruneExpired();
      const grant = grants.get(jobId);
      if (grant === undefined) {
        return Promise.reject(new SecretJobGrantResolverError('no grant bound for this job'));
      }
      let sealed = false;
      const sealEnvelope = (redemption: RunGrantRedemption): Promise<SecretEnvelope> => {
        // Bind to the job on BOTH the redemption jobId and the workload's jobId — the same pair the
        // broker's AAD binds against — so one job's capability can never seal for another.
        if (redemption.jobId !== jobId || redemption.workload.jobId !== jobId) {
          return Promise.reject(
            new SecretJobGrantResolverError('redemption targets a different job'),
          );
        }
        if (sealed) {
          return Promise.reject(
            new SecretJobGrantResolverError('grant already redeemed for this job'),
          );
        }
        // The map is the shared single-use gate across every binding handed out for this job: if the
        // grant this binding captured is no longer the one bound (consumed by another binding, unbound,
        // or rebound), refuse rather than redeem a stale capability. Combined with the per-binding
        // `sealed` flag this fails closed for a double-resolve or a rebind. The broker remains the
        // authoritative single-use gate; this fails fast and frees state.
        if (grants.get(jobId) !== grant) {
          return Promise.reject(
            new SecretJobGrantResolverError('grant already redeemed for this job'),
          );
        }
        sealed = true;
        grants.delete(jobId);
        return options.redeem(grant.capability, redemption);
      };
      return Promise.resolve({ claims: grant.claims, sealEnvelope });
    },

    size(): number {
      pruneExpired();
      return grants.size;
    },
  };
}
