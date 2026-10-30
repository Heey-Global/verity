/** Disposable boot fixture: the real EmbeddedServer with persistent test PostgreSQL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTestEmbeddedServer } from '../../../packages/server/src/testing.js';
import { createDockerClient } from '../../../packages/server/src/docker.js';
import { createProjectEgressHostClient } from '../../../packages/server/src/project-egress-host-client.js';
import { ProjectEgressLifecycle } from '../../../packages/server/src/project-egress-lifecycle.js';
import { startAgentGatewayRuntime } from '../../../packages/server/src/agent-gateway-runtime.js';

assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
const root = '/var/lib/verity-egress-fixture';
const config = JSON.parse(await readFile(`${root}/config.json`, 'utf8')) as {
  runnerImage: string;
  relayImage: string;
  dataRoot: string;
  gatewayKey: string;
};
const gatewaySocket = `${root}/gateway.sock`;
if (process.argv[2] === 'gateway') {
  const gateway = await startAgentGatewayRuntime({
    controlSocketPath: gatewaySocket,
    healthPort: 9080,
    healthHost: '127.0.0.1',
    claudePort: 9443,
    claudeHost: '127.0.0.1',
    claudeListenerAuthority: 'verity-agent-gateway:9443',
    spillPath: `${root}/gateway.spill`,
    codexPort: 9444,
    codexHost: '127.0.0.1',
    codexListenerAuthority: 'verity-agent-gateway:9444',
  });
  process.on('SIGTERM', () => {
    void gateway.close().then(() => process.exit(0));
  });
} else {
  assert.equal(process.argv[2], 'server');
  const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
  const command = createProjectEgressHostClient({
    socketPath: '/run/verity-egress/control.sock',
    token: (await readFile('/etc/verity-egress/control.key', 'utf8')).trim(),
  });
  const server = await buildTestEmbeddedServer({
    logger: true,
    dataDir: `${root}/database`,
    dataVolume: 'verity-boot-data',
    dataVolumeRoot: config.dataRoot,
    secretMaterializationRoot: `${config.dataRoot}/secrets`,
    hostCloneRoot: `${config.dataRoot}/projects`,
    workspacesDir: `${config.dataRoot}/workspaces`,
    dockerBaseUrl: 'unix:///var/run/docker.sock',
    projectEgress: new ProjectEgressLifecycle(command, docker),
    projectRelayImage: config.relayImage,
    projectRelayGid: 1102,
    defaultProjectImage: config.runnerImage,
    runnerSupervisor: true,
    runnerSupervisorTrustedDefaultImage: true,
    runnerRuntimeGid: 1101,
    runnerSupervisorReconcileIntervalMs: 1000,
    sandboxMemoryBytes: 768 * 1024 * 1024,
    sandboxPidsLimit: 256,
    agentSeedHostPath: '/opt/verity-fixture/agent-seed',
    claudeEgressGatewayUrl: 'https://verity-agent-gateway:9443',
    codexEgressGatewayUrl: 'https://verity-agent-gateway:9444',
    claudeConnectorPort: 9444,
    agentGatewayUrl: 'https://verity-agent-gateway:9443',
    agentGatewayClaudePort: 9443,
    agentGatewayControlSocket: gatewaySocket,
    agentGatewayUnsealKey: config.gatewayKey,
    dockerGc: false,
    transcriptSweep: 'off',
  });
  await server.app.listen({ host: '127.0.0.1', port: 9000 });
  process.on('SIGTERM', () => {
    void server.close({ preserveProjectRelays: true }).then(() => process.exit(0));
  });
}
