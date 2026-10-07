import { createGhcrForgeAdapter } from './brokered-forge-ghcr.js';
import { parse, Kind } from 'graphql';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import {
  createServer,
  request,
  type Server,
  type IncomingMessage,
  type RequestListener,
} from 'node:http';
import { connect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createServer as createNetServer,
  createConnection,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import Fastify from 'fastify';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrokeredForgeProxy } from './brokered-http-tool.js';
import { createGitHubForgeAdapter, type ForgeAction } from './brokered-forge-github.js';
import {
  createProjectEgressCa,
  issueGatewayServerCertificate,
  type EgressCa,
  type PemCertificate,
} from './claude-egress-ca.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

const exec = promisify(execFile);
const seed = resolve('agent-seed/bin');
const realGh = spawnSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).stdout.trim();
const cap = 'c'.repeat(43);
const token = 'ghs_server_only_test_credential';
const identity = { projectId: 'p1', containerGeneration: 'g1' };
const binding = { ...identity, owner: 'acme', repo: 'app' };
const capabilities: GhTokenCapabilityRegistry = {
  issue: async () => cap,
  resolve: async (value) => (value === cap ? binding : undefined),
  revokeProject: async () => {},
};
const allActions = new Set<ForgeAction>([
  'git-read',
  'git-write',
  'issues-read',
  'issues-write',
  'pulls-read',
  'pulls-write',
  'checks-read',
  'actions-read',
  'actions-write',
  'releases-read',
  'releases-write',
]);
let ca: EgressCa;
let certificate: PemCertificate;
let dir: string;
const servers: Array<Server | NetServer> = [];
const cleanups: Array<() => Promise<void>> = [];
const sockets = new Set<Socket>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-forge-test-'));
  ca = await createProjectEgressCa();
  certificate = await issueGatewayServerCertificate(ca, {
    serverName: 'github.com',
    additionalServerNames: ['api.github.com', 'uploads.github.com', 'ghcr.io'],
  });
  await writeFile(join(dir, 'ca.crt'), ca.caCertPem);
  await writeFile(join(dir, 'cap'), cap);
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

async function listen(server: Server | NetServer): Promise<number> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as { port: number }).port;
}
async function harness(
  handler: (...args: Parameters<RequestListener>) => unknown,
  options: {
    generation?: string;
    actions?: Set<ForgeAction>;
    enabled?: boolean;
    registry?: boolean;
  } = {},
) {
  const upstreamPort = await listen(
    createServer((req, res) => {
      void (async () => handler(req, res))().catch(() => res.destroy());
    }),
  );
  const received: Array<{ path: string; auth: string | undefined; body: Buffer }> = [];
  const transport: BrokeredHttpStreamTransport = async (input) => {
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : await (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Uint8Array));
          return Buffer.concat(chunks);
        })();
    received.push({ path: input.path, auth: input.headers.authorization, body });
    return await new Promise<IncomingMessage>((done, reject) => {
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: input.path,
          method: input.method,
          headers: input.headers,
          signal: input.signal,
        },
        done,
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
  const mint = vi.fn(async () => token);
  const adapter = options.registry
    ? createGhcrForgeAdapter({
        packages: async () => ['acme/app/server'],
        mint: async () => token,
        transport,
      })
    : createGitHubForgeAdapter({ mint, transport });
  const proxy = createBrokeredForgeProxy({
    certificate,
    capabilities,
    adapter,
    transport,
    enabled: () => options.enabled ?? true,
    actions: () => options.actions ?? allActions,
  });
  const app = Fastify();
  await app.ready();
  const socketRoot = await mkdtemp(join(dir, 'project-socket-'));
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot,
    identity: {
      ...identity,
      containerGeneration: options.generation ?? identity.containerGeneration,
    },
    ownerUid: process.getuid!(),
    relayGid: process.getgid!(),
    forgeProxy: proxy,
  });
  cleanups.push(async () => {
    await listener.close();
    await app.close();
  });
  const server = createNetServer((socket) => {
    const upstream = createConnection({ path: listener.socketPath });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const port = await listen(server);
  return { port, received, mint };
}
async function call(
  port: number,
  path: string,
  auth = `Bearer verity-broker-${cap}`,
  host = 'api.github.com',
  body?: string,
  connection?: string,
  method?: string,
): Promise<{ status: number; body: string; length?: string }> {
  return await new Promise((done, reject) => {
    const outer = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
    outer.on('error', reject);
    outer.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done({ status: res.statusCode ?? 0, body: '' });
        return;
      }
      const tls = connect({ socket, servername: host, ca: ca.caCertPem });
      tls.on('error', reject);
      const inner = request(
        {
          hostname: host,
          path,
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: {
            host,
            authorization: auth,
            ...(connection === undefined ? {} : { connection }),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
          createConnection: () => tls,
        },
        (response) => {
          let result = '';
          response.on('data', (value: Buffer) => {
            result += value.toString();
          });
          response.on('error', reject);
          response.on('end', () =>
            done({
              status: response.statusCode ?? 0,
              body: result,
              ...(response.headers['content-length'] === undefined
                ? {}
                : { length: response.headers['content-length'] }),
            }),
          );
        },
      );
      inner.on('error', reject);
      inner.end(body);
    });
    outer.end();
  });
}
function cliEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${seed}:${process.env.PATH ?? ''}`,
    VERITY_GH_REAL: realGh,
    VERITY_FORGE_MODE: 'proxy-test',
    VERITY_FORGE_PROXY_URL: `http://127.0.0.1:${port}`,
    VERITY_FORGE_PROXY_CA_FILE: join(dir, 'ca.crt'),
    VERITY_GH_BROKER_CAPABILITY_FILE: join(dir, 'cap'),
    GH_PROMPT_DISABLED: '1',
    GH_CONFIG_DIR: join(dir, 'gh-config'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NO_PROXY: '',
    no_proxy: '',
  };
}

describe('brokered forge TLS boundary', () => {
  it('injects credentials only upstream and preserves binary bodies larger than the JSON broker limit', async () => {
    const binary = randomBytes(2 * 1024 * 1024);
    const h = await harness((_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(binary);
    });
    const result = await exec(
      'curl',
      [
        '--fail',
        '--silent',
        '--proxy',
        `http://127.0.0.1:${h.port}`,
        '--cacert',
        join(dir, 'ca.crt'),
        '-H',
        `Authorization: Bearer verity-broker-${cap}`,
        'https://api.github.com/repos/acme/app/issues',
      ],
      {
        env: { ...process.env, NO_PROXY: '', no_proxy: '' },
        encoding: 'buffer',
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(result.stdout).toEqual(binary);
    expect(h.received[0]?.auth).toBe(`Bearer ${token}`);
    expect(h.received[0]?.body).toEqual(Buffer.alloc(0));
  });
  it('parses long Connection headers and rejects unknown hop-by-hop options', async () => {
    const h = await harness((_req, res) => res.end('ok'));
    const padding = ' '.repeat(6000);
    expect(
      (
        await call(
          h.port,
          '/repos/acme/app/pulls',
          undefined,
          undefined,
          undefined,
          `keep-alive,${padding}close`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          h.port,
          '/repos/acme/app/pulls',
          undefined,
          undefined,
          undefined,
          `${padding}x-forbidden`,
        )
      ).status,
    ).toBe(403);
    expect(h.received).toHaveLength(1);
  });
  it('rejects absent/foreign capabilities, generations, repositories, targets and disabled projects before minting', async () => {
    const h = await harness((_req, res) => res.end('ok'));
    for (const [path, auth] of [
      ['/repos/other/app/issues', `Bearer verity-broker-${cap}`],
      ['/repos/acme/app/issues', 'Bearer stolen-token'],
      ['/repos/acme/app/../other/issues', `Bearer verity-broker-${cap}`],
    ]) {
      expect((await call(h.port, path!, auth)).status).toBe(
        auth === 'Bearer stolen-token' ? 401 : 403,
      );
    }
    expect((await call(h.port, '/', undefined, 'example.com')).status).toBe(403);
    expect(h.mint).not.toHaveBeenCalled();
    const old = await harness((_req, res) => res.end('ok'), { generation: 'old' });
    expect((await call(old.port, '/repos/acme/app/issues')).status).toBe(401);
    expect(old.mint).not.toHaveBeenCalled();
    const disabled = await harness((_req, res) => res.end('ok'), { enabled: false });
    expect((await call(disabled.port, '/repos/acme/app/issues')).status).toBe(403);
  });
  it('relays Release and Actions evidence reads with server-side credentials', async () => {
    const h = await harness((_req, res) => res.end('{"evidence":true}'), {
      actions: new Set<ForgeAction>(['releases-read', 'actions-read']),
    });
    for (const path of [
      '/repos/acme/app/releases/tags/v1.56.0',
      '/repos/acme/app/actions/runs/123/jobs',
    ]) {
      expect(await call(h.port, path)).toEqual({ status: 200, body: '{"evidence":true}' });
    }
    expect(h.mint).toHaveBeenCalledTimes(2);
  });
  it('does not follow redirects or expose upstream errors and echoed credentials', async () => {
    const h = await harness((req, res) => {
      if (req.url?.endsWith('issues')) {
        res.writeHead(302, { location: 'https://example.com/' });
        res.end(token);
      } else {
        res.writeHead(500);
        res.write(token.slice(0, 10));
        res.end(token.slice(10));
      }
    });
    expect(await call(h.port, '/repos/acme/app/issues')).toEqual({
      status: 502,
      body: '{"error":"forge broker request rejected"}',
    });
    await expect(call(h.port, '/repos/acme/app/pulls')).rejects.toThrow();
    expect(h.received).toHaveLength(2);
  });
  it('keeps registry exchange bearers outside TLS clients and rejects unmapped packages', async () => {
    const registryBearer = 'server-only-registry-bearer';
    const h = await harness(
      (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/token?')) res.end(JSON.stringify({ token: registryBearer }));
        else res.end(JSON.stringify({ tags: ['v1.56.0'] }));
      },
      { registry: true, actions: new Set<ForgeAction>(['packages-read']) },
    );
    const issued = await call(
      h.port,
      '/token?service=ghcr.io&scope=repository:acme/app/server:pull',
      undefined,
      'ghcr.io',
    );
    expect(issued).toEqual({
      status: 200,
      body: JSON.stringify({ token: 'verity-broker-' + cap }),
    });
    expect(h.received).toHaveLength(0);
    expect(await call(h.port, '/v2/acme/app/server/tags/list', undefined, 'ghcr.io')).toEqual({
      status: 200,
      body: JSON.stringify({ tags: ['v1.56.0'] }),
    });
    expect(h.received.at(-1)?.auth).toBe('Bearer ' + registryBearer);
    expect((await call(h.port, '/v2/acme/other/tags/list', undefined, 'ghcr.io')).status).toBe(403);
    expect(h.received).toHaveLength(2);
  });
  it('preserves manifest size for registry HEAD reads', async () => {
    const h = await harness(
      (req, res) => {
        if (req.url?.startsWith('/token?')) res.end(JSON.stringify({ token: 'registry-bearer' }));
        else {
          res.setHeader('content-type', 'application/vnd.oci.image.manifest.v1+json');
          res.setHeader('content-length', '1234');
          res.end();
        }
      },
      { registry: true, actions: new Set<ForgeAction>(['packages-read']) },
    );
    const result = await call(
      h.port,
      '/v2/acme/app/server/manifests/v1',
      undefined,
      'ghcr.io',
      undefined,
      undefined,
      'HEAD',
    );
    expect(result).toEqual({ status: 200, body: '', length: '1234' });
  });
  it('streams Release uploads and follows authorized asset redirects without forwarding credentials', async () => {
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const h = await harness((req, res) => {
      if (req.url === '/repos/acme/app/releases/assets/123') {
        res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/download' });
        res.end();
      } else if (req.url === '/download') res.end('asset-bytes');
      else {
        let bytes = 0;
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        req.on('end', () => res.end(JSON.stringify({ bytes })));
      }
    });
    expect(
      await call(
        h.port,
        '/repos/acme/app/releases/1/assets?name=test.bin',
        undefined,
        'uploads.github.com',
        payload,
      ),
    ).toEqual({
      status: 200,
      body: JSON.stringify({ bytes: payload.length }),
    });
    expect(await call(h.port, '/repos/acme/app/releases/assets/123')).toEqual({
      status: 200,
      body: 'asset-bytes',
    });
    expect(h.received.at(-1)?.auth).toBeUndefined();
    expect(h.received[0]?.auth).toBe(`Bearer ${token}`);
  });
  it('runs real gh Release asset upload and download', async () => {
    const asset = {
      id: 7,
      name: 'evidence.bin',
      size: 8,
      url: 'https://api.github.com/repos/acme/app/releases/assets/7',
      browser_download_url: 'https://github.com/acme/app/releases/download/v1.56.0/evidence.bin',
      content_type: 'application/octet-stream',
    };
    const h = await harness((req, res) => {
      if (req.url?.includes('/releases/tags/')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 123,
            tag_name: 'v1.56.0',
            assets: [asset],
            upload_url:
              'https://uploads.github.com/repos/acme/app/releases/123/assets{?name,label}',
          }),
        );
      } else if (req.url?.startsWith('/repos/acme/app/releases/123/assets?')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...asset, id: 8, name: 'new.bin' }));
      } else {
        res.setHeader('content-type', 'application/octet-stream');
        res.end('fixture-binary');
      }
    });
    const env = cliEnv(h.port);
    const file = join(dir, 'new.bin');
    await writeFile(file, randomBytes(2 * 1024 * 1024));
    await exec(join(seed, 'gh'), ['release', 'upload', 'v1.56.0', file, '--repo', 'acme/app'], {
      env,
    });
    const downloaded = await exec(
      join(seed, 'gh'),
      [
        'release',
        'download',
        'v1.56.0',
        '--pattern',
        'evidence.bin',
        '--output',
        '-',
        '--repo',
        'acme/app',
      ],
      { env },
    );
    expect(downloaded.stdout).toBe('fixture-binary');
    expect(
      h.received.some(
        (entry) => entry.path.includes('/assets?') && entry.body.length === 2 * 1024 * 1024,
      ),
    ).toBe(true);
  });
  it('runs real gh Release and Actions reads and dispatch through placeholders', async () => {
    const h = await harness((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/releases/tags/'))
        res.end(
          JSON.stringify({
            id: 123,
            tag_name: 'v1.56.0',
            name: 'Release',
            draft: false,
            prerelease: true,
            assets: [],
          }),
        );
      else if (req.url?.includes('/actions/runs'))
        res.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
      else if (req.url?.includes('/actions/workflows/ci.yml') && req.method === 'GET')
        res.end(
          JSON.stringify({ id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }),
        );
      else {
        res.writeHead(204);
        res.end();
      }
    });
    const env = cliEnv(h.port);
    await exec(
      join(seed, 'gh'),
      ['release', 'view', 'v1.56.0', '--repo', 'acme/app', '--json', 'tagName,assets'],
      { env },
    );
    await exec(
      join(seed, 'gh'),
      ['run', 'list', '--repo', 'acme/app', '--json', 'databaseId,status'],
      { env },
    );
    await exec(
      join(seed, 'gh'),
      ['workflow', 'run', 'ci.yml', '--repo', 'acme/app', '--ref', 'test'],
      { env },
    );
    expect(h.received.some((entry) => entry.path.endsWith('/dispatches'))).toBe(true);
    expect(h.received.every((entry) => entry.auth === `Bearer ${token}`)).toBe(true);
  });
  it('withholds a Git Basic credential echo even when the upstream strips the scheme', async () => {
    const h = await harness((req, res) => {
      const encoded = req.headers.authorization!.slice('Basic '.length);
      res.writeHead(500);
      res.write(encoded.slice(0, 8));
      res.end(encoded.slice(8));
    });
    const placeholder = `Basic ${Buffer.from(`x-access-token:verity-broker-${cap}`).toString('base64')}`;
    await expect(
      call(h.port, '/acme/app.git/info/refs?service=git-upload-pack', placeholder, 'github.com'),
    ).rejects.toThrow();
  });
  it.skipIf(!realGh)('runs real gh issue/PR reads and comments through placeholders', async () => {
    const h = await harness(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/graphql') {
        res.end(JSON.stringify([{ number: 1, title: 'Test issue' }]));
        return;
      }
      const { query, variables } = JSON.parse(body) as {
        query: string;
        variables: Record<string, unknown>;
      };

      if (query.includes('ProjectItems')) {
        const kind = query.includes('pullRequest(') ? 'pullRequest' : 'issue';
        res.end(
          JSON.stringify({
            data: {
              repository: {
                [kind]: {
                  projectItems: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: '' },
                  },
                },
              },
            },
          }),
        );
      } else if (/__type\s*\(/.test(query)) {
        const operation = parse(query).definitions.find(
          (node) => node.kind === Kind.OPERATION_DEFINITION,
        );
        const fields = operation?.selectionSet.selections ?? [];
        res.end(
          JSON.stringify({
            data: Object.fromEntries(
              fields.flatMap((field) =>
                field.kind === Kind.FIELD
                  ? [[field.alias?.value ?? field.name.value, { fields: [] }]]
                  : [],
              ),
            ),
          }),
        );
      } else if (query.includes('query($id:ID!)'))
        res.end(
          JSON.stringify({
            data: {
              node:
                variables.id === 'R_app'
                  ? { __typename: 'Repository', nameWithOwner: 'acme/app' }
                  : {
                      __typename: String(variables.id).startsWith('PR_') ? 'PullRequest' : 'Issue',
                      repository: { nameWithOwner: 'acme/app' },
                    },
            },
          }),
        );
      else if (query.includes('viewerMergeHeadlineText'))
        res.end(
          JSON.stringify({
            data: { node: { viewerMergeHeadlineText: 'Test merge', viewerMergeBodyText: '' } },
          }),
        );
      else if (query.includes('createPullRequest'))
        res.end(
          JSON.stringify({
            data: {
              createPullRequest: {
                pullRequest: { id: 'PR_3', url: 'https://github.com/acme/app/pull/3' },
              },
            },
          }),
        );
      else if (query.includes('closePullRequest'))
        res.end(JSON.stringify({ data: { closePullRequest: { pullRequest: { id: 'PR_2' } } } }));
      else if (query.includes('mergePullRequest'))
        res.end(JSON.stringify({ data: { mergePullRequest: { clientMutationId: 'test-merge' } } }));
      else if (query.includes('createIssue'))
        res.end(
          JSON.stringify({
            data: { createIssue: { issue: { url: 'https://github.com/acme/app/issues/3' } } },
          }),
        );
      else if (query.includes('addComment'))
        res.end(
          JSON.stringify({
            data: {
              addComment: {
                commentEdge: {
                  node: { url: 'https://github.com/acme/app/issues/1#issuecomment-1' },
                },
              },
            },
          }),
        );
      else
        res.end(
          JSON.stringify({
            data: {
              viewer: { login: 'acme', id: 'U_acme' },
              repository: {
                id: 'R_app',
                name: 'app',
                nameWithOwner: 'acme/app',
                owner: { login: 'acme', id: 'U_acme', __typename: 'User' },
                viewerPermission: 'WRITE',
                defaultBranchRef: { name: 'main' },
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
                squashMergeAllowed: true,
                hasIssuesEnabled: true,
                issueTypes: { nodes: [] },
                issues: {
                  nodes: [],
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: '' },
                },
                pullRequests: {
                  nodes: [],
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: '' },
                },
                issue: {
                  __typename: 'Issue',
                  id: 'I_1',
                  number: variables.number ?? 1,
                  title: 'Test issue',
                  projectItems: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: '' },
                  },
                  comments: { nodes: [], totalCount: 0 },
                  reactionGroups: [],
                  assignees: { nodes: [] },
                  labels: { nodes: [] },
                  url: 'https://github.com/acme/app/issues/1',
                },
                pullRequest: {
                  __typename: 'PullRequest',
                  id: 'PR_2',
                  state: 'OPEN',
                  isDraft: false,
                  headRefName: 'test',
                  baseRefName: 'main',
                  headRefOid: 'a'.repeat(40),
                  mergeStateStatus: 'CLEAN',
                  headRepositoryOwner: { login: 'acme' },
                  headRepository: { id: 'R_app', name: 'app', owner: { login: 'acme' } },
                  number: 2,
                  title: 'Test PR',
                  projectItems: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: '' },
                  },
                  comments: { nodes: [], totalCount: 0 },
                  reactionGroups: [],
                  assignees: { nodes: [] },
                  labels: { nodes: [] },
                  url: 'https://github.com/acme/app/pull/2',
                },
              },
            },
          }),
        );
    });
    const env = cliEnv(h.port);
    for (const [kind, number, title] of [
      ['issue', '1', 'Test issue'],
      ['pr', '2', 'Test PR'],
    ]) {
      const result = await exec(
        join(seed, 'gh'),
        [kind!, 'view', number!, '--repo', 'acme/app', '--json', 'number,title'],
        { env },
      );
      expect(JSON.parse(result.stdout)).toEqual({ number: Number(number), title });
      expect(result.stdout + result.stderr).not.toContain(token);
    }
    for (const [kind, number] of [
      ['issue', '1'],
      ['pr', '2'],
    ]) {
      await exec(join(seed, 'gh'), [kind!, 'view', number!, '--repo', 'acme/app'], { env });
    }
    const result = await exec(
      join(seed, 'gh'),
      ['issue', 'comment', '1', '--repo', 'acme/app', '--body', 'hello'],
      { env },
    );
    expect(result.stdout).toContain('issuecomment-1');
    for (const kind of ['issue', 'pr']) {
      const listed = await exec(
        join(seed, 'gh'),
        [kind, 'list', '--repo', 'acme/app', '--json', 'number,title'],
        { env },
      );
      expect(JSON.parse(listed.stdout)).toEqual([]);
    }
    const created = await exec(
      join(seed, 'gh'),
      ['issue', 'create', '--repo', 'acme/app', '--title', 'Test', '--body', 'hello'],
      { env },
    );
    expect(created.stdout).toContain('/issues/3');
    const pr = await exec(
      join(seed, 'gh'),
      [
        'pr',
        'create',
        '--repo',
        'acme/app',
        '--head',
        'test',
        '--base',
        'main',
        '--title',
        'Test PR',
        '--body',
        'hello',
      ],
      { env },
    );
    expect(pr.stdout).toContain('/pull/3');
    await exec(join(seed, 'gh'), ['pr', 'close', '2', '--repo', 'acme/app'], { env });
    await exec(join(seed, 'gh'), ['pr', 'merge', '2', '--repo', 'acme/app', '--merge'], { env });
    expect(h.received.every((entry) => entry.auth === `Bearer ${token}`)).toBe(true);
  });
  it('runs real Git clone/fetch/push through Smart HTTP without a sandbox GitHub token', async () => {
    const root = join(dir, 'git-root');
    await mkdir(join(root, 'acme'), { recursive: true });
    const repo = join(root, 'acme', 'app.git');
    await exec('git', ['init', '--bare', '--initial-branch=main', repo]);
    await exec('git', ['--git-dir', repo, 'config', 'http.receivepack', 'true']);
    const h = await harness((req, res) => {
      const url = new URL(req.url ?? '/', 'http://upstream');
      const backend = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          REMOTE_USER: 'verity',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      req.pipe(backend.stdin);
      let headers = Buffer.alloc(0);
      let started = false;
      backend.stdout.on('data', (chunk: Buffer) => {
        if (started) {
          res.write(chunk);
          return;
        }
        headers = Buffer.concat([headers, chunk]);
        const end = headers.indexOf('\r\n\r\n');
        if (end < 0) return;
        for (const line of headers.subarray(0, end).toString().split('\r\n')) {
          const index = line.indexOf(':');
          if (index < 0) continue;
          const key = line.slice(0, index);
          const value = line.slice(index + 1).trim();
          if (key.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
          else res.setHeader(key, value);
        }
        started = true;
        res.write(headers.subarray(end + 4));
      });
      backend.on('close', () => res.end());
      backend.on('error', () => res.destroy());
    });
    const env = cliEnv(h.port);
    const config = [
      '-c',
      `http.https://github.com.proxy=http://127.0.0.1:${h.port}`,
      '-c',
      `http.https://github.com.sslCAInfo=${join(dir, 'ca.crt')}`,
      '-c',
      `credential.helper=${join(seed, 'verity-gh-cred')}`,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
    ];
    const clone = join(dir, 'clone');
    await exec('git', [...config, 'clone', 'https://github.com/acme/app.git', clone], { env });
    await exec('git', ['-C', clone, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { env });
    await writeFile(join(clone, 'large.bin'), randomBytes(2 * 1024 * 1024));
    await exec('git', [...config, '-C', clone, 'add', '.'], { env });
    await exec('git', [...config, '-C', clone, 'commit', '-m', 'test: seed transport fixture'], {
      env,
    });
    await exec('git', [...config, '-C', clone, 'push', 'origin', 'main'], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    await exec('git', [...config, '-C', clone, 'fetch', 'origin'], { env });
    const second = join(dir, 'second-clone');
    await exec('git', [...config, 'clone', 'https://github.com/acme/app.git', second], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(await readFile(join(second, 'large.bin'))).toEqual(
      await readFile(join(clone, 'large.bin')),
    );
    expect(
      h.received.every(
        (entry) =>
          entry.auth === `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ),
    ).toBe(true);
    expect(await readFile(join(clone, '.git', 'config'), 'utf8')).not.toContain(token);
  });
});
