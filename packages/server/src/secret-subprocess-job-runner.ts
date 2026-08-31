import { spawn } from 'node:child_process';

import type { RawJobChunk } from './secret-job-executor.js';

/**
 * The in-sandbox job body for the Brokered Secrets worker: it runs the pinned executable with the
 * opened secrets injected, and returns its raw stdout/stderr for the worker runtime to redact. This
 * is the `runJob` the worker process supplies to {@link createSecretWorkerRuntime}; it holds the
 * plaintext only for the duration of the child process.
 *
 * v1 supports ENV injection (the canonical pilot case): each opened secret is injected as an
 * environment variable keyed by its target. The child gets a MINIMAL base environment (never the
 * worker's own env), and secrets travel only through `env` — never argv, where they would show up in
 * process listings. FILE and STDIN injection (see {@link file://../../secret-contracts/src/common.ts})
 * and executable-digest pinning are deliberate follow-ups.
 *
 * Fail-closed: a spawn failure (e.g. a missing executable) rejects, and output beyond `maxOutputBytes`
 * kills the child and rejects rather than streaming unbounded job output. Only the child's captured
 * bytes are returned; redaction and zeroization stay in the runtime.
 */

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface SubprocessJobResult {
  chunks: readonly RawJobChunk[];
  exitCode: number;
}

export interface SubprocessSecretJobRunnerOptions {
  /** Absolute path to the pinned executable to run inside the sandbox. */
  executablePath: string;
  /** Non-secret arguments. Secrets are NEVER passed here — only via env. */
  arguments?: readonly string[];
  /** Base environment for the child; defaults to a minimal `{ PATH }`. The worker's own environment is
   * never inherited. Injected secrets are layered on top. */
  baseEnv?: Readonly<Record<string, string>>;
  /** Total stdout+stderr byte cap; exceeding it kills the child and fails the job. */
  maxOutputBytes?: number;
  /** Child runtime cap; exceeding it kills the entire job process group. */
  maxRuntimeMs?: number;
}

/**
 * Build a `runJob(secrets)` that env-injects the opened secrets and runs the pinned executable,
 * returning its captured output and exit code.
 */
export function createSubprocessSecretJobRunner(
  options: SubprocessSecretJobRunnerOptions,
): (secrets: ReadonlyMap<string, Uint8Array>) => Promise<SubprocessJobResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('maxOutputBytes must be a positive integer');
  }
  if (!options.executablePath.startsWith('/')) {
    throw new Error('executablePath must be absolute');
  }
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs <= 0) {
    throw new Error('maxRuntimeMs must be a positive integer');
  }

  return (secrets: ReadonlyMap<string, Uint8Array>): Promise<SubprocessJobResult> => {
    const env = Object.create(null) as Record<string, string>;
    for (const [target, value] of Object.entries(
      options.baseEnv ?? { PATH: process.env.PATH ?? '' },
    )) {
      if (!ENV_NAME_PATTERN.test(target)) {
        return Promise.reject(new Error('base environment contains an invalid variable name'));
      }
      env[target] = value;
    }
    for (const [target, value] of secrets) {
      if (!ENV_NAME_PATTERN.test(target)) {
        return Promise.reject(new Error('secret target is not a valid environment variable name'));
      }
      let decoded: string;
      try {
        decoded = fatalUtf8Decoder.decode(value);
      } catch {
        return Promise.reject(new Error('secret value is not valid UTF-8 for env injection'));
      }
      if (decoded.includes('\0')) {
        // An environment variable cannot carry a NUL; fail rather than silently truncate a secret.
        return Promise.reject(new Error('secret value is not valid for env injection'));
      }
      env[target] = decoded;
    }

    return new Promise<SubprocessJobResult>((resolve, reject) => {
      const child = spawn(options.executablePath, [...(options.arguments ?? [])], {
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: RawJobChunk[] = [];
      let totalBytes = 0;
      let settled = false;
      let terminalError: Error | undefined;
      const killProcessGroup = (): void => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // Fall through when the process group is already absent.
          }
        }
        child.kill('SIGKILL');
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(runtimeTimer);
        fn();
      };

      const runtimeTimer = setTimeout(() => {
        terminalError = new Error('job exceeded the maximum runtime');
        killProcessGroup();
      }, maxRuntimeMs);
      runtimeTimer.unref();

      const collect =
        (stream: 'stdout' | 'stderr') =>
        (data: Buffer): void => {
          if (settled || terminalError !== undefined) return;
          totalBytes += data.length;
          if (totalBytes > maxOutputBytes) {
            terminalError = new Error('job output exceeded the maximum size');
            // `detached` gives the job its own process group. Kill the group so descendants cannot
            // outlive the direct child while retaining the injected environment.
            killProcessGroup();
            return;
          }
          chunks.push({ stream, chunk: new Uint8Array(data) });
        };

      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code, signal) => {
        if (terminalError !== undefined) {
          const error = terminalError;
          finish(() => reject(error));
          return;
        }
        // The direct child may have forked background descendants that closed their inherited stdio
        // before it exited. They remain in the detached job process group and retain the injected
        // environment, so normal completion must reap the group just like failure/timeout paths.
        killProcessGroup();
        // A signal-killed child (including our own overflow SIGKILL, already settled) has no exit
        // code; report a non-zero code so the runtime records a failed outcome.
        finish(() => resolve({ chunks, exitCode: code ?? (signal ? 128 : 1) }));
      });
    });
  };
}
