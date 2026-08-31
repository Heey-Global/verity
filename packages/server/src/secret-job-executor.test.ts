import { describe, expect, it, vi } from 'vitest';

import type {
  ExecutorWorkloadIdentity,
  RunGrantClaims,
  SecretJobFrame,
  SecretJobStartRequest,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { createInMemorySecretGrantStore, createSecretGrantBroker } from './secret-grant-broker.js';
import {
  createSecretEnvelopeSealer,
  generateRecipientKeyPair,
  type RawX25519KeyPair,
} from './secret-envelope-crypto.js';
import {
  createSecretJobExecutor,
  runSandboxWorkload,
  type LaunchedSandbox,
  type RawJobChunk,
  type SandboxLaunchSpec,
  type SandboxLauncher,
  type SandboxWorkloadContext,
} from './secret-job-executor.js';
import { createInMemorySecretAuditLog, type SecretAuditLog } from './secret-audit-log.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';

const SECRET_VALUE = 'fake-secret-value-abcdef';
const now = () => new Date('2026-07-19T00:01:00Z');

const REDACTOR_PROFILE: StreamingRedactorProfile = {
  id: 'redactor-1',
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

function claims(): RunGrantClaims {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: 'a'.repeat(64),
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-19T00:00:00Z',
    expiresAt: '2026-07-19T00:05:00Z',
    nonce: 'n'.repeat(32),
  };
}

function workload(): ExecutorWorkloadIdentity {
  return {
    executorInstanceId: 'exec-1',
    jobId: 'job-1',
    publicKeyId: 'key-1',
    attestationHash: 'c'.repeat(64),
  };
}

function startRequest(overrides: Partial<SecretJobStartRequest> = {}): SecretJobStartRequest {
  return {
    protocolVersion: 1,
    requestId: 'req-1',
    projectId: 'project-1',
    requestHash: 'a'.repeat(64),
    jobId: 'job-1',
    grantId: 'grant-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    executorImageDigest: 'e'.repeat(64),
    absoluteDeadline: '2026-07-19T00:10:00Z',
    ...overrides,
  };
}

/** A grant broker whose sealer addresses `sealTo` (defaults to the sandbox's own recipient key). */
function setupBroker(
  secrets: Map<string, Uint8Array>,
  recipient: RawX25519KeyPair,
  sealTo?: Uint8Array,
) {
  return createSecretGrantBroker({
    store: createInMemorySecretGrantStore(),
    resolveSecrets: () => Promise.resolve(secrets),
    sealEnvelope: createSecretEnvelopeSealer({
      resolveRecipientPublicKey: (id) =>
        Promise.resolve(id === 'key-1' ? (sealTo ?? recipient.publicKey) : undefined),
    }),
    authorizeWorkload: () => Promise.resolve(true),
    authorizeCurrentClaims: () => Promise.resolve(true),
    now,
  });
}

function sandboxContext(
  broker: ReturnType<typeof setupBroker>,
  capability: string,
  recipient: RawX25519KeyPair,
  runJob: SandboxWorkloadContext['runJob'],
): SandboxWorkloadContext {
  return {
    jobId: 'job-1',
    claims: claims(),
    capability,
    workload: workload(),
    recipientPrivateKey: recipient.privateKey,
    redactorProfile: REDACTOR_PROFILE,
    redeem: (cap, redemption) => broker.redeem(cap, redemption),
    runJob,
    now,
  };
}

async function* fromArray(frames: readonly SecretJobFrame[]): AsyncIterable<SecretJobFrame> {
  for (const frame of frames) yield frame;
}

/** A launcher that runs the real in-sandbox workload and records the spec it was handed. */
function fakeLauncher(
  context: SandboxWorkloadContext,
  sink: { spec?: SandboxLaunchSpec },
): SandboxLauncher {
  let reaped = false;
  const teardowns: string[] = [];
  const launcher: SandboxLauncher & { teardowns: string[] } = {
    teardowns,
    async launch(spec: SandboxLaunchSpec): Promise<LaunchedSandbox> {
      sink.spec = spec;
      const out = await runSandboxWorkload(context);
      return {
        workload: context.workload,
        frames: fromArray(out.frames),
        result: Promise.resolve(out.result),
      };
    },
    teardown(jobId: string): Promise<'reaped' | 'already_reaped'> {
      teardowns.push(jobId);
      const disposition = reaped ? 'already_reaped' : 'reaped';
      reaped = true;
      return Promise.resolve(disposition);
    },
  };
  return launcher;
}

function decodeFrames(frames: SecretJobFrame[]): string {
  return frames.map((frame) => Buffer.from(frame.payload, 'base64').toString('utf8')).join('');
}

function echoJob(): SandboxWorkloadContext['runJob'] {
  return (secrets) => {
    const value = secrets.get('TOKEN')!;
    const line = Buffer.concat([
      Buffer.from('using token='),
      Buffer.from(value),
      Buffer.from(' done'),
    ]);
    const chunks: RawJobChunk[] = [{ stream: 'stdout', chunk: new Uint8Array(line) }];
    return Promise.resolve({ chunks, exitCode: 0 });
  };
}

describe('secret job executor', () => {
  it('runs a job end-to-end and never leaks the secret into frames', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());

    const persisted: SecretJobFrame[] = [];
    const sink = {};
    const launcher = fakeLauncher(context, sink) as SandboxLauncher & { teardowns: string[] };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: (frame) => void persisted.push(frame) },
      runtime: 'docker-gvisor',
      now,
    });

    const response = await executor.start(startRequest());
    expect(response.disposition).toBe('created');
    const result = await executor.settle('job-1');

    expect(result.outcome).toBe('succeeded');
    const output = decodeFrames(persisted);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(SECRET_VALUE);
    expect(persisted.map((frame) => frame.sequence)).toEqual(persisted.map((_, index) => index));
    expect(executor.jobState('job-1')).toBe('reaped');
    expect(launcher.teardowns).toEqual(['job-1']);
  });

  it('records job_succeeded then cleanup_complete for a successful job', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const log = createInMemorySecretAuditLog();
    const executor = createSecretJobExecutor({
      launcher: fakeLauncher(context, {}),
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      recorder: createSecretAuditRecorder(log),
      now,
    });

    await executor.start(startRequest());
    await executor.settle('job-1');

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['job_succeeded', 'cleanup_complete']);
    expect(events.every((event) => event.grantId === 'grant-1' && event.jobId === 'job-1')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 2 });
  });

  it('records job_failed when the job ends in a fail-closed terminal result', async () => {
    const recipient = generateRecipientKeyPair();
    const attacker = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    // Sealed to the attacker's key: the sandbox cannot open the envelope, so the job fails closed.
    const broker = setupBroker(secrets, recipient, attacker.publicKey);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const log = createInMemorySecretAuditLog();
    const executor = createSecretJobExecutor({
      launcher: fakeLauncher(context, {}),
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      recorder: createSecretAuditRecorder(log),
      now,
    });

    await executor.start(startRequest());
    await executor.settle('job-1');

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['job_failed', 'cleanup_complete']);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 2 });
  });

  it('never lets a failing recorder break the job lifecycle', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const failing: SecretAuditLog = {
      append: () => Promise.reject(new Error('audit store down')),
      query: () => Promise.resolve([]),
      verifyChain: () => Promise.resolve({ ok: true, checked: 0 }),
    };
    const errors: unknown[] = [];
    const launcher = fakeLauncher(context, {}) as SandboxLauncher & { teardowns: string[] };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      recorder: createSecretAuditRecorder(failing, { onError: (error) => errors.push(error) }),
      now,
    });

    await executor.start(startRequest());
    const result = await executor.settle('job-1');
    expect(result.outcome).toBe('succeeded');
    expect(executor.jobState('job-1')).toBe('reaped');
    expect(launcher.teardowns).toEqual(['job-1']);
    // Both the job-outcome and cleanup appends failed, surfaced but non-fatal.
    expect(errors).toHaveLength(2);
  });

  it('hands the launcher a spec free of every secret and capability value', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());

    const sink: { spec?: SandboxLaunchSpec } = {};
    const executor = createSecretJobExecutor({
      launcher: fakeLauncher(context, sink),
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await executor.start(startRequest());
    await executor.settle('job-1');

    const serialized = JSON.stringify(sink.spec);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(issued.capability);
    expect(sink.spec?.executorImageDigest).toBe('e'.repeat(64));
  });

  it('consumes the grant exactly once — a replayed capability is rejected', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());

    const first = await runSandboxWorkload(
      sandboxContext(broker, issued.capability, recipient, echoJob()),
    );
    expect(first.result.outcome).toBe('succeeded');

    await expect(
      runSandboxWorkload(sandboxContext(broker, issued.capability, recipient, echoJob())),
    ).rejects.toThrow(/unknown or consumed grant/);
  });

  it('fails closed with no frames when the envelope cannot be opened', async () => {
    const recipient = generateRecipientKeyPair();
    const attacker = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    // Broker seals to the attacker's public key while the sandbox holds the real key-1 private key:
    // the GCM tag cannot be opened, so the workload must fail closed and emit nothing.
    const broker = setupBroker(secrets, recipient, attacker.publicKey);
    const issued = await broker.issue(claims());

    const out = await runSandboxWorkload(
      sandboxContext(broker, issued.capability, recipient, echoJob()),
    );
    expect(out.result.outcome).toBe('failed');
    expect(out.frames).toHaveLength(0);
  });

  it('fails closed when redaction exceeds its output budget', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context: SandboxWorkloadContext = {
      ...sandboxContext(broker, issued.capability, recipient, (secretsIn) => {
        void secretsIn;
        const chunk = new Uint8Array(Buffer.from('x'.repeat(64)));
        return Promise.resolve({ chunks: [{ stream: 'stdout', chunk }], exitCode: 0 });
      }),
      redactorProfile: { ...REDACTOR_PROFILE, maximumOutputBytes: 8 },
    };

    const out = await runSandboxWorkload(context);
    expect(out.result.outcome).toBe('failed');
  });

  it('rethrows a non-redaction job-body error after zeroizing the opened secrets', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());

    // A crash in the job body is a non-terminal path that never reaches flush/abort. The finally
    // must still run: it disposes both redactors and zeroizes the opened plaintext secrets.
    let captured: ReadonlyMap<string, Uint8Array> | undefined;
    const runJob: SandboxWorkloadContext['runJob'] = (injected) => {
      captured = injected;
      return Promise.reject(new Error('job body crashed'));
    };

    await expect(
      runSandboxWorkload(sandboxContext(broker, issued.capability, recipient, runJob)),
    ).rejects.toThrow(/job body crashed/);

    expect(captured).toBeDefined();
    expect([...captured!.values()].every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('is idempotent: a replayed start does not launch a second sandbox', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());

    let launches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launcher: SandboxLauncher = {
      async launch(): Promise<LaunchedSandbox> {
        launches += 1;
        const out = await runSandboxWorkload(context);
        return {
          workload: context.workload,
          frames: fromArray([]),
          result: gate.then(() => out.result),
        };
      },
      teardown: () => Promise.resolve('reaped'),
    };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });

    const first = await executor.start(startRequest());
    const second = await executor.start(startRequest());
    expect(first.disposition).toBe('created');
    expect(second.disposition).toBe('existing');
    expect(launches).toBe(1);

    release();
    await executor.settle('job-1');
  });

  it('rejects a second start after the job is consumed (single-use per job)', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const executor = createSecretJobExecutor({
      launcher: fakeLauncher(sandboxContext(broker, issued.capability, recipient, echoJob()), {}),
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await executor.start(startRequest());
    await executor.settle('job-1');

    await expect(executor.start(startRequest())).rejects.toThrow(/already consumed/);
  });

  it('rejects a start that rebinds a job id to a different request', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const executor = createSecretJobExecutor({
      launcher: {
        async launch(): Promise<LaunchedSandbox> {
          const out = await runSandboxWorkload(context);
          return {
            workload: context.workload,
            frames: fromArray([]),
            result: gate.then(() => out.result),
          };
        },
        teardown: () => Promise.resolve('reaped'),
      },
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await executor.start(startRequest());
    await expect(executor.start(startRequest({ requestHash: 'f'.repeat(64) }))).rejects.toThrow(
      /different request/,
    );
    release();
    await executor.settle('job-1');
  });

  it('rejects a start whose deadline has already elapsed', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const executor = createSecretJobExecutor({
      launcher: fakeLauncher(sandboxContext(broker, issued.capability, recipient, echoJob()), {}),
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await expect(
      executor.start(startRequest({ absoluteDeadline: '2026-07-19T00:00:30Z' })),
    ).rejects.toThrow(/deadline already elapsed/);
  });

  it('tears down a running sandbox when its absolute deadline elapses', async () => {
    vi.useFakeTimers();
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const teardown = vi.fn(async () => 'reaped' as const);
    const executor = createSecretJobExecutor({
      launcher: {
        async launch() {
          return {
            workload: context.workload,
            frames: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
            result: new Promise(() => {}),
          };
        },
        teardown,
      },
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await executor.start(startRequest({ absoluteDeadline: '2026-07-19T00:02:00Z' }));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(executor.settle('job-1')).resolves.toMatchObject({ outcome: 'failed' });
    expect(teardown).toHaveBeenCalledWith('job-1');
    vi.useRealTimers();
  });

  it('reaps deterministically and idempotently', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());
    const launcher = fakeLauncher(context, {}) as SandboxLauncher & { teardowns: string[] };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });
    await executor.start(startRequest());
    await executor.settle('job-1');
    expect(executor.jobState('job-1')).toBe('reaped');

    const cleanup = await executor.cleanup('job-1');
    expect(cleanup.disposition).toBe('already_reaped');
    expect(launcher.teardowns).toEqual(['job-1']);
  });

  it('tears down a secret-bearing sandbox even when driving it throws', async () => {
    // A sandbox that just held plaintext must never be left running: if the runtime crashes while
    // driving, the orchestrator still records a fail-closed result and reaps deterministically.
    const teardowns: string[] = [];
    const launcher: SandboxLauncher = {
      launch(): Promise<LaunchedSandbox> {
        return Promise.resolve({
          workload: workload(),
          frames: fromArray([]),
          result: Promise.reject(new Error('sandbox runtime crashed')),
        });
      },
      teardown(jobId: string): Promise<'reaped' | 'already_reaped'> {
        teardowns.push(jobId);
        return Promise.resolve('reaped');
      },
    };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });

    await executor.start(startRequest());
    const result = await executor.settle('job-1');
    expect(result.outcome).toBe('failed');
    expect(executor.jobState('job-1')).toBe('reaped');
    expect(teardowns).toEqual(['job-1']);
  });

  it('drops the record when launch fails so a replay can start cleanly', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());

    let attempts = 0;
    const launcher: SandboxLauncher = {
      async launch(): Promise<LaunchedSandbox> {
        attempts += 1;
        // The failing launch is secret-free and happens before the sandbox redeems the capability,
        // so nothing is consumed and the retry can redeem cleanly.
        if (attempts === 1) throw new Error('image pull failed');
        const out = await runSandboxWorkload(context);
        return {
          workload: context.workload,
          frames: fromArray(out.frames),
          result: Promise.resolve(out.result),
        };
      },
      teardown: () => Promise.resolve('reaped'),
    };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });

    await expect(executor.start(startRequest())).rejects.toThrow(/image pull failed/);
    // Not masked as an existing pending job — the failed launch left no record behind.
    expect(executor.jobState('job-1')).toBeUndefined();

    const retry = await executor.start(startRequest());
    expect(retry.disposition).toBe('created');
    const result = await executor.settle('job-1');
    expect(result.outcome).toBe('succeeded');
  });

  it('owns and tears down a launch that never settles without admitting a replacement', async () => {
    vi.useFakeTimers();
    try {
      const teardown = vi.fn(() => Promise.resolve<'reaped'>('reaped'));
      const executor = createSecretJobExecutor({
        launcher: {
          launch: () => new Promise<LaunchedSandbox>(() => undefined),
          teardown,
        },
        frames: { persist: () => {} },
        runtime: 'docker-gvisor',
        now,
      });
      const request = startRequest({ absoluteDeadline: '2026-07-19T00:01:01Z' });
      const started = executor.start(request);
      const rejected = expect(started).rejects.toThrow(/deadline elapsed during launch/);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(teardown).toHaveBeenCalledWith('job-1');
      expect(executor.jobState('job-1')).toBe('reaped');
      await expect(executor.start(request)).rejects.toThrow(/job already consumed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers via cleanup when an initial teardown fails', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const context = sandboxContext(broker, issued.capability, recipient, echoJob());

    let teardownCalls = 0;
    const launcher: SandboxLauncher = {
      async launch(): Promise<LaunchedSandbox> {
        const out = await runSandboxWorkload(context);
        return {
          workload: context.workload,
          frames: fromArray(out.frames),
          result: Promise.resolve(out.result),
        };
      },
      teardown(): Promise<'reaped' | 'already_reaped'> {
        teardownCalls += 1;
        if (teardownCalls === 1) return Promise.reject(new Error('teardown transient failure'));
        return Promise.resolve('reaped');
      },
    };
    const executor = createSecretJobExecutor({
      launcher,
      frames: { persist: () => {} },
      runtime: 'docker-gvisor',
      now,
    });

    await executor.start(startRequest());
    // The drive path's reap hits the failing teardown and leaves the job stuck in `reaping`.
    await expect(executor.settle('job-1')).rejects.toThrow(/teardown transient failure/);
    expect(executor.jobState('job-1')).toBe('reaping');

    // cleanup resumes the reap; the second teardown succeeds and the job reaches `reaped`.
    const cleanup = await executor.cleanup('job-1');
    expect(cleanup.disposition).toBe('reaped');
    expect(executor.jobState('job-1')).toBe('reaped');
    expect(teardownCalls).toBe(2);
  });

  it('redacts each stream independently and preserves stream attribution', async () => {
    const recipient = generateRecipientKeyPair();
    const secrets = new Map<string, Uint8Array>([
      ['TOKEN', new Uint8Array(Buffer.from(SECRET_VALUE))],
    ]);
    const broker = setupBroker(secrets, recipient);
    const issued = await broker.issue(claims());
    const runJob: SandboxWorkloadContext['runJob'] = (injected) => {
      const token = injected.get('TOKEN')!;
      const outChunk = Buffer.concat([Buffer.from('out='), Buffer.from(token)]);
      const errChunk = Buffer.concat([Buffer.from('err='), Buffer.from(token)]);
      return Promise.resolve({
        chunks: [
          { stream: 'stdout', chunk: new Uint8Array(outChunk) },
          { stream: 'stderr', chunk: new Uint8Array(errChunk) },
        ],
        exitCode: 0,
      });
    };

    const out = await runSandboxWorkload(
      sandboxContext(broker, issued.capability, recipient, runJob),
    );
    const decodeStream = (stream: SecretJobFrame['stream']): string =>
      out.frames
        .filter((frame) => frame.stream === stream)
        .map((frame) => Buffer.from(frame.payload, 'base64').toString('utf8'))
        .join('');

    // The secret is redacted on both streams and, crucially, one stream's bytes never surface on
    // the other — a shared redactor would flush stderr's retained tail onto stdout.
    expect(decodeStream('stdout')).toBe('out=[REDACTED]');
    expect(decodeStream('stderr')).toBe('err=[REDACTED]');
    expect(decodeStream('stdout')).not.toContain('err=');
    expect(decodeStream('stderr')).not.toContain('out=');
  });
});
