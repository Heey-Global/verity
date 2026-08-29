import { describe, expect, it, vi } from 'vitest';
import { type Backend, type SpawnedProcess, type Spawner } from '@verity/session';
import { DockerExecBackend, containerPathFor, dockerHostFor } from './project-backend.js';

const AGENT_SEED_PATH =
  'PATH=/opt/agent-seed/bin:/usr/local/share/nvm/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SIGNING_DOCKER_CONTAINER = 'VERITY_SIGNING_DOCKER_CONTAINER=dev-heey-global--verity';
const GH_TOKEN_DOCKER_CONTAINER = 'VERITY_GH_TOKEN_DOCKER_CONTAINER';

function fakeProcess(stdout: string[] = []): SpawnedProcess {
  return {
    stdout: (async function* () {
      for (const chunk of stdout) yield chunk;
    })(),
    pid: 1,
    exited: Promise.resolve(0),
    stderr: () => '',
    kill: () => undefined,
  };
}

describe('containerPathFor (#174)', () => {
  it('maps the host project root to /work', () => {
    expect(containerPathFor('/data/dev/heey-global-verity', '/data/dev/heey-global-verity')).toBe(
      '/work',
    );
  });

  it('maps a host-side project worktree under the bind mount', () => {
    expect(
      containerPathFor(
        '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        '/data/dev/heey-global-verity',
      ),
    ).toBe('/work/.verity-sessions/agent-x');
  });

  it('rejects paths outside the project clone root', () => {
    expect(() => containerPathFor('/data/dev/other', '/data/dev/heey-global-verity')).toThrow(
      /not under project root/,
    );
  });
});

describe('DockerExecBackend (#174)', () => {
  it('reports supervisor compatibility from its wrapped backend', () => {
    expect(
      new DockerExecBackend({
        containerName: 'dev-heey-global--verity',
        hostProjectRoot: '/data/dev/heey-global-verity',
        // The default wrapped backend is the ACP transport (ADR 0012); the native
        // Claude runner it replaced is gone, so `claude-acp` is the only Claude
        // supervisor identity left.
      }).runnerSupervisorBackend,
    ).toBe('claude-acp');

    expect(
      new DockerExecBackend({
        containerName: 'dev-heey-global--verity',
        hostProjectRoot: '/data/dev/heey-global-verity',
        backend: {} as Backend,
      }).runnerSupervisorBackend,
    ).toBeUndefined();

    expect(
      new DockerExecBackend({
        containerName: 'dev-heey-global--verity',
        hostProjectRoot: '/data/dev/heey-global-verity',
        backend: { runnerSupervisorBackend: 'codex-acp' } as Backend,
      }).runnerSupervisorBackend,
    ).toBe('codex-acp');
  });

  it('maps the Docker HTTP base URL to a Docker CLI host', () => {
    expect(dockerHostFor('http://host.docker.internal:9234/v1.41')).toBe(
      'tcp://host.docker.internal:9234',
    );
  });

  it('strips the API-version suffix from a unix base URL so the CLI can dial the socket', () => {
    // ADR 0003 R2: the same env var feeds createDockerClient (which accepts the
    // :/v1.41 suffix) and this CLI-exec path (which cannot). The CLI would
    // otherwise try to dial `/var/run/docker.sock:/v1.41` and fail with ENOENT.
    expect(dockerHostFor('unix:///var/run/docker.sock:/v1.41')).toBe('unix:///var/run/docker.sock');
  });

  it('passes a plain unix base URL through unchanged', () => {
    expect(dockerHostFor('unix:///var/run/docker.sock')).toBe('unix:///var/run/docker.sock');
  });

  it('wraps the Claude ACP adapter spawn in docker exec with the mapped working directory', async () => {
    const spawner = vi.fn<Spawner>(() => fakeProcess());
    const backend = new DockerExecBackend({
      containerName: 'dev-heey-global--verity',
      hostProjectRoot: '/data/dev/heey-global-verity',
      spawner,
    });

    await backend
      .run({
        store: {
          createSession: async () => undefined,
        } as never,
        worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        cwd: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        prompt: 'go',
      })
      .catch(() => undefined);

    expect(spawner).toHaveBeenCalled();
    const [cmd, args, opts] = spawner.mock.calls[0]!;
    expect(cmd).toBe('docker');
    expect(args.slice(0, 12)).toEqual([
      'exec',
      '-i',
      '-e',
      AGENT_SEED_PATH,
      '-e',
      SIGNING_DOCKER_CONTAINER,
      '-e',
      GH_TOKEN_DOCKER_CONTAINER,
      '-w',
      '/work/.verity-sessions/agent-x',
      'dev-heey-global--verity',
      // The agent the wrapper launches is the ACP adapter, not the bare CLI: the
      // sandbox's spawn broker only maps `claude-agent-acp` for Claude now.
      'claude-agent-acp',
    ]);
    expect(opts.cwd).toBe(process.cwd());
    expect(opts.env).toMatchObject({
      VERITY_GH_TOKEN_DOCKER_CONTAINER: 'dev-heey-global--verity',
    });
  });

  it('threads DOCKER_HOST from the configured Docker HTTP base URL', async () => {
    const spawner = vi.fn<Spawner>(() => fakeProcess());
    const backend = new DockerExecBackend({
      containerName: 'dev-heey-global--verity',
      hostProjectRoot: '/data/dev/heey-global-verity',
      dockerBaseUrl: 'http://host.docker.internal:9234/v1.41',
      spawner,
    });

    await backend
      .run({
        store: {
          createSession: async () => undefined,
        } as never,
        worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        cwd: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        env: { PATH: '/usr/bin' },
        prompt: 'go',
      })
      .catch(() => undefined);

    expect(spawner.mock.calls[0]![2].env).toMatchObject({
      PATH: '/usr/bin',
      DOCKER_HOST: 'tcp://host.docker.internal:9234',
    });
  });

  it('projects configured settings into the container environment', async () => {
    const spawner = vi.fn<Spawner>(() => fakeProcess());
    const backend = new DockerExecBackend({
      containerName: 'dev-heey-global--verity',
      hostProjectRoot: '/data/dev/heey-global-verity',
      containerEnv: {
        VERITY_DOPPLER_TOKEN_REF: 'doppler://verity/prod',
        VERITY_PROJECT_DEV_SERVER_URL: 'http://localhost:8081',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
      },
      spawner,
    });

    await backend
      .run({
        store: {
          createSession: async () => undefined,
        } as never,
        worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        cwd: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
        prompt: 'go',
      })
      .catch(() => undefined);

    const args = spawner.mock.calls[0]![1];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        AGENT_SEED_PATH,
        '-e',
        SIGNING_DOCKER_CONTAINER,
        '-e',
        GH_TOKEN_DOCKER_CONTAINER,
        '-e',
        'VERITY_DOPPLER_TOKEN_REF=doppler://verity/prod',
        '-e',
        'VERITY_PROJECT_DEV_SERVER_URL=http://localhost:8081',
        '-e',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]),
    );
    expect(args.join(' ')).not.toContain('oauth-secret');
    expect(spawner.mock.calls[0]![2].env).toMatchObject({
      VERITY_GH_TOKEN_DOCKER_CONTAINER: 'dev-heey-global--verity',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    });
    expect(args.slice(args.indexOf('-w'), args.indexOf('-w') + 3)).toEqual([
      '-w',
      '/work/.verity-sessions/agent-x',
      'dev-heey-global--verity',
    ]);
  });
});

describe('DockerExecBackend.query (one-shot, in-container)', () => {
  it('has no one-shot to delegate to on the default Claude ACP transport', async () => {
    // Not an oversight: `AcpClaudeBackend` withholds `query` on purpose, and the
    // wrapper must surface that as "unavailable" rather than reaching around the
    // supervised boundary for a native `claude -p`.
    const spawner = vi.fn<Spawner>(() => fakeProcess());
    const backend = new DockerExecBackend({
      containerName: 'dev-heey-global--verity',
      hostProjectRoot: '/data/dev/heey-global-verity',
      spawner,
    });
    expect(
      await backend.query({
        prompt: 'name it',
        model: 'claude-sonnet-4-6',
        cwd: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
      }),
    ).toBeUndefined();
    expect(spawner).not.toHaveBeenCalled();
  });

  it('returns undefined when the inner backend has no one-shot', async () => {
    const inner = { run: async () => ({}) } as unknown as Backend;
    const backend = new DockerExecBackend({
      containerName: 'c',
      hostProjectRoot: '/data/dev/heey-global-verity',
      backend: inner,
    });
    expect(
      await backend.query({ prompt: 'x', model: 'm', cwd: '/data/dev/heey-global-verity' }),
    ).toBeUndefined();
  });
});
