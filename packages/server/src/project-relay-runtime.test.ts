import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { DockerClient } from './docker.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ProjectInternalUnixListener } from './internal-listener.js';
import type { ProjectClaudeUnixListener } from './project-claude-unix-listener.js';
import { createProjectRelayRuntime } from './project-relay-runtime.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';

describe('project relay runtime composition', () => {
  it('passes all generation-bound listener paths to the relay starter', async () => {
    const identity = { projectId: 'p1', containerGeneration: 'generation-1' };
    const closeBroker = vi.fn(async () => {});
    const closeClaude = vi.fn(async () => {});
    const closeCodex = vi.fn(async () => {});
    const broker: ProjectInternalUnixListener = {
      identity,
      socketPath: '/data/broker/binding/broker.sock',
      close: closeBroker,
    };
    const claude: ProjectClaudeUnixListener = {
      identity,
      socketPath: '/data/claude/binding/claude.sock',
      close: closeClaude,
    };
    const codex: ProjectClaudeUnixListener = {
      identity,
      socketPath: '/data/codex/binding/codex.sock',
      close: closeCodex,
    };
    const signing = {
      issue: vi.fn(async () => 'sign-cap'),
      resolve: vi.fn(),
      revokeProject: vi.fn(async () => {}),
    } satisfies SigningCapabilityRegistry;
    const github = {
      issue: vi.fn(async () => 'github-cap'),
      resolve: vi.fn(),
      revokeProject: vi.fn(async () => {}),
    } satisfies GhTokenCapabilityRegistry;
    const startRelay = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
    const runtime = createProjectRelayRuntime({
      app: {} as FastifyInstance,
      docker: {} as DockerClient,
      signingCapabilities: signing,
      githubCapabilities: github,
      image: `relay@sha256:${'a'.repeat(64)}`,
      dataVolume: 'data',
      dataVolumeRoot: '/data',
      brokerSocketRoot: '/data/broker',
      claudeSocketRoot: '/data/claude',
      codexSocketRoot: '/data/codex',
      socketOwnerUid: 1000,
      relayGid: 65_532,
      projectNetwork: (projectId) => `verity-proj-${projectId}`,
      startBrokerListener: vi.fn(async () => broker),
      startClaudeListener: vi.fn(async () => claude),
      startCodexListener: vi.fn(async () => codex),
      startRelay,
    });

    await expect(
      runtime.start({
        owner: 'heey-global',
        repo: 'verity',
        ...identity,
        claudeGateway: { host: '127.0.0.1', port: 9443 },
        codexGateway: { host: '127.0.0.1', port: 9444 },
      }),
    ).resolves.toMatchObject({ signingCapability: 'sign-cap', githubCapability: 'github-cap' });
    expect(startRelay).toHaveBeenCalledWith({
      identity,
      brokerSocketPath: broker.socketPath,
      claudeSocketPath: claude.socketPath,
      codexSocketPath: codex.socketPath,
    });
    await runtime.stop('p1');
    expect(closeBroker).toHaveBeenCalledOnce();
    expect(closeClaude).toHaveBeenCalledOnce();
    expect(closeCodex).toHaveBeenCalledOnce();
  });
});
