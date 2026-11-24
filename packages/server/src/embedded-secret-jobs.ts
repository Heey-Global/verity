import { createHash } from 'node:crypto';
import { LEGACY_DOPPLER_CONNECTION_ID, type Database, type SecretCipher } from '@verity/store';
import type { Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { AuthTokenRegistry } from './auth.js';
import type { EmbeddedServerConfig, EmbeddedSecretJobs } from './embedded-types.js';
import type { createEmbeddedDoppler } from './embedded-doppler.js';
import type { SecretAuditLog } from './secret-audit-log.js';
import type { DockerClient } from './docker.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';
import { PINNED_RUNSC_ARGS, PINNED_RUNSC_PATH } from './gvisor-runtime-config.js';
import { createBrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import { createPostgresSecretGrantStore, createSecretGrantBroker } from './secret-grant-broker.js';
import { createPostgresSecretJobFrameSpool } from './secret-job-frame-spool.js';
import { createSecretJobService } from './secret-job-service.js';
import { registerSecretJobRoutes } from './secret-job-routes.js';
import { createPostgresSecretJobStore } from './secret-job-store.js';
import { createPostgresSecretProviderCatalog } from './secret-provider-catalog.js';
import { registerSecretProviderRoutes } from './secret-provider-routes.js';
import { createPostgresSecretRevocationStore } from './secret-revocation.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
import type { RunGrantClaims } from '@verity/secret-contracts';
import { createRuntimeReadinessGate } from './runtime-readiness-gate.js';
import {
  createDopplerSecretNameLister,
  createDopplerSecretResolver,
} from './doppler-secret-resolver.js';

type SecretJobsConfig = Pick<
  EmbeddedServerConfig,
  | 'secretJobs'
  | 'secretJobRuntimeReadiness'
  | 'secretJobRuntimeRequired'
  | 'secretJobRuntimeReadinessTtlMs'
  | 'dockerBaseUrl'
>;
type DopplerCredentials = Pick<ReturnType<typeof createEmbeddedDoppler>, 'dopplerCredentialFor'>;

export function createEmbeddedSecretJobs({
  config,
  runtimeDocker,
  db,
  secretCipher,
  secretAuditLog,
  dopplerCredentialFor,
}: DopplerCredentials & {
  config: SecretJobsConfig;
  runtimeDocker: DockerClient | undefined;
  db: Kysely<Database>;
  secretCipher: SecretCipher;
  secretAuditLog: SecretAuditLog;
}) {
  let secretJobRuntimeReadiness = config.secretJobRuntimeReadiness;
  if (config.secretJobRuntimeRequired === true && secretJobRuntimeReadiness === undefined) {
    // Validated before opening the DB by the composition root; retain local type narrowing.
    const dockerBaseUrl = config.dockerBaseUrl;
    if (dockerBaseUrl === undefined) throw new Error('unreachable: missing dockerBaseUrl');
    if (runtimeDocker === undefined) throw new Error('unreachable: missing runtime Docker client');
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: runtimeDocker,
      expectedPath: PINNED_RUNSC_PATH,
      expectedArgs: PINNED_RUNSC_ARGS,
    });
    secretJobRuntimeReadiness = createRuntimeReadinessGate(() => verifier.verify('runsc'), {
      ...(config.secretJobRuntimeReadinessTtlMs !== undefined
        ? { ttlMs: config.secretJobRuntimeReadinessTtlMs }
        : {}),
    });
  }
  let embeddedSecretJobs: EmbeddedSecretJobs | undefined;
  const secretProviderCatalog =
    config.secretJobs?.doppler !== undefined ? createPostgresSecretProviderCatalog(db) : undefined;
  if (config.secretJobs !== undefined) {
    const secretJobsConfig = config.secretJobs;
    const dopplerConnectionId =
      secretJobsConfig.doppler?.connectionId ?? LEGACY_DOPPLER_CONNECTION_ID;
    if (runtimeDocker === undefined || config.dockerBaseUrl === undefined) {
      throw new Error('unreachable: missing Secret Job Docker configuration');
    }
    const audit = createSecretAuditRecorder(secretAuditLog, {
      failureMode: 'fail-closed',
    });
    const revocations = createPostgresSecretRevocationStore(db);
    const recipientKeys = createSecretWorkerRecipientKeyRegistry();
    const sealEnvelope = createSecretEnvelopeSealer({
      resolveRecipientPublicKey: (publicKeyId, jobId) => recipientKeys.resolve(publicKeyId, jobId),
    });
    const broker = createSecretGrantBroker({
      store: createPostgresSecretGrantStore(db),
      resolveSecrets:
        secretJobsConfig.doppler !== undefined
          ? createDopplerSecretResolver({
              ...secretJobsConfig.doppler,
              catalog: secretProviderCatalog!,
              // The catalog retains its instance connection independently of project defaults.
              readCredential: (_ref, { projectId, userId }, scope) =>
                dopplerCredentialFor(userId, projectId, dopplerConnectionId, scope),
            })
          : secretJobsConfig.resolveSecrets!,
      sealEnvelope,
      authorizeWorkload: secretJobsConfig.authorizeWorkload,
      authorizeCurrentClaims: async (claims) => {
        if (
          !(await revocations.isClaimsActive(claims)) ||
          !(await secretJobsConfig.authorizeCurrentClaims(claims))
        ) {
          return false;
        }
        if (secretJobsConfig.doppler === undefined) return true;
        return secretProviderCatalog!.checkClaimsPermissions(claims);
      },
      ...(secretJobsConfig.doppler === undefined
        ? {}
        : {
            authorizeResolvedClaims: (claims: RunGrantClaims) =>
              secretProviderCatalog!.authorizeClaimsPermissions(claims),
          }),
      recorder: audit,
    });
    const frames = createPostgresSecretJobFrameSpool(db, secretCipher);
    const executor = createBrokeredSecretJobExecutor({
      broker,
      docker: runtimeDocker,
      dockerBaseUrl: config.dockerBaseUrl,
      frames,
      redactorProfile: secretJobsConfig.redactorProfile,
      recipientKeys,
      expectedRuntimePath: PINNED_RUNSC_PATH,
      expectedRuntimeArgs: PINNED_RUNSC_ARGS,
      executorImageRepository: secretJobsConfig.executorImageRepository,
    });
    const service = createSecretJobService({
      authorization: secretJobsConfig.createAuthorization(broker),
      executor,
      frames,
      store: createPostgresSecretJobStore(db),
      authorizeInvocation: secretJobsConfig.authorizeInvocation,
      onExecutorError: (jobId, error) =>
        console.error(`verity: Secret Job ${jobId} executor failed`, error),
    });
    // Container cleanup and output retention are deliberately independent. Completed frames remain
    // replayable until an explicit retention/acknowledgement reaper calls frames.deleteJob/purge.
    embeddedSecretJobs = {
      broker,
      executor,
      frames,
      service,
    };
  }
  return { secretJobRuntimeReadiness, embeddedSecretJobs, secretProviderCatalog };
}

export function installEmbeddedSecretJobs(
  app: FastifyInstance,
  {
    config,
    embeddedSecretJobs,
    secretProviderCatalog,
    authRegistry,
    dopplerCredentialFor,
  }: DopplerCredentials &
    Pick<
      ReturnType<typeof createEmbeddedSecretJobs>,
      'embeddedSecretJobs' | 'secretProviderCatalog'
    > & {
      config: Pick<EmbeddedServerConfig, 'secretJobs'>;
      authRegistry: Pick<AuthTokenRegistry, 'resolveId'>;
    },
): void {
  if (embeddedSecretJobs !== undefined) {
    registerSecretJobRoutes(app, embeddedSecretJobs.service, (header) => {
      const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
      const actorId = authRegistry.resolveId(token);
      if (token === undefined || actorId === undefined) return undefined;
      return {
        actorId,
        authorizationHash: createHash('sha256')
          .update(`verity.secret-job-approval.v1\0${token}`)
          .digest('hex'),
      };
    });
    app.addHook('onClose', () => embeddedSecretJobs.service.close());
  }
  if (secretProviderCatalog !== undefined) {
    const dopplerOptions = config.secretJobs!.doppler!;
    const dopplerConnectionId = dopplerOptions.connectionId ?? LEGACY_DOPPLER_CONNECTION_ID;
    registerSecretProviderRoutes(
      app,
      secretProviderCatalog,
      createDopplerSecretNameLister({
        ...dopplerOptions,
        readCredential: (_ref, { projectId, userId }, scope) =>
          dopplerCredentialFor(userId, projectId, dopplerConnectionId, scope),
      }),
      async (header, projectId) => {
        const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
        const actorId = token === undefined ? undefined : authRegistry.resolveId(token);
        if (
          actorId === undefined ||
          !(await config.secretJobs!.authorizeProviderAdministration!(actorId, projectId))
        ) {
          return undefined;
        }
        return actorId;
      },
    );
  }
}
