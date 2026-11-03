import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { expect, it, vi } from 'vitest';
import {
  createPackageArtifactBroker,
  PACKAGE_ARTIFACT_BASE_URL,
} from './package-artifact-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

const bytes = Buffer.from('package archive bytes');
const digest = createHash('sha512').update(bytes).digest('base64');
const manifest = (
  tarball = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
  integrity = `sha512-${digest}`,
) => ({
  name: 'example',
  versions: { '1.0.0': { name: 'example', version: '1.0.0', dist: { tarball, integrity } } },
  'dist-tags': { latest: '1.0.0' },
  time: { '1.0.0': '2020-01-01T00:00:00Z' },
});
function response(
  body: unknown,
  statusCode = 200,
  headers: Record<string, string> = {},
): IncomingMessage {
  return Object.assign(
    Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]),
    { statusCode, headers },
  ) as IncomingMessage;
}
const metadataPath = (path: string) => !path.includes('/-/') && !path.startsWith('/packages/');
function fixture() {
  const transport = vi
    .fn<BrokeredHttpStreamTransport>()
    .mockImplementation(async ({ path }) => response(metadataPath(path) ? manifest() : bytes));
  const broker = createPackageArtifactBroker({ transport });
  const signal = new AbortController().signal;
  const authorized = vi.fn(async () => true);
  const serve = (path: string) => broker.serve(path, signal, authorized);
  return { transport, serve, broker, signal, authorized };
}
const pathOf = (url: string) => new URL(url).pathname.replace('/internal/package-artifacts/', '');
async function selector(f: ReturnType<typeof fixture>): Promise<string> {
  const metadata = JSON.parse((await f.serve('npm/example')).body.toString()) as ReturnType<
    typeof manifest
  >;
  return pathOf(metadata.versions['1.0.0'].dist.tarball);
}

it('rewrites npm metadata to stable content selectors while retaining native age metadata', async () => {
  const f = fixture();
  const metadata = JSON.parse((await f.serve('npm/example')).body.toString()) as ReturnType<
    typeof manifest
  >;
  expect(metadata.time['1.0.0']).toBe('2020-01-01T00:00:00Z');
  const url = new URL(metadata.versions['1.0.0'].dist.tarball);
  expect(url.origin).toBe(PACKAGE_ARTIFACT_BASE_URL);
  expect((await f.serve(pathOf(url.href))).body).toEqual(bytes);
  expect(
    f.transport.mock.calls.every(
      ([input]) => input.headers.authorization === undefined && input.method === 'GET',
    ),
  ).toBe(true);
});

it('reauthorizes a frozen lockfile selector after broker restart and generation replacement', async () => {
  const f = fixture();
  const path = await selector(f);
  const replacement = createPackageArtifactBroker({ transport: f.transport });
  const currentGenerationAuthorized = vi.fn(async () => true);
  expect((await replacement.serve(path, f.signal, currentGenerationAuthorized)).body).toEqual(
    bytes,
  );
  expect(currentGenerationAuthorized).toHaveBeenCalled();
  const retired = new AbortController();
  retired.abort();
  await expect(
    replacement.serve(path, retired.signal, currentGenerationAuthorized),
  ).rejects.toMatchObject({ status: 401 });
  await expect(replacement.serve(path, f.signal, async () => false)).rejects.toMatchObject({
    status: 401,
  });
});

it('never returns wrong-integrity bytes or a selector no longer present in provider metadata', async () => {
  const f = fixture();
  const path = await selector(f);
  f.transport.mockImplementation(async ({ path }) =>
    response(metadataPath(path) ? manifest() : Buffer.from('corrupted')),
  );
  await expect(f.serve(path)).rejects.toMatchObject({ status: 502 });
  f.transport.mockImplementation(async () =>
    response(manifest(undefined, `sha512-${Buffer.alloc(64).toString('base64')}`)),
  );
  await expect(f.serve(path)).rejects.toMatchObject({ status: 404 });
});

it('rejects metadata URLs outside fixed provider paths and credential/query smuggling', async () => {
  for (const url of [
    'https://evil.example/example/-/example.tgz',
    'https://registry.npmjs.org:444/example/-/example.tgz',
    'https://user:password@registry.npmjs.org/example/-/example.tgz',
    'https://registry.npmjs.org/example/-/example.tgz?q=payload',
    'https://registry.npmjs.org/other/-/other.tgz',
    'https://registry.npmjs.org/example/-/%2e%2e/other.tgz',
  ]) {
    const f = fixture();
    f.transport.mockImplementation(async () => response(manifest(url)));
    await expect(f.serve('npm/example')).rejects.toThrow();
  }
  const f = fixture();
  for (const path of [
    'npm/../secret',
    'npm/-/publish',
    'https://registry.npmjs.org/example',
    'file/arbitrary',
  ])
    await expect(f.serve(path)).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});

it('keeps redirects on the provider and bounds redirect chains and metadata bytes', async () => {
  const f = fixture();
  f.transport.mockImplementation(async () =>
    response('', 302, { location: 'https://evil.example/secret' }),
  );
  await expect(f.serve('npm/example')).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(1);
  f.transport
    .mockClear()
    .mockImplementation(async () =>
      response('', 302, { location: 'https://registry.npmjs.org/example' }),
    );
  await expect(f.serve('npm/example')).rejects.toMatchObject({ status: 502 });
  expect(f.transport).toHaveBeenCalledTimes(3);
  f.transport.mockImplementation(async () =>
    response({}, 200, { 'content-length': String(2 * 1024 ** 2 + 1) }),
  );
  await expect(f.serve('npm/example')).rejects.toMatchObject({ status: 413 });
});

it('checks current authority after upstream metadata waits and before releasing artifact bytes', async () => {
  const f = fixture();
  f.transport.mockImplementation(async () => {
    f.authorized.mockResolvedValue(false);
    return response(manifest());
  });
  await expect(f.serve('npm/example')).rejects.toMatchObject({ status: 401 });
  const g = fixture();
  const path = await selector(g);
  g.transport.mockImplementation(async ({ path }) => {
    if (!metadataPath(path)) g.authorized.mockResolvedValue(false);
    return response(metadataPath(path) ? manifest() : bytes);
  });
  await expect(g.serve(path)).rejects.toMatchObject({ status: 401 });
});

it('bounds concurrent upstream work without an unbounded wait queue', async () => {
  const f = fixture();
  const waiting: ((value: IncomingMessage) => void)[] = [];
  f.transport.mockImplementation(() => new Promise((resolve) => waiting.push(resolve)));
  const first = f.serve('npm/example');
  const second = f.serve('npm/example');
  await vi.waitFor(() => expect(waiting).toHaveLength(2));
  await expect(f.serve('npm/example')).rejects.toMatchObject({ status: 429 });
  waiting.forEach((resolve) => resolve(response(manifest())));
  await Promise.all([first, second]);
});

it('serves PyPI JSON selectors and preserves resolver/release-age fields across restart', async () => {
  const f = fixture();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const data = {
    name: 'Example',
    files: [
      {
        filename: 'example-1.0-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/aa/bb/example.whl',
        hashes: { sha256: hash },
        size: bytes.length,
        'upload-time': '2020-01-01T00:00:00Z',
        'requires-python': '>=3.9',
        yanked: 'unsafe',
      },
    ],
  };
  f.transport.mockImplementation(async ({ hostname }) =>
    response(hostname === 'pypi.org' ? data : bytes),
  );
  const result = await f.serve('pypi/simple/example/');
  expect(result.contentType).toBe('application/vnd.pypi.simple.v1+json');
  const metadata = JSON.parse(result.body.toString()) as { files: { url: string }[] };
  expect(metadata.files[0]).toMatchObject({
    'upload-time': '2020-01-01T00:00:00Z',
    'requires-python': '>=3.9',
    yanked: 'unsafe',
  });
  const replacement = createPackageArtifactBroker({ transport: f.transport });
  expect(
    (await replacement.serve(pathOf(metadata.files[0]!.url), f.signal, f.authorized)).body,
  ).toEqual(bytes);
});

it('rejects oversized artifacts before buffering and compressed provider metadata', async () => {
  const f = fixture();
  const path = await selector(f);
  f.transport.mockImplementation(async ({ path }) =>
    metadataPath(path)
      ? response(manifest())
      : response(bytes, 200, { 'content-length': String(32 * 1024 ** 2 + 1) }),
  );
  await expect(f.serve(path)).rejects.toMatchObject({ status: 413 });
  f.transport.mockImplementation(async () =>
    response(manifest(), 200, { 'content-encoding': 'gzip' }),
  );
  await expect(f.serve('npm/example')).rejects.toMatchObject({ status: 502 });
});

it('rejects foreign PyPI URLs and omits oversized files from resolvable metadata', async () => {
  const f = fixture();
  const file = {
    filename: 'example-1.whl',
    url: 'https://evil.example/packages/example.whl',
    hashes: { sha256: 'a'.repeat(64) },
    size: 1,
  };
  f.transport.mockImplementation(async () => response({ name: 'example', files: [file] }));
  await expect(f.serve('pypi/simple/example/')).rejects.toThrow();
  f.transport.mockImplementation(async () =>
    response({ name: 'example', files: [{ ...file, size: 32 * 1024 ** 2 + 1 }] }),
  );
  expect(JSON.parse((await f.serve('pypi/simple/example/')).body.toString())).toMatchObject({
    files: [],
  });
});

it('keeps npm audit on a fixed schema-validated endpoint without publishing or redirects', async () => {
  const f = fixture();
  const advisory = {
    name: 'example',
    id: 1,
    severity: 'high',
    vulnerable_versions: '<2.0.0',
    title: 'Example advisory',
    url: 'https://github.com/advisories/example',
  };
  f.transport.mockImplementation(async () => response({ example: [advisory] }));
  expect(
    JSON.parse(
      (await f.broker.advisories({ example: ['1.0.0'] }, f.signal, f.authorized)).body.toString(),
    ),
  ).toEqual({ example: [advisory] });
  expect(f.transport.mock.calls[0]?.[0]).toMatchObject({
    hostname: 'registry.npmjs.org',
    path: '/-/npm/v1/security/advisories/bulk',
    method: 'POST',
    body: Buffer.from('{"example":["1.0.0"]}'),
  });
  expect(f.transport.mock.calls[0]?.[0].headers.authorization).toBeUndefined();
  for (const input of [
    { action: 'publish' },
    { 'https://evil.example': ['1.0.0'] },
    { example: ['version with payload'] },
    { example: Array.from({ length: 101 }, () => '1.0.0') },
  ])
    await expect(f.broker.advisories(input, f.signal, f.authorized)).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(1);
  f.transport.mockImplementation(async () =>
    response('', 302, { location: 'https://evil.example' }),
  );
  await expect(
    f.broker.advisories({ example: ['1.0.0'] }, f.signal, f.authorized),
  ).rejects.toMatchObject({ status: 502 });
});
