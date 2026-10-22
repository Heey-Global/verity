import { createServer } from 'node:https';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { brokeredHttpStreamTransport } from './brokered-http-stream.js';
import { createProjectEgressCa, issueGatewayServerCertificate } from './claude-egress-ca.js';
let ca: string;
let port: number;
let fixture: ReturnType<typeof createServer>;
beforeAll(async () => {
  const authority = await createProjectEgressCa();
  const certificate = await issueGatewayServerCertificate(authority, { serverName: 'localhost' });
  ca = authority.caCertPem;
  fixture = createServer(
    { key: certificate.keyPem, cert: certificate.certPem },
    (_request, response) => {
      response.end('trusted');
    },
  );
  await new Promise<void>((resolve) => fixture.listen(0, resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('fixture missing address');
  port = address.port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});
it('uses the configured port and upstream CA independently from the sandbox-facing broker CA', async () => {
  const input = {
    hostname: 'localhost',
    port,
    path: '/prefix/repo',
    method: 'GET',
    headers: {},
    body: Buffer.alloc(0),
    signal: new AbortController().signal,
    allowPrivateAddress: true,
  };
  const response = await brokeredHttpStreamTransport({ ...input, ca });
  let result = '';
  for await (const chunk of response) result += String(chunk);
  expect(result).toBe('trusted');
  await expect(brokeredHttpStreamTransport(input)).rejects.toThrow();
  await expect(
    brokeredHttpStreamTransport({ ...input, ca, allowPrivateAddress: false }),
  ).rejects.toThrow('destination rejected');
});

it('keeps SAN verification and connection trust isolation on brokered upstream requests', async () => {
  const unrelatedAuthority = await createProjectEgressCa();
  const input = {
    hostname: 'localhost',
    port,
    path: '/prefix/repo',
    method: 'GET',
    headers: {},
    body: Buffer.alloc(0),
    signal: new AbortController().signal,
    allowPrivateAddress: true,
  };
  await expect(
    brokeredHttpStreamTransport({ ...input, ca: unrelatedAuthority.caCertPem }),
  ).rejects.toThrow();
  // Trusting the upstream CA must not allow an IP absent from its DNS-only SAN.
  await expect(
    brokeredHttpStreamTransport({ ...input, hostname: '127.0.0.1', ca }),
  ).rejects.toThrow();
  const response = await brokeredHttpStreamTransport({ ...input, ca });
  let body = '';
  for await (const chunk of response) body += String(chunk);
  expect(body).toBe('trusted');
});
