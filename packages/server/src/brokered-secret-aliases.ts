import type { BrokeredHttpProjectBinding } from './brokered-http-tool.js';

/**
 * Secret NAMES (never values) for a turn's context, so the agent stops guessing
 * aliases (ADR 0011 D3). Resolved with the turn's person's Doppler connection
 * (ADR 0023 §3) and cached per person and project: two people's connections can
 * see different names, and one person's list must never answer for another.
 * Briefly cached; every failure, a missing connection included, degrades to
 * "no list".
 */
export function createBrokeredSecretAliases(options: {
  getProjectBinding(projectId: string): Promise<BrokeredHttpProjectBinding | undefined>;
  credentialFor(userId: string | null, projectId: string): Promise<Uint8Array>;
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
    const binding = await options.getProjectBinding(projectId);
    if (binding === undefined) return [];
    let names: readonly string[];
    let ttlMs = 60_000;
    let token: Uint8Array | undefined;
    try {
      token = await options.credentialFor(userId, projectId);
      names = await options.listNames({
        dopplerProject: binding.dopplerProject,
        dopplerConfig: binding.dopplerConfig,
        token,
      });
    } catch {
      // Keep provider outages best-effort without paying the same network timeout
      // at the start of every turn. Retry soon enough to recover automatically.
      names = [];
      ttlMs = 10_000;
    } finally {
      token?.fill(0);
    }
    if (cache.size >= 256) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(cacheKey, { names, expiresAt: now() + ttlMs });
    return names;
  };
}
