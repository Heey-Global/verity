import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runEgressConnector } from '../features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs';
import { startRelay } from '../packages/project-relay/src/relay.js';
import { configureAgentGateway } from '../packages/server/src/agent-gateway-control.js';
import {
  createProjectEgressCa,
  gatewayMtlsMaterial,
  issueGatewayServerCertificate,
  issueProjectClientCertificate,
} from '../packages/server/src/claude-egress-ca.js';
import type { CodexEgressForwardRequest } from '../packages/server/src/codex-egress-gateway.js';
import { startCodexEgressGateway } from '../packages/server/src/codex-egress-gateway.js';
import { startAgentGatewayRuntime } from '../packages/server/src/agent-gateway-runtime.js';
import { startProjectClaudeUnixListener } from '../packages/server/src/project-claude-unix-listener.js';
import { codexGatewayConfig } from '../packages/server/src/provisioner.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex gateway end-to-end cutover', () => {
  it('routes the real Codex CLI through connector, relay, mTLS, and gateway without auth.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-codex-gateway-e2e-'));
    roots.push(root);
    const ca = await createProjectEgressCa({ validityDays: 1 });
    const serverCertificate = await issueGatewayServerCertificate(ca, {
      serverName: 'verity-agent-gateway',
      validityDays: 1,
    });
    const projectCertificate = await issueProjectClientCertificate(ca, {
      projectId: 'codex-e2e-project',
      validityDays: 1,
    });
    const material = gatewayMtlsMaterial(ca, serverCertificate, [projectCertificate]);
    const realAccessToken = 'gateway-only-access-token';
    const realRefreshToken = 'gateway-only-refresh-token';
    const accountId = 'gateway-only-account';
    const forwarded: Array<{
      authorization: string | null;
      accountId: string | null;
      body: string;
    }> = [];
    let observeCliRequest: (() => void) | undefined;
    const cliRequest = new Promise<void>((resolve) => (observeCliRequest = resolve));
    const forward = async (request: CodexEgressForwardRequest) => {
      let body = '';
      for await (const chunk of request.body as AsyncIterable<Buffer>) body += chunk.toString();
      forwarded.push({
        authorization: request.headers.get('authorization'),
        accountId: request.headers.get('chatgpt-account-id'),
        body,
      });
      observeCliRequest?.();
      return {
        status: 400,
        headers: {
          'content-type': 'application/json',
          'x-codex-primary-used-percent': '17',
        },
        body: Readable.from(['{"error":{"message":"e2e complete"}}']),
      };
    };

    const runtime = await startAgentGatewayRuntime({
      controlSocketPath: join(root, 'control.sock'),
      healthPort: 0,
      claudePort: 0,
      claudeListenerAuthority: 'verity-agent-gateway:9443',
      spillPath: join(root, 'state', 'claude.enc'),
      codexPort: 0,
      codexListenerAuthority: 'verity-agent-gateway:9444',
      codexSpillPath: join(root, 'state', 'codex.enc'),
      startClaudeGateway: async () => {
        throw new Error('revoked Claude listener must stay dormant');
      },
      startCodexGateway: (options) => startCodexEgressGateway({ ...options, forward }),
    });
    let unixListener: Awaited<ReturnType<typeof startProjectClaudeUnixListener>> | undefined;
    let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
    let connector: Awaited<ReturnType<typeof runEgressConnector>> | undefined;
    try {
      await configureAgentGateway(join(root, 'control.sock'), {
        revision: 'codex-e2e',
        claude: {
          tls: {
            ca: ca.caCertPem,
            cert: serverCertificate.certPem,
            key: serverCertificate.keyPem,
          },
          peerBindings: material.peerBindings,
          credential: { unsealKey: '6a'.repeat(32), accessToken: null },
        },
        codex: {
          credential: {
            unsealKey: '7b'.repeat(32),
            sourceRevision: '1'.repeat(64),
            authJson: JSON.stringify({
              tokens: {
                access_token: realAccessToken,
                refresh_token: realRefreshToken,
                account_id: accountId,
              },
            }),
          },
        },
      });
      expect(runtime.status()).toMatchObject({
        codexCredentialReady: true,
        codexListenerReady: true,
      });

      const identity = {
        projectId: 'codex-e2e-project',
        containerGeneration: 'generation-1',
      };
      const socketRoot = join(root, 'relay-sockets');
      await mkdir(socketRoot, { mode: 0o700 });
      unixListener = await startProjectClaudeUnixListener({
        socketRoot,
        identity,
        ownerUid: process.getuid?.() ?? 1000,
        relayGid: process.getgid?.() ?? 1000,
        gatewayHost: '127.0.0.1',
        gatewayPort: runtime.status().codexPort!,
        socketName: 'codex.sock',
        serviceName: 'Codex',
      });
      relay = await startRelay({
        host: '127.0.0.1',
        brokerPort: 0,
        claudePort: 0,
        codexPort: 0,
        brokerSocketPath: join(root, 'unused-broker.sock'),
        claudeSocketPath: join(root, 'unused-claude.sock'),
        codexSocketPath: unixListener.socketPath,
      });

      connector = await runEgressConnector({
        port: 0,
        localAuthority: '127.0.0.1:0',
        egressUrl: `https://127.0.0.1:${String(relay.claudePort)}`,
        egressAuthority: 'verity-agent-gateway:9443',
        codexEgressUrl: `https://127.0.0.1:${String(relay.codexPort)}`,
        codexEgressAuthority: 'verity-agent-gateway:9444',
        ca: ca.caCertPem,
        cert: projectCertificate.certPem,
        key: projectCertificate.keyPem,
      });

      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'config.toml'), codexGatewayConfig(connector.port));
      const codex = codexExecutable();
      const child = spawn(
        codex,
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox',
          'danger-full-access',
          '--color',
          'never',
          '-m',
          'gpt-5.4',
          'Reply with probe.',
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            CODEX_HOME: codexHome,
            VERITY_CODEX_PLACEHOLDER: 'verity-codex-gateway-placeholder-v1',
            NO_BROWSER: '1',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      const childExit = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
      const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
      timeout.unref();
      let routeTimeout: NodeJS.Timeout | undefined;
      const routeDeadline = new Promise<never>((_, reject) => {
        routeTimeout = setTimeout(
          () => reject(new Error(`Codex did not reach gateway: ${sanitize(stderr)}`)),
          15_000,
        );
        routeTimeout.unref();
      });
      await Promise.race([
        cliRequest,
        routeDeadline,
        childExit.then(() => {
          if (forwarded.length === 0) {
            throw new Error(`Codex exited before reaching gateway: ${sanitize(stderr)}`);
          }
        }),
      ]);
      if (routeTimeout !== undefined) clearTimeout(routeTimeout);
      await childExit;
      clearTimeout(timeout);

      expect(forwarded[0]).toMatchObject({
        authorization: `Bearer ${realAccessToken}`,
        accountId,
      });
      expect(forwarded[0]?.body).toContain('"model":"gpt-5.4"');
      expect(existsSync(join(codexHome, 'auth.json'))).toBe(false);
      const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
      expect(config).not.toContain(realAccessToken);
      expect(config).not.toContain(realRefreshToken);

      const response = await callConnector(connector.port);
      expect(response).toEqual({
        status: 400,
        quota: '17',
        body: '{"error":{"message":"e2e complete"}}',
      });
    } finally {
      await connector?.close();
      await relay?.close();
      await unixListener?.close();
      await runtime.close();
    }
  }, 30_000);
});

function codexExecutable(): string {
  const configured = process.env.CODEX_PATH;
  if (configured && existsSync(configured)) return configured;
  const local = join(process.cwd(), 'node_modules', '.bin', 'codex');
  if (existsSync(local)) return local;
  if (existsSync('/usr/local/bin/codex')) return '/usr/local/bin/codex';
  throw new Error('Pinned Codex CLI is missing; install the root devDependency');
}

function callConnector(port: number): Promise<{ status: number; quota?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/codex/responses',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${String(port)}`,
          authorization: 'Bearer verity-codex-gateway-placeholder-v1',
          'content-type': 'application/json',
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            ...(typeof response.headers['x-codex-primary-used-percent'] === 'string'
              ? { quota: response.headers['x-codex-primary-used-percent'] }
              : {}),
            body,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end('{"model":"gpt-5.4","input":"quota probe"}');
  });
}

function sanitize(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 500);
}
