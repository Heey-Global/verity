import type { FastifyInstance } from 'fastify';

export interface HealthRouteDeps {
  version: string;
  pushEnabled: boolean;
  publicPreviewsEnabled: () => boolean;
  secretJobRuntimeReadiness?: () => Promise<void>;
}

/** Registers the public liveness and deployment-capability probe. */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const base = {
      version: deps.version,
      pushEnabled: deps.pushEnabled,
      // Uplink admission happens after the HTTP server is constructed and can
      // disappear again when its lease or socket is lost. Resolve availability
      // for every probe so clients do not retain the boot-time state forever.
      publicPreviewsEnabled: deps.publicPreviewsEnabled(),
      // Capability, not a deployment gate: it is true wherever this build runs.
      // The app needs it because older servers silently drop `forceRebuild`.
      imageRebuildSupported: true,
    };
    if (deps.secretJobRuntimeReadiness === undefined) {
      return { status: 'ok' as const, ...base };
    }
    try {
      await deps.secretJobRuntimeReadiness();
      return {
        status: 'ok' as const,
        ...base,
        secretJobRuntime: { required: true as const, ready: true as const },
      };
    } catch {
      reply.code(503);
      return {
        status: 'degraded' as const,
        ...base,
        secretJobRuntime: { required: true as const, ready: false as const },
      };
    }
  });
}
