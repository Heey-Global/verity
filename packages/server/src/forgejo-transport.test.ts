import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ForgejoRequestError,
  ForgejoTransport,
  normalizeForgejoUrl,
  validateForgejoCa,
} from './forgejo-transport.js';

let directory: string;
let ca: string;
let baseUrl: string;
let token = 'first-fixture';
let bypassAuthentication = false;
const requests: { path: string; auth: string | undefined }[] = [];
let fixture: ReturnType<typeof createServer>;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'forgejo-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  ca = readFileSync(join(directory, 'cert.pem'), 'utf8');
  fixture = createServer(
    { key: readFileSync(join(directory, 'key.pem')), cert: ca },
    (request, response) => {
      requests.push({ path: request.url ?? '', auth: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/forge/api/v1/protected-merge') {
        response
          .writeHead(405)
          .end(JSON.stringify({ message: `Not allowed to push into protected branch: ${token}` }));
      } else if (request.url === '/forge/api/v1/user') {
        response.writeHead(403).end();
      } else if (request.url?.startsWith('/forge/api/v1/repos/search')) {
        if (
          !bypassAuthentication &&
          !['token first-fixture', 'token rotated-fixture'].includes(
            request.headers.authorization ?? '',
          )
        ) {
          response.writeHead(401).end();
        } else {
          const data = request.url.includes('page=1')
            ? Array.from({ length: 50 }, (_, i) => ({
                owner: { login: 'Owner' },
                name: `Repo${i}`,
              }))
            : [];
          response.end(JSON.stringify({ data }));
        }
      } else if (request.url === '/forge/api/v1/redirect') {
        response.writeHead(302, { location: '/forge/api/v1/user' });
        response.end();
      } else if (request.url?.includes('page=1'))
        response.end(
          JSON.stringify(
            Array.from({ length: 50 }, (_, i) => ({ owner: { login: 'Owner' }, name: `Repo${i}` })),
          ),
        );
      else response.end('[]');
    },
  );
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  baseUrl = `https://127.0.0.1:${address.port}/forge`;
});
afterAll(async () => {
  if (fixture) await new Promise<void>((resolve) => fixture.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it('uses custom CA, base prefix and current credentials on every page', async () => {
  const transport = new ForgejoTransport(baseUrl, async () => token, ca);
  await transport.validate();
  token = 'rotated-fixture';
  const repositories = await transport.repositories();
  expect(repositories).toHaveLength(50);
  expect(repositories[0]).toMatchObject({ owner: 'owner', repo: 'repo0' });
  expect(requests.slice(-4)).toEqual([
    { path: '/forge/api/v1/repos/search?limit=1', auth: 'token first-fixture' },
    { path: '/forge/api/v1/repos/search?limit=1', auth: expect.any(String) },
    { path: '/forge/api/v1/repos/search?page=1&limit=50', auth: 'token rotated-fixture' },
    { path: '/forge/api/v1/repos/search?page=2&limit=50', auth: 'token rotated-fixture' },
  ]);
  expect(requests.at(-3)?.auth).not.toBe('token first-fixture');
});
it('rejects redirects without making another request and requires a trusted CA', async () => {
  const count = requests.length;
  await expect(
    new ForgejoTransport(baseUrl, async () => token, ca).json('/redirect'),
  ).rejects.toBeInstanceOf(ForgejoRequestError);
  expect(requests).toHaveLength(count + 1);
  await expect(new ForgejoTransport(baseUrl, async () => token).validate()).rejects.toThrow(
    'TLS certificate verification failed',
  );
});
it('rejects origin and path escapes before contacting the endpoint', async () => {
  for (const url of [
    'http://forge.test',
    'https://user:password@forge.test',
    'https://forge.test/?query=1',
    'https://forge.test/#fragment',
  ])
    expect(() => normalizeForgejoUrl(url)).toThrow();
  expect(() => validateForgejoCa('not a certificate')).toThrow();
  const count = requests.length;
  const transport = new ForgejoTransport(baseUrl, async () => token, ca);
  for (const path of ['//other.test', '/../user', '/%2e%2e/user', '/repo%2Fother', '/repo\\other'])
    await expect(transport.json(path)).rejects.toThrow();
  expect(requests).toHaveLength(count);
});

async function tlsEndpoint(name: string, san: string, days = 1) {
  const keyPath = join(directory, `${name}-key.pem`);
  const certPath = join(directory, `${name}-cert.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      `subjectAltName=${san}`,
    ],
    { stdio: 'ignore' },
  );
  if (days < 0) {
    // Negative -days is rejected by newer OpenSSL. Explicit dates also make
    // this fixture independent of the CI clock and certificate generation time.
    const csr = join(directory, `${name}.csr`);
    const config = join(directory, `${name}.cnf`);
    const database = join(directory, `${name}.index`);
    const serial = join(directory, `${name}.serial`);
    writeFileSync(database, '');
    writeFileSync(serial, '01\n');
    writeFileSync(
      config,
      `[ca]
 default_ca=fixture
[fixture]
 database=${database}
 serial=${serial}
 new_certs_dir=${directory}
 default_md=sha256
 policy=policy
 x509_extensions=extensions
[policy]
 commonName=supplied
[extensions]
 subjectAltName=${san}
 basicConstraints=critical,CA:TRUE
`,
    );
    execFileSync(
      'openssl',
      ['req', '-new', '-key', keyPath, '-subj', '/CN=localhost', '-out', csr],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'ca',
        '-selfsign',
        '-batch',
        '-notext',
        '-config',
        config,
        '-in',
        csr,
        '-cert',
        certPath,
        '-keyfile',
        keyPath,
        '-startdate',
        '20200101000000Z',
        '-enddate',
        '20200102000000Z',
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
  }

  const pem = readFileSync(certPath, 'utf8');
  const server = createServer({ key: readFileSync(keyPath), cert: pem }, (_request, reply) => {
    reply.end('[]');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing TLS fixture address');
  return {
    pem,
    url: (host: string) => `https://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it('checks DNS and IP SANs even when the connection CA is trusted', async () => {
  const endpoint = await tlsEndpoint('dns-only', 'DNS:localhost');
  try {
    await expect(
      new ForgejoTransport(endpoint.url('localhost'), async () => token, endpoint.pem).json('/tls'),
    ).resolves.toEqual([]);
    // A matching CN or a trusted chain must not bypass the IP SAN requirement.
    await expect(
      new ForgejoTransport(endpoint.url('127.0.0.1'), async () => token, endpoint.pem).json('/tls'),
    ).rejects.toThrow();
    await expect(
      new ForgejoTransport(baseUrl, async () => token, ca).json('/tls'),
    ).resolves.toEqual([]);
  } finally {
    await endpoint.close();
  }
});

it('does not share custom trust between connections and accepts a rotated CA only when supplied', async () => {
  const endpoint = await tlsEndpoint('rotated', 'IP:127.0.0.1');
  try {
    await expect(
      new ForgejoTransport(endpoint.url('127.0.0.1'), async () => token, ca).json('/tls'),
    ).rejects.toThrow();
    await expect(
      new ForgejoTransport(endpoint.url('127.0.0.1'), async () => token, endpoint.pem).json('/tls'),
    ).resolves.toEqual([]);
    await expect(
      new ForgejoTransport(endpoint.url('127.0.0.1'), async () => token).json('/tls'),
    ).rejects.toThrow();
    await expect(
      new ForgejoTransport(baseUrl, async () => token, endpoint.pem).json('/tls'),
    ).rejects.toThrow();
  } finally {
    await endpoint.close();
  }
});

it('rejects an expired certificate even when explicitly trusted', async () => {
  const endpoint = await tlsEndpoint('expired', 'IP:127.0.0.1', -1);
  try {
    expect(new Date(new X509Certificate(endpoint.pem).validTo).getUTCFullYear()).toBe(2020);
    await expect(
      new ForgejoTransport(endpoint.url('127.0.0.1'), async () => token, endpoint.pem).json('/tls'),
    ).rejects.toThrow();
  } finally {
    await endpoint.close();
  }
});

it('validates a repository-scoped token without user scope and rejects invalid credentials despite public search', async () => {
  const scoped = new ForgejoTransport(baseUrl, async () => 'rotated-fixture', ca);
  await expect(scoped.json('/user')).rejects.toMatchObject({ status: 403 });
  await expect(scoped.validate()).resolves.toBeUndefined();
  const invalid = new ForgejoTransport(baseUrl, async () => 'invalid-fixture', ca);
  await expect(invalid.validate()).rejects.toMatchObject({ status: 401 });
});

it('refuses validation when a public search endpoint ignores invalid credentials', async () => {
  bypassAuthentication = true;
  try {
    const transport = new ForgejoTransport(baseUrl, async () => 'invalid-fixture', ca);
    await expect(transport.json('/repos/search?limit=1')).resolves.toEqual({ data: [] });
    await expect(transport.validate()).rejects.toThrow('does not verify token authentication');
  } finally {
    bypassAuthentication = false;
  }
});

it('classifies a protected-branch refusal without retaining upstream credentials', async () => {
  const transport = new ForgejoTransport(baseUrl, async () => token, ca);
  const error = await transport.json('/protected-merge').catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ForgejoRequestError);
  expect(error).toMatchObject({ status: 405, mergePermissionDenied: true });
  expect(String(error)).not.toContain(token);
  expect(JSON.stringify(error)).not.toContain(token);
});
