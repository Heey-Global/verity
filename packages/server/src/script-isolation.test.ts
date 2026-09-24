import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  probeScriptSandbox as probeFromBroker,
  runAgentSpawnBroker,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import {
  handleSupervisorRequest,
  probeScriptSandbox as probeFromSupervisor,
  runSupervisor,
  runTrustedCliViaBroker,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { runSupervisorTrustedCli, TrustedCliDispatchError } from '@verity/session';
import {
  createTrustedCliPreflight,
  SCRIPT_ISOLATION_UNAVAILABLE_MESSAGE,
} from './mcp-gateway-tools.js';
import { ControlPlaneSessionToolError } from './session-handoff-tool.js';

// The native helper uses Landlock where available and a private filesystem view
// built with user/mount namespaces under gVisor. If a runtime supports neither,
// the Runner must still start and refuse the paths that require isolation before
// their approval card and again before secrets are written, never run unconfined.

const architecture =
  process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
const prebuiltHelper =
  architecture === undefined
    ? undefined
    : resolve(
        `features/verity-sandbox-toolkit/prebuilt/linux-${architecture}/verity-script-sandbox`,
      );

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verity-script-isolation-'));
  await chmod(root, 0o770);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A helper standing in for a runtime with no supported isolation mechanism. */
async function unavailableHelper(): Promise<string> {
  const helper = join(root, 'verity-script-sandbox-unavailable');
  await writeFile(
    helper,
    [
      '#!/bin/sh',
      'echo "verity-script-sandbox: script isolation is unavailable: Function not implemented" >&2',
      'exit 126',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return helper;
}

async function turnWithTrustedCli(runtimeDir: string, turnId: string, cwd: string) {
  const turnDir = join(runtimeDir, 'turns', turnId);
  await mkdir(turnDir, { recursive: true });
  await writeFile(
    join(turnDir, 'request.json'),
    `${JSON.stringify({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId,
      cwd,
      trustedCliExecution: true,
    })}\n`,
  );
}

async function brokerStatus(socketPath: string): Promise<Record<string, unknown>> {
  const { createConnection } = await import('node:net');
  return await new Promise((resolveStatus, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.once('error', reject);
    socket.on('data', (chunk) => (response += chunk.toString('utf8')));
    socket.once('end', () => resolveStatus(JSON.parse(response) as Record<string, unknown>));
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'status' })}\n`),
    );
  });
}

describe('script sandbox probe', () => {
  it.skipIf(prebuiltHelper === undefined || process.platform !== 'linux')(
    'reports the attested helper as available when a filesystem boundary can be enforced',
    async () => {
      // Copied, as the native-helper suite does: the checkout's own mode bits are
      // not what an installed helper has.
      const helper = join(root, 'verity-script-sandbox');
      await copyFile(prebuiltHelper!, helper);
      await chmod(helper, 0o755);
      await expect(probeFromBroker(helper)).resolves.toEqual({ available: true });
      await expect(probeFromSupervisor(helper)).resolves.toEqual({ available: true });
    },
  );

  it('reports an unavailable isolation helper with its reason', async () => {
    const helper = await unavailableHelper();
    const expected = {
      available: false,
      reason: 'verity-script-sandbox: script isolation is unavailable: Function not implemented',
    };
    await expect(probeFromBroker(helper)).resolves.toEqual(expected);
    await expect(probeFromSupervisor(helper)).resolves.toEqual(expected);
  });

  it('treats a missing helper as unavailable rather than throwing', async () => {
    await expect(probeFromBroker(join(root, 'absent'))).resolves.toMatchObject({
      available: false,
    });
    await expect(probeFromSupervisor(join(root, 'absent'))).resolves.toMatchObject({
      available: false,
    });
  });
});

describe('Runner start without script isolation', () => {
  it('starts the supervisor, reports the capability off, and serves plain requests', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const supervisor = await runSupervisor({
      runtimeDir: root,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      scriptSandboxPath: await unavailableHelper(),
    });
    try {
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('worktree entry scripts are disabled'),
      );
      const { requestRunnerSupervisor } = await import('@verity/session');
      await expect(
        requestRunnerSupervisor(supervisor.socketPath, { kind: 'status' }),
      ).resolves.toMatchObject({ ok: true, scriptIsolation: false, knowledgeIsolation: false });
      await expect(
        requestRunnerSupervisor(supervisor.socketPath, {
          kind: 'claim-turn',
          turnId: 'turn-plain',
          startCommandId: 'start-plain',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
    } finally {
      stderr.mockRestore();
      await supervisor.close();
    }
  });

  it('reports the capability on when the helper probe passes', async () => {
    const supervisor = await runSupervisor({
      runtimeDir: root,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      scriptIsolation: { available: true },
    });
    try {
      const { requestRunnerSupervisor } = await import('@verity/session');
      await expect(
        requestRunnerSupervisor(supervisor.socketPath, { kind: 'status' }),
      ).resolves.toMatchObject({ ok: true, scriptIsolation: true, knowledgeIsolation: true });
    } finally {
      await supervisor.close();
    }
  });

  it('refuses an entry script at the supervisor before it reaches the broker', async () => {
    const runTrustedCli = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const turnStarter = {
      start: vi.fn(),
      runTrustedCli,
    } as unknown as Parameters<typeof handleSupervisorRequest>[3];
    const request = {
      protocolVersion: 1,
      kind: 'run-trusted-cli',
      turnId: 'turn-1',
      secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'canary' }],
      command: ['/bin/sh', '/work/script.sh'],
    };
    const entryScript = {
      path: '/work/script.sh',
      projectPath: 'script.sh',
      sha256: 'a'.repeat(64),
      loading: 'isolated',
    };
    const off = { scriptIsolation: false };
    await expect(
      handleSupervisorRequest(
        root,
        'runner-1',
        { ...request, entryScript },
        turnStarter,
        undefined,
        undefined,
        off,
      ),
    ).rejects.toThrow('worktree script isolation is unavailable');
    expect(runTrustedCli).not.toHaveBeenCalled();
    // The same Sandbox still runs an installed executable with no entry script.
    await expect(
      handleSupervisorRequest(root, 'runner-1', request, turnStarter, undefined, undefined, off),
    ).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(runTrustedCli).toHaveBeenCalledOnce();
    await expect(
      handleSupervisorRequest(
        root,
        'runner-1',
        {
          protocolVersion: 1,
          kind: 'start-turn',
          knowledgeIsolation: true,
        },
        turnStarter,
        undefined,
        undefined,
        off,
      ),
    ).rejects.toThrow('worktree script isolation is unavailable');
  });
});

describe('spawn broker entry scripts', () => {
  async function scriptFixture() {
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    // Readable to the script only if the helper is NOT confining it to its snapshot.
    await writeFile(join(worktree, 'mutable-dependency'), 'unconfined read\n');
    const script = join(worktree, 'deploy.sh');
    const contents = `printf 'token=%s\\n' "$DEPLOY_TOKEN"; cat ${join(worktree, 'mutable-dependency')} || echo confined\n`;
    await writeFile(script, contents, { mode: 0o644 });
    const turnId = 'turn-entry-script';
    await turnWithTrustedCli(root, turnId, worktree);
    return {
      worktree,
      turnId,
      request: {
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        correlationId: 'call-entry-script',
        secrets: [{ secretAlias: 'DEPLOY_TOKEN', env: 'DEPLOY_TOKEN', secret: 'canary-value' }],
        command: ['/bin/sh', script],
        entryScript: {
          path: script,
          projectPath: 'worktree/deploy.sh',
          sha256: createHash('sha256').update(contents).digest('hex'),
          loading: 'isolated' as const,
        },
      },
    };
  }

  async function startBroker(scriptSandboxPath: string, spawned: string[][]) {
    return await runAgentSpawnBroker({
      runtimeDir: root,
      enforceRoot: false,
      // The broker refuses uid 0 for the agent; a root test host still runs the child
      // as itself, since setpriv is skipped below.
      agentUid: process.getuid?.() || 1000,
      agentGid: process.getgid?.() || 1000,
      worktreeRoot: root,
      secretDir: join(root, 'secrets'),
      trustedCliEntryScriptDir: join(root, 'entry-scripts'),
      scriptSandboxPath,
      env: { PATH: '/usr/bin:/bin' },
      // Skip setpriv (the test is unprivileged) and run the argv after it, which
      // starts with the script sandbox helper whenever an entry script is present.
      spawnChild: (_command, args, options) => {
        spawned.push(args.slice(7));
        return spawn(args[7]!, args.slice(8), options);
      },
    });
  }

  it('refuses an entry script before materializing it or its secrets when isolation is unavailable', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const spawned: string[][] = [];
    const broker = await startBroker(await unavailableHelper(), spawned);
    stderr.mockRestore();
    try {
      await expect(brokerStatus(broker.socketPath)).resolves.toMatchObject({
        ok: true,
        scriptIsolation: false,
        knowledgeIsolation: false,
      });
      const { request } = await scriptFixture();
      const refused = await runTrustedCliViaBroker(request, {
        runtimeDir: root,
        brokerSocket: broker.socketPath,
      }).then(
        () => undefined,
        (error: Error & { trustedCliFailure?: unknown }) => error,
      );
      expect(refused?.trustedCliFailure).toEqual({
        phase: 'validation',
        cause: 'validation failed',
        code: 'validation_script_isolation_unavailable',
        correlationId: 'call-entry-script',
      });
      expect(spawned).toEqual([]);
      // Nothing was staged: no snapshot of the approved script, no secret file.
      await expect(readdir(join(root, 'entry-scripts')).catch(() => [])).resolves.toEqual([]);
      await expect(readdir(join(root, 'secrets')).catch(() => [])).resolves.toEqual([]);

      // The rest of trusted CLI keeps working in the same Sandbox. Fresh secrets: the
      // client blanks the ones it sent once a request settles.
      const plain = await runTrustedCliViaBroker(
        {
          turnId: request.turnId,
          secrets: [{ secretAlias: 'DEPLOY_TOKEN', env: 'DEPLOY_TOKEN', secret: 'canary-value' }],
          command: ['/bin/sh', '-c', 'echo "$DEPLOY_TOKEN"'],
        },
        { runtimeDir: root, brokerSocket: broker.socketPath },
      );
      expect(plain).toMatchObject({ exitCode: 0, stdout: '[REDACTED]\n' });
    } finally {
      await broker.close();
    }
  });

  it.skipIf(prebuiltHelper === undefined || process.platform !== 'linux')(
    'confines an approved entry script with the real helper',
    async () => {
      const helper = join(root, 'verity-script-sandbox');
      await copyFile(prebuiltHelper!, helper);
      await chmod(helper, 0o755);
      const spawned: string[][] = [];
      const broker = await startBroker(helper, spawned);
      try {
        await expect(brokerStatus(broker.socketPath)).resolves.toMatchObject({
          scriptIsolation: true,
        });
        const { request } = await scriptFixture();
        const result = await runTrustedCliViaBroker(request, {
          runtimeDir: root,
          brokerSocket: broker.socketPath,
        });
        expect(spawned[0]?.[0]).toBe(helper);
        expect(result).toMatchObject({ exitCode: 0 });
        expect(result.stdout).toContain('token=[REDACTED]');
        // The helper denied the mutable worktree read; the script did not see it.
        expect(result.stdout).toContain('confined');
        expect(result.stdout).not.toContain('unconfined read');
      } finally {
        await broker.close();
      }
    },
  );

  it('relays the refusal to the Server as a named, non-started dispatch failure', async () => {
    const socketDir = join(root, 'project');
    await mkdir(socketDir);
    const { createServer } = await import('node:net');
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          `${JSON.stringify({ ok: false, error: 'worktree script isolation is unavailable' })}\n`,
        );
      });
    });
    await new Promise<void>((listening) =>
      server.listen(join(socketDir, 'supervisor.sock'), listening),
    );
    try {
      const error = await runSupervisorTrustedCli(socketDir, {
        turnId: 'turn-1',
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'canary' }],
        command: ['/bin/sh', '/work/script.sh'],
        entryScript: {
          path: '/work/script.sh',
          projectPath: 'script.sh',
          sha256: 'a'.repeat(64),
          loading: 'isolated',
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TrustedCliDispatchError);
      expect(error).toMatchObject({
        executionStarted: false,
        supervisorRefusal: 'worktree script isolation is unavailable',
      });
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
});

describe('Server pre-approval refusal', () => {
  const call = (request: unknown) => ({
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'verity_secret_run' as const,
    request,
  });
  const entryScriptRequest = {
    secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
    command: ['/bin/sh', '/work/script.sh'],
    entryScript: {
      path: '/work/script.sh',
      projectPath: 'script.sh',
      sha256: 'a'.repeat(64),
      loading: 'isolated',
    },
  };

  it('refuses an entry script before the card when the Sandbox reports no isolation', async () => {
    const requestStatus = vi.fn(async () => ({ ok: true, scriptIsolation: false }));
    const preflight = createTrustedCliPreflight({ runnerRoot: '/srv/runners', requestStatus });
    const refused = await preflight(call(entryScriptRequest)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ControlPlaneSessionToolError);
    expect((refused as Error).message).toBe(SCRIPT_ISOLATION_UNAVAILABLE_MESSAGE);
    expect(requestStatus).toHaveBeenCalledWith('/srv/runners/project-1/supervisor.sock');
  });

  it('lets calls through that do not need isolation, or that the Sandbox can confine', async () => {
    const off = vi.fn(async () => ({ ok: true, scriptIsolation: false }));
    const preflightOff = createTrustedCliPreflight({ runnerRoot: '/r', requestStatus: off });
    await expect(
      preflightOff(call({ ...entryScriptRequest, entryScript: undefined })),
    ).resolves.toBeUndefined();
    await expect(
      preflightOff({ ...call(entryScriptRequest), toolName: 'verity_http_request' }),
    ).resolves.toBeUndefined();
    expect(off).not.toHaveBeenCalled();

    for (const status of [
      async () => ({ ok: true, scriptIsolation: true }),
      // A supervisor from before this field started only after the helper probe passed.
      async () => ({ ok: true }),
      // An unreachable supervisor fails the call on its own after approval, as before.
      async () => Promise.reject(new Error('ECONNREFUSED')),
    ]) {
      const preflight = createTrustedCliPreflight({ runnerRoot: '/r', requestStatus: status });
      await expect(preflight(call(entryScriptRequest))).resolves.toBeUndefined();
    }
  });
});
