import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { buildTestEmbeddedServer } from './testing.js';

it('composes protected gVisor without preview activation and rejects privilege additions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-embedded-egress-'));
  const command = vi.fn(async (): Promise<never> => {
    throw new Error('No project should be admitted');
  });
  const projectEgress = new ProjectEgressLifecycle(command, {});
  const config = {
    projectEgress,
    dataVolume: 'verity-egress-test-data',
    dataVolumeRoot: directory,
    hostCloneRoot: join(directory, 'projects'),
    dockerBaseUrl: 'http://127.0.0.1:1',
    projectRelayImage: `example.test/relay@sha256:${'0'.repeat(64)}`,
    projectRelayGid: process.getgid?.() ?? 1000,
    claudeEgressGatewayUrl: 'https://gateway:9443',
    codexEgressGatewayUrl: 'https://gateway:9444',
    claudeConnectorPort: 9444,
    agentGatewayUrl: 'https://gateway:9443',
    agentGatewayClaudePort: 9443,
    agentGatewayControlSocket: join(directory, 'gateway.sock'),
    agentGatewayUnsealKey: 'a'.repeat(64),
    dockerGc: false,
  };
  try {
    const server = await buildTestEmbeddedServer(config);
    await server.close();
    expect(command).not.toHaveBeenCalled();
    await expect(
      buildTestEmbeddedServer({ ...config, sandboxCapAdd: ['NET_ADMIN'] }),
    ).rejects.toThrow(
      'Experimental egress requires the isolated gVisor runtime without added privileges',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
