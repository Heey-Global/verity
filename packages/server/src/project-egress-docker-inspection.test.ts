import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProjectEgressDockerInspector } from './project-egress-docker-inspection.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(body = '{}', status = 200) {
  const dir = await mkdtemp('/tmp/egress-');
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.writeHead(status);
    res.end(body);
  });
  const socket = join(dir, 's');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  return { paths, inspect: createProjectEgressDockerInspector(socket) };
}
it('reads current daemon facts with CLI-compatible shapes and escaped identities', async () => {
  const { paths, inspect } = await fixture('{"Runtimes":{"runsc":{}}}');
  const id = 'a'.repeat(64);
  expect(JSON.parse((await inspect(['container', 'inspect', id]))!)).toEqual([
    { Runtimes: { runsc: {} } },
  ]);
  await inspect(['network', 'inspect', id]);
  await inspect(['image', 'inspect', 'sha256:abc']);
  await inspect(['volume', 'inspect', 'a/b']);
  expect(await inspect(['info', '--format', '{{json .Runtimes}}'])).toBe('{"runsc":{}}');
  expect(paths).toEqual([
    `GET /v1.52/containers/${id}/json`,
    `GET /v1.52/networks/${id}`,
    'GET /v1.52/images/sha256%3Aabc/json',
    'GET /v1.52/volumes/a%2Fb',
    'GET /v1.52/info',
  ]);
});
it('never translates mutations or invalid endpoint identities into requests', async () => {
  const { paths, inspect } = await fixture();
  expect(await inspect(['container', 'stop', 'a'.repeat(64)])).toBeUndefined();
  await expect(inspect(['inspect', '../info'])).rejects.toThrow('identity');
  expect(paths).toEqual([]);
});
it.each([
  ['{}', 404],
  ['not JSON', 200],
  ['oversized', 200],
])('fails closed for invalid responses', async (body, status) => {
  const { inspect } = await fixture(
    body === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : body,
    status,
  );
  await expect(inspect(['inspect', 'a'.repeat(64)])).rejects.toThrow();
});
it('bounds a daemon that never responds', async () => {
  const dir = await mkdtemp('/tmp/egress-');
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = createServer(() => {});
  const socket = join(dir, 's');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await expect(
    createProjectEgressDockerInspector(socket)(['inspect', 'a'.repeat(64)]),
  ).rejects.toThrow('timed out');
});
