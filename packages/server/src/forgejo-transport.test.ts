import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
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
const requests: { path: string; auth: string | undefined }[] = [];
let fixture: ReturnType<typeof createServer>;
beforeAll(async () => {
  directory = mkdtempSync(join(process.cwd(), '.cache/forgejo-tls-'));
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
      if (request.url === '/forge/api/v1/user')
        response.end(JSON.stringify({ id: 1, login: 'fixture' }));
      else if (request.url === '/forge/api/v1/redirect') {
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
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});
it('uses custom CA, base prefix and current credentials on every page', async () => {
  const transport = new ForgejoTransport(baseUrl, async () => token, ca);
  await transport.validate();
  token = 'rotated-fixture';
  const repositories = await transport.repositories();
  expect(repositories).toHaveLength(50);
  expect(repositories[0]).toMatchObject({ owner: 'owner', repo: 'repo0' });
  expect(requests.slice(-3)).toEqual([
    { path: '/forge/api/v1/user', auth: 'token first-fixture' },
    { path: '/forge/api/v1/user/repos?page=1&limit=50', auth: 'token rotated-fixture' },
    { path: '/forge/api/v1/user/repos?page=2&limit=50', auth: 'token rotated-fixture' },
  ]);
});
it('rejects redirects without making another request and requires a trusted CA', async () => {
  const count = requests.length;
  await expect(
    new ForgejoTransport(baseUrl, async () => token, ca).json('/redirect'),
  ).rejects.toBeInstanceOf(ForgejoRequestError);
  expect(requests).toHaveLength(count + 1);
  await expect(new ForgejoTransport(baseUrl, async () => token).validate()).rejects.toThrow(
    'connection unavailable',
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
