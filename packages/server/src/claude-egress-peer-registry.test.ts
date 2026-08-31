import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createProjectEgressCa,
  issueGatewayServerCertificate,
  issueProjectClientCertificate,
  type EgressCa,
  type PemCertificate,
  type ProjectClientCertificate,
} from './claude-egress-ca.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';
import { createClaudeEgressPeerRegistry } from './claude-egress-peer-registry.js';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import {
  startClaudeEgressMtlsGateway,
  type ClaudeEgressMtlsMaterial,
} from './claude-egress-mtls.js';

const SERVER_NAME = 'localhost';
const AUTHORITY = 'claude-proxy.project-1:9443';

let ca: EgressCa;
let server: PemCertificate;
let certA: ProjectClientCertificate;
let certB: ProjectClientCertificate;

beforeAll(async () => {
  ca = await createProjectEgressCa({ validityDays: 5 });
  server = await issueGatewayServerCertificate(ca, { serverName: SERVER_NAME, validityDays: 5 });
  // Two distinct certificates for the SAME project — a rotation: different key +
  // fingerprint, same project identity.
  certA = await issueProjectClientCertificate(ca, { projectId: 'project-1', validityDays: 5 });
  certB = await issueProjectClientCertificate(ca, { projectId: 'project-1', validityDays: 5 });
}, 60_000);

const gateways: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe('createClaudeEgressPeerRegistry', () => {
  it('starts empty and authenticates no one', () => {
    const registry = createClaudeEgressPeerRegistry();
    expect(registry.size()).toBe(0);
    // A non-TLS socket never resolves.
    expect(registry.authenticatePeer({} as never)).toBeUndefined();
  });

  it('reflects the replaced binding set in size()', () => {
    const registry = createClaudeEgressPeerRegistry([
      { projectId: 'project-1', fingerprint256: certA.fingerprint256 },
    ]);
    expect(registry.size()).toBe(1);
    registry.replace([
      { projectId: 'project-1', fingerprint256: certA.fingerprint256 },
      { projectId: 'project-2', fingerprint256: certB.fingerprint256 },
    ]);
    expect(registry.size()).toBe(2);
    registry.replace([]);
    expect(registry.size()).toBe(0);
  });

  it('discards an invalid update and keeps the previous snapshot', () => {
    const registry = createClaudeEgressPeerRegistry([
      { projectId: 'project-1', fingerprint256: certA.fingerprint256 },
    ]);
    // A fingerprint bound to two projects is rejected — the whole update is dropped.
    expect(() =>
      registry.replace([
        { projectId: 'project-1', fingerprint256: certA.fingerprint256 },
        { projectId: 'project-2', fingerprint256: certA.fingerprint256 },
      ]),
    ).toThrow('bound more than once');
    expect(() =>
      registry.replace([{ projectId: '', fingerprint256: certB.fingerprint256 }]),
    ).toThrow('project is empty');
    // The prior snapshot survives both rejected updates.
    expect(registry.size()).toBe(1);
  });

  it('rejects a gateway configured with both or neither peer source', () => {
    const tls: ClaudeEgressMtlsMaterial = {
      ca: ca.caCertPem,
      cert: server.certPem,
      key: server.keyPem,
    };
    const base = {
      projectId: 'project-1',
      listenerAuthority: AUTHORITY,
      accessToken: async () => 'token',
      tls,
      port: 0,
    };
    // Neither peer source → the gateway would authenticate no one; refuse to start.
    expect(() => startClaudeEgressMtlsGateway({ ...base })).toThrow(
      /requires peerBindings or authenticatePeer/,
    );
    // Both sources → an ambiguous configuration; fail loud rather than pick one.
    const registry = createClaudeEgressPeerRegistry();
    expect(() =>
      startClaudeEgressMtlsGateway({
        ...base,
        peerBindings: [{ projectId: 'project-1', fingerprint256: certA.fingerprint256 }],
        authenticatePeer: registry.authenticatePeer,
      }),
    ).toThrow(/not both/);
  });

  it('authenticates a rotated certificate live, without restarting the gateway', async () => {
    const registry = createClaudeEgressPeerRegistry([
      { projectId: 'project-1', fingerprint256: certA.fingerprint256 },
    ]);
    const material: ClaudeEgressMtlsMaterial = {
      ca: ca.caCertPem,
      cert: server.certPem,
      key: server.keyPem,
    };
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>(async () => ({
      status: 200,
      headers: {},
      body: Readable.from(['ok']),
    }));
    const gateway = await startClaudeEgressMtlsGateway({
      projectId: 'project-1',
      listenerAuthority: AUTHORITY,
      accessToken,
      forward,
      authenticatePeer: registry.authenticatePeer,
      tls: material,
      port: 0,
    });
    gateways.push(gateway);

    // Cert A authenticates.
    await expect(call(gateway.port, certA)).resolves.toMatchObject({ status: 200 });

    // Rotate the project to cert B — no gateway restart.
    registry.replace([{ projectId: 'project-1', fingerprint256: certB.fingerprint256 }]);
    // The superseded cert A no longer authenticates; the rotated cert B does.
    await expect(call(gateway.port, certA)).resolves.toMatchObject({ status: 403 });
    await expect(call(gateway.port, certB)).resolves.toMatchObject({ status: 200 });

    // Revoke every binding — cert B stops authenticating too.
    registry.replace([]);
    await expect(call(gateway.port, certB)).resolves.toMatchObject({ status: 403 });
  });
});

function call(
  port: number,
  client: ProjectClientCertificate,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: SERVER_NAME,
        ca: ca.caCertPem,
        cert: client.certPem,
        key: client.keyPem,
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
