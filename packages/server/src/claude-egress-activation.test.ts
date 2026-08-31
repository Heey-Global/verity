import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeEgressCaRecord, ClaudeEgressClientCertRecord } from '@verity/store';

import type { SandboxEgressMaterial } from './claude-egress-ca.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityStore,
} from './claude-egress-identity.js';
import {
  CLAUDE_EGRESS_PLACEHOLDER,
  ClaudeEgressCredentialUnavailableError,
} from './claude-egress-policy.js';
import { createClaudeEgressPeerRegistry } from './claude-egress-peer-registry.js';
import { startClaudeEgressMtlsGateway } from './claude-egress-mtls.js';

/**
 * Integration test of the exact wiring `embedded.ts` encodes for the multi-tenant
 * Claude-egress gateway: the identity service's `onBindingsChanged` refreshes a
 * live peer registry, the gateway authenticates against that registry, and its
 * `accessToken` delegates to one account-token source — so a project provisioned
 * AFTER the gateway started authenticates without a restart, a revoked one stops,
 * and a missing token fails closed.
 */

const SERVER_NAME = 'localhost';
const AUTHORITY = 'verity:9443';

/** Minimal in-memory {@link ClaudeEgressIdentityStore} — the store methods are
 *  covered elsewhere; this proves the embedded WIRING with real certificates. */
class FakeStore implements ClaudeEgressIdentityStore {
  ca: ClaudeEgressCaRecord | undefined;
  readonly clients = new Map<string, ClaudeEgressClientCertRecord>();
  async getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined> {
    return this.ca;
  }
  async upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    this.ca = record;
  }
  async replaceClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    this.ca = record;
    this.clients.clear();
  }
  async getClaudeEgressClientCert(id: string): Promise<ClaudeEgressClientCertRecord | undefined> {
    return this.clients.get(id);
  }
  async upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void> {
    this.clients.set(record.projectId, record);
  }
  async listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]> {
    return [...this.clients.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  }
  async deleteClaudeEgressClientCert(id: string): Promise<void> {
    this.clients.delete(id);
  }
}

const gateways: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

/** Wire the identity service, live registry and multi-tenant gateway exactly as
 *  `embedded.ts` does, and return the moving parts a test drives. */
async function activate(getAccessToken: () => Promise<string | undefined>) {
  const store = new FakeStore();
  const registry = createClaudeEgressPeerRegistry();
  const identity = createClaudeEgressIdentityService({
    store,
    serverName: SERVER_NAME,
    onBindingsChanged: (bindings) => registry.replace(bindings),
  });
  const forward = vi.fn<ClaudeEgressForward>(async (request) => ({
    status: 200,
    headers: {},
    body: Readable.from([request.headers.get('authorization') ?? '']),
  }));
  const material = await identity.gatewayMaterial();
  registry.replace(material.peerBindings); // initial (empty) snapshot
  const gateway = await startClaudeEgressMtlsGateway({
    authenticatePeer: registry.authenticatePeer,
    tls: material.tls,
    listenerAuthority: AUTHORITY,
    accessToken: async (): Promise<string> => {
      const token = await getAccessToken();
      // Mirror embedded.ts: a missing token fails closed, but as retryable
      // unavailability because restart/unlock races can resolve moments later.
      if (token === undefined) {
        throw new ClaudeEgressCredentialUnavailableError(
          'Claude egress has no OAuth token configured',
        );
      }
      return token;
    },
    forward,
    port: 0,
  });
  gateways.push(gateway);
  return { identity, gateway, forward, caCertPem: material.tls.ca as string };
}

describe('Claude egress activation wiring', () => {
  it('authenticates a project provisioned AFTER the gateway started, with no restart', async () => {
    const { identity, gateway, forward, caCertPem } = await activate(async () => 'oauth-token');

    // A project provisions now: the identity service issues its cert and the
    // onBindingsChanged hook refreshes the live registry — no gateway restart.
    const sandbox = await identity.sandboxMaterial('project-1');

    const response = await call(gateway.port, sandbox, caCertPem);
    expect(response.status).toBe(200);
    // The gateway injected the server-side OAuth token; the sandbox only ever sent
    // the placeholder.
    expect(response.body).toBe('Bearer oauth-token');
    expect(response.body).not.toContain(CLAUDE_EGRESS_PLACEHOLDER);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('stops authenticating a project once it is revoked, live', async () => {
    const { identity, gateway, caCertPem } = await activate(async () => 'oauth-token');
    const sandbox = await identity.sandboxMaterial('project-1');
    await expect(call(gateway.port, sandbox, caCertPem)).resolves.toMatchObject({ status: 200 });

    await identity.revokeProject('project-1');
    await expect(call(gateway.port, sandbox, caCertPem)).resolves.toMatchObject({ status: 403 });
  });

  it('fails closed with a retryable response when no OAuth token is configured', async () => {
    const { identity, gateway, forward, caCertPem } = await activate(async () => undefined);
    const sandbox = await identity.sandboxMaterial('project-1');

    // The peer authenticates, but the access-token adapter throws → denied, and the
    // request is never forwarded upstream (no credential-less forward).
    const response = await call(gateway.port, sandbox, caCertPem);
    expect(response.status).toBe(503);
    expect(forward).not.toHaveBeenCalled();
  });
});

function call(
  port: number,
  sandbox: SandboxEgressMaterial,
  caCertPem: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: SERVER_NAME,
        ca: caCertPem,
        cert: sandbox.clientCertPem,
        key: sandbox.clientKeyPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        method: 'POST',
        path: '/v1/messages',
        headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}
