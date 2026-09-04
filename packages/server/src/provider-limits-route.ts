import type { RateLimitState } from '@verity/events';
import type { FastifyInstance } from 'fastify';

interface ProviderLimitsProbe {
  getLimits(): Promise<RateLimitState[]>;
}

export interface ProviderLimitsRouteDeps {
  claudeUsage: ProviderLimitsProbe;
  codexUsage: ProviderLimitsProbe;
}

/** Registers the combined account-global quota view for configured providers. */
export function registerProviderLimitsRoute(
  app: FastifyInstance,
  deps: ProviderLimitsRouteDeps,
): void {
  app.get('/provider-limits', async (): Promise<RateLimitState[]> => {
    const [claude, codex] = await Promise.all([
      deps.claudeUsage.getLimits(),
      deps.codexUsage.getLimits(),
    ]);
    return [...claude, ...codex];
  });
}
