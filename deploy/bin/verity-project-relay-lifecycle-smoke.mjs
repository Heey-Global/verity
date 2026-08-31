import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createConnection, createServer } from 'node:net';

import Fastify from 'fastify';

import { createDockerClient } from '../../packages/server/dist/docker.js';
import { internalConnectionIdentity } from '../../packages/server/dist/internal-listener.js';
import { projectRelayContainerName } from '../../packages/server/dist/project-relay-docker.js';
import { createProjectRelayRuntime } from '../../packages/server/dist/project-relay-runtime.js';

const [image, dataVolume, projectNetwork, suffix] = process.argv.slice(2);
assert(image?.includes('@sha256:'), 'relay lifecycle smoke requires a digest-pinned image');
assert(dataVolume && projectNetwork && suffix, 'relay lifecycle smoke arguments are incomplete');

const brokerSocketRoot = '/data/relay-lifecycle/broker';
const claudeSocketRoot = '/data/relay-lifecycle/claude';
mkdirSync(brokerSocketRoot, { recursive: true, mode: 0o755 });
mkdirSync(claudeSocketRoot, { recursive: true, mode: 0o755 });

const app = Fastify();
app.post('/internal/github/token', async (request) => internalConnectionIdentity(request));
await app.ready();

const gateway = createServer((socket) => {
  socket.once('data', (chunk) => socket.end(`claude:${chunk.toString()}`));
});
await new Promise((resolve, reject) => {
  gateway.once('error', reject);
  gateway.listen(0, '127.0.0.1', resolve);
});
const gatewayAddress = gateway.address();
assert(gatewayAddress && typeof gatewayAddress !== 'string');

function capabilityRegistry(prefix) {
  const active = new Map();
  const revoked = [];
  return {
    active,
    revoked,
    async issue(binding) {
      const value = `${prefix}-${binding.projectId}-${binding.containerGeneration}`;
      active.set(binding.projectId, { value, binding });
      return value;
    },
    async resolve(value) {
      return [...active.values()].find((entry) => entry.value === value)?.binding;
    },
    async revokeProject(projectId) {
      revoked.push(projectId);
      active.delete(projectId);
    },
  };
}

const signingCapabilities = capabilityRegistry('sign');
const githubCapabilities = capabilityRegistry('github');
const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
const runtime = createProjectRelayRuntime({
  app,
  docker,
  signingCapabilities,
  githubCapabilities,
  image,
  dataVolume,
  dataVolumeRoot: '/data',
  brokerSocketRoot,
  claudeSocketRoot,
  socketOwnerUid: 0,
  relayGid: 65_532,
  projectNetwork: (projectId) =>
    projectId === `rollback-${suffix}` ? `missing-network-${suffix}` : projectNetwork,
});

async function waitFor(description, containerName, operation) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const container = await docker.inspectContainer(containerName);
      if (container.status !== 'running') {
        throw new Error(
          `${description} failed because ${containerName} is ${container.status ?? 'unknown'}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${description} did not become ready within 90 seconds`, { cause: lastError });
}

async function probeBroker(containerName, expectedIdentity) {
  // The relay enforces a strict request-header allowlist (accept, authorization,
  // connection, content-length, content-type, host, transfer-encoding, user-agent)
  // and answers anything else with 400 "invalid headers". `fetch` injects an
  // `accept-encoding` header that is not on that list, so this uses a raw HTTP
  // request with a controlled header set, matching the other relay smokes.
  const { status, body } = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: containerName,
        port: 8080,
        method: 'POST',
        path: '/internal/github/token',
        timeout: 5_000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.once('timeout', () => outgoing.destroy(new Error('broker probe timed out')));
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), expectedIdentity);
}

async function probeClaude(containerName) {
  const body = await new Promise((resolve, reject) => {
    const connection = createConnection({ host: containerName, port: 8443 });
    const chunks = [];
    connection.setTimeout(5_000, () => connection.destroy(new Error('Claude probe timed out')));
    connection.once('connect', () => connection.write('probe'));
    connection.on('data', (chunk) => chunks.push(chunk));
    connection.once('end', () => resolve(Buffer.concat(chunks).toString()));
    connection.once('error', reject);
  });
  assert.equal(body, 'claude:probe');
}

async function assertContainerGone(containerName) {
  await assert.rejects(() => docker.inspectContainer(containerName));
}

const projectId = `lifecycle-${suffix}`;
const firstBinding = {
  projectId,
  owner: 'Heey-Global',
  repo: 'Verity',
  containerGeneration: 'generation-a',
  // The UDS listener runs in this harness process and opens the gateway TCP
  // connection from this namespace. The relay container only sees the mounted
  // Unix socket, so loopback keeps the gateway off the project network.
  claudeGateway: { host: '127.0.0.1', port: gatewayAddress.port },
};
const first = await runtime.start(firstBinding);
const firstContainer = projectRelayContainerName(first.identity);
await waitFor('generation-a broker relay', firstContainer, () =>
  probeBroker(firstContainer, first.identity),
);
await waitFor('generation-a Claude relay', firstContainer, () => probeClaude(firstContainer));
assert.equal(signingCapabilities.active.get(projectId)?.value, first.signingCapability);
assert.equal(githubCapabilities.active.get(projectId)?.value, first.githubCapability);

await runtime.stop(projectId);
await assertContainerGone(firstContainer);
assert.equal(signingCapabilities.active.has(projectId), false);
assert.equal(githubCapabilities.active.has(projectId), false);

const second = await runtime.start({ ...firstBinding, containerGeneration: 'generation-b' });
const secondContainer = projectRelayContainerName(second.identity);
assert.notEqual(secondContainer, firstContainer);
await waitFor('generation-b broker relay', secondContainer, () =>
  probeBroker(secondContainer, second.identity),
);
await waitFor('generation-b Claude relay', secondContainer, () => probeClaude(secondContainer));

const rollbackProject = `rollback-${suffix}`;
const rollbackIdentity = {
  projectId: rollbackProject,
  containerGeneration: 'generation-failed',
};
await assert.rejects(() =>
  runtime.start({
    ...rollbackIdentity,
    owner: 'Heey-Global',
    repo: 'Verity',
    claudeGateway: firstBinding.claudeGateway,
  }),
);
await assertContainerGone(projectRelayContainerName(rollbackIdentity));
assert.equal(signingCapabilities.active.has(rollbackProject), false);
assert.equal(githubCapabilities.active.has(rollbackProject), false);
assert(signingCapabilities.revoked.includes(rollbackProject));
assert(githubCapabilities.revoked.includes(rollbackProject));

await runtime.stop(projectId);
await assertContainerGone(secondContainer);
await runtime.close();
await new Promise((resolve, reject) =>
  gateway.close((error) => (error ? reject(error) : resolve())),
);
await app.close();

console.log('project relay production lifecycle smoke test passed');
