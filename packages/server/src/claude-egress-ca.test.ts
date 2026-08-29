import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createProjectEgressCa,
  gatewayMtlsMaterial,
  issueGatewayServerCertificate,
  issueProjectClientCertificate,
  sandboxEgressMaterial,
  type EgressCa,
  type PemCertificate,
  type ProjectClientCertificate,
} from './claude-egress-ca.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import { normalizeFingerprint, startClaudeEgressMtlsGateway } from './claude-egress-mtls.js';

const SERVER_NAME = 'localhost';
const AUTHORITY = 'claude-proxy.project-1:9443';

let ca: EgressCa;
let server: PemCertificate;
let projectOne: ProjectClientCertificate;
let projectTwo: ProjectClientCertificate;
let rogue: ProjectClientCertificate;

const gateways: Array<{ close(): Promise<void> }> = [];

beforeAll(async () => {
  ca = await createProjectEgressCa({ validityDays: 5 });
  server = await issueGatewayServerCertificate(ca, { serverName: SERVER_NAME, validityDays: 5 });
  projectOne = await issueProjectClientCertificate(ca, { projectId: 'project-1', validityDays: 5 });
  projectTwo = await issueProjectClientCertificate(ca, { projectId: 'project-2', validityDays: 5 });
  // A client from an independent CA — the gateway must reject it at the handshake.
  const otherCa = await createProjectEgressCa({ validityDays: 5 });
  rogue = await issueProjectClientCertificate(otherCa, { projectId: 'project-1', validityDays: 5 });
}, 60_000);

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe('Claude egress certificate issuance', () => {
  it('issues a CA that is a real certificate authority with a private key', () => {
    const caCert = new X509Certificate(ca.caCertPem);
    expect(caCert.ca).toBe(true);
    expect(ca.caKeyPem).toContain('PRIVATE KEY');
    expect(ca.caCertPem).toContain('BEGIN CERTIFICATE');
  });

  it('signs leaf certificates that chain to the CA', () => {
    const authority = new X509Certificate(ca.caCertPem);
    for (const leaf of [server.certPem, projectOne.certPem, projectTwo.certPem]) {
      const cert = new X509Certificate(leaf);
      expect(cert.ca).toBe(false);
      expect(cert.checkIssued(authority)).toBe(true);
    }
    expect(new X509Certificate(rogue.certPem).checkIssued(authority)).toBe(false);
  });

  it('marks leaf certificates with their intended extended key usage', () => {
    // OIDs: clientAuth = 1.3.6.1.5.5.7.3.2, serverAuth = 1.3.6.1.5.5.7.3.1.
    expect(new X509Certificate(projectOne.certPem).keyUsage).toContain('1.3.6.1.5.5.7.3.2');
    expect(new X509Certificate(projectOne.certPem).keyUsage).not.toContain('1.3.6.1.5.5.7.3.1');
    expect(new X509Certificate(server.certPem).keyUsage).toContain('1.3.6.1.5.5.7.3.1');
  });

  it('issues a leaf covering the in-process listener and the Agent Gateway', async () => {
    const leaf = await issueGatewayServerCertificate(ca, {
      serverName: 'verity',
      additionalServerNames: ['verity-agent-gateway'],
    });
    const names = new X509Certificate(leaf.certPem).subjectAltName;
    expect(names).toContain('DNS:verity');
    expect(names).toContain('DNS:verity-agent-gateway');
  });

  it('rotates a project by re-issuing a fresh key and fingerprint', async () => {
    const rotated = await issueProjectClientCertificate(ca, {
      projectId: 'project-1',
      validityDays: 5,
    });
    expect(rotated.fingerprint256).not.toBe(projectOne.fingerprint256);
    expect(rotated.keyPem).not.toBe(projectOne.keyPem);
    expect(
      new X509Certificate(rotated.certPem).checkIssued(new X509Certificate(ca.caCertPem)),
    ).toBe(true);
  });

  it('binds each project fingerprint to the DER Node reports at request time', () => {
    // The issued fingerprint is the request-time DER SHA-256 canonicalized to the
    // gateway registry key form, so it equals the normalized peer fingerprint the
    // mTLS authenticator derives from `socket.getPeerCertificate().fingerprint256`.
    expect(projectOne.fingerprint256).toMatch(/^[a-f0-9]{64}$/u);
    expect(projectOne.fingerprint256).toBe(
      normalizeFingerprint(new X509Certificate(projectOne.certPem).fingerprint256),
    );
    expect(projectTwo.fingerprint256).toBe(
      normalizeFingerprint(new X509Certificate(projectTwo.certPem).fingerprint256),
    );
    expect(projectOne.fingerprint256).not.toBe(projectTwo.fingerprint256);
  });

  it('never lets the CA private key cross into Sandbox material', () => {
    const material = sandboxEgressMaterial(ca, projectOne);
    const serialized = JSON.stringify(material);
    expect(serialized).not.toContain(ca.caKeyPem);
    expect(Object.values(material)).not.toContain(ca.caKeyPem);
    expect(material).toEqual({
      projectId: 'project-1',
      caCertPem: ca.caCertPem,
      clientCertPem: projectOne.certPem,
      clientKeyPem: projectOne.keyPem,
    });
  });

  it('assembles gateway material without any client private key', () => {
    const material = gatewayMtlsMaterial(ca, server, [projectOne, projectTwo]);
    expect(material.tls).toEqual({ ca: ca.caCertPem, cert: server.certPem, key: server.keyPem });
    expect(JSON.stringify(material)).not.toContain(projectOne.keyPem);
    expect(material.peerBindings).toEqual([
      { projectId: 'project-1', fingerprint256: projectOne.fingerprint256 },
      { projectId: 'project-2', fingerprint256: projectTwo.fingerprint256 },
    ]);
  });

  it('rejects unsafe subject values and non-positive validity', async () => {
    await expect(issueProjectClientCertificate(ca, { projectId: 'bad/id' })).rejects.toThrow(
      'project id',
    );
    await expect(issueGatewayServerCertificate(ca, { serverName: 'no spaces' })).rejects.toThrow(
      'server name',
    );
    await expect(
      issueProjectClientCertificate(ca, { projectId: 'project-1', validityDays: 0 }),
    ).rejects.toThrow('validity');
    await expect(createProjectEgressCa({ commonName: 'Evil/O=Acme' })).rejects.toThrow(
      'CA common name',
    );
  });

  it('authenticates an issued project certificate end-to-end through the gateway', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer server-only-token');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const gateway = await start(accessToken, forward);

    await expect(call(gateway.port, projectOne)).resolves.toEqual({ status: 200, body: 'ok' });
    expect(accessToken).toHaveBeenCalledWith('project-1');
  });

  it('keeps an authenticated provider stream alive after Server token access disappears', async () => {
    let serverAvailable = true;
    const upstream = new PassThrough();
    let forwardEntered: (() => void) | undefined;
    const forwarding = new Promise<void>((resolve) => (forwardEntered = resolve));
    const accessToken = vi.fn(async () => {
      if (!serverAvailable) throw new Error('Server unavailable');
      return 'buffered-access-token';
    });
    const forward = vi.fn<ClaudeEgressForward>(async () => {
      forwardEntered?.();
      return { status: 200, headers: {}, body: upstream };
    });
    const gateway = await start(accessToken, forward);

    const response = call(gateway.port, projectOne);
    await forwarding;
    serverAvailable = false;
    upstream.write('stream-');
    upstream.end('survived');

    await expect(response).resolves.toEqual({ status: 200, body: 'stream-survived' });
    expect(accessToken).toHaveBeenCalledOnce();
  });

  it('rejects a same-CA certificate bound to another project before token access', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const gateway = await start(accessToken, vi.fn<ClaudeEgressForward>());

    await expect(call(gateway.port, projectTwo)).resolves.toMatchObject({ status: 403 });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('rejects a client certificate from a foreign CA during the handshake', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const gateway = await start(accessToken, vi.fn<ClaudeEgressForward>());

    await expect(call(gateway.port, rogue)).rejects.toBeDefined();
    expect(accessToken).not.toHaveBeenCalled();
  });
});

async function start(
  accessToken: (projectId: string) => Promise<string>,
  forward: ClaudeEgressForward,
) {
  const material = gatewayMtlsMaterial(ca, server, [projectOne, projectTwo]);
  const gateway = await startClaudeEgressMtlsGateway({
    projectId: 'project-1',
    listenerAuthority: AUTHORITY,
    accessToken,
    forward,
    peerBindings: material.peerBindings,
    tls: material.tls,
    port: 0,
  });
  gateways.push(gateway);
  return gateway;
}

function call(
  port: number,
  client: ProjectClientCertificate,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        servername: SERVER_NAME,
        ca: ca.caCertPem,
        cert: client.certPem,
        key: client.keyPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        headers: {
          host: AUTHORITY,
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once('error', reject);
    request.end();
  });
}
