import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import {
  claudeEgressMtlsServerOptions,
  createClaudeEgressMtlsAuthenticator,
  resolveClaudeEgressPeerProject,
  startClaudeEgressMtlsGateway,
} from './claude-egress-mtls.js';
import type { ClaudeEgressForward } from './claude-egress-gateway.js';

const FINGERPRINT_ONE = Array.from({ length: 32 }, () => 'AA').join(':');
const FINGERPRINT_TWO = Array.from({ length: 32 }, () => 'BB').join(':');
const AUTHORITY = 'claude-proxy.project-1:9443';
let fixtureDir = '';
let CA = '';
let SERVER = '';
let SERVER_ROTATED = '';
let PROJECT_ONE = '';
let PROJECT_TWO = '';
let ROGUE = '';
const gateways: Array<{ close(): Promise<void> }> = [];

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'verity-claude-mtls-'));
  generateTlsFixtures(fixtureDir);
  CA = readFileSync(join(fixtureDir, 'ca.crt'), 'utf8');
  SERVER = combined(fixtureDir, 'server');
  SERVER_ROTATED = combined(fixtureDir, 'server-rotated');
  PROJECT_ONE = combined(fixtureDir, 'project1');
  PROJECT_TWO = combined(fixtureDir, 'project2');
  ROGUE = combined(fixtureDir, 'rogue');
});

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe('Claude egress mTLS project identity', () => {
  it('forces TLS 1.3 and CA-verified client certificates', () => {
    const options = claudeEgressMtlsServerOptions({
      ca: 'ca-public-certificate',
      cert: 'gateway-certificate',
      key: 'gateway-private-key',
    });

    expect(options).toMatchObject({
      minVersion: 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: true,
      honorCipherOrder: true,
    });
  });

  it('maps only an authorized peer fingerprint to its fixed project', () => {
    const bindings = new Map([[FINGERPRINT_ONE.replaceAll(':', '').toLowerCase(), 'project-1']]);

    expect(
      resolveClaudeEgressPeerProject(
        { authorized: true, fingerprint256: FINGERPRINT_ONE },
        bindings,
      ),
    ).toBe('project-1');
    expect(
      resolveClaudeEgressPeerProject(
        { authorized: false, fingerprint256: FINGERPRINT_ONE },
        bindings,
      ),
    ).toBeUndefined();
    expect(
      resolveClaudeEgressPeerProject(
        { authorized: true, fingerprint256: FINGERPRINT_TWO },
        bindings,
      ),
    ).toBeUndefined();
  });

  it('rejects malformed, empty, and duplicate deployment bindings', () => {
    expect(() => createClaudeEgressMtlsAuthenticator([])).toThrow('requires a peer');
    expect(() =>
      createClaudeEgressMtlsAuthenticator([
        { projectId: 'project-1', fingerprint256: 'not-sha256' },
      ]),
    ).toThrow('must be SHA-256');
    expect(() =>
      createClaudeEgressMtlsAuthenticator([{ projectId: '', fingerprint256: FINGERPRINT_ONE }]),
    ).toThrow('project is empty');
    expect(() =>
      createClaudeEgressMtlsAuthenticator([
        { projectId: 'project-1', fingerprint256: FINGERPRINT_ONE },
        { projectId: 'project-2', fingerprint256: FINGERPRINT_ONE.toLowerCase() },
      ]),
    ).toThrow('bound more than once');
  });

  it('authenticates the bound client certificate end-to-end over TLS 1.3', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer server-only-token');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const gateway = await start(accessToken, forward);

    await expect(call(gateway.port, PROJECT_ONE)).resolves.toEqual({ status: 200, body: 'ok' });
    expect(accessToken).toHaveBeenCalledWith('project-1');
  });

  it('reloads the gateway leaf for new handshakes without restarting the listener', async () => {
    const gateway = await start(
      async () => 'server-only-token',
      async () => ({ status: 200, headers: {}, body: Readable.from(['ok']) }),
    );
    const before = await serverFingerprint(gateway.port);

    gateway.reloadTls({ ca: CA, cert: SERVER_ROTATED, key: SERVER_ROTATED });

    const after = await serverFingerprint(gateway.port);
    expect(before).toBe(new X509Certificate(certificate(SERVER)).fingerprint256);
    expect(after).toBe(new X509Certificate(certificate(SERVER_ROTATED)).fingerprint256);
    expect(after).not.toBe(before);
  });

  it('rejects a valid same-CA certificate bound to another project before token access', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const gateway = await start(accessToken, vi.fn<ClaudeEgressForward>());

    await expect(call(gateway.port, PROJECT_TWO)).resolves.toMatchObject({ status: 403 });
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('rejects an untrusted client CA during the TLS handshake', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const gateway = await start(accessToken, vi.fn<ClaudeEgressForward>());

    await expect(call(gateway.port, ROGUE)).rejects.toBeDefined();
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('rejects TLS 1.2 before request handling', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const gateway = await start(accessToken, vi.fn<ClaudeEgressForward>());

    await expect(call(gateway.port, PROJECT_ONE, 'TLSv1.2')).rejects.toBeDefined();
    expect(accessToken).not.toHaveBeenCalled();
  });
});

async function start(
  accessToken: (projectId: string) => Promise<string>,
  forward: ClaudeEgressForward,
) {
  const projectOneFingerprint = new X509Certificate(certificate(PROJECT_ONE)).fingerprint256;
  const projectTwoFingerprint = new X509Certificate(certificate(PROJECT_TWO)).fingerprint256;
  const gateway = await startClaudeEgressMtlsGateway({
    projectId: 'project-1',
    listenerAuthority: AUTHORITY,
    accessToken,
    forward,
    peerBindings: [
      { projectId: 'project-1', fingerprint256: projectOneFingerprint },
      { projectId: 'project-2', fingerprint256: projectTwoFingerprint },
    ],
    tls: { ca: CA, cert: SERVER, key: SERVER },
    port: 0,
  });
  gateways.push(gateway);
  return gateway;
}

function call(
  port: number,
  client: string,
  maxVersion: 'TLSv1.2' | 'TLSv1.3' = 'TLSv1.3',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: CA,
        cert: client,
        key: client,
        maxVersion,
        minVersion: maxVersion,
        method: 'POST',
        path: '/v1/messages',
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

function serverFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: CA,
        cert: PROJECT_ONE,
        key: PROJECT_ONE,
        agent: false,
        minVersion: 'TLSv1.3',
        headers: {
          host: AUTHORITY,
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        },
      },
      (response) => {
        const fingerprint = (response.socket as TLSSocket).getPeerCertificate().fingerprint256;
        response.resume();
        response.once('end', () => resolve(fingerprint));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function certificate(combined: string): string {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u.exec(combined);
  if (match === null) throw new Error('TLS fixture has no certificate');
  return match[0];
}

function generateTlsFixtures(dir: string): void {
  const openssl = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  };
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Verity Test CA',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
  );
  for (const name of ['server', 'server-rotated']) {
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
    );
    writeFileSync(
      join(dir, `${name}.ext`),
      'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n',
    );
    sign(openssl, name);
  }
  for (const name of ['project1', 'project2']) {
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${name}`,
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
    );
    writeFileSync(join(dir, `${name}.ext`), 'extendedKeyUsage=clientAuth\n');
    sign(openssl, name);
  }
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Rogue Client',
    '-keyout',
    'rogue.key',
    '-out',
    'rogue.crt',
  );
}

function sign(openssl: (...args: string[]) => void, name: string): void {
  openssl(
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.crt`,
  );
}

function combined(dir: string, name: string): string {
  return `${readFileSync(join(dir, `${name}.key`), 'utf8')}\n${readFileSync(join(dir, `${name}.crt`), 'utf8')}`;
}
