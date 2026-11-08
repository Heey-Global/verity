import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, chown, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
  runnerStackHealth,
  runAgentSpawnBroker,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { runSupervisor } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { requestRunnerSupervisor } from '@verity/session';
import { classifyProbeError } from './sandbox-turn-readiness.js';

const execFileAsync = promisify(execFile);
const controlDir = '/fixed-broker';
function stat(pid: number, start: string) {
  return `${pid} (node worker) ${Array.from({ length: 20 }, (_, index) => (index === 19 ? start : '0')).join(' ')}`;
}
function fixture() {
  const env: NodeJS.ProcessEnv = {
    VERITY_MEMORY_GUARD: '0',
    VERITY_CLAUDE_CONNECTOR_PORT: '8181',
    VERITY_CLAUDE_CONNECTOR_AUTHORITY: '127.0.0.1:8181',
    VERITY_CLAUDE_EGRESS_URL: 'https://gateway.test/claude',
    VERITY_CLAUDE_EGRESS_AUTHORITY: 'gateway.test',
    VERITY_CLAUDE_EGRESS_SERVERNAME: 'gateway.test',
    VERITY_CODEX_EGRESS_URL: 'https://gateway.test/codex',
    VERITY_CODEX_EGRESS_AUTHORITY: 'gateway.test',
    VERITY_CLAUDE_EGRESS_CA: '/tls/ca',
    VERITY_CLAUDE_EGRESS_CERT: '/tls/cert',
    VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE: '/tls/key',
  };
  const files = new Map([
    ['/tls/ca', 'synthetic-ca'],
    ['/tls/cert', 'synthetic-cert'],
    ['/tls/key', 'synthetic-key'],
    ['/proc/42/stat', stat(42, '123')],
    ['/proc/42/cmdline', 'node\0/usr/local/bin/verity-egress-connector\0'],
  ]);
  const read = (path: string): string => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  };
  const fingerprint = () => {
    const hash = createHash('sha256');
    hash.update(
      [
        env.VERITY_CLAUDE_EGRESS_URL,
        env.VERITY_CLAUDE_EGRESS_AUTHORITY,
        env.VERITY_CLAUDE_EGRESS_SERVERNAME,
        env.VERITY_CODEX_EGRESS_URL,
        env.VERITY_CODEX_EGRESS_AUTHORITY,
      ].join('\0') + '\0',
    );
    for (const path of ['/tls/ca', '/tls/cert', '/tls/key'])
      hash.update(`${createHash('sha256').update(read(path)).digest('hex')}  ${path}\n`);
    return hash.digest('hex');
  };
  files.set(`${controlDir}/egress-connector.pid`, `42 123 ${fingerprint()}`);
  const fetch = vi.fn(async () => new Response('{"ready":true}'));
  return {
    env,
    files,
    read,
    fingerprint,
    fetch,
    options: { env, controlDir, readFile: read, fetch },
  };
}

it('checks existing services without requiring optional disabled services', async () => {
  const readFile = vi.fn(() => {
    throw new Error('no optional files');
  });
  const result = await runnerStackHealth({ env: { VERITY_MEMORY_GUARD: '0' }, readFile });
  expect(result).toEqual({
    ok: true,
    stackHealthVersion: 1,
    healthy: true,
    memoryGuard: true,
    connector: true,
  });
  expect(readFile).not.toHaveBeenCalled();
});

it('detects a missing or replaced memory guard only where its protection applies', async () => {
  const f = fixture();
  delete f.env.VERITY_CLAUDE_CONNECTOR_PORT;
  delete f.env.VERITY_MEMORY_GUARD;
  f.files.set('/proc/version', 'Linux gvisor');
  f.files.set('/sys/fs/cgroup/memory.max', '1000000');
  f.files.set('/sys/fs/cgroup/memory.current', '100');
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, memoryGuard: false });
  f.files.set(`${controlDir}/memory-guard.pid`, '43 456');
  f.files.set('/proc/43/stat', stat(43, '456'));
  f.files.set('/proc/43/cmdline', 'node\0/usr/local/bin/verity-memory-guard\0');
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: true, memoryGuard: true });
  f.files.set('/proc/43/stat', stat(43, '457'));
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, memoryGuard: false });
  f.env.VERITY_MEMORY_GUARD = '0';
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: true });
  delete f.env.VERITY_MEMORY_GUARD;
  f.files.set('/proc/version', 'Linux ordinary kernel');
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: true });
  f.files.set('/proc/version', 'Linux gvisor');
  f.files.set('/sys/fs/cgroup/memory.max', 'max');
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: true });
});

it('requires live connector identity, readiness and unchanged credentials without exposing them', async () => {
  const f = fixture();
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: true, connector: true });
  expect(f.fetch).toHaveBeenCalledWith(
    'http://127.0.0.1:8181/__verity/ready',
    expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
  );
  f.files.set('/proc/42/stat', stat(42, '124'));
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, connector: false });
  f.files.set('/proc/42/stat', stat(42, '123'));
  f.files.set('/proc/42/cmdline', 'node\0some-other-service\0');
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, connector: false });
  f.files.set('/proc/42/cmdline', 'node\0/usr/local/bin/verity-egress-connector\0');
  f.fetch.mockResolvedValueOnce(new Response('{"ready":false}'));
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, connector: false });
  f.fetch.mockRejectedValueOnce(new Error('synthetic-private-failure'));
  const unavailable = await runnerStackHealth(f.options);
  expect(unavailable).toMatchObject({ healthy: false, connector: false });
  expect(JSON.stringify(unavailable)).not.toContain('synthetic');
  f.files.set('/tls/key', 'rotated-synthetic-key');
  const calls = f.fetch.mock.calls.length;
  expect(await runnerStackHealth(f.options)).toMatchObject({ healthy: false, connector: false });
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.files.set(`${controlDir}/egress-connector.pid`, `42 123 ${f.fingerprint()}`);
  const restored = await runnerStackHealth(f.options);
  expect(restored).toMatchObject({ healthy: true, connector: true });
  expect(JSON.stringify(restored)).not.toMatch(/synthetic|\/tls|fingerprint|gateway/);
});

it('matches the real launcher configuration fingerprint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-stack-fingerprint-'));
  try {
    await chmod(directory, 0o755);
    const f = fixture();
    const uid = Math.max(1, process.getuid?.() ?? 1000);
    const gid = Math.max(1, process.getgid?.() ?? 1000);
    const contents = new Map<string, string>();
    for (const name of [
      'VERITY_CLAUDE_EGRESS_CA',
      'VERITY_CLAUDE_EGRESS_CERT',
      'VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE',
    ]) {
      const path = join(directory, name);
      await writeFile(path, `synthetic-${name}`, { mode: 0o640 });
      if (process.getuid?.() === 0) await chown(path, 0, gid);
      f.env[name] = path;
      contents.set(path, await readFile(path, 'utf8'));
    }
    const { stdout } = await execFileAsync(
      'bash',
      [
        resolve('features/verity-sandbox-toolkit/bin/verity-egress-connector-start'),
        '--config-fingerprint',
      ],
      {
        env: {
          ...process.env,
          ...f.env,
          VERITY_RUNNER_RUNTIME_UID: String(uid),
          VERITY_RUNNER_RUNTIME_GID: String(gid),
        },
      },
    );
    f.files.set(`${controlDir}/egress-connector.pid`, `42 123 ${stdout.trim()}`);
    const readHealthFile = (path: string) => contents.get(path) ?? f.read(path);
    expect(await runnerStackHealth({ ...f.options, readFile: readHealthFile })).toMatchObject({
      healthy: true,
      connector: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function request(socketPath: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('health request timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });
    socket.once('end', () => {
      try {
        resolveRequest(JSON.parse(response.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Supervisor socket request failed', { cause: error }),
        );
      }
    });
  });
}

it('exposes health through existing broker and supervisor sockets, ignoring caller-selected paths', async () => {
  const directory = await mkdtemp('/tmp/verity-stack-socket-');
  await chmod(directory, 0o770);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const broker = await runAgentSpawnBroker({
    runtimeDir: directory,
    worktreeRoot: directory,
    enforceRoot: false,
    agentUid: Math.max(1, uid),
    agentGid: Math.max(1, gid),
    scriptIsolation: { available: true },
    env: { PATH: '/usr/bin:/bin', VERITY_MEMORY_GUARD: '0' },
  });
  let supervisor: Awaited<ReturnType<typeof runSupervisor>> | undefined;
  const previousSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  try {
    const payload = {
      protocolVersion: 1,
      kind: 'stack-health',
      controlDir: '/caller-private',
      env: { VERITY_CLAUDE_CONNECTOR_PORT: '1' },
    };
    expect(await request(broker.socketPath, payload)).toMatchObject({
      healthy: true,
      stackHealthVersion: 1,
    });
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    supervisor = await runSupervisor({
      runtimeDir: directory,
      uid,
      gid,
      scriptIsolation: { available: true },
      brokerSocket: broker.socketPath,
    });
    expect(await request(supervisor.socketPath, payload)).toMatchObject({
      healthy: true,
      stackHealthVersion: 1,
    });
  } finally {
    if (previousSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousSocket;
    await supervisor?.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// The turn-start gate reaches this through the same sockets as stack health. The
// targets come from the Sandbox's own environment: a caller naming its own hosts
// must not turn the probe into a connect-anywhere primitive.
it('exposes egress readiness through the broker and supervisor sockets', async () => {
  const directory = await mkdtemp('/tmp/verity-egress-socket-');
  await chmod(directory, 0o770);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
  const refusedPort = (closed.address() as AddressInfo).port;
  await new Promise((done) => closed.close(done));
  const broker = await runAgentSpawnBroker({
    runtimeDir: directory,
    worktreeRoot: directory,
    enforceRoot: false,
    agentUid: Math.max(1, uid),
    agentGid: Math.max(1, gid),
    scriptIsolation: { available: true },
    env: {
      PATH: '/usr/bin:/bin',
      VERITY_MEMORY_GUARD: '0',
      VERITY_CODEX_EGRESS_URL: `https://127.0.0.1:${String(refusedPort)}`,
    },
  });
  let supervisor: Awaited<ReturnType<typeof runSupervisor>> | undefined;
  const previousSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  try {
    const payload = {
      protocolVersion: 1,
      kind: 'egress-readiness',
      env: { VERITY_CODEX_EGRESS_URL: 'https://elsewhere.invalid:1' },
    };
    const expected = {
      ok: true,
      egressReadinessVersion: 1,
      connector: 'not_configured',
      claude: 'not_configured',
      codex: 'refused',
      broker: 'not_configured',
    };
    expect(await request(broker.socketPath, payload)).toEqual(expected);
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    supervisor = await runSupervisor({
      runtimeDir: directory,
      uid,
      gid,
      scriptIsolation: { available: true },
      brokerSocket: broker.socketPath,
    });
    expect(await request(supervisor.socketPath, payload)).toEqual(expected);
  } finally {
    if (previousSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousSocket;
    await supervisor?.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// A Sandbox built from a toolkit without `egress-readiness` refuses it the way
// it refuses any request it does not know. That refusal must let the turn
// through as before, never park it on a 90 second wait.
it('reads a supervisor that does not know the readiness request as an older toolkit', async () => {
  const directory = await mkdtemp('/tmp/verity-egress-old-');
  await chmod(directory, 0o770);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const supervisor = await runSupervisor({
    runtimeDir: directory,
    uid,
    gid,
    scriptIsolation: { available: true },
    brokerSocket: join(directory, 'absent-broker.sock'),
  });
  try {
    const refusal = await requestRunnerSupervisor(
      supervisor.socketPath,
      { kind: 'egress-readiness-from-a-later-release' },
      2_000,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(classifyProbeError(refusal)).toEqual({ kind: 'unsupported' });
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});
