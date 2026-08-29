import type { ExecutorWorkloadIdentity } from '@verity/secret-contracts';

const X25519_PUBLIC_KEY_BYTES = 32;

export class SecretWorkerRecipientKeyRegistryError extends Error {}

export interface AuthenticatedRecipientKey {
  workload: ExecutorWorkloadIdentity;
  recipientPublicKey: Uint8Array;
  expiresAt: string;
}

/**
 * Bounded, process-local handoff from proof authentication to envelope sealing. Entries are keyed by
 * the hash-derived `publicKeyId`, expire with the challenge, and are consumed before being returned.
 * The raw key is public material, but single-use ownership prevents a stale authenticated key from
 * being silently reused for another redemption.
 */
export function createSecretWorkerRecipientKeyRegistry(options?: {
  now?: () => Date;
  maximumEntries?: number;
}) {
  const now = options?.now ?? (() => new Date());
  const maximumEntries = options?.maximumEntries ?? 1_024;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new Error('maximum recipient key entries must be positive');
  }
  const entries = new Map<string, { jobId: string; key: Uint8Array; expiresAtMs: number }>();

  const purgeExpired = (instantMs: number): void => {
    for (const [id, entry] of entries) {
      if (entry.expiresAtMs <= instantMs) entries.delete(id);
    }
  };

  return {
    register(input: AuthenticatedRecipientKey): void {
      const instantMs = now().getTime();
      purgeExpired(instantMs);
      const expiresAtMs = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= instantMs) {
        throw new SecretWorkerRecipientKeyRegistryError('recipient key is already expired');
      }
      if (input.recipientPublicKey.byteLength !== X25519_PUBLIC_KEY_BYTES) {
        throw new SecretWorkerRecipientKeyRegistryError('recipient key must be 32 bytes');
      }
      const id = input.workload.publicKeyId;
      if (entries.has(id)) {
        throw new SecretWorkerRecipientKeyRegistryError('recipient key is already registered');
      }
      if (entries.size >= maximumEntries) {
        throw new SecretWorkerRecipientKeyRegistryError(
          'recipient key registry capacity exhausted',
        );
      }
      entries.set(id, {
        jobId: input.workload.jobId,
        key: Uint8Array.prototype.slice.call(input.recipientPublicKey),
        expiresAtMs,
      });
    },

    /** Consume before validation/return: every lookup gets at most one attempt. */
    resolve(publicKeyId: string, jobId: string): Promise<Uint8Array | undefined> {
      const entry = entries.get(publicKeyId);
      if (entry !== undefined) entries.delete(publicKeyId);
      if (entry === undefined || entry.expiresAtMs <= now().getTime() || entry.jobId !== jobId) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(Uint8Array.prototype.slice.call(entry.key));
    },

    revoke(publicKeyId: string): void {
      entries.delete(publicKeyId);
    },

    size(): number {
      purgeExpired(now().getTime());
      return entries.size;
    },
  };
}

export type SecretWorkerRecipientKeyRegistry = ReturnType<
  typeof createSecretWorkerRecipientKeyRegistry
>;
