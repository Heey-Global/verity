import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { DockerClient } from './docker.js';
import type { ServerDeps } from './server-deps.js';
import { createPostgresAuditLog, type AuditServerIdentity } from './audit-log.js';
import { createAuditRecorder } from './audit-recorder.js';
import { runtimeServerVersion } from './runtime-version.js';
import { createBuildDiagnosticStore } from './build-diagnostics.js';
import { createServerLogSource } from './server-log-source.js';

export function createEmbeddedAudit(ctx: {
  config: Pick<EmbeddedServerConfig, 'dataDir' | 'dataVolumeRoot' | 'workspacesDir'>;
  db: Parameters<typeof createPostgresAuditLog>[0];
  projectDocker: Pick<DockerClient, 'inspectContainer'> | undefined;
}) {
  const { config, db, projectDocker } = ctx;
  // Durable audit trail for project image builds (ADR 0028). The Server generation is
  // read from this container's own label once; outside a managed deployment it is null.
  let auditServer: AuditServerIdentity | undefined;
  const buildDiagnostics = createBuildDiagnosticStore(
    join(
      config.dataDir ?? config.dataVolumeRoot ?? config.workspacesDir ?? join(tmpdir(), 'verity'),
      'build-diagnostics',
    ),
  );
  const auditLog = createPostgresAuditLog(db);
  const auditRecorder = createAuditRecorder(auditLog, {
    server: async () => {
      if (auditServer !== undefined) return auditServer;
      let generation: number | null = null;
      let settled = true;
      try {
        const label = (await projectDocker?.inspectContainer(hostname()))?.labels?.[
          'verity.generation'
        ];
        const parsed = label === undefined ? Number.NaN : Number(label);
        generation = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
      } catch {
        // Recorded as unknown this time, and asked again next time: a transient
        // failure must neither block a build nor stick for the life of the process.
        settled = false;
      }
      const identity = { release: runtimeServerVersion(), generation };
      if (settled) auditServer = identity;
      return identity;
    },
    onError: (error, kind) => {
      console.warn(`verity: audit event ${kind} could not be recorded`, error);
    },
  });
  return { auditRecorder, auditLog, buildDiagnostics };
}

export function createEmbeddedAuditBindings(
  ctx: ReturnType<typeof createEmbeddedAudit> & {
    runtimeDocker: Parameters<typeof createServerLogSource>[0];
    config: Pick<EmbeddedServerConfig, 'diagnosticServerContainerId'>;
  },
): Pick<ServerDeps, 'audit'> {
  const { auditRecorder, auditLog, buildDiagnostics, runtimeDocker, config } = ctx;
  return {
    audit: {
      recorder: auditRecorder,
      log: auditLog,
      buildDiagnostics,
      serverLogs: createServerLogSource(runtimeDocker, config.diagnosticServerContainerId),
    },
  };
}
