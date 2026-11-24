import type { BrokeredHttpProjectBinding } from './brokered-http-tool.js';
import { secretReferenceNames } from './doppler-secret-reference.js';

/**
 * Secret NAMES (never values) for a turn's context, so the agent stops guessing
 * aliases (ADR 0011 D3). Names of the default binding are listed bare, every other
 * binding's as `project/config/NAME` (ADR 0031). Resolved with the turn's person's
 * Doppler token for each binding's connection (ADR 0023 §3) and cached per person
 * and project: two people's tokens can see different names, and one person's list
 * must never answer for another. Briefly cached; a binding whose names cannot be
 * listed, a missing token included, is left out without failing the others.
 */
export function createBrokeredSecretAliases(options: {
  getProjectBindings(projectId: string): Promise<readonly BrokeredHttpProjectBinding[]>;
  credentialFor(
    userId: string | null,
    projectId: string,
    connectionId: string,
  ): Promise<Uint8Array>;
  listNames(input: {
    dopplerProject: string;
    dopplerConfig: string;
    token: Uint8Array;
  }): Promise<string[]>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { names: readonly string[]; expiresAt: number }>();
  return async (
    projectId: string,
    initiatedBy: { readonly userId: string } | undefined,
  ): Promise<readonly string[]> => {
    const userId = initiatedBy?.userId ?? null;
    const cacheKey = `${userId ?? ''}\0${projectId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now()) return cached.names;
    if (cached !== undefined) cache.delete(cacheKey);
    let bindings: readonly BrokeredHttpProjectBinding[];
    try {
      bindings = await options.getProjectBindings(projectId);
    } catch {
      return [];
    }
    if (bindings.length === 0) return [];
    let ttlMs = 60_000;
    const entries = await Promise.all(
      bindings.map(async (binding) => {
        let token: Uint8Array | undefined;
        try {
          token = await options.credentialFor(userId, projectId, binding.connectionId);
          const names = await options.listNames({
            dopplerProject: binding.dopplerProject,
            dopplerConfig: binding.dopplerConfig,
            token,
          });
          return { binding, names };
        } catch {
          // Keep provider outages best-effort without paying the same network timeout
          // at the start of every turn. Retry soon enough to recover automatically.
          ttlMs = 10_000;
          return { binding, names: [] };
        } finally {
          token?.fill(0);
        }
      }),
    );
    const names = secretReferenceNames(entries);
    if (cache.size >= 256) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(cacheKey, { names, expiresAt: now() + ttlMs });
    return names;
  };
}
