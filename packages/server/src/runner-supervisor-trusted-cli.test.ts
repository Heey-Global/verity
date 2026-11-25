import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSupervisorTrustedCli } from '@verity/session';
import {
  handleSupervisorRequest,
  runTrustedCliViaBroker,
  supervisorRequestTimeoutMs,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  runAgentSpawnBroker,
  runSupervisor,
  supervisorRequest,
} from './runner-supervisor-feature.test-helper.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('executes trusted CLI requests through the agent broker and returns only redacted output', async () => {
    const turnId = 'trusted-cli-turn';
    const secretDir = join(runtimeDir, 'trusted-cli-secrets');
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, 'STALE_LEGACY_FILE'), 'stale-secret', { mode: 0o600 });
    const childSignals: Array<NodeJS.Signals | null> = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      // The real directory is root-owned under /run/verity-runner; the test runs
      // unprivileged, so file injection needs a writable one.
      secretDir,
      spawnChild: (_command, args, options) => {
        const child = spawn(args[7]!, args.slice(8), options);
        child.on('exit', (_code, signal) => childSignals.push(signal));
        return child;
      },
    });
    await expect(readFile(join(secretDir, 'STALE_LEGACY_FILE'))).rejects.toThrow(/ENOENT/u);
    const previousBrokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    const spawned = vi.fn();
    const run = async (request: unknown) => {
      try {
        return {
          ok: true,
          ...(await runTrustedCliViaBroker(
            request as Parameters<typeof runTrustedCliViaBroker>[0],
            { runtimeDir, onSpawned: spawned },
          )),
        };
      } catch (error) {
        const trustedCliFailure = (error as Error & { trustedCliFailure?: unknown })
          .trustedCliFailure;
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(trustedCliFailure === undefined ? {} : { trustedCliFailure }),
        };
      }
    };
    try {
      // A root-owned 0700 parent blocks the CLI even when its per-call directory
      // is searchable. Same-UID test children otherwise hide this deployment failure.
      await chmod(secretDir, 0o700);
      const firstFile = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        correlationId: 'first-correlated-file',
        secrets: [
          { secretAlias: 'API_KEY', env: 'FIRST_FILE', injection: 'file', secret: 'canary' },
        ],
        command: ['/bin/sh', '-c', 'cat "$FIRST_FILE"'],
      });
      expect(firstFile).toMatchObject({ ok: true, exitCode: 0, stdout: '[REDACTED]' });
      expect((await lstat(secretDir)).mode & 0o777).toBe(0o711);
      await expect(lstat(join(secretDir, 'first-correlated-file'))).rejects.toThrow(/ENOENT/u);
      spawned.mockClear();
      const result = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret/value' }],
        command: [
          '/bin/sh',
          '-c',
          'printf "raw=%s base64=%s url=secret%%2Fvalue" "$CLI_SECRET" "$(printf %s "$CLI_SECRET" | base64)"; printf " err=%s" "$CLI_SECRET" >&2',
        ],
      });
      expect(result).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: 'raw=[REDACTED] base64=[REDACTED] url=[REDACTED]',
        stderr: ' err=[REDACTED]',
      });
      expect(JSON.stringify(result)).not.toContain('secret/value');
      expect(JSON.stringify(result)).not.toContain(Buffer.from('secret/value').toString('base64'));
      expect(spawned).toHaveBeenCalledOnce();
      // The case the single-secret contract could not express: a key id, an
      // issuer id and a private key in one process, the key as a file. No
      // sequence of single-secret runs composes into this, which is why agents
      // kept asking for one combined JSON alias instead.
      const multi = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'ASC_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
          { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID', secret: 'key-id-marker' },
          { secretAlias: 'ASC_API_ISSUER_ID', env: 'ASC_ISSUER_ID', secret: 'issuer-id-marker' },
        ],
        command: [
          '/bin/sh',
          '-c',
          'printf "id=%s issuer=%s file=%s key=%s" "$ASC_KEY_ID" "$ASC_ISSUER_ID" "$ASC_KEY_FILE" "$(cat "$ASC_KEY_FILE")"',
        ],
      });
      expect(multi).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: `id=[REDACTED] issuer=[REDACTED] file=${secretDir}/ASC_KEY_FILE key=[REDACTED]`,
      });
      const encodedFile = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'KUBECONFIG',
            env: 'KUBECONFIG',
            injection: 'file',
            secret: Buffer.from('apiVersion: v1\n').toString('base64'),
            encoding: 'base64',
          },
        ],
        command: [
          '/bin/sh',
          '-c',
          'cat "$KUBECONFIG"; cat "$KUBECONFIG" >&2; base64 < "$KUBECONFIG"',
        ],
      });
      // The broker decodes file injection; masking only the wire value leaks
      // the original credential when a CLI echoes its configuration.
      expect(encodedFile).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: '[REDACTED][REDACTED]\n',
        stderr: '[REDACTED]',
      });
      // Every value is redacted, not just the first one.
      for (const value of ['private-key-marker', 'key-id-marker', 'issuer-id-marker']) {
        expect(JSON.stringify(multi)).not.toContain(value);
      }
      // The file is removed once the run settles; a second run must not be
      // refused by the `wx` guard tripping over its own leftover.
      await expect(readFile(`${secretDir}/ASC_KEY_FILE`)).rejects.toThrow(/ENOENT/u);
      // Naming the injected path as its own argv token, rather than reaching it
      // through the variable: that is the form argument validation actually
      // inspects, and it has to grant the same exception materialization uses.
      const named = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'ASC_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
        ],
        command: ['/bin/cat', `${secretDir}/ASC_KEY_FILE`],
      });
      expect(named).toMatchObject({ ok: true, exitCode: 0, stdout: '[REDACTED]' });
      const correlationIds = ['concurrent-file-1', 'concurrent-file-2'];
      const releasePath = join(runtimeDir, 'release-concurrent-files');
      const concurrentRuns = correlationIds.map((correlationId) =>
        run({
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          correlationId,
          secrets: [
            {
              secretAlias: 'VERITY_CANARY_SECRET',
              env: 'SHARED_KEY_FILE',
              injection: 'file',
              secret: `${correlationId}-marker`,
            },
          ],
          command: [
            '/bin/sh',
            '-c',
            `test -r "$SHARED_KEY_FILE" || exit 41; touch ${JSON.stringify(join(runtimeDir, `${correlationId}.ready`))}; attempts=0; while [ ! -f ${JSON.stringify(releasePath)} ]; do attempts=$((attempts + 1)); [ "$attempts" -lt 500 ] || exit 42; sleep 0.01; done; cat "$SHARED_KEY_FILE"`,
          ],
        }),
      );
      try {
        // Promise.all alone can pass with serialized calls. Both children must
        // hold readable files before either may finish and trigger cleanup.
        await vi.waitFor(
          async () => {
            for (const correlationId of correlationIds) {
              await lstat(join(runtimeDir, `${correlationId}.ready`));
              expect(
                await readFile(join(secretDir, correlationId, 'SHARED_KEY_FILE'), 'utf8'),
              ).toBe(`${correlationId}-marker`);
            }
          },
          { timeout: 3000 },
        );
      } finally {
        await writeFile(releasePath, 'release');
        await Promise.all(concurrentRuns);
      }
      expect(await Promise.all(concurrentRuns)).toEqual([
        expect.objectContaining({ ok: true, exitCode: 0, stdout: '[REDACTED]' }),
        expect.objectContaining({ ok: true, exitCode: 0, stdout: '[REDACTED]' }),
      ]);
      for (const correlationId of correlationIds) {
        await expect(lstat(join(secretDir, correlationId))).rejects.toThrow(/ENOENT/u);
      }
      const terminatedRequest = {
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        correlationId: 'terminated-file',
        secrets: [
          {
            secretAlias: 'VERITY_CANARY_SECRET',
            env: 'SHARED_KEY_FILE',
            injection: 'file',
            secret: 'terminated-file-marker',
          },
        ],
        command: ['/bin/sh', '-c', 'cat "$SHARED_KEY_FILE"; kill -TERM $$'],
      };
      const terminated = await run(terminatedRequest);
      expect(terminated).toMatchObject({ ok: true, exitCode: 1, stdout: '[REDACTED]' });
      expect(childSignals.at(-1)).toBe('SIGTERM');
      await expect(lstat(join(secretDir, 'terminated-file'))).rejects.toThrow(/ENOENT/u);
      const retry = await run({
        ...terminatedRequest,
        correlationId: 'retry-after-terminated-file',
        secrets: [
          {
            secretAlias: 'VERITY_CANARY_SECRET',
            env: 'SHARED_KEY_FILE',
            injection: 'file',
            secret: 'retry-marker',
          },
        ],
        command: ['/bin/sh', '-c', 'cat "$SHARED_KEY_FILE"'],
      });
      expect(retry).toMatchObject({ ok: true, exitCode: 0, stdout: '[REDACTED]' });
      await expect(lstat(join(secretDir, 'retry-after-terminated-file'))).rejects.toThrow(
        /ENOENT/u,
      );
      // Removal can fail, and the file it leaves behind is a live credential at a
      // path the agent already knows. Take the directory's write bit away mid-run
      // so the unlink hits EACCES: the run has to come back as a failure naming
      // that, because reporting the command's own clean exit is what would let a
      // readable secret sit in the sandbox unnoticed and unrotated.
      const stranded = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'LEAK_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
        ],
        command: ['/bin/sh', '-c', `chmod 0500 ${JSON.stringify(secretDir)}`],
      });
      expect(stranded).toMatchObject({
        ok: false,
        error: expect.stringContaining('trusted CLI secret file could not be removed'),
      });
      expect(JSON.stringify(stranded)).not.toContain('private-key-marker');
      await chmod(secretDir, 0o700);
      await rm(`${secretDir}/LEAK_KEY_FILE`, { force: true });
      // Materialization can also die part-way, and what it already wrote is just
      // as live as what a finished run leaves behind. Plant a leftover so the
      // second secret trips the `wx` guard: the run fails, but the first secret's
      // file has to be gone, or the next run trips over that one instead.
      const failedInvocationDir = `${secretDir}/call-materialization-1`;
      await mkdir(failedInvocationDir, { recursive: true });
      await writeFile(`${failedInvocationDir}/PARTIAL_SECOND`, 'stale', { mode: 0o600 });
      const partial = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        correlationId: 'call-materialization-1',
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'PARTIAL_FIRST',
            injection: 'file',
            secret: 'first-file-marker',
          },
          {
            secretAlias: 'ASC_API_KEY_ID',
            env: 'PARTIAL_SECOND',
            injection: 'file',
            secret: 'second-file-marker',
          },
        ],
        command: ['/bin/sh', '-c', 'true'],
      });
      expect(partial).toMatchObject({ ok: false, error: expect.stringContaining('EEXIST') });
      expect(partial).toMatchObject({
        trustedCliFailure: {
          phase: 'materialization',
          cause: 'materialization failed',
          code: 'materialization_secret_file_exists',
          correlationId: 'call-materialization-1',
        },
      });
      // Containment worked here, so the caller hears the materialization error
      // itself — the leak wording is reserved for the case that needs a rotation.
      expect(partial).not.toMatchObject({
        error: expect.stringContaining('trusted CLI secret file could not be removed'),
      });
      for (const value of ['first-file-marker', 'second-file-marker']) {
        expect(JSON.stringify(partial)).not.toContain(value);
      }
      await expect(readFile(`${failedInvocationDir}/PARTIAL_FIRST`)).rejects.toThrow(/ENOENT/u);

      // A stranded file belongs only to the invocation that created it. A later
      // approved call using the same environment name must get its own directory
      // instead of failing over an unrelated run's credential.
      const recovered = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        correlationId: 'call-materialization-2',
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_ID',
            env: 'PARTIAL_SECOND',
            injection: 'file',
            secret: 'replacement-marker',
          },
        ],
        command: ['/bin/sh', '-c', 'cat "$PARTIAL_SECOND"'],
      });
      expect(recovered).toMatchObject({ ok: true, stdout: '[REDACTED]' });
      await expect(readFile(`${secretDir}/call-materialization-2`)).rejects.toThrow(/ENOENT/u);
      await rm(failedInvocationDir, { recursive: true, force: true });
      // The server and this image deploy separately, so a rollout always has a
      // window where an older server still sends the flat single-secret shape.
      // Rejecting it would make "ship the image first" unserviceable in both
      // directions, so the supervisor keeps reading it for now.
      const legacy = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secretAlias: 'API_KEY',
        env: 'CLI_SECRET',
        secret: 'legacy-shape-value',
        command: ['/bin/sh', '-c', 'printf "raw=%s" "$CLI_SECRET"'],
      });
      expect(legacy).toMatchObject({ ok: true, exitCode: 0, stdout: 'raw=[REDACTED]' });
      expect(JSON.stringify(legacy)).not.toContain('legacy-shape-value');
      const truncated = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          { secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
        ],
        command: ['/bin/sh', '-c', 'head -c 30000 /dev/zero | tr "\\0" x'],
      });
      expect(truncated).toMatchObject({
        ok: true,
        stdout: '[output withheld: truncated]',
        stderr: '[output withheld: truncated]',
        truncated: true,
      });
      expect(JSON.stringify(truncated)).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      // A large successful command must reach its exit without the old inline cap killing it.
      const streamed: Buffer[] = [];
      const large = await runTrustedCliViaBroker(
        {
          turnId,
          streamOutput: true,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'head -c 100000 /dev/zero'],
        },
        {
          runtimeDir,
          onOutput: async (_stream: string, bytes: Buffer) => {
            streamed.push(Buffer.from(bytes));
          },
        },
      );
      expect(large).toMatchObject({
        outputMode: 'stream-v1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        terminationReason: 'process_exit',
        stdoutBytes: 100000,
        stderrBytes: 0,
      });
      expect(Buffer.concat(streamed)).toHaveLength(100000);
      const failedSink = await runTrustedCliViaBroker(
        {
          turnId,
          streamOutput: true,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'yes synthetic'],
        },
        {
          runtimeDir,
          onOutput: async () => {
            throw Object.assign(new Error('private error'), { outputFailure: 'storage_failure' });
          },
        },
      );
      expect(failedSink).toMatchObject({
        outputMode: 'stream-v1',
        terminationReason: 'storage_failure',
        terminationRequested: true,
      });
      expect(JSON.stringify(failedSink)).not.toContain('private error');
      let acceptedBytes = 0;
      const limited = await runTrustedCliViaBroker(
        {
          turnId,
          streamOutput: true,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'yes synthetic'],
        },
        {
          runtimeDir,
          onOutput: async (_stream: string, bytes: Buffer) => {
            acceptedBytes += bytes.length;
          },
        },
      );
      expect(limited).toMatchObject({
        terminationReason: 'output_limit',
        terminationRequested: true,
        truncated: true,
      });
      expect(acceptedBytes).toBeGreaterThan(24 * 1024);
      expect(acceptedBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
      const deadline = await runTrustedCliViaBroker(
        {
          turnId,
          streamOutput: true,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'sleep 5'],
        },
        { runtimeDir, timeoutMs: 100, onOutput: async () => {} },
      );
      expect(deadline).toMatchObject({
        terminationReason: 'timeout',
        timedOut: true,
        terminationRequested: true,
      });

      const directoryRefusal = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'directory-secret-marker' }],
        command: ['/usr/bin/true', '--input-dir', runtimeDir],
      });
      expect(directoryRefusal).toMatchObject({
        ok: false,
        trustedCliFailure: {
          phase: 'validation',
          cause: 'validation failed',
          code: 'validation_operand_not_regular_file',
        },
      });
      expect(JSON.stringify(directoryRefusal)).not.toContain('directory-secret-marker');
      await expect(
        run({
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'LD_PRELOAD', secret: 'attacker-library' }],
          command: ['/bin/sh', '-c', 'exit 0'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI broker rejected execution: invalid trusted CLI spawn request',
        trustedCliFailure: {
          phase: 'validation',
          cause: 'validation failed',
          code: 'validation_invalid_request',
        },
      });
    } finally {
      await broker.close();
      if (previousBrokerSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
      else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousBrokerSocket;
    }
  });

  it('refuses a persisted trusted CLI capability when no live worker owns the turn', async () => {
    const turnId = 'trusted-cli-retired-turn';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [
            { secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'never-forwarded' },
            {
              secretAlias: 'billing-service/stg_restore/TOKEN',
              env: 'TOKEN_FILE',
              secret: 'synthetic',
              injection: 'file',
            },
          ],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI turn capability is no longer active',
      });
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'billing-service//TOKEN', env: 'TOKEN', secret: 'synthetic' }],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({ ok: false, error: 'invalid trusted CLI request' });
    } finally {
      await supervisor.close();
    }
  });

  it('executes through the supervisor only while its ACP worker is live', async () => {
    const turnId = 'trusted-cli-live-acp-turn';
    const secretDir = join(runtimeDir, 'live-acp-secrets');
    const workerReadyPath = join(runtimeDir, 'live-acp-worker-ready');
    const cancelSeenPath = join(runtimeDir, 'live-acp-cancel-seen');
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      secretDir,
      spawnChild: (_command, args, options) => spawn(args[7]!, args.slice(8), options),
    });
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {unlinkSync,writeFileSync} from 'node:fs';unlinkSync(process.argv[1]);writeFileSync(${JSON.stringify(workerReadyPath)},'ready');process.once('SIGTERM',()=>{writeFileSync(${JSON.stringify(cancelSeenPath)},'seen');setTimeout(()=>process.exit(0),250)});setInterval(()=>{},1000);`,
      ],
      brokerSocket: broker.socketPath,
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId,
          startCommandId: 'start-trusted-cli-live-acp-turn',
          sessionId: 'session-trusted-cli-live-acp-turn',
          backend: 'codex-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'stay live',
          trustedCliExecution: true,
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(async () => {
        await expect(readFile(workerReadyPath, 'utf8')).resolves.toBe('ready');
      });
      await expect(
        readFile(join(runtimeDir, 'turns', turnId, 'request.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const defaultSecret = 'token: plötzlich/größer\n';
      const qualifiedSecret = 'token from the secondary binding';
      const resolveSecret = vi.fn(async ({ connectionId }: { connectionId: string }) =>
        Buffer.from(connectionId === 'platform' ? defaultSecret : qualifiedSecret),
      );
      const tool = createTrustedCliTool({
        getProjectBindings: async () => [
          {
            id: 'default-binding',
            connectionId: 'platform',
            dopplerProject: 'platform',
            dopplerConfig: 'prod',
            isDefault: true,
          },
          {
            id: 'secondary-binding',
            connectionId: 'billing',
            dopplerProject: 'billing-service',
            dopplerConfig: 'stg_restore',
            isDefault: false,
          },
        ],
        resolveSecret,
        consumeApproval: async () => true,
      });
      const defaultHash = createHash('sha256').update(defaultSecret).digest('hex');
      const qualifiedHash = createHash('sha256').update(qualifiedSecret).digest('hex');
      await expect(
        tool(
          'project-1',
          'session-trusted-cli-live-acp-turn',
          turnId,
          {
            id: 'mixed-bindings',
            name: 'verity_secret_run',
            input: {
              secrets: [
                { secretAlias: 'KUBECONFIG', env: 'KUBECONFIG', injection: 'file' },
                {
                  secretAlias: 'billing-service/stg_restore/TOKEN',
                  env: 'TOKEN_FILE',
                  injection: 'file',
                },
              ],
              command: [
                '/bin/sh',
                '-c',
                `test "$(sha256sum "$KUBECONFIG" | cut -d ' ' -f 1)" = "${defaultHash}" || exit 23; test "$(sha256sum "$TOKEN_FILE" | cut -d ' ' -f 1)" = "${qualifiedHash}" || exit 24; cat "$KUBECONFIG"; cat "$TOKEN_FILE" >&2`,
              ],
            },
          },
          (input, options) => runSupervisorTrustedCli(runtimeDir, input, options),
        ),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: '[REDACTED]',
        stderr: '[REDACTED]',
      });
      expect(resolveSecret.mock.calls.map(([request]) => request.connectionId)).toEqual([
        'platform',
        'billing',
      ]);

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'live-secret' }],
          command: ['/usr/bin/id'],
        }),
      ).resolves.toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: expect.stringMatching(/^uid=/u),
        stderr: '',
      });
      const output: Buffer[] = [];
      const streamed = await runSupervisorTrustedCli(
        runtimeDir,
        {
          turnId,
          secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'head -c 100000 /dev/zero'],
        },
        {
          onOutput: async (_stream, bytes) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            output.push(Buffer.from(bytes));
          },
        },
      );
      expect(streamed).toMatchObject({
        outputMode: 'stream-v1',
        terminationReason: 'process_exit',
        exitCode: 0,
        stdoutBytes: 100000,
      });
      expect(Buffer.concat(output)).toHaveLength(100000);
      const rejected = await runSupervisorTrustedCli(
        runtimeDir,
        {
          turnId,
          secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'synthetic-secret' }],
          command: ['/bin/sh', '-c', 'yes synthetic'],
        },
        {
          onOutput: async () => {
            throw Object.assign(new Error('private'), { outputFailure: 'redaction_failure' });
          },
        },
      );
      expect(rejected).toMatchObject({
        terminationReason: 'redaction_failure',
        terminationRequested: true,
      });
      await expect(readFile(join(secretDir, 'KUBECONFIG'))).rejects.toThrow(/ENOENT/u);
      const cancellation = supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'cancel-turn',
        turnId,
      });
      await vi.waitFor(async () => {
        await expect(readFile(cancelSeenPath, 'utf8')).resolves.toBe('seen');
      });
      // The worker still exists during its SIGTERM grace period, but cancellation has
      // already revoked the execution capability.
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'retired-secret' }],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI turn capability is no longer active',
      });
      await expect(cancellation).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
    } finally {
      await supervisor.close();
      await broker.close();
    }
  });

  it('reports the stranded secret, not the spawn error, when a trusted CLI child never starts', async () => {
    const turnId = 'trusted-cli-spawn-failure';
    const secretDir = join(runtimeDir, 'spawn-failure-secrets');
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    // Both spawn failures are handled apart from the child-exit path, and each
    // once discarded the containment result: the caller heard "spawn refused"
    // and never learned a readable credential had been left in the sandbox.
    let asynchronous = false;
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      secretDir,
      spawnChild: () => {
        // Strand the file the way a failing unlink would. The test runs
        // unprivileged, so the broker cannot chown it back either and
        // containment genuinely fails rather than being simulated.
        chmodSync(secretDir, 0o500);
        if (!asynchronous) throw new Error('spawn refused');
        // Only the handful of members the broker touches on a child that never
        // reached `spawn`: the event surface, and `kill` for shutdown.
        const child = Object.assign(new EventEmitter(), {
          kill: () => true,
          exitCode: null,
          signalCode: null,
        }) as unknown as ChildProcess;
        queueMicrotask(() => {
          child.emit('error', new Error('spawn refused'));
          // A child that errored still closes, and the broker waits on that
          // before it will shut down. Omitting it hangs teardown, not the run.
          child.emit('close', 1, null);
        });
        return child;
      },
    });
    const previousBrokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    try {
      for (const env of ['SPAWN_KEY_SYNC', 'SPAWN_KEY_ASYNC']) {
        const result = runTrustedCliViaBroker(
          {
            turnId,
            secrets: [
              {
                secretAlias: 'ASC_API_KEY_P8',
                env,
                injection: 'file',
                secret: 'private-key-marker',
              },
            ],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir },
        );
        await expect(result).rejects.toThrow(/trusted CLI secret file could not be removed/u);
        // The spawn error still rides along, so the failure stays diagnosable.
        await expect(result).rejects.toThrow(/spawn refused/u);
        await chmod(secretDir, 0o700);
        await rm(`${secretDir}/${env}`, { force: true });
        asynchronous = true;
      }
    } finally {
      await broker.close();
      if (previousBrokerSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
      else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousBrokerSocket;
    }
  });

  it('rejects when the trusted CLI broker does not settle after SIGKILL', async () => {
    const turnId = 'trusted-cli-hung-broker';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const socketPath = join(runtimeDir, 'hung-broker.sock');
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write(`${JSON.stringify({ ok: true, kind: 'spawned' })}\n`);
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      await expect(
        runTrustedCliViaBroker(
          {
            turnId,
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret-value' }],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir, brokerSocket: socketPath, timeoutMs: 10, killGraceMs: 10 },
        ),
      ).rejects.toThrow(/did not settle after SIGKILL/u);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('kills a trusted CLI that reports spawned after its timeout', async () => {
    const turnId = 'trusted-cli-late-spawn';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const socketPath = join(runtimeDir, 'late-spawn-broker.sock');
    let receivedKill = false;
    const server = createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const frame = JSON.parse(buffered.slice(0, newline)) as { kind?: string };
          buffered = buffered.slice(newline + 1);
          if (frame.kind === 'spawn-trusted-cli') {
            setTimeout(
              () => socket.write(`${JSON.stringify({ ok: true, kind: 'spawned' })}\n`),
              20,
            );
          } else if (frame.kind === 'signal') {
            receivedKill = true;
            socket.write(`${JSON.stringify({ ok: true, kind: 'exit', code: 137 })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      await expect(
        runTrustedCliViaBroker(
          {
            turnId,
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret-value' }],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir, brokerSocket: socketPath, timeoutMs: 5, killGraceMs: 100 },
        ),
      ).resolves.toMatchObject({ exitCode: 137, timedOut: true });
      expect(receivedKill).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('keeps bounded request deadlines after reading a supervisor frame', () => {
    const regular = supervisorRequestTimeoutMs({ kind: 'status' });
    const trustedCli = supervisorRequestTimeoutMs({ kind: 'run-trusted-cli' });
    expect(regular).toBeGreaterThan(0);
    expect(trustedCli).toBeGreaterThan(regular);
    expect(trustedCli).toBeLessThanOrEqual(31 * 60 * 1_000);
  });

  it('forwards the broker start acknowledgement before returning the trusted CLI result', async () => {
    const started = vi.fn();
    const runTrustedCli = vi.fn(async (_request: unknown, onSpawned: (() => void) | undefined) => {
      onSpawned?.();
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    await expect(
      handleSupervisorRequest(
        runtimeDir,
        'runner-1',
        { protocolVersion: 1, kind: 'run-trusted-cli' },
        { runTrustedCli } as never,
        started,
      ),
    ).resolves.toEqual({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' });
    expect(started).toHaveBeenCalledOnce();
    expect(runTrustedCli).toHaveBeenCalledOnce();
  });
});
