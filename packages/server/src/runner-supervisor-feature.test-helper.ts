import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { runSupervisor as runSupervisorRuntime } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  runAgentSpawnBroker as runAgentSpawnBrokerRuntime,
  validateTrustedCliArguments as validateTrustedCliArgumentsRuntime,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

// Helpers shared by the runner supervisor feature suites.

export const execFileAsync = promisify(execFile);
export const connectorLauncher = resolve(
  'features/verity-sandbox-toolkit/bin/verity-egress-connector-start',
);
export const NATIVE_WORKER_SETTLE_TIMEOUT_MS = 5_000;
// Keep broker fixtures independent of the host image's runner-writable
// /usr/local/bin; dedicated tests below still cover mutable PATH rejection.
export const IMMUTABLE_EXECUTABLE_PATH = '/usr/bin:/bin';

export const validateTrustedCliArguments: typeof validateTrustedCliArgumentsRuntime = (
  command,
  args,
  cwd,
  executablePath = IMMUTABLE_EXECUTABLE_PATH,
  ...rest
) => validateTrustedCliArgumentsRuntime(command, args, cwd, executablePath, ...rest);

export function runAgentSpawnBroker(options: Parameters<typeof runAgentSpawnBrokerRuntime>[0]) {
  const testIdentity =
    options.enforceRoot === false
      ? { agentUid: process.getuid?.() ?? 0, agentGid: process.getgid?.() ?? 0 }
      : {};
  return runAgentSpawnBrokerRuntime({
    // The helper is not installed on a test host; script-isolation.test.ts owns the probe.
    scriptIsolation: { available: true },
    worktreeRoot: options.runtimeDir ?? tmpdir(),
    ...options,
    ...testIdentity,
    env: { ...options.env, PATH: options.env?.PATH ?? IMMUTABLE_EXECUTABLE_PATH },
  });
}

export type RunSupervisorOptions = Parameters<typeof runSupervisorRuntime>[0];

export function runSupervisor(options: RunSupervisorOptions = {}) {
  return runSupervisorRuntime({
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    scriptIsolation: { available: true },
    ...options,
  });
}

export async function supervisorRequest(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frames = await supervisorRequestFrames(socketPath, payload);
  return frames.at(-1) ?? {};
}

export async function supervisorRequestFrames(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  return await new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.once('error', rejectReply);
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      const frames = response
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolveReply(frames);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
  });
}

/**
 * Send several requests that must be IN FLIGHT TOGETHER.
 *
 * `Promise.all` over independent connect-then-write round trips does not give that:
 * on a host that schedules unkindly, each request can be answered before the next
 * socket even connects, and a test about a full queue quietly becomes a test about
 * six starts in a row. Connecting everything first and only then writing removes the
 * scheduling from the question — the frames land while the first start is still
 * awaiting its own filesystem work.
 */
export async function supervisorRequestsTogether(
  socketPath: string,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const frames = await supervisorRequestFramesTogether(socketPath, payloads);
  return frames.map((lines) => lines.at(-1) ?? {});
}

/**
 * The same burst, keeping EVERY frame each connection received.
 *
 * What a two-phase reply refuses to say matters as much as what it says: a refusal
 * that arrives on its own proves the supervisor never acknowledged the start, which
 * is the difference between a turn the Server may retry and one it has to fence.
 * Collapsing each connection to its last frame hides exactly that.
 */
export async function supervisorRequestFramesTogether(
  socketPath: string,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[][]> {
  const pending = payloads.map(async (payload) => {
    const socket = createConnection(socketPath);
    let response = '';
    const connected = new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('connect', () => resolveConnect());
      socket.once('error', rejectConnect);
    });
    const replied = new Promise<Record<string, unknown>[]>((resolveReply, rejectReply) => {
      socket.once('error', rejectReply);
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });
      socket.once('end', () => {
        resolveReply(
          response
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
      });
    });
    await connected;
    return { payload, socket, replied };
  });
  const ready = await Promise.all(pending);
  for (const { socket, payload } of ready) socket.write(`${JSON.stringify(payload)}\n`);
  return await Promise.all(ready.map(async ({ replied }) => await replied));
}

/** Every source module of the Runner supervisor, joined: the code of record. The
 *  shipped bin/ file is bundled from these, and the bundler reformats and may rename. */
export async function supervisorSources(): Promise<string> {
  const dir = 'features/verity-sandbox-toolkit/src/runner-supervisor';
  const files = (await readdir(dir)).filter((file) => file.endsWith('.mjs')).sort();
  return (await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))).join('\n');
}
