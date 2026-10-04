import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import {
  DockerProjectRuntime,
  PREVIEW_FORWARDER_SCRIPT,
  type RuntimeRunner,
} from './project-runtime.js';

const project: ProjectRecord = {
  id: 'p1',
  owner: 'heey-global',
  repo: 'verity',
  containerName: 'dev-heey-global-verity',
  imageRef: null,
  state: 'active',
  provisionError: null,
  provisionWarning: null,
  hiddenAt: null,
  latestReleaseTag: null,
  latestReleaseName: null,
  latestReleaseUrl: null,
  latestReleasePublishedAt: null,
  createdAt: new Date('2026-06-26T00:00:00.000Z'),
  updatedAt: new Date('2026-06-26T00:00:00.000Z'),
  stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
};

describe('DockerProjectRuntime', () => {
  it('starts loopback helpers using the configured container identity', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValue({ stdout: '42000\n', stderr: '', exitCode: 0 });
    const runtime = new DockerProjectRuntime({ runner });
    vi.spyOn(runtime, 'listListeningProcesses').mockResolvedValue([
      { port: 5173, pid: 10, cwd: '/work', command: 'vite', bind: 'loopback' },
    ]);
    expect(await runtime.ensurePreviewTarget(project, 5173)).toBe(42000);
    expect(runner.mock.calls[0]?.[1]).toEqual([
      'exec',
      project.containerName,
      'node',
      '-e',
      PREVIEW_FORWARDER_SCRIPT,
      '5173',
      '127.0.0.1',
    ]);
  });

  it.each(['127.0.0.1', '127.0.0.2', '::1'])(
    'restarts a crashed relay for %s and ignores unrelated live PIDs',
    async (address) => {
      const root = await mkdtemp(join(tmpdir(), 'verity-relay-test-'));
      const target = createServer((socket) => socket.end('hello'));
      await new Promise<void>((resolve) => target.listen(0, address, resolve));
      const port = (target.address() as { port: number }).port;
      let pid: number | undefined;
      const run = async () =>
        Number(
          (
            await promisify(execFile)(
              process.execPath,
              ['-e', PREVIEW_FORWARDER_SCRIPT, String(port), address],
              { env: { ...process.env, VERITY_PREVIEW_FORWARDER_STATE_DIR: root } },
            )
          ).stdout.trim(),
        );
      try {
        const relay = await run();
        const body = await new Promise<string>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: relay });
          let value = '';
          socket.on('data', (chunk) => {
            value += chunk.toString();
          });
          socket.on('end', () => resolve(value));
          socket.on('error', reject);
        });
        expect(body).toBe('hello');
        pid = JSON.parse(await readFile(join(root, `${port}.json`), 'utf8')).pid;
        expect(await run()).toBe(relay);
        process.kill(pid!, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeFile(
          join(root, `${port}.json`),
          JSON.stringify({ pid: process.pid, port: relay }),
        );
        expect(await run()).toBe(relay);
        const restarted = JSON.parse(await readFile(join(root, `${port}.json`), 'utf8'));
        pid = restarted.pid;
        expect(restarted.pid).not.toBe(process.pid);
        const otherAddress = address === '127.0.0.2' ? '127.0.0.1' : '127.0.0.2';
        await promisify(execFile)(
          process.execPath,
          ['-e', PREVIEW_FORWARDER_SCRIPT, String(port), otherAddress],
          { env: { ...process.env, VERITY_PREVIEW_FORWARDER_STATE_DIR: root } },
        );
        const changed = JSON.parse(await readFile(join(root, `${port}.json`), 'utf8'));
        expect(changed.pid).not.toBe(pid);
        pid = changed.pid;
      } finally {
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            // The relay may already have exited with its source listener.
          }
        }
        target.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['IPv6 wildcard', '00000000000000000000000000000000', '[true]', true],
    ['IPv6 wildcard', '00000000000000000000000000000000', '[false]', false],
    ['specific IPv4', '030014AC', '[true]', true],
    ['specific IPv4', '030014AC', '[false]', false],
  ])('probes IPv4 reachability for %s (%s)', async (kind, address, probeResult, reachable) => {
    const output = [
      '#tcp',
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      `   0: ${address}:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 21 1 0`,
      '#fd',
      '/proc/40/fd:',
      'lrwx------ 1 dev dev 64 Sep 30 13:07 18 -> socket:[21]',
      '#proc',
      'P\t40\t/work/sessions/s1\tnode server.js',
    ].join('\n');
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce({ stdout: output, stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: probeResult, stderr: '', exitCode: 0 });
    const processes = await new DockerProjectRuntime({ runner }).listListeningProcesses(project);

    expect(runner.mock.calls[0]?.[1]).not.toContain('--user');
    expect(processes).toEqual([expect.objectContaining({ port: 5173, reachable })]);
    expect(processes[0]?.ipv6Wildcard).toBe(kind === 'IPv6 wildcard' ? true : undefined);
    expect(runner.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['exec', project.containerName, 'node', '-e', '5173']),
    );
  });

  it('runs an Agent Loop script inside its session worktree with hard bounds', async () => {
    const runner = vi.fn<RuntimeRunner>().mockResolvedValue({
      stdout: '{"spawn":true}\n',
      stderr: '',
      exitCode: 0,
    });
    const runtime = new DockerProjectRuntime({ runner });
    const result = await runtime.runAgentLoopScript(
      project,
      {
        defaultBranch: null,
        defaultModel: null,
      },
      {
        workdir: '/work/.verity-sessions/loop-1',
        script: './check.sh',
        timeoutMs: 120_000,
        maxOutputBytes: 65_536,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(runner).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-i',
        '-w',
        '/work/.verity-sessions/loop-1',
        'dev-heey-global-verity',
        'timeout',
        '--signal=TERM',
        '--kill-after=5s',
        '120s',
        'sh',
        '-lc',
        './check.sh',
      ]),
      expect.objectContaining({
        timeoutMs: 130_000,
        maxBuffer: 65_536,
        env: expect.objectContaining({ DOPPLER_TOKEN: '' }),
      }),
    );
    const execArgs = runner.mock.calls[0]?.[1] ?? [];
    expect(execArgs).toContain('DOPPLER_TOKEN');
    expect(execArgs).toContain('VERITY_DOPPLER_TOKEN_REF=');
  });

  it('starts the configured command detached inside the project container', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({
      dockerBaseUrl: 'http://host.docker.internal:9234/v1.41',
      runner,
    });

    const result = await runtime.startDevServer(project, {
      defaultBranch: 'main',
      defaultModel: 'codex/default',
      devServerCommand: 'pnpm dev',
      devServerUrl: 'http://localhost:8081',
    });

    expect(result).toEqual({
      projectId: 'p1',
      url: 'http://localhost:8081',
      running: true,
      pid: '123',
    });
    expect(runner.mock.calls[0]![1].at(-1)).not.toContain('then;');
    expect(runner.mock.calls[1]![1].at(-1)).not.toContain('then;');
    expect(runner).toHaveBeenNthCalledWith(
      1,
      'docker',
      expect.arrayContaining(['exec', 'dev-heey-global-verity', 'sh', '-lc']),
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_HOST: 'tcp://host.docker.internal:9234' }),
      }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      'docker',
      expect.arrayContaining([
        'exec',
        '-d',
        '-e',
        'VERITY_PROJECT_DEFAULT_BRANCH=main',
        '-w',
        '/work',
        'dev-heey-global-verity',
        'sh',
        '-lc',
        expect.stringContaining('pnpm dev'),
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_HOST: 'tcp://host.docker.internal:9234' }),
      }),
    );
  });

  it('starts in a configured session workdir when one is set', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });

    await runtime.startDevServer(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: null,
      devServerWorkdir: '/work/.verity-sessions/agent-a',
    });

    expect(runner.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['-w', '/work/.verity-sessions/agent-a']),
    );
  });

  it('anchors a relative workdir at the container project root', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });

    await runtime.startDevServer(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'python3 -m http.server 3000',
      devServerUrl: null,
      devServerWorkdir: 'docs/website/site',
    });

    expect(runner.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['-w', '/work/docs/website/site']),
    );
  });

  it('anchors a relative workdir at a configured containerProjectRoot', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner, containerProjectRoot: '/repo' });

    await runtime.startDevServer(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: null,
      devServerWorkdir: 'apps/web',
    });

    expect(runner.mock.calls[1]![1]).toEqual(expect.arrayContaining(['-w', '/repo/apps/web']));
  });

  it('rebases an absolute project workdir onto the active preview checkout', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });

    await runtime.startDevServer(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: null,
      devServerWorkdir: '/work/apps/web',
      devServerCheckoutRoot: '/work/.verity-sessions/agent-a',
    });

    expect(runner.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['-w', '/work/.verity-sessions/agent-a/apps/web']),
    );
  });

  it('preserves an absolute workdir outside the project checkout', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 123\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });

    await runtime.startDevServer(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: null,
      devServerWorkdir: '/opt/shared/web',
      devServerCheckoutRoot: '/work/.verity-sessions/agent-a',
    });

    expect(runner.mock.calls[1]![1]).toEqual(expect.arrayContaining(['-w', '/opt/shared/web']));
  });

  it('rejects an empty command before shelling out', async () => {
    const runner = vi.fn<RuntimeRunner>(async () => undefined);
    const runtime = new DockerProjectRuntime({ runner });

    await expect(
      runtime.startDevServer(project, {
        defaultBranch: null,
        defaultModel: null,
        devServerCommand: '  ',
        devServerUrl: null,
      }),
    ).rejects.toThrow(/not configured/);
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports, stops, and tails the tracked dev-server pid', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce({ stdout: 'running 456\n', stderr: '' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'ready\nlistening\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });
    const settings = {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: 'http://localhost:8081',
    };

    await expect(runtime.devServerStatus(project, settings)).resolves.toEqual({
      projectId: 'p1',
      url: 'http://localhost:8081',
      running: true,
      pid: '456',
    });
    await expect(runtime.stopDevServer(project, settings)).resolves.toEqual({
      projectId: 'p1',
      url: 'http://localhost:8081',
      running: false,
      pid: null,
    });
    await expect(runtime.devServerLogs(project)).resolves.toEqual({
      projectId: 'p1',
      logs: 'ready\nlistening\n',
    });
    expect(runner.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['exec', 'dev-heey-global-verity', 'sh', '-lc']),
    );
    expect(runner.mock.calls[2]![1]).toEqual(
      expect.arrayContaining(['exec', 'dev-heey-global-verity', 'sh', '-lc']),
    );
    expect(runner.mock.calls[0]![1].at(-1)).not.toContain('then;');
    expect(runner.mock.calls[1]![1].at(-1)).not.toContain('then;');
    expect(runner.mock.calls[2]![1].at(-1)).not.toContain('then;');
    expect(runner.mock.calls[2]![1].at(-1)).toContain('tail -n 200');
  });

  it('isolates pid and log files by stable dev-server id', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 101\n', stderr: '' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 202\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'web ready\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'docs ready\n', stderr: '' });
    const runtime = new DockerProjectRuntime({ runner });
    const base = {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'npm run dev',
      devServerUrl: null,
    };

    await runtime.startDevServer(project, { ...base, devServerId: 'web' });
    await runtime.startDevServer(project, {
      ...base,
      devServerId: 'docs/server',
      devServerCommand: 'npm run docs',
    });
    await runtime.devServerLogs(project, { devServerId: 'web' });
    await runtime.devServerLogs(project, { devServerId: 'docs/server' });

    const scripts = runner.mock.calls.map((call) => String(call[1].at(-1)));
    expect(scripts[0]).toContain('dev-server-web.pid');
    expect(scripts[1]).toContain('dev-server-web.log');
    expect(scripts[3]).toContain('dev-server-docs_server.pid');
    expect(scripts[4]).toContain('dev-server-docs_server.log');
    expect(scripts[6]).toContain('dev-server-web.log');
    expect(scripts[7]).toContain('dev-server-docs_server.log');
    expect(scripts[3]).not.toContain('dev-server-web.pid');
  });

  it('adopts legacy pid and log files for the first migrated dev server', async () => {
    const runner = vi.fn<RuntimeRunner>().mockResolvedValue({
      stdout: 'running 123\n',
      stderr: '',
    });
    const runtime = new DockerProjectRuntime({ runner });

    await runtime.devServerStatus(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerId: 'server-1',
      adoptLegacyDevServerFiles: true,
      devServerCommand: 'npm run dev',
      devServerUrl: null,
    });

    const script = String(runner.mock.calls[0]![1].at(-1));
    expect(script).toContain('dev-server.pid');
    expect(script).toContain('mv');
    expect(script).toContain('dev-server-server-1.pid');
    expect(script).toContain('dev-server-server-1.log');
  });

  it('starts dev servers in their own process group and stops the process tree', async () => {
    const runner = vi
      .fn<RuntimeRunner>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stdout: 'running 456\n', stderr: '' })
      .mockResolvedValueOnce(undefined);
    const runtime = new DockerProjectRuntime({ runner });
    const settings = {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'npm run dev -- --port 3000',
      devServerUrl: 'http://localhost:3000',
    };

    await runtime.startDevServer(project, settings);
    await runtime.stopDevServer(project, settings);

    const start = String(runner.mock.calls[1]![1].at(-1));
    const stop = String(runner.mock.calls[3]![1].at(-1));
    expect(start).toContain('setsid sh -lc');
    expect(start).toContain('npm run dev -- --port 3000');
    expect(stop).toContain('kill -TERM "-$pid"');
    expect(stop).toContain('kill -KILL "-$pid"');
  });

  it('checks the configured dev-server URL health', async () => {
    const healthFetch = vi.fn(async () => ({ status: 204 }));
    const runtime = new DockerProjectRuntime({
      runner: vi.fn<RuntimeRunner>(async () => undefined),
      healthFetch,
    });

    await expect(
      runtime.devServerHealth(project, {
        defaultBranch: null,
        defaultModel: null,
        devServerCommand: 'pnpm dev',
        devServerUrl: 'http://localhost:8081',
      }),
    ).resolves.toMatchObject({
      projectId: 'p1',
      url: 'http://localhost:8081',
      reachable: true,
      status: 204,
      error: null,
    });
    expect(healthFetch).toHaveBeenCalledWith(
      'http://localhost:8081/',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  it('probes the Docker host rather than its own loopback when Docker is remote', async () => {
    const healthFetch = vi.fn(async () => ({ status: 204 }));
    const runtime = new DockerProjectRuntime({
      dockerBaseUrl: 'http://host.docker.internal:9234/v1.41',
      healthFetch,
    });
    await runtime.devServerHealth(project, {
      defaultBranch: null,
      defaultModel: null,
      devServerCommand: 'pnpm dev',
      devServerUrl: 'http://localhost:8081',
    });
    expect(healthFetch).toHaveBeenCalledWith(
      'http://host.docker.internal:8081/',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('falls back to GET when HEAD is not allowed and records failures', async () => {
    const healthFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 405 })
      .mockRejectedValueOnce(new Error('connection refused'));
    const runtime = new DockerProjectRuntime({
      runner: vi.fn<RuntimeRunner>(async () => undefined),
      healthFetch,
    });

    await expect(
      runtime.devServerHealth(project, {
        defaultBranch: null,
        defaultModel: null,
        devServerCommand: 'pnpm dev',
        devServerUrl: 'http://localhost:8081',
      }),
    ).resolves.toMatchObject({
      projectId: 'p1',
      url: 'http://localhost:8081',
      reachable: false,
      status: null,
      error: 'connection refused',
    });
    expect(healthFetch).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8081/',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('rejects non-loopback and credential-bearing health URLs without fetching', async () => {
    const healthFetch = vi.fn(async () => ({ status: 204 }));
    const runtime = new DockerProjectRuntime({
      runner: vi.fn<RuntimeRunner>(async () => undefined),
      healthFetch,
    });

    for (const devServerUrl of [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.2:3000',
      'https://user:secret@localhost:3000',
      'file:///etc/passwd',
    ]) {
      await expect(
        runtime.devServerHealth(project, {
          defaultBranch: null,
          defaultModel: null,
          devServerCommand: 'pnpm dev',
          devServerUrl,
        }),
      ).resolves.toMatchObject({
        reachable: false,
        status: null,
        error: expect.stringMatching(/loopback/),
      });
    }
    expect(healthFetch).not.toHaveBeenCalled();
  });

  it('does not follow health-check redirects', async () => {
    const healthFetch = vi.fn(async () => ({ status: 302 }));
    const runtime = new DockerProjectRuntime({
      runner: vi.fn<RuntimeRunner>(async () => undefined),
      healthFetch,
    });
    await expect(
      runtime.devServerHealth(project, {
        defaultBranch: null,
        defaultModel: null,
        devServerCommand: 'pnpm dev',
        devServerUrl: 'http://localhost:3000',
      }),
    ).resolves.toMatchObject({ reachable: true, status: 302 });
    expect(healthFetch).toHaveBeenCalledWith(
      'http://localhost:3000/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});

it('uses the resolved agent identity and original loopback address', async () => {
  const runner = vi.fn<RuntimeRunner>().mockResolvedValue({ stdout: '42000', stderr: '' });
  const runtime = new DockerProjectRuntime({ runner, resolveUser: async () => '2000:2000' });
  vi.spyOn(runtime, 'listListeningProcesses').mockResolvedValue([
    {
      port: 5173,
      pid: 10,
      cwd: '/work',
      command: 'vite',
      bind: 'loopback',
      loopbackAddress: '::1',
    },
  ]);
  expect(await runtime.ensurePreviewTarget(project, 5173)).toBe(42000);
  expect(runner.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--user', '2000:2000']));
  expect(runner.mock.calls[0]?.[1].at(-1)).toBe('::1');
});
