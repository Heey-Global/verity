import type { RateLimitState } from '@verity/events';
import type { FastifyInstance } from 'fastify';

import { viewerId } from './view-state-routes.js';

interface ProviderLimitsProbe {
  getLimits(): Promise<RateLimitState[]>;
}

export interface ProviderLimitsRouteDeps {
  claudeUsage: ProviderLimitsProbe;
  codexUsage: ProviderLimitsProbe;
  /**
   * The probes of `viewer`'s own accounts (ADR 0023 §3). Absent, or answering
   * undefined, keeps the instance probes — whose accounts were the
   * administrator's.
   */
  probesFor?: (
    viewer: string,
  ) => { claudeUsage: ProviderLimitsProbe; codexUsage: ProviderLimitsProbe } | undefined;
}

/** Registers the combined account-global quota view for configured providers. */
export function registerProviderLimitsRoute(
  app: FastifyInstance,
  deps: ProviderLimitsRouteDeps,
): void {
  app.get('/provider-limits', async (request): Promise<RateLimitState[]> => {
    const probes = deps.probesFor?.(viewerId(request)) ?? deps;
    const [claude, codex] = await Promise.all([
      probes.claudeUsage.getLimits(),
      probes.codexUsage.getLimits(),
    ]);
    return [...claude, ...codex];
  });
}
