import { createHash, randomBytes } from 'node:crypto';

import type {
  RunGrantClaims,
  SecretJobFrame,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';
import Fastify from 'fastify';

import { createBrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import { createDockerClient } from './docker.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import { createInMemorySecretGrantStore, createSecretGrantBroker } from './secret-grant-broker.js';
import { PINNED_RUNSC_ARGS, PINNED_RUNSC_PATH } from './gvisor-runtime-config.js';
import { createInMemorySecretJobFrameSpool } from './secret-job-frame-spool.js';
import { registerSecretJobRoutes } from './secret-job-routes.js';
import { createSecretJobService } from './secret-job-service.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';

const SECRET = 'verity-live-fake-secret-9f42c6';
const HASH = 'a'.repeat(64);
const REDACTOR: StreamingRedactorProfile = {
  id: 'live-redactor',
  version: 1,
  implementationDigest: 'd'.repeat(64),
  algorithm: 'byte-longest-first-v1',
  minimumSecretBytes: 4,
  maximumSecretBytes: 4096,
  maximumActiveSecrets: 64,
  maximumInputChunkBytes: 65_536,
  maximumScanComparisons: 8_388_608,
  maximumOutputBytes: 1_048_576,
  replacement: '[REDACTED]',
};

function fail(message: string): never {
  throw new Error(`live Secret Job smoke failed: ${message}`);
}

function decodeFrames(frames: readonly SecretJobFrame[]): string {
  return frames
    .map((frame) =>
      frame.encoding === 'utf8'
        ? frame.payload
        : Buffer.from(frame.payload, 'base64').toString('utf8'),
    )
    .join('');
}

async function main(): Promise<void> {
  const digestRef = process.argv[2];
  if (digestRef === undefined) fail('usage: secret-job-live-smoke IMAGE@sha256:DIGEST');
  const dockerBaseUrl = process.env.VERITY_SECRET_JOB_DOCKER_BASE_URL;
  if (dockerBaseUrl === undefined || !dockerBaseUrl.startsWith('unix://')) {
    fail('VERITY_SECRET_JOB_DOCKER_BASE_URL must name the isolated unix Docker socket');
  }
  const match = /^(?<repository>.+)@sha256:(?<digest>[a-f0-9]{64})$/.exec(digestRef);
  if (match?.groups === undefined) fail('image must be a canonical digest reference');
  const repository = match.groups.repository!;
  const executorImageDigest = match.groups.digest!;
  const suffix = randomBytes(6).toString('hex');
  const jobId = `live-job-${suffix}`;
  const instant = new Date();
  const absoluteDeadline = new Date(instant.getTime() + 90_000).toISOString();
  const claims: RunGrantClaims = {
    protocolVersion: 1,
    grantId: `live-grant-${suffix}`,
    requestHash: HASH,
    projectId: 'live-project',
    sessionId: 'live-session',
    turnId: 'live-turn',
    toolCallId: 'live-call',
    profile: { id: 'live-fake-pilot', version: 1, policyHash: HASH },
    executorImageDigest,
    aliases: [{ id: 'live-api-token', version: 1 }],
    providerBindings: [{ id: 'live-fake-provider', version: 1, provider: 'doppler' }],
    snapshotId: HASH,
    audience: 'verity-secret-job-executor',
    issuedAt: instant.toISOString(),
    expiresAt: absoluteDeadline,
    nonce: randomBytes(24).toString('base64url'),
  };
  const recipientKeys = createSecretWorkerRecipientKeyRegistry();
  const broker = createSecretGrantBroker({
    store: createInMemorySecretGrantStore(),
    resolveSecrets: () => Promise.resolve(new Map([['API_TOKEN', Buffer.from(SECRET, 'utf8')]])),
    sealEnvelope: createSecretEnvelopeSealer({
      resolveRecipientPublicKey: (publicKeyId, sealedJobId) =>
        recipientKeys.resolve(publicKeyId, sealedJobId),
    }),
    authorizeWorkload: () => Promise.resolve(true),
    authorizeCurrentClaims: () => Promise.resolve(true),
  });
  const frames = createInMemorySecretJobFrameSpool();
  const docker = createDockerClient({ baseUrl: dockerBaseUrl });
  let workerTerminal: { kind: 'result' | 'error'; errorCode?: string } | undefined;
  const executor = createBrokeredSecretJobExecutor({
    broker,
    docker,
    dockerBaseUrl,
    frames,
    redactorProfile: REDACTOR,
    recipientKeys,
    expectedRuntimePath: PINNED_RUNSC_PATH,
    expectedRuntimeArgs: PINNED_RUNSC_ARGS,
    executorImageRepository: repository,
    maxRuntimeMs: 120_000,
    seams: {
      onTerminalOutcome: (outcome) => {
        workerTerminal = outcome;
      },
    },
  });
  const actor = { actorId: 'live-device', authorizationHash: 'c'.repeat(64) };
  const service = createSecretJobService({
    authorization: {
      request: () => Promise.resolve({ approvalId: 'live-approval' }),
      decide: async (_approvalId, candidate, approved) => {
        if (
          candidate.actorId !== actor.actorId ||
          candidate.authorizationHash !== actor.authorizationHash
        ) {
          throw new Error('unexpected approval actor');
        }
        if (!approved) return { decision: 'denied' as const };
        const issued = await broker.issue(claims);
        return {
          decision: 'approved' as const,
          ...issued,
          claims: { ...issued.claims, executorImageDigest },
        };
      },
    },
    executor,
    frames,
    authorizeInvocation: (candidate, invocation) =>
      Promise.resolve(
        candidate.actorId === actor.actorId && invocation.context.projectId === claims.projectId,
      ),
    onExecutorError: (_failedJobId, error) => {
      throw error;
    },
  });
  const app = Fastify({ logger: false });
  registerSecretJobRoutes(app, service, (header) =>
    header === 'Bearer live-token' ? actor : undefined,
  );
  const auth = { authorization: 'Bearer live-token' };
  const containerName = `verity-secret-job-${createHash('sha256')
    .update(jobId, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
  let apiCleanupCompleted = false;
  try {
    const invocation = {
      context: {
        protocolVersion: 1 as const,
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        turnId: claims.turnId,
        toolCallId: claims.toolCallId,
        channel: 'codex-mcp' as const,
      },
      request: {
        kind: 'restricted' as const,
        profile: claims.profile,
        parameters: { operation: 'echo-redaction-fixture' },
        snapshotId: HASH,
      },
    };
    const approval = await app.inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      headers: {
        ...auth,
      },
      payload: invocation,
    });
    if (
      approval.statusCode !== 202 ||
      approval.json<{ approvalId?: string }>().approvalId !== 'live-approval'
    ) {
      fail(`approval request returned ${approval.statusCode}`);
    }
    const start = await app.inject({
      method: 'POST',
      url: '/secret-jobs/approvals/live-approval/decision',
      headers: auth,
      payload: { approved: true, jobId, absoluteDeadline },
    });
    if (start.statusCode !== 202) fail(`job start returned ${start.statusCode}: ${start.body}`);

    let status: {
      state?: string;
      result?: { outcome?: string; exitCode?: number; finalSequence?: number };
    } = {};
    while (Date.now() < Date.parse(absoluteDeadline) + 5_000) {
      const response = await app.inject({
        method: 'GET',
        url: `/secret-jobs/${jobId}`,
        headers: auth,
      });
      if (response.statusCode !== 200) fail(`job status returned ${response.statusCode}`);
      status = response.json<typeof status>();
      if (status.state === 'reaped') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const replay = await app.inject({
      method: 'GET',
      url: `/secret-jobs/${jobId}/frames`,
      headers: auth,
    });
    if (replay.statusCode !== 200) fail(`frame replay returned ${replay.statusCode}`);
    const replayed = replay.json<{ frames?: SecretJobFrame[] }>().frames ?? [];
    const output = decodeFrames(replayed);
    if (status.state !== 'reaped' || status.result?.outcome !== 'succeeded') {
      // Never print frame payloads here: even though the worker contract guarantees redaction,
      // this diagnostic runs specifically when that contract may have failed. These fixed markers
      // and counts distinguish envelope-open failures (no frames), spawn failures (no frames), and
      // pilot failures (safe marker/exit code) without exposing arbitrary job output or secrets.
      fail(
        `unexpected terminal status ${JSON.stringify({
          state: status.state,
          outcome: status.result?.outcome,
          exitCode: status.result?.exitCode,
          finalSequence: status.result?.finalSequence,
          frameCount: replayed.length,
          stdoutFrames: replayed.filter((frame) => frame.stream === 'stdout').length,
          stderrFrames: replayed.filter((frame) => frame.stream === 'stderr').length,
          missingTokenMarker: output.includes('fake pilot missing API_TOKEN'),
          redactedStdoutMarker: output.includes('pilot-stdout:[REDACTED]:complete'),
          redactedStderrMarker: output.includes('pilot-stderr:[REDACTED]:complete'),
          workerTerminal,
        })}`,
      );
    }
    if (output.includes(SECRET)) fail('plaintext secret escaped in a frame');
    if (!output.includes('pilot-stdout:[REDACTED]:complete')) fail('stdout was not redacted');
    if (!output.includes('pilot-stderr:[REDACTED]:complete')) fail('stderr was not redacted');
    if (executor.boundGrants() !== 0) fail('grant binding survived terminal cleanup');
    if (recipientKeys.size() !== 0) fail('recipient key survived envelope sealing');
    const cleanup = await app.inject({
      method: 'POST',
      url: `/secret-jobs/${jobId}/cleanup`,
      headers: auth,
    });
    if (
      cleanup.statusCode !== 200 ||
      cleanup.json<{ disposition?: string }>().disposition !== 'already_reaped'
    ) {
      fail('container was not reaped exactly once');
    }
    apiCleanupCompleted = true;

    process.stdout.write(
      JSON.stringify({ outcome: status.result.outcome, frames: replayed.length, redacted: true }) +
        '\n',
    );
  } finally {
    if (!apiCleanupCompleted) {
      await docker.removeContainer(containerName).catch(() => undefined);
      await service.settle(jobId, actor).catch(() => undefined);
      await service.cleanup(jobId, actor).catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    service.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'live Secret Job smoke failed'}\n`,
  );
  process.exitCode = 1;
});
