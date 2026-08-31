import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createProjectEgressCa,
  gatewayMtlsMaterial,
  issueGatewayServerCertificate,
  issueProjectClientCertificate,
  type EgressCa,
  type PemCertificate,
  type ProjectClientCertificate,
} from './claude-egress-ca.js';
import type { AgentGatewayConfiguration } from './agent-gateway-control.js';
import { startAgentGatewayRuntime, type AgentGatewayRuntime } from './agent-gateway-runtime.js';
import {
  startAgentGatewaySynchronizer,
  type AgentGatewaySynchronizer,
} from './agent-gateway-sync.js';
import { claudeEgressAgentEnv, claudeEgressRouteEnabled } from './claude-egress-agent-env.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';
import { startClaudeEgressMtlsGateway } from './claude-egress-mtls.js';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';

const SERVER_NAME = 'verity-agent-gateway';
const AUTHORITY = 'verity-agent-gateway:9443';
const TOKEN = 'server-projected-token';
const UNSEAL_KEY = '6a'.repeat(32);

let ca: EgressCa;
let server: PemCertificate;
let canary: ProjectClientCertificate;
let legacy: ProjectClientCertificate;

const roots: string[] = [];
const runtimes: AgentGatewayRuntime[] = [];
const synchronizers: AgentGatewaySynchronizer[] = [];

beforeAll(async () => {
  ca = await createProjectEgressCa({ validityDays: 5 });
  server = await issueGatewayServerCertificate(ca, {
    serverName: 'verity',
    additionalServerNames: [SERVER_NAME],
    validityDays: 5,
  });
  canary = await issueProjectClientCertificate(ca, {
    projectId: 'project-canary',
    validityDays: 5,
  });
  legacy = await issueProjectClientCertificate(ca, {
    projectId: 'project-legacy',
    validityDays: 5,
  });
}, 60_000);

afterEach(async () => {
  await Promise.all(synchronizers.splice(0).map((synchronizer) => synchronizer.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hermetic standalone gateway live gates', () => {
  it('survives Server synchronization replacement and rolls the Canary back fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-live-gate-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const upstream = new PassThrough();
    let forwardingEntered: (() => void) | undefined;
    const forwarding = new Promise<void>((resolve) => (forwardingEntered = resolve));
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      forwardingEntered?.();
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: upstream,
      };
    });
    const synchronizationErrors: unknown[] = [];
    const runtime = await startAgentGatewayRuntime({
      controlSocketPath: socketPath,
      healthPort: 0,
      claudePort: 0,
      claudeListenerAuthority: AUTHORITY,
      spillPath: join(root, 'state', 'claude.enc'),
      startClaudeGateway: (options) => startClaudeEgressMtlsGateway({ ...options, forward }),
    });
    runtimes.push(runtime);

    const firstServer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 20,
      onError: (error) => synchronizationErrors.push(error),
    });
    synchronizers.push(firstServer);
    firstServer.update(configuration('server-generation-1', [canary], TOKEN));
    await vi.waitFor(() =>
      expect(runtime.status()).toMatchObject({
        revision: 'server-generation-1',
        claudePeerCount: 1,
        credentialReady: true,
        listenerReady: true,
      }),
    );
    const port = runtime.status().claudePort;
    expect(port).toBeTypeOf('number');

    await expect(call(port!, legacy, '/__verity/gateway-ready')).resolves.toMatchObject({
      status: 403,
    });
    expect(forward).not.toHaveBeenCalled();

    const response = call(port!, canary, '/v1/messages');
    await forwarding;

    // The old Server disappears while the provider stream remains open. A fresh
    // Server-side synchronizer reconnects and replays the durable snapshot; the
    // standalone listener and its in-flight response must remain uninterrupted.
    await firstServer.close();
    const replacementServer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 20,
      onError: (error) => synchronizationErrors.push(error),
    });
    synchronizers.push(replacementServer);
    replacementServer.update(configuration('server-generation-2', [canary], TOKEN));
    await vi.waitFor(() =>
      expect(runtime.status()).toMatchObject({ revision: 'server-generation-2' }),
    );

    // Revocation blocks every new connection immediately, while the already
    // authenticated provider stream is allowed to drain to its terminal event.
    replacementServer.update(configuration('rollback', [], TOKEN));
    await vi.waitFor(() =>
      expect(runtime.status()).toMatchObject({ revision: 'rollback', claudePeerCount: 0 }),
    );
    await expect(call(port!, canary, '/__verity/gateway-ready')).resolves.toMatchObject({
      status: 403,
    });

    upstream.write('event: content_block_delta\ndata: stream-survived\n\n');
    upstream.end('event: message_stop\ndata: done\n\n');

    const completed = await response;
    expect(completed).toEqual({
      status: 200,
      body:
        'event: content_block_delta\ndata: stream-survived\n\n' +
        'event: message_stop\ndata: done\n\n',
    });
    expect(completed.body.match(/event: message_stop/gu)).toHaveLength(1);
    expect(forward).toHaveBeenCalledOnce();
    expect(synchronizationErrors).toEqual([]);
    await replacementServer.close();
  });

  it('proves the Phase 2B rolling cutover and recovers the stable route after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-cutover-gate-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const spillPath = join(root, 'state', 'claude.enc');

    const unroutedEnvironment = claudeEgressAgentEnv({
      routed: claudeEgressRouteEnabled({ isClaudeSession: false, egressActive: true }),
      connectorPort: 47821,
    });
    const routedEnvironment = claudeEgressAgentEnv({
      routed: claudeEgressRouteEnabled({ isClaudeSession: true, egressActive: true }),
      connectorPort: 47821,
    });

    // A non-Claude session receives no Claude environment at all; every Claude
    // project turn receives only the loopback route and a deliberately useless
    // placeholder, so the real token never enters the sandbox.
    expect(unroutedEnvironment).toEqual({});
    expect(routedEnvironment).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
    });
    expect(JSON.stringify(routedEnvironment)).not.toContain(TOKEN);

    const forwardedAuthorizations: string[] = [];
    let credentialResolutions = 0;
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      forwardedAuthorizations.push(request.headers.get('authorization') ?? '');
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Readable.from(['event: message_stop\ndata: done\n\n']),
      };
    });
    const runtime = await startAgentGatewayRuntime({
      controlSocketPath: socketPath,
      healthPort: 0,
      claudePort: 0,
      claudeListenerAuthority: AUTHORITY,
      spillPath,
      startClaudeGateway: (options) =>
        startClaudeEgressMtlsGateway({
          ...options,
          accessToken: async (projectId) => {
            credentialResolutions += 1;
            return options.accessToken(projectId);
          },
          forward,
        }),
    });
    runtimes.push(runtime);
    const synchronizationErrors: unknown[] = [];
    const synchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 20,
      onError: (error) => synchronizationErrors.push(error),
    });
    synchronizers.push(synchronizer);
    synchronizer.update(configuration('cutover', [canary], TOKEN));
    await vi.waitFor(() =>
      expect(runtime.status()).toMatchObject({
        revision: 'cutover',
        credentialReady: true,
        listenerReady: true,
      }),
    );
    const port = runtime.status().claudePort!;

    await expect(call(port, legacy, '/v1/messages')).resolves.toMatchObject({ status: 403 });
    await expect(call(port, canary, '/v1/models')).resolves.toMatchObject({ status: 403 });
    expect(forward).not.toHaveBeenCalled();
    expect(credentialResolutions).toBe(0);
    await expect(call(port, canary, '/v1/messages')).resolves.toEqual({
      status: 200,
      body: 'event: message_stop\ndata: done\n\n',
    });
    expect(forward).toHaveBeenCalledOnce();
    expect(credentialResolutions).toBe(1);
    expect(forwardedAuthorizations).toEqual([`Bearer ${TOKEN}`]);

    const encryptedSpill = await readFile(spillPath, 'utf8');
    expect(encryptedSpill).toMatch(/^enc:v1:/u);
    expect(encryptedSpill).not.toContain(TOKEN);

    // Restart the independently supervised process on the same stable port.
    // The replacement receives only the ephemeral unseal key and restores the
    // provider credential from its encrypted spill before accepting traffic.
    await synchronizer.close();
    synchronizers.splice(synchronizers.indexOf(synchronizer), 1);
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    const replacement = await startAgentGatewayRuntime({
      controlSocketPath: socketPath,
      healthPort: 0,
      claudePort: port,
      claudeListenerAuthority: AUTHORITY,
      spillPath,
      startClaudeGateway: (options) =>
        startClaudeEgressMtlsGateway({
          ...options,
          accessToken: async (projectId) => {
            credentialResolutions += 1;
            return options.accessToken(projectId);
          },
          forward,
        }),
    });
    runtimes.push(replacement);
    const replacementSynchronizer = startAgentGatewaySynchronizer({
      socketPath,
      reconcileIntervalMs: 20,
      onError: (error) => synchronizationErrors.push(error),
    });
    synchronizers.push(replacementSynchronizer);
    replacementSynchronizer.update(configuration('recovered', [canary], undefined));
    await vi.waitFor(() =>
      expect(replacement.status()).toMatchObject({
        revision: 'recovered',
        credentialReady: true,
        listenerReady: true,
        claudePort: port,
      }),
    );

    await expect(callAfterRestart(port, canary, '/v1/messages')).resolves.toMatchObject({
      status: 200,
    });
    expect(forward).toHaveBeenCalledTimes(2);
    expect(credentialResolutions).toBe(2);
    expect(synchronizationErrors).toEqual([]);
  });
});

function configuration(
  revision: string,
  clients: readonly ProjectClientCertificate[],
  accessToken: string | undefined,
): AgentGatewayConfiguration {
  const material = gatewayMtlsMaterial(ca, server, clients);
  return {
    revision,
    claude: {
      tls: { ca: ca.caCertPem, cert: server.certPem, key: server.keyPem },
      peerBindings: material.peerBindings,
      credential: {
        unsealKey: UNSEAL_KEY,
        ...(accessToken === undefined ? {} : { accessToken }),
      },
    },
  };
}

function call(
  port: number,
  client: ProjectClientCertificate,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: path === '/v1/messages' ? 'POST' : 'GET',
        servername: SERVER_NAME,
        ca: ca.caCertPem,
        cert: client.certPem,
        key: client.keyPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        headers: {
          host: AUTHORITY,
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          'content-type': 'application/json',
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once('error', reject);
    request.end(path === '/v1/messages' ? '{}' : undefined);
  });
}

async function callAfterRestart(
  port: number,
  client: ProjectClientCertificate,
  path: string,
): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call(port, client, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'ECONNRESET' && code !== 'ECONNREFUSED' && code !== 'EPIPE')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
