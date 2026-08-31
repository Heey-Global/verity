import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDockerClient,
  createUnixSocketFetch,
  DockerError,
  parseUnixBaseUrl,
  parseImageRef,
  findPullStreamError,
  isUnixBaseUrl,
  openDockerUnixAttach,
  type ContainerSpec,
  type HttpFetchInit,
} from './docker.js';
import type { HttpFetch, HttpResponse } from './github.js';

interface FakeRoute {
  match: RegExp;
  method?: string;
  resp: HttpResponse | (() => HttpResponse);
}

/** Build a fake {@link HttpFetch} that dispatches on `method + url` substrings
 *  to canned {@link HttpResponse} objects. Each route may be a static response
 *  or a function `() => HttpResponse` so a test can simulate 304s, 409s, etc. */
function fakeFetch(routes: FakeRoute[]): HttpFetch & {
  calls: Array<{ url: string; init: HttpFetchInit | undefined }>;
} {
  const calls: Array<{ url: string; init: HttpFetchInit | undefined }> = [];
  const fetchFn: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (r.method !== undefined && init?.method !== r.method) continue;
      if (r.match.test(url)) {
        return typeof r.resp === 'function' ? r.resp() : r.resp;
      }
    }
    throw new Error(`fake fetch: no route for ${init?.method ?? 'GET'} ${url}`);
  };
  return Object.assign(fetchFn, { calls });
}

/** Build an HttpResponse shell for the docker client — `ok`/`status`/`json`. */
function res(body: unknown, opts: { ok?: boolean; status?: number } = {}): HttpResponse {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

/** HttpResponse whose `text()` returns a verbatim body — for the
 *  `/images/create` NDJSON stream (not a single JSON document). */
function textRes(body: string, opts: { ok?: boolean; status?: number } = {}): HttpResponse {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

const sampleSpec: ContainerSpec = {
  image: 'ghcr.io/heey-global/dev-base:2026.06@sha256:abc',
  name: 'dev-heey-global-verity',
  binds: ['/data/dev/heey-global-verity:/work'],
  labels: { 'verity.project-id': 'p1' },
};

describe('createDockerClient (#174)', () => {
  it('does not re-add a volume the replacement already inherits through Binds', async () => {
    // The shape every Gateway actually has: compose declares its volumes as Binds,
    // and HostConfig.Mounts is empty. Carrying them over a second time as Mounts
    // makes the daemon reject the create with "Duplicate mount point".
    const fetch = fakeFetch([
      {
        match: /\/containers\/old\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-agent-gateway-1',
          Config: { Image: 'ghcr.io/heey-global/verity/verity-server@sha256:old' },
          HostConfig: {
            Binds: [
              'verity-agent-gateway-control:/run/verity-agent-gateway:rw',
              '/var/run/docker.sock:/var/run/docker.sock',
            ],
          },
          Mounts: [
            {
              Type: 'volume',
              Name: 'verity-agent-gateway-control',
              Destination: '/run/verity-agent-gateway',
              RW: true,
            },
            {
              Type: 'volume',
              Name: 'anonymous-state',
              Destination: '/var/lib/state',
              RW: true,
            },
          ],
        }),
      },
      { match: /\/containers\/json\?all=true/, method: 'GET', resp: res([]) },
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
      { match: /\/images\/.*\/json/, method: 'GET', resp: res({ Config: { Env: [] } }) },
      {
        match: /\/containers\/create\?name=verity-agent-gateway-1-replacement-old/,
        method: 'POST',
        resp: res({ Id: 'new' }),
      },
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}) },
      {
        match: /\/containers\/old\/rename\?name=verity-agent-gateway-1-predecessor-old/,
        method: 'POST',
        resp: res({}),
      },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-agent-gateway-1-replacement-old',
          State: { Running: true },
        }),
      },
      {
        match: /\/containers\/new\/rename\?name=verity-agent-gateway-1/,
        method: 'POST',
        resp: res({}),
      },
      { match: /\/containers\/old\?force=true&v=false/, method: 'DELETE', resp: res({}) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

    await expect(
      docker.replaceContainerImage?.(
        'old',
        `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`,
      ),
    ).resolves.toBe('new');

    const create = fetch.calls.find((call) => /\/containers\/create\?/.test(call.url));
    const body = JSON.parse(create?.init?.body ?? '{}') as {
      HostConfig?: { Binds?: string[]; Mounts?: Array<{ Target?: string }> };
    };
    // The bound volume stays a Bind and must not appear a second time as a Mount.
    expect(body.HostConfig?.Binds).toContain(
      'verity-agent-gateway-control:/run/verity-agent-gateway:rw',
    );
    expect((body.HostConfig?.Mounts ?? []).map((mount) => mount.Target)).toEqual([
      '/var/lib/state',
    ]);
  });

  /**
   * The maintenance-window guarantee (ADR 0008 D14).
   *
   * The control-plane PostgreSQL swap pre-pulls during preparation so that
   * nothing inside the cutover's quiesce window waits on a registry. This method
   * used to pull unconditionally, which made that guarantee false without a
   * single caller doing anything wrong — so the skip is pinned here, where it is
   * enforced, rather than only asserted at the call site through a mock.
   */
  describe('the implicit pull', () => {
    const routes = (present: boolean): FakeRoute[] => [
      {
        match: /\/containers\/old\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-postgres-1',
          Config: { Image: 'postgres:18-alpine@sha256:old', Env: [] },
          HostConfig: {},
        }),
      },
      { match: /\/containers\/json\?all=true/, method: 'GET', resp: res([]) },
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
      {
        match: /\/images\/.*\/json/,
        method: 'GET',
        resp: present
          ? res({ Config: { Env: [] } })
          : (() => {
              let seen = false;
              return () => {
                // Absent, then present once the pull has run.
                const answer = seen
                  ? res({ Config: { Env: [] } })
                  : res({}, { ok: false, status: 404 });
                seen = true;
                return answer;
              };
            })(),
      },
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'new' }) },
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}) },
      { match: /\/containers\/old\/rename\?name=/, method: 'POST', resp: res({}) },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({ Name: '/verity-postgres-1-replacement-old', State: { Running: true } }),
      },
      { match: /\/containers\/new\/rename\?name=/, method: 'POST', resp: res({}) },
      { match: /\/containers\/old\?force=true&v=false/, method: 'DELETE', resp: res({}) },
    ];
    const pulls = (fetch: { calls: Array<{ url: string }> }): number =>
      fetch.calls.filter((call) => /\/images\/create/.test(call.url)).length;

    it('is skipped for a digest-pinned image the daemon already holds', async () => {
      const fetch = fakeFetch(routes(true));
      const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
      await expect(
        docker.replaceContainerImage?.('old', `postgres:18-alpine@sha256:${'b'.repeat(64)}`),
      ).resolves.toBe('new');
      expect(pulls(fetch)).toBe(0);
    });

    it('still runs for a digest the daemon does not have', async () => {
      const fetch = fakeFetch(routes(false));
      const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
      await expect(
        docker.replaceContainerImage?.('old', `postgres:18-alpine@sha256:${'b'.repeat(64)}`),
      ).resolves.toBe('new');
      expect(pulls(fetch)).toBe(1);
    });

    it('still runs for a tag, which names different bytes over time', async () => {
      const fetch = fakeFetch(routes(true));
      const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
      await expect(docker.replaceContainerImage?.('old', 'postgres:18-alpine')).resolves.toBe(
        'new',
      );
      expect(pulls(fetch)).toBe(1);
    });
  });

  it('replaces infrastructure containers without changing their runtime contract', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/old\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-updater-1',
          Config: {
            Image: 'ghcr.io/heey-global/verity/verity-server@sha256:old',
            Env: ['VERITY_MANAGED_DEPLOYMENT_ID=deployment-1', 'VERITY_SERVER_VERSION=13.0.1'],
            Cmd: ['managed-updater'],
            Labels: {
              'com.docker.compose.service': 'verity-updater',
              'org.opencontainers.image.version': 'v13.0.1',
              'org.opencontainers.image.revision': 'oldsha',
            },
          },
          HostConfig: {
            NetworkMode: 'none',
            Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
            RestartPolicy: { Name: 'unless-stopped' },
          },
          Mounts: [
            {
              Type: 'volume',
              Name: 'anonymous-runtime-state',
              Destination: '/var/lib/runtime-state',
              RW: true,
            },
          ],
          NetworkSettings: {
            Networks: {
              'verity-net': {
                Aliases: ['verity-updater-1', 'a'.repeat(12), 'verity-updater'],
                DriverOpts: { 'com.example.option': 'kept' },
                MacAddress: '02:42:ac:13:00:08',
              },
            },
          },
        }),
      },
      { match: /\/containers\/json\?all=true/, method: 'GET', resp: res([]) },
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
      {
        match: /\/images\/.*\/json/,
        method: 'GET',
        resp: res({
          Config: {
            Env: ['VERITY_SERVER_VERSION=13.1.5'],
            Labels: {
              'org.opencontainers.image.version': 'v13.1.5',
              'org.opencontainers.image.revision': 'newsha',
            },
          },
        }),
      },
      {
        match: /\/containers\/create\?name=verity-updater-1-replacement-old/,
        method: 'POST',
        resp: res({ Id: 'new' }),
      },
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}) },
      {
        match: /\/containers\/old\/rename\?name=verity-updater-1-predecessor-old/,
        method: 'POST',
        resp: res({}),
      },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({ Name: '/verity-updater-1-replacement-old', State: { Running: true } }),
      },
      { match: /\/containers\/new\/rename\?name=verity-updater-1/, method: 'POST', resp: res({}) },
      { match: /\/containers\/old\?force=true&v=false/, method: 'DELETE', resp: res({}) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

    await expect(
      docker.replaceContainerImage?.(
        'old',
        `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      ),
    ).resolves.toBe('new');

    const create = fetch.calls.find((call) => /\/containers\/create\?/.test(call.url));
    const body = JSON.parse(create?.init?.body ?? '{}');
    expect(body).toMatchObject({
      Image: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      Env: ['VERITY_MANAGED_DEPLOYMENT_ID=deployment-1', 'VERITY_SERVER_VERSION=13.1.5'],
      Cmd: ['managed-updater'],
      Labels: { 'com.docker.compose.service': 'verity-updater' },
      HostConfig: {
        NetworkMode: 'none',
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        RestartPolicy: { Name: 'unless-stopped' },
        Mounts: [
          {
            Type: 'volume',
            Source: 'anonymous-runtime-state',
            Target: '/var/lib/runtime-state',
            ReadOnly: false,
          },
        ],
      },
    });
    expect(body.Labels).toMatchObject({
      'com.docker.compose.service': 'verity-updater',
      'verity.replacement-for': 'old',
      'verity.replacement-name': 'verity-updater-1',
    });
    // The replacement describes the image it RUNS, not the one it displaced —
    // fleet inspection reads these, and inheriting them verbatim made a v13.5.0
    // container report v13.3.2. Labels the target image does not define survive,
    // which is why the Compose service above is still there.
    expect(body.Labels).toMatchObject({
      'org.opencontainers.image.version': 'v13.1.5',
      'org.opencontainers.image.revision': 'newsha',
    });
    expect(body.NetworkingConfig.EndpointsConfig['verity-net']).toEqual({
      Aliases: ['verity-updater'],
      DriverOpts: { 'com.example.option': 'kept' },
    });
  });

  it('finishes an interrupted replacement after the predecessor disappeared', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/old\/json/,
        method: 'GET',
        resp: res({ message: 'No such container: old' }, { ok: false, status: 404 }),
      },
      {
        match: /\/containers\/json\?all=true/,
        method: 'GET',
        resp: res([
          {
            Id: 'new',
            Labels: {
              'verity.replacement-for': 'old',
              'verity.replacement-name': 'verity-updater-1',
            },
          },
        ]),
      },
      {
        match: /\/containers\/new\/start/,
        method: 'POST',
        resp: res({}, { ok: false, status: 304 }),
      },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({ Name: '/verity-updater-1' }),
      },
      {
        match: /\/containers\/new\/rename\?name=verity-updater-1/,
        method: 'POST',
        resp: res({}),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

    await expect(
      docker.replaceContainerImage?.(
        'old',
        `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      ),
    ).resolves.toBe('new');
    expect(fetch.calls.some((call) => call.url.includes('/containers/new/rename'))).toBe(false);
  });

  it('waits for one-shot containers and reads a bounded log tail', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/wait\?condition=not-running/,
        method: 'POST',
        resp: res({ StatusCode: 0 }),
      },
      {
        match: /\/containers\/abc\/logs\?stdout=1&stderr=1&tail=25/,
        method: 'GET',
        resp: res('ready'),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.waitContainer?.('abc')).resolves.toBe(0);
    await expect(docker.containerLogs?.('abc', 25)).resolves.toBe('"ready"');
  });

  it('rejects malformed wait responses and unbounded log requests', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/wait/,
        method: 'POST',
        resp: res({ StatusCode: '0' }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.waitContainer?.('abc')).rejects.toThrow(/invalid container wait response/);
    await expect(docker.containerLogs?.('abc', 1001)).rejects.toThrow(/between 1 and 1000/);
  });

  it('decodes Docker multiplexed stdout and stderr log frames', async () => {
    const frame = (stream: number, value: string): Buffer => {
      const payload = Buffer.from(value);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const body = Buffer.concat([frame(1, 'ready\n'), frame(2, 'warning\n')]).toString('utf8');
    const fetch = fakeFetch([
      { match: /\/containers\/abc\/logs/, method: 'GET', resp: textRes(body) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.containerLogs?.('abc', 25)).resolves.toBe('ready\nwarning\n');
  });

  it('preserves bounded diagnostics when a Docker log frame is truncated', async () => {
    const payload = Buffer.alloc(70 * 1024, 97);
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    const body = Buffer.concat([header, payload]).toString('utf8');
    const fetch = fakeFetch([
      { match: /\/containers\/abc\/logs/, method: 'GET', resp: textRes(body) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    const logs = await docker.containerLogs?.('abc', 25);
    expect(logs).toContain('aaaa');
    expect(logs).toContain('[truncated]');
    expect(Buffer.byteLength(logs ?? '')).toBeLessThanOrEqual(64 * 1024);
  });

  it('POSTs /containers/create?name=… and pulls the Id + Warnings out', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc123', Warnings: ['note'] }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
    });
    const result = await docker.createContainer(sampleSpec);
    expect(result.id).toBe('abc123');
    expect(result.warnings).toEqual(['note']);
    // Request shape asserts the bind-mount + labels reach the engine body.
    const last = fetch.calls[0];
    expect(last?.init?.method).toBe('POST');
    expect(last?.url).toContain('name=dev-heey-global-verity');
    const body = JSON.parse(last?.init?.body ?? '{}');
    expect(body.Image).toBe(sampleSpec.image);
    expect(body.HostConfig.Binds).toEqual(['/data/dev/heey-global-verity:/work']);
    expect(body.Labels).toEqual({ 'verity.project-id': 'p1' });
    expect(body.HostConfig.Init).toBe(true);
    // No network override → the daemon's default bridge (today's behavior).
    expect(body.HostConfig.NetworkMode).toBe('default');
  });

  it('attaches the container to an explicit network when spec.network is set', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc123' }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
    });
    await docker.createContainer({ ...sampleSpec, network: 'verity-net' });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    // Reaches the server (and the signing broker) by service DNS name over the
    // shared internal network instead of the default bridge.
    expect(body.HostConfig.NetworkMode).toBe('verity-net');
  });

  it('passes the managed platform and supplementary groups to Docker', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      platform: 'linux/arm64',
      groupAdd: ['999', '1101'],
    });
    expect(fetch.calls[0]?.url).toContain('platform=linux%2Farm64');
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.GroupAdd).toEqual(['999', '1101']);
  });

  it('emits named-volume mounts with a subpath as HostConfig.Mounts (Docker 25 volume-subpath)', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      volumeMounts: [
        { volume: 'verity-data', target: '/work', subpath: 'workspaces/heey-global-verity' },
        {
          volume: 'verity-data',
          target: '/run/verity',
          subpath: 'secrets/p1',
          readOnly: true,
        },
      ],
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Mounts).toEqual([
      {
        Type: 'volume',
        Source: 'verity-data',
        Target: '/work',
        ReadOnly: false,
        VolumeOptions: { Subpath: 'workspaces/heey-global-verity' },
      },
      {
        Type: 'volume',
        Source: 'verity-data',
        Target: '/run/verity',
        ReadOnly: true,
        VolumeOptions: { Subpath: 'secrets/p1' },
      },
    ]);
  });

  it('omits HostConfig.Mounts when the spec sets no volume mounts', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer(sampleSpec);
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Mounts).toBeUndefined();
  });

  it('omits all hardening HostConfig fields when the spec sets none (backward compatible)', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer(sampleSpec);
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.CapDrop).toBeUndefined();
    expect(body.HostConfig.SecurityOpt).toBeUndefined();
    expect(body.HostConfig.PidsLimit).toBeUndefined();
    expect(body.HostConfig.Memory).toBeUndefined();
    expect(body.HostConfig.NanoCpus).toBeUndefined();
    expect(body.HostConfig.Ulimits).toBeUndefined();
    expect(body.HostConfig.Runtime).toBeUndefined();
    expect(body.HostConfig.ReadonlyRootfs).toBeUndefined();
    expect(body.HostConfig.Tmpfs).toBeUndefined();
  });

  it('emits runtime-hardening HostConfig fields when the spec sets them (C1)', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      capDrop: ['ALL'],
      capAdd: ['NET_BIND_SERVICE'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 512,
      memoryBytes: 2 * 1024 ** 3,
      memorySwapBytes: 2 * 1024 ** 3,
      nanoCpus: 1_500_000_000,
      ulimits: [{ name: 'core', soft: 0, hard: 0 }],
      runtime: 'runsc',
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864' },
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.CapAdd).toEqual(['NET_BIND_SERVICE']);
    expect(body.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(body.HostConfig.PidsLimit).toBe(512);
    expect(body.HostConfig.Memory).toBe(2 * 1024 ** 3);
    // Pinned to `Memory`: the swap ceiling is what stops a capped container from
    // thrashing instead of OOMing, and Docker's default is twice the memory limit.
    expect(body.HostConfig.MemorySwap).toBe(2 * 1024 ** 3);
    expect(body.HostConfig.NanoCpus).toBe(1_500_000_000);
    // Docker's rlimit shape: the `RLIMIT_` prefix is dropped, soft and hard are both
    // required, and a zero core limit is a real limit rather than an omission.
    expect(body.HostConfig.Ulimits).toEqual([{ Name: 'core', Soft: 0, Hard: 0 }]);
    expect(body.HostConfig.Runtime).toBe('runsc');
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Tmpfs).toEqual({
      '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
    });
  });

  it('drops a ulimit whose soft/hard is not a usable rlimit value', async () => {
    // Unlike `Memory`, a bad rlimit is not merely ignored: `NaN` serializes to `null`
    // and Docker rejects the whole create, so one nonsense limit would read as a
    // container that could not start. `-1` is Docker's "unlimited" and stays.
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      ulimits: [
        { name: 'core', soft: Number.NaN, hard: 0 },
        { name: 'nofile', soft: -5, hard: 1024 },
        { name: '', soft: 0, hard: 0 },
        { name: 'core ', soft: 0, hard: 0 },
        { name: 'unsupported', soft: 0, hard: 0 },
        // A soft above its hard is rejected by the daemon too — and `-1` compares as
        // unlimited, so an unlimited soft under a finite hard is that same mistake.
        { name: 'nofile', soft: 4096, hard: 1024 },
        { name: 'nofile', soft: -1, hard: 1024 },
        { name: 'nproc', soft: -1, hard: -1 },
        { name: 'core', soft: 0, hard: -1 },
      ],
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Ulimits).toEqual([
      { Name: 'nproc', Soft: -1, Hard: -1 },
      { Name: 'core', Soft: 0, Hard: -1 },
    ]);
  });

  it('drops a swap ceiling that comes without a memory ceiling', async () => {
    // Docker refuses "MemorySwap without Memory" outright, so forwarding it would turn a
    // half-specified spec into a container that cannot start.
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({ ...sampleSpec, memorySwapBytes: 2 * 1024 ** 3 });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Memory).toBeUndefined();
    expect(body.HostConfig.MemorySwap).toBeUndefined();
  });

  it('drops a swap ceiling below the memory ceiling', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      memoryBytes: 2 * 1024 ** 3,
      memorySwapBytes: 1024 ** 3,
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Memory).toBe(2 * 1024 ** 3);
    expect(body.HostConfig.MemorySwap).toBeUndefined();
  });

  it('omits Ulimits entirely when every entry was unusable', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({
      ...sampleSpec,
      ulimits: [{ name: 'core', soft: Number.NaN, hard: Number.NaN }],
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Ulimits).toBeUndefined();
  });

  it('drops a zero memory/cpu limit rather than pinning it to 0 (unlimited)', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create\?name=/, method: 'POST', resp: res({ Id: 'abc123' }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.createContainer({ ...sampleSpec, memoryBytes: 0, nanoCpus: 0 });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.HostConfig.Memory).toBeUndefined();
    expect(body.HostConfig.NanoCpus).toBeUndefined();
  });

  it('passes an explicit container user on create', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc123' }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
    });
    await docker.createContainer({ ...sampleSpec, user: 'vscode' });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.User).toBe('vscode');
  });

  it('includes explicit host port bindings on container create', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc123' }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
    });

    await docker.createContainer({
      ...sampleSpec,
      portBindings: [{ hostPort: '3000', containerPort: '3000' }],
    });

    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.ExposedPorts).toEqual({ '3000/tcp': {} });
    expect(body.HostConfig.PortBindings).toEqual({
      '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }],
    });
  });

  it('includes explicit entrypoint and command overrides on container create', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc123' }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
    });

    await docker.createContainer({
      ...sampleSpec,
      entrypoint: ['/bin/sh', '-lc'],
      command: ['sleep infinity'],
      openStdin: true,
    });

    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(body.Entrypoint).toEqual(['/bin/sh', '-lc']);
    expect(body.Cmd).toEqual(['sleep infinity']);
    expect(body.OpenStdin).toBe(true);
    expect(body.AttachStdin).toBe(true);
  });

  it('maps a 404 on /containers/create to image_not_found (not generic API 404)', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create/,
        method: 'POST',
        resp: res(
          { message: 'No such image: ghcr.io/.../dev-base:2026.06' },
          { ok: false, status: 404 },
        ),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.createContainer(sampleSpec)).rejects.toMatchObject({
      kind: 'image_not_found',
      image: sampleSpec.image,
    });
  });

  it('maps a 409 (name taken) to a conflict error', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create/,
        method: 'POST',
        resp: res(
          { message: 'Conflict. The container name "/dev-x" is already in use' },
          { ok: false, status: 409 },
        ),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.createContainer(sampleSpec)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('maps a network/fetch failure to a network error (preserves cause)', async () => {
    const fetch: HttpFetch = async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:9234');
    };
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.createContainer(sampleSpec)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('startContainer: POSTs /containers/{id}/start with no body', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc123\/start/,
        method: 'POST',
        resp: res(''),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.startContainer('abc123');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.init?.body).toBeUndefined();
    expect(fetch.calls[0]?.init?.method).toBe('POST');
  });

  it('startContainer maps 404 to container_not_found (the container was already GCed)', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc123\/start/,
        method: 'POST',
        resp: res({ message: 'No such container: abc123' }, { ok: false, status: 404 }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.startContainer('abc123')).rejects.toMatchObject({
      kind: 'container_not_found',
      id: 'abc123',
    });
  });

  it('stopContainer is no-op on 304 (already-stopped signal — Engine convention)', async () => {
    // Engine convention: stop returns 304 when the container was already stopped,
    // a NOT-modified status code that fetch treats as "ok" (2xx-3xx). The client
    // resolves successfully — the caller doesn't care whether it was already
    // stopped; only that it stopped / is stopped now.
    const fetch = fakeFetch([
      { match: /\/containers\/abc\/stop/, method: 'POST', resp: res('', { status: 304 }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.stopContainer('abc')).resolves.toBeUndefined();
  });

  it('removeContainer on 404 raises container_not_found (the deprovision path catches)', async () => {
    // We do NOT swallow 404 here intentionally — the deprovision path's
    // `try { docker.removeContainer } catch { /* already gone */ }` is the place
    // idempotency is implemented, not in the client (which tries to be truthful
    // about what the Engine said).
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\?force=true/,
        method: 'DELETE',
        resp: res('', { ok: false, status: 404 }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.removeContainer('abc')).rejects.toMatchObject({
      kind: 'container_not_found',
    });
  });

  it('removeContainer uses ?force=true (the engine tears down a running container)', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/abc\?force=true/, method: 'DELETE', resp: res('') },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.removeContainer('abc');
    expect(fetch.calls[0]?.url).toContain('?force=true');
  });

  it('removeContainer passes v=true so anonymous volumes die with the container', async () => {
    // Regression guard for the host-disk leak: an image with a VOLUME instruction
    // makes the daemon mint an anonymous volume per create. Removing without `v`
    // orphans it, and `docker system prune` never reaches a volume — so a runner
    // that provisions/tears down sandboxes leaks one per container until the disk
    // is full. Named volumes (verity-data) are untouched by this flag.
    const fetch = fakeFetch([
      { match: /\/containers\/abc\?force=true&v=true/, method: 'DELETE', resp: res('') },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.removeContainer('abc');
    expect(fetch.calls[0]?.url).toContain('v=true');
  });

  it('listImages drops the <none>:<none> placeholder and tolerates a null RepoTags', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/json/,
        method: 'GET',
        resp: res([
          { Id: 'sha256:a', RepoTags: ['verity-devc-acme-web:aaa'], Created: 100, Size: 5 },
          { Id: 'sha256:b', RepoTags: ['<none>:<none>'], Created: 90, Size: 6 },
          { Id: 'sha256:c', RepoTags: null, Created: 80, Size: 7 },
        ]),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    expect(await docker.listImages?.()).toEqual([
      { id: 'sha256:a', repoTags: ['verity-devc-acme-web:aaa'], created: 100, size: 5 },
      { id: 'sha256:b', repoTags: [], created: 90, size: 6 },
      { id: 'sha256:c', repoTags: [], created: 80, size: 7 },
    ]);
  });

  it('removeImage and removeVolume treat 404 as already-gone', async () => {
    const fetch = fakeFetch([
      { match: /\/images\//, method: 'DELETE', resp: res('', { ok: false, status: 404 }) },
      { match: /\/volumes\//, method: 'DELETE', resp: res('', { ok: false, status: 404 }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.removeImage?.('verity-devc-acme-web:aaa')).resolves.toBeUndefined();
    await expect(docker.removeVolume?.('abc')).resolves.toBeUndefined();
  });

  it('removeImage surfaces a 409 (image still in use) as a typed conflict', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\//,
        method: 'DELETE',
        resp: res({ message: 'image is being used' }, { ok: false, status: 409 }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.removeImage?.('verity-devc-acme-web:aaa')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('listVolumes asks the daemon for the dangling filter', async () => {
    const fetch = fakeFetch([
      {
        match: /\/volumes/,
        method: 'GET',
        resp: res({
          Volumes: [
            {
              Name: 'abc',
              Labels: { 'com.docker.volume.anonymous': '' },
              CreatedAt: '2026-07-01T00:00:00Z',
            },
            { Name: 'verity-data', Labels: null },
          ],
        }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    const volumes = await docker.listVolumes?.({ danglingOnly: true });
    expect(fetch.calls[0]?.url).toContain(encodeURIComponent('{"dangling":["true"]}'));
    expect(volumes).toEqual([
      {
        name: 'abc',
        labels: { 'com.docker.volume.anonymous': '' },
        createdAt: '2026-07-01T00:00:00Z',
      },
      { name: 'verity-data', labels: {} },
    ]);
  });

  it('pruneBuildCache sends the until filter and returns SpaceReclaimed', async () => {
    const fetch = fakeFetch([
      { match: /\/build\/prune/, method: 'POST', resp: res({ SpaceReclaimed: 4096 }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    expect(await docker.pruneBuildCache?.({ untilHours: 168 })).toBe(4096);
    expect(fetch.calls[0]?.url).toContain(encodeURIComponent('{"until":["168h"]}'));
  });

  it('inspectContainer reads {State.Running} + Id, returns {id, running}', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/json/,
        method: 'GET',
        resp: res({
          Id: 'abc',
          State: { Running: true },
          Config: {
            Env: [],
            User: '65532:65532',
            Entrypoint: ['/usr/local/bin/verity-secret-job-worker'],
            Cmd: [],
            OpenStdin: true,
          },
          HostConfig: {
            Runtime: 'runsc',
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            Tmpfs: { '/tmp': 'rw,noexec' },
            CapDrop: ['ALL'],
            CapAdd: null,
            SecurityOpt: ['no-new-privileges:true'],
            PidsLimit: 128,
            Memory: 536_870_912,
            MemorySwap: 536_870_912,
            NanoCpus: 1_000_000_000,
            Privileged: false,
            Devices: [],
            DeviceRequests: null,
            RestartPolicy: { Name: 'no' },
            Init: true,
          },
          Mounts: [
            {
              Type: 'bind',
              Source: '/run/project/credentials',
              Destination: '/run/credentials',
              RW: false,
            },
          ],
          NetworkSettings: {
            Networks: {
              'verity-net': { IPAddress: '172.19.0.4' },
              empty: { IPAddress: '' },
            },
          },
        }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    const result = await docker.inspectContainer('abc');
    expect(result.id).toBe('abc');
    expect(result.running).toBe(true);
    expect(result.runtime).toBe('runsc');
    expect(result.mounts).toEqual([
      {
        type: 'bind',
        source: '/run/project/credentials',
        destination: '/run/credentials',
        readWrite: false,
      },
    ]);
    expect(result).toMatchObject({
      networkMode: 'none',
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      pidsLimit: 128,
      memoryBytes: 536_870_912,
      // Equal to the memory ceiling, so the container cannot swap. Reported
      // because the difference from Docker's default (twice the memory limit) is
      // invisible otherwise.
      memorySwapBytes: 536_870_912,
      nanoCpus: 1_000_000_000,
      privileged: false,
      deviceCount: 0,
      restartPolicy: 'no',
      mountCount: 1,
      env: [],
      user: '65532:65532',
      entrypoint: ['/usr/local/bin/verity-secret-job-worker'],
      command: [],
      openStdin: true,
      init: true,
    });
    expect(result.networks?.['verity-net']?.ipAddress).toBe('172.19.0.4');
  });

  it('inspectContainer reports the container environment verbatim', async () => {
    // The mapping itself is not new; the coverage is. It is what the whole env-drift
    // feature rests on and what nothing else pinned: every classification test feeds
    // a hand-built inspect, so if this mapping were dropped or renamed, drift would
    // simply never be detected in production and the suite would stay green.
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/json/,
        method: 'GET',
        resp: res({
          Id: 'abc',
          State: { Running: true },
          Config: { Env: ['PATH=/usr/bin', 'VERITY_CODEX_EGRESS_URL=https://relay:8444'] },
        }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.inspectContainer('abc')).resolves.toMatchObject({
      env: ['PATH=/usr/bin', 'VERITY_CODEX_EGRESS_URL=https://relay:8444'],
    });
  });

  it('inspectContainer omits env entirely when the reply carries none', async () => {
    // Relay migration reads env to decide whether a sandbox needs a recreate, and
    // has to tell env that is absent from env it never read (`project-relay-migration.ts`).
    // It defends itself — an empty or non-array `env` reads as unread there too — but
    // leaving the field off when the reply carries no `Config.Env` is what makes
    // "unread" observable at all, rather than something inferred from a shape.
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/json/,
        method: 'GET',
        resp: res({ Id: 'abc', State: { Running: true }, Config: { User: 'dev' } }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    const result = await docker.inspectContainer('abc');
    expect(result.user).toBe('dev');
    expect('env' in result).toBe(false);
    expect(result.env).toBeUndefined();
  });

  it('inspectContainer keeps a volume mount name apart from the host path it resolves to', async () => {
    // The daemon reports `Source` for a named volume as wherever the volume
    // currently lives on disk. Callers comparing a spec's `verity-data` against
    // that path would never match, so `Name` is carried through separately.
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/json/,
        method: 'GET',
        resp: res({
          Id: 'abc',
          State: { Running: true },
          Config: { Env: [] },
          HostConfig: {},
          Mounts: [
            {
              Type: 'volume',
              Name: 'verity-data',
              Source: '/var/lib/docker/volumes/verity-data/_data',
              Destination: '/srv/verity',
              RW: true,
            },
          ],
        }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    expect((await docker.inspectContainer('abc')).mounts).toEqual([
      {
        type: 'volume',
        name: 'verity-data',
        source: '/var/lib/docker/volumes/verity-data/_data',
        destination: '/srv/verity',
        readWrite: true,
      },
    ]);
  });

  it('inspectImageEnv reads the image environment and reports an absent image as undefined', async () => {
    const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
    const fetch = fakeFetch([
      {
        match: new RegExp(
          `/images/${encodeURIComponent(image).replace(/[$*+?.^|]/g, '\\$&')}/json`,
        ),
        method: 'GET',
        resp: res({ Config: { Env: ['PATH=/usr/local/bin', 'NODE_ENV=production'] } }),
      },
      {
        match: /\/images\/.*missing.*\/json/,
        method: 'GET',
        resp: res({ message: 'No such image' }, { ok: false, status: 404 }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.inspectImageEnv?.(image)).resolves.toEqual([
      'PATH=/usr/local/bin',
      'NODE_ENV=production',
    ]);
    // An image with no baked environment is still present; only a 404 is absent.
    await expect(docker.inspectImageEnv?.('verity/missing:1')).resolves.toBeUndefined();
  });

  it('inspectImageEnv treats an image without a baked environment as empty, not absent', async () => {
    const fetch = fakeFetch([
      { match: /\/images\/.*\/json/, method: 'GET', resp: res({ Config: {} }) },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.inspectImageEnv?.('verity/bare:1')).resolves.toEqual([]);
  });

  it('inspectContainer maps 404 to container_not_found', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/json/,
        method: 'GET',
        resp: res({ message: 'No such container' }, { ok: false, status: 404 }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await expect(docker.inspectContainer('abc')).rejects.toMatchObject({
      kind: 'container_not_found',
      id: 'abc',
    });
  });

  it('inspectRuntime reads the exact daemon path and arguments from /info', async () => {
    const fetch = fakeFetch([
      {
        match: /\/info$/,
        method: 'GET',
        resp: res({
          Runtimes: {
            runsc: {
              path: '/opt/verity/runsc/release-20260714.0/runsc',
              runtimeArgs: ['--platform=systrap', '--network=none'],
            },
          },
        }),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://docker:2375/v1.41', fetch });

    await expect(docker.inspectRuntime?.('runsc')).resolves.toEqual({
      path: '/opt/verity/runsc/release-20260714.0/runsc',
      args: ['--platform=systrap', '--network=none'],
    });
    await expect(docker.inspectRuntime?.('missing')).resolves.toBeUndefined();
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/create\?name=/,
        method: 'POST',
        resp: res({ Id: 'abc' }),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41/',
      fetch,
    });
    await docker.createContainer(sampleSpec);
    expect(fetch.calls[0]?.url).toBe(
      'http://127.0.0.1:9234/v1.41/containers/create?name=dev-heey-global-verity',
    );
  });

  it("passes AbortSignal.timeout(timeoutMs) so a hung Engine can't stall the caller", async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create/, method: 'POST', resp: res({ Id: 'abc' }) },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
      timeoutMs: 5_000,
    });
    await docker.createContainer(sampleSpec);
    const signal = fetch.calls[0]?.init?.signal;
    expect(signal).toBeDefined();
    // AbortSignal.timeout's `aborted` is false on construction; we don't
    // actively wait it. Just verify it was wired.
    expect((signal as { aborted?: boolean } | undefined)?.aborted).toBe(false);
  });
});

describe('parseUnixBaseUrl (ADR 0003 R2)', () => {
  it('detects unix vs http base URLs', () => {
    expect(isUnixBaseUrl('unix:///var/run/docker.sock')).toBe(true);
    expect(isUnixBaseUrl('unix:/var/run/docker.sock')).toBe(true);
    expect(isUnixBaseUrl('http://127.0.0.1:9234/v1.41')).toBe(false);
  });

  it('parses a bare socket path with no API-version prefix', () => {
    const parsed = parseUnixBaseUrl('unix:///var/run/docker.sock');
    expect(parsed.socketPath).toBe('/var/run/docker.sock');
    expect(parsed.apiPrefix).toBe('');
  });

  it('splits off a trailing :/<api-version> as the api prefix', () => {
    const parsed = parseUnixBaseUrl('unix:///var/run/docker.sock:/v1.41');
    expect(parsed.socketPath).toBe('/var/run/docker.sock');
    expect(parsed.apiPrefix).toBe('/v1.41');
  });

  it('throws on an empty socket path', () => {
    expect(() => parseUnixBaseUrl('unix://')).toThrow(/empty socket path/);
  });
});

/** Route table for the unix Docker stub: keyed by `METHOD path` (path includes
 *  the api-version prefix + query the client sends). Each handler receives the
 *  parsed JSON body (or undefined) and returns `{ status, body }`. */
interface StubCall {
  method: string;
  path: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

/** Start a real HTTP server on a temp unix socket that behaves like a tiny
 *  Docker Engine, so the unix transport is exercised end-to-end (node:http over
 *  the socket) rather than mocked. Returns the socket path + a call log. */
function startDockerStub(
  handler: (call: StubCall) => { status: number; body?: unknown; raw?: string },
): Promise<{ socketPath: string; calls: StubCall[]; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'verity-dsock-'));
  const socketPath = join(dir, 'docker.sock');
  const calls: StubCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const call: StubCall = {
        method: req.method ?? 'GET',
        path: req.url ?? '',
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
        headers: req.headers,
      };
      calls.push(call);
      const { status, body, raw: rawBody } = handler(call);
      res.statusCode = status;
      // `raw` lets a test send a verbatim body (e.g. the /images/create NDJSON
      // progress stream, which is NOT a single JSON document).
      if (rawBody !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(rawBody);
      } else if (body === undefined) {
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen({ path: socketPath }, () => {
      resolve({
        socketPath,
        calls,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              res();
            });
          }),
      });
    });
  });
}

describe('createDockerClient unix-socket transport (ADR 0003 R2)', () => {
  let stub: Awaited<ReturnType<typeof startDockerStub>> | undefined;

  beforeEach(() => {
    stub = undefined;
  });
  afterEach(async () => {
    if (stub !== undefined) await stub.close();
  });

  it('createContainer sends POST /containers/create with body over the socket and parses the Id', async () => {
    stub = await startDockerStub((call) => {
      if (call.method === 'POST' && call.path.startsWith('/containers/create')) {
        return { status: 201, body: { Id: 'unix-abc', Warnings: ['w'] } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    const result = await docker.createContainer(sampleSpec);

    expect(result.id).toBe('unix-abc');
    expect(result.warnings).toEqual(['w']);
    const call = stub.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/containers/create?name=dev-heey-global-verity');
    // The JSON body the client built reached the socket intact.
    const body = call?.body as { Image?: string; HostConfig?: { Binds?: string[] } };
    expect(body.Image).toBe(sampleSpec.image);
    expect(body.HostConfig?.Binds).toEqual(['/data/dev/heey-global-verity:/work']);
  });

  it('honours an API-version path prefix in the base URL', async () => {
    stub = await startDockerStub(() => ({ status: 201, body: { Id: 'x' } }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}:/v1.41` });
    await docker.createContainer(sampleSpec);
    // The daemon sees the version-prefixed path.
    expect(stub.calls[0]?.path).toBe('/v1.41/containers/create?name=dev-heey-global-verity');
  });

  it('startContainer POSTs /containers/{id}/start with no body and resolves on 204', async () => {
    stub = await startDockerStub(() => ({ status: 204 }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.startContainer('unix-abc')).resolves.toBeUndefined();
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.path).toBe('/containers/unix-abc/start');
    expect(stub.calls[0]?.body).toBeUndefined();
  });

  it('maps a 404 on create to image_not_found (mapping reused over the socket)', async () => {
    stub = await startDockerStub(() => ({
      status: 404,
      body: { message: 'No such image: ghcr.io/heey-global/dev-base' },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.createContainer(sampleSpec)).rejects.toMatchObject({
      kind: 'image_not_found',
      image: sampleSpec.image,
    });
  });

  it('maps a 404 on start to container_not_found', async () => {
    stub = await startDockerStub(() => ({
      status: 404,
      body: { message: 'No such container: gone' },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.startContainer('gone')).rejects.toMatchObject({
      kind: 'container_not_found',
      id: 'gone',
    });
  });

  it('inspectContainer reads State.Running over the socket', async () => {
    stub = await startDockerStub(() => ({
      status: 200,
      body: { Id: 'unix-abc', State: { Running: true } },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    const result = await docker.inspectContainer('unix-abc');
    expect(result).toEqual({ id: 'unix-abc', running: true });
    expect(stub.calls[0]?.path).toBe('/containers/unix-abc/json');
  });

  it('imageExists returns true on 200 (ADR 0003 R3.1)', async () => {
    stub = await startDockerStub(() => ({
      status: 200,
      body: { Id: 'sha256:img', RepoTags: ['verity-devc-heey-global-verity:abc123def456'] },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.imageExists?.('verity-devc-heey-global-verity:abc123def456')).resolves.toBe(
      true,
    );
    expect(stub.calls[0]?.method).toBe('GET');
    expect(stub.calls[0]?.path).toBe(
      `/images/${encodeURIComponent('verity-devc-heey-global-verity:abc123def456')}/json`,
    );
  });

  it('imageExists returns false on 404 (ADR 0003 R3.1)', async () => {
    stub = await startDockerStub(() => ({
      status: 404,
      body: { message: 'No such image: verity-devc-heey-global-verity:missing' },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.imageExists?.('verity-devc-heey-global-verity:missing')).resolves.toBe(
      false,
    );
  });

  it('imageExists rejects with a typed DockerError on other failures (e.g. 500)', async () => {
    stub = await startDockerStub(() => ({
      status: 500,
      body: { message: 'server error' },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.imageExists?.('verity-devc-heey-global-verity:x')).rejects.toMatchObject({
      kind: 'other',
      status: 500,
    });
  });

  it('inspectImageLabels returns local image labels', async () => {
    const imageRef = 'ghcr.io/heey-global/verity/verity-sandbox@sha256:7851e0a4a2e9';
    stub = await startDockerStub(() => ({
      status: 200,
      body: {
        Id: 'sha256:img',
        Config: {
          Labels: {
            'org.opencontainers.image.version': 'v1.18.0',
            'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
            ignored: 123,
          },
        },
      },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.inspectImageLabels?.(imageRef)).resolves.toEqual({
      'org.opencontainers.image.version': 'v1.18.0',
      'org.opencontainers.image.revision': '7851e0a4a2e9ef8c07e4cb5f3e8f2a4a5b6c7d8e',
    });
    expect(stub.calls[0]?.path).toBe(`/images/${encodeURIComponent(imageRef)}/json`);
  });

  it('inspectImageLabels returns undefined when the image is absent', async () => {
    const imageRef = 'ghcr.io/heey-global/verity/verity-sandbox@sha256:missing';
    stub = await startDockerStub(() => ({
      status: 404,
      body: { message: 'No such image' },
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.inspectImageLabels?.(imageRef)).resolves.toBeUndefined();
  });

  it('maps a missing socket (ENOENT) to a network error', async () => {
    const docker = createDockerClient({
      baseUrl: 'unix:///nonexistent/verity-no-such.sock',
    });
    await expect(docker.startContainer('abc')).rejects.toMatchObject({ kind: 'network' });
  });

  it('honours the per-request timeout (hung socket → network error)', async () => {
    // Stub that never responds so the AbortSignal.timeout fires and aborts the
    // in-flight request → transport rejects → mapped to { kind: 'network' }.
    stub = await startDockerStub(() => {
      // Deliberately unreachable: handler only runs on 'end', but we never send
      // a body here; instead we rely on the server holding the connection. To
      // reliably hang, use a handler that returns after a long delay is awkward,
      // so we short-circuit by pointing at a socket whose server never replies.
      return { status: 200, body: {} };
    });
    // Replace the stub's request handling with a non-responding server: close
    // the responsive one and stand up a silent listener on the same path.
    await stub.close();
    const dir = mkdtempSync(join(tmpdir(), 'verity-dsock-hang-'));
    const socketPath = join(dir, 'docker.sock');
    const silent = http.createServer(() => {
      /* never call res.end → request hangs until the client aborts */
    });
    await new Promise<void>((resolve) => silent.listen({ path: socketPath }, () => resolve()));
    stub = {
      socketPath,
      calls: [],
      close: () =>
        new Promise<void>((res) => {
          silent.closeAllConnections?.();
          silent.close(() => {
            rmSync(dir, { recursive: true, force: true });
            res();
          });
        }),
    };
    const docker = createDockerClient({ baseUrl: `unix://${socketPath}`, timeoutMs: 150 });
    await expect(docker.startContainer('abc')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('Docker secret-worker attach transport', () => {
  it('hijacks a local Docker attach request into a binary duplex stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-attach-'));
    const socketPath = join(dir, 'docker.sock');
    const server = http.createServer();
    let requestPath = '';
    let stdin = Buffer.alloc(0);
    let resolveStdin!: () => void;
    const stdinReceived = new Promise<void>((resolve) => {
      resolveStdin = resolve;
    });
    let upgradedSocket: import('node:stream').Duplex | undefined;
    server.on('upgrade', (request, socket) => {
      upgradedSocket = socket;
      socket.on('error', () => undefined);
      requestPath = request.url ?? '';
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.write(Buffer.from([1, 2, 3, 4]));
      socket.once('data', (chunk: Buffer) => {
        stdin = Buffer.from(chunk);
        resolveStdin();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: socketPath }, resolve);
    });

    try {
      const controller = new AbortController();
      const attach = await openDockerUnixAttach({
        baseUrl: `unix://${socketPath}:/v1.47`,
        containerId: 'a'.repeat(64),
        signal: controller.signal,
      });
      const output = await new Promise<Buffer>((resolve) =>
        attach.stream.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk))),
      );
      attach.stream.write(Buffer.from([9, 8, 7]));
      await stdinReceived;

      expect(output).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(stdin).toEqual(Buffer.from([9, 8, 7]));
      expect(requestPath).toBe(
        `/v1.47/containers/${'a'.repeat(64)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      );
      controller.abort();
      expect(attach.stream.destroyed).toBe(true);
    } finally {
      upgradedSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects network Docker endpoints before opening a channel', async () => {
    await expect(
      openDockerUnixAttach({
        baseUrl: 'http://docker-socket-proxy:2375',
        containerId: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/requires a Docker unix socket/);
  });

  it.each(['../containers/other', 'short', 'A'.repeat(64), `${'a'.repeat(64)}?stdin=0`])(
    'rejects the path-unsafe container id %s',
    async (containerId) => {
      await expect(
        openDockerUnixAttach({
          baseUrl: 'unix:///var/run/docker.sock',
          containerId,
        }),
      ).rejects.toThrow(/invalid Docker container id/);
    },
  );

  it('honours an already-aborted signal without leaving a request alive', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openDockerUnixAttach({
        baseUrl: 'unix:///does/not/exist/docker.sock',
        containerId: 'a'.repeat(64),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/network/);
  });
});

describe('parseImageRef (ADR 0003 R6 / #299)', () => {
  it('defaults a bare name to the latest tag', () => {
    expect(parseImageRef('ghcr.io/heey-global/dev-base')).toEqual({
      fromImage: 'ghcr.io/heey-global/dev-base',
      tag: 'latest',
    });
  });

  it('splits name:tag', () => {
    expect(parseImageRef('ghcr.io/heey-global/dev-base:2026.06')).toEqual({
      fromImage: 'ghcr.io/heey-global/dev-base',
      tag: '2026.06',
    });
  });

  it('keeps a @sha256 digest on fromImage with NO tag param', () => {
    expect(parseImageRef('ghcr.io/heey-global/dev-base@sha256:abc123')).toEqual({
      fromImage: 'ghcr.io/heey-global/dev-base@sha256:abc123',
    });
  });

  it('drops the tag when both tag and digest are present (digest wins)', () => {
    expect(parseImageRef('ghcr.io/heey-global/dev-base:2026.06@sha256:abc123')).toEqual({
      fromImage: 'ghcr.io/heey-global/dev-base@sha256:abc123',
    });
  });

  it('does not mistake a registry :port for a tag', () => {
    expect(parseImageRef('registry.local:5000/dev-base')).toEqual({
      fromImage: 'registry.local:5000/dev-base',
      tag: 'latest',
    });
    expect(parseImageRef('registry.local:5000/dev-base:v1')).toEqual({
      fromImage: 'registry.local:5000/dev-base',
      tag: 'v1',
    });
  });
});

describe('findPullStreamError', () => {
  it('returns undefined for a clean progress stream', () => {
    const body = '{"status":"Pulling from heey-global/dev-base"}\n{"status":"Download complete"}\n';
    expect(findPullStreamError(body)).toBeUndefined();
  });

  it('surfaces an in-stream {"error":...} line', () => {
    const body =
      '{"status":"Pulling fs layer"}\n{"error":"manifest unknown","errorDetail":{"message":"manifest unknown"}}\n';
    expect(findPullStreamError(body)).toBe('manifest unknown');
  });
});

describe('DockerClient.pullImage (ADR 0003 R6 / #299)', () => {
  let stub: Awaited<ReturnType<typeof startDockerStub>> | undefined;
  afterEach(async () => {
    if (stub !== undefined) await stub.close();
    stub = undefined;
  });

  it('POSTs /images/create with fromImage+tag and resolves on a clean 200 stream (unix socket)', async () => {
    stub = await startDockerStub((call) => {
      if (call.method === 'POST' && call.path.startsWith('/images/create')) {
        // Real Docker streams NDJSON progress objects at HTTP 200.
        return {
          status: 200,
          raw: '{"status":"Pulling from heey-global/dev-base"}\n{"status":"Download complete"}\n',
        };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(
      docker.pullImage!('ghcr.io/heey-global/dev-base:2026.06'),
    ).resolves.toBeUndefined();
    const call = stub.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toContain('/images/create?');
    const query = new URLSearchParams(call?.path.split('?')[1] ?? '');
    expect(query.get('fromImage')).toBe('ghcr.io/heey-global/dev-base');
    expect(query.get('tag')).toBe('2026.06');
  });

  it('sends a @sha256 digest on fromImage with no tag param', async () => {
    stub = await startDockerStub(() => ({ status: 200, raw: '{"status":"Download complete"}\n' }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await docker.pullImage!('ghcr.io/heey-global/dev-base@sha256:deadbeef');
    const query = new URLSearchParams(stub.calls[0]?.path.split('?')[1] ?? '');
    expect(query.get('fromImage')).toBe('ghcr.io/heey-global/dev-base@sha256:deadbeef');
    expect(query.has('tag')).toBe(false);
  });

  it('rejects with image_not_found when a 200 stream body carries {"error":...} (the Docker gotcha)', async () => {
    stub = await startDockerStub(() => ({
      status: 200,
      raw: '{"status":"Pulling fs layer"}\n{"error":"manifest for ghcr.io/x unknown: manifest unknown"}\n',
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.pullImage!('ghcr.io/x:missing')).rejects.toMatchObject({
      kind: 'image_not_found',
      image: 'ghcr.io/x:missing',
    });
  });

  it('rejects with kind:other for a non-missing in-stream error (e.g. transient network)', async () => {
    stub = await startDockerStub(() => ({
      status: 200,
      raw: '{"error":"received unexpected HTTP status: 500 Internal Server Error"}\n',
    }));
    const docker = createDockerClient({ baseUrl: `unix://${stub.socketPath}` });
    await expect(docker.pullImage!('ghcr.io/x:v1')).rejects.toMatchObject({ kind: 'other' });
  });

  it('sets X-Registry-Auth when registryAuth is configured', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
      registryAuth: 'base64-creds',
    });
    await docker.pullImage!('ghcr.io/private/img:v1');
    expect(fetch.calls[0]?.init?.headers?.['X-Registry-Auth']).toBe('base64-creds');
  });

  it('omits X-Registry-Auth by default (public ghcr base image)', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
    ]);
    const docker = createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });
    await docker.pullImage!('ghcr.io/heey-global/dev-base:2026.06');
    expect(fetch.calls[0]?.init?.headers?.['X-Registry-Auth']).toBeUndefined();
  });
});

describe('createDockerClient network primitives (H2)', () => {
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

  it('ensureNetwork POSTs /networks/create as a bridge and is idempotent on 409', async () => {
    const fetch = fakeFetch([
      { match: /\/networks\/create/, method: 'POST', resp: res({ Id: 'net1' }, { status: 201 }) },
    ]);
    await client(fetch).ensureNetwork!('verity-proj-abc', {
      labels: { 'verity.project-id': 'abc' },
    });
    const body = JSON.parse(fetch.calls[0]?.init?.body ?? '{}');
    expect(fetch.calls[0]?.url).toContain('/networks/create');
    expect(body).toMatchObject({
      Name: 'verity-proj-abc',
      Driver: 'bridge',
      Labels: { 'verity.project-id': 'abc' },
    });

    // Already exists → 409 is a no-op (does not throw).
    const fetch409 = fakeFetch([
      {
        match: /\/networks\/create/,
        method: 'POST',
        resp: res({ message: 'exists' }, { ok: false, status: 409 }),
      },
    ]);
    await expect(client(fetch409).ensureNetwork!('verity-proj-abc')).resolves.toBeUndefined();
  });

  it('ensureNetwork throws on a real failure (500)', async () => {
    const fetch = fakeFetch([
      {
        match: /\/networks\/create/,
        method: 'POST',
        resp: res({ message: 'boom' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).ensureNetwork!('verity-proj-abc')).rejects.toBeInstanceOf(
      DockerError,
    );
  });
});

describe('createDockerClient inventory endpoints (disk GC)', () => {
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

  it('listContainers strips the daemon leading slash and drops entries with no image id', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/json\?all=true/,
        method: 'GET',
        resp: res([
          {
            Id: 'c1',
            ImageID: 'sha256:a',
            Names: ['/verity-acme--web', 7],
            Labels: { 'verity.project-id': 'p1', 'verity.bad': 3 },
            Created: 100,
          },
          { Id: 'c2', ImageID: 'sha256:b' },
          // The GC removes an image only when NO container references it, so an
          // entry whose ImageID the daemon did not report must not become a
          // summary that silently claims "references nothing".
          { Id: 'c3', Names: ['/no-image'] },
          null,
        ]),
      },
    ]);
    expect(await client(fetch).listContainers?.()).toEqual([
      {
        id: 'c1',
        imageId: 'sha256:a',
        names: ['verity-acme--web'],
        labels: { 'verity.project-id': 'p1' },
        created: 100,
      },
      { id: 'c2', imageId: 'sha256:b', names: [], labels: {} },
    ]);
    expect(fetch.calls[0]?.url).toBe('http://127.0.0.1:9234/v1.41/containers/json?all=true');
  });

  it('listContainers surfaces a daemon failure instead of reporting an empty fleet', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/json/,
        method: 'GET',
        resp: res({ message: 'daemon busy' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).listContainers?.()).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'daemon busy',
    });
  });

  it('listVolumes without danglingOnly asks for /volumes with no filter query', async () => {
    const fetch = fakeFetch([
      { match: /\/volumes/, method: 'GET', resp: res({ Volumes: [{ Name: 'verity-data' }] }) },
    ]);
    expect(await client(fetch).listVolumes?.()).toEqual([{ name: 'verity-data', labels: {} }]);
    expect(fetch.calls[0]?.url).toBe('http://127.0.0.1:9234/v1.41/volumes');
  });

  it('listVolumes reports an absent Volumes array as no volumes', async () => {
    const fetch = fakeFetch([{ match: /\/volumes/, method: 'GET', resp: res({ Volumes: null }) }]);
    expect(await client(fetch).listVolumes?.()).toEqual([]);
  });

  it('removeVolume surfaces a 409 (volume still in use) as a typed conflict', async () => {
    const fetch = fakeFetch([
      {
        match: /\/volumes\//,
        method: 'DELETE',
        resp: res({ message: 'volume is in use' }, { ok: false, status: 409 }),
      },
    ]);
    await expect(client(fetch).removeVolume?.('verity-data')).rejects.toMatchObject({
      kind: 'conflict',
      message: 'volume is in use',
    });
  });

  it('pruneBuildCache without untilHours prunes all cache and no filter', async () => {
    const fetch = fakeFetch([{ match: /\/build\/prune/, method: 'POST', resp: res({}) }]);
    // No SpaceReclaimed in the reply → 0 bytes reported, never NaN/undefined.
    expect(await client(fetch).pruneBuildCache?.()).toBe(0);
    expect(fetch.calls[0]?.url).toBe('http://127.0.0.1:9234/v1.41/build/prune?all=true');
  });

  it('pruneBuildCache surfaces a daemon failure', async () => {
    const fetch = fakeFetch([
      {
        match: /\/build\/prune/,
        method: 'POST',
        resp: res({ message: 'prune failed' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).pruneBuildCache?.()).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'prune failed',
    });
  });

  it('listImages surfaces a daemon failure', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/json/,
        method: 'GET',
        resp: res({ message: 'images unavailable' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).listImages?.()).rejects.toMatchObject({
      message: 'images unavailable',
    });
  });

  it('inspectImageLabels distinguishes an absent image (404) from a broken daemon (500)', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/.*\/json/,
        method: 'GET',
        resp: res({ message: 'engine exploded' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).inspectImageLabels?.('verity-devc:aaa')).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'engine exploded',
    });
    expect(fetch.calls[0]?.url).toBe(
      `http://127.0.0.1:9234/v1.41/images/${encodeURIComponent('verity-devc:aaa')}/json`,
    );
  });

  it('inspectImageEnv surfaces a broken daemon rather than reporting no environment', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/.*\/json/,
        method: 'GET',
        resp: res({ message: 'engine exploded' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).inspectImageEnv?.('verity-devc:aaa')).rejects.toMatchObject({
      kind: 'other',
      status: 500,
    });
  });
});

describe('createDockerClient runtime + response validation', () => {
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

  it('inspectRuntime reports an unregistered runtime as undefined', async () => {
    const fetch = fakeFetch([
      { match: /\/info/, method: 'GET', resp: res({ Runtimes: { runc: { path: 'runc' } } }) },
    ]);
    await expect(client(fetch).inspectRuntime?.('sysbox-runc')).resolves.toBeUndefined();
  });

  it('inspectRuntime reports a daemon without a Runtimes map as undefined', async () => {
    const fetch = fakeFetch([{ match: /\/info/, method: 'GET', resp: res({ Runtimes: null }) }]);
    await expect(client(fetch).inspectRuntime?.('sysbox-runc')).resolves.toBeUndefined();
  });

  it('inspectRuntime refuses a registration missing its path or runtimeArgs', async () => {
    // A half-registered runtime must not read as "installed" — the provisioner
    // would then start project containers on a runtime the daemon cannot exec.
    const fetch = fakeFetch([
      {
        match: /\/info/,
        method: 'GET',
        resp: res({ Runtimes: { 'sysbox-runc': { path: '/usr/bin/sysbox-runc' } } }),
      },
    ]);
    await expect(client(fetch).inspectRuntime?.('sysbox-runc')).rejects.toMatchObject({
      kind: 'other',
      status: 200,
      message: 'invalid runtime registration for sysbox-runc',
    });
  });

  it('inspectRuntime surfaces a failing /info', async () => {
    const fetch = fakeFetch([
      {
        match: /\/info/,
        method: 'GET',
        resp: res({ message: 'no info for you' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).inspectRuntime?.('sysbox-runc')).rejects.toMatchObject({
      message: 'no info for you',
    });
  });

  it('createContainer refuses a 2xx create reply that carries no Id', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/create/, method: 'POST', resp: res({ Warnings: ['odd'] }) },
    ]);
    await expect(client(fetch).createContainer(sampleSpec)).rejects.toMatchObject({
      kind: 'other',
      status: 200,
      message: 'missing Id in /containers/create response',
    });
  });

  it('inspectContainer refuses a 2xx inspect reply that carries no Id', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/abc\/json/, method: 'GET', resp: res({ State: { Running: true } }) },
    ]);
    await expect(client(fetch).inspectContainer('abc')).rejects.toMatchObject({
      kind: 'other',
      status: 200,
      message: 'missing Id in /containers/{id}/json',
    });
  });

  it('waitContainer refuses a wait that reports a daemon-side error alongside its code', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/wait/,
        method: 'POST',
        resp: res({ StatusCode: 0, Error: { Message: 'no such container' } }),
      },
    ]);
    await expect(client(fetch).waitContainer?.('abc')).rejects.toMatchObject({
      kind: 'other',
      status: 200,
      message: 'container wait reported an error',
    });
  });

  it('waitContainer ignores an empty Error.Message and returns the exit code', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/wait/,
        method: 'POST',
        resp: res({ StatusCode: 17, Error: { Message: '' } }),
      },
    ]);
    await expect(client(fetch).waitContainer?.('abc')).resolves.toBe(17);
  });

  it('waitContainer maps a 404 to container_not_found', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/wait/,
        method: 'POST',
        resp: res({ message: 'No such container' }, { ok: false, status: 404 }),
      },
    ]);
    await expect(client(fetch).waitContainer?.('abc')).rejects.toMatchObject({
      kind: 'container_not_found',
      id: 'abc',
    });
  });

  it('containerLogs maps a 404 to container_not_found', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/logs/,
        method: 'GET',
        resp: res({ message: 'No such container' }, { ok: false, status: 404 }),
      },
    ]);
    await expect(client(fetch).containerLogs?.('abc', 25)).rejects.toMatchObject({
      kind: 'container_not_found',
      id: 'abc',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('containerLogs refuses the tail %s', async (tail) => {
    const fetch = fakeFetch([]);
    await expect(client(fetch).containerLogs?.('abc', tail)).rejects.toThrow(
      'container log tail must be between 1 and 1000',
    );
  });

  // Deliberately asserted as it behaves, not as it ought to: the byte budget cuts
  // NON-MULTIPLEXED output SILENTLY. `[truncated]` is appended by the frame decoder,
  // and plain output returns before reaching it — so a capped read is indistinguishable
  // from a complete one. Marking it is a production change and is not made here; pinning
  // the current behaviour is what makes that change visible when someone makes it.
  it('containerLogs bounds a streaming log body at the read budget, unmarked', async () => {
    // The Engine streams logs; a runaway container must not be able to pull an
    // unbounded body into the Server's heap through a diagnostics read.
    const chunk = new Uint8Array(32 * 1024).fill(97);
    let served = 0;
    const body = {
      getReader: () => ({
        read: () => Promise.resolve(served++ < 4 ? { done: false, value: chunk } : { done: true }),
        cancel: () => Promise.resolve(),
      }),
    };
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/logs/,
        method: 'GET',
        resp: {
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          body,
        } as unknown as HttpResponse,
      },
    ]);
    const logs = await client(fetch).containerLogs?.('abc', 25);
    // Plain (non-multiplexed) output comes back verbatim, capped at the budget.
    expect(Buffer.byteLength(logs ?? '')).toBe(64 * 1024 - 32);
    expect(logs).toMatch(/^a+$/);
  });

  it('containerLogs falls back to arrayBuffer when the response exposes no stream', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/abc\/logs/,
        method: 'GET',
        resp: {
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          arrayBuffer: () => Promise.resolve(new Uint8Array(70 * 1024).fill(98).buffer),
        },
      },
    ]);
    const logs = await client(fetch).containerLogs?.('abc', 25);
    expect(Buffer.byteLength(logs ?? '')).toBe(64 * 1024 - 32);
    // Same unmarked cut as the streaming path above, by the same route.
    expect(logs).toMatch(/^b+$/);
  });

  it('containerLogs marks a trailing partial frame header as truncated', async () => {
    const payload = Buffer.from('ready\n');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    // A complete frame followed by fewer than 8 bytes of the next header.
    const raw = Buffer.concat([header, payload, Buffer.from([1, 0, 0])]).toString('utf8');
    const fetch = fakeFetch([
      { match: /\/containers\/abc\/logs/, method: 'GET', resp: textRes(raw) },
    ]);
    await expect(client(fetch).containerLogs?.('abc', 25)).resolves.toBe('ready\n\n[truncated]\n');
  });
});

describe('DockerClient.pullImage failure mapping (ADR 0003 R6 / #299)', () => {
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

  it('maps a pre-stream 404 to image_not_found carrying the daemon message', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: res({ message: 'manifest unknown' }, { ok: false, status: 404 }),
      },
    ]);
    await expect(client(fetch).pullImage?.('ghcr.io/x:v1')).rejects.toMatchObject({
      kind: 'image_not_found',
      image: 'ghcr.io/x:v1',
      message: 'manifest unknown',
    });
  });

  it('rethrows a pre-stream 500 as a typed daemon error, not image_not_found', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: res({ message: 'proxy refused' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).pullImage?.('ghcr.io/x:v1')).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'proxy refused',
    });
  });

  it('maps a transport failure during a pull to a network error preserving the cause', async () => {
    const cause = new Error('socket hang up');
    const fetch = Object.assign(
      () => {
        throw cause;
      },
      { calls: [] },
    ) as unknown as ReturnType<typeof fakeFetch>;
    await expect(client(fetch).pullImage?.('ghcr.io/x:v1')).rejects.toMatchObject({
      kind: 'network',
      cause,
    });
  });

  it('prefixes an in-stream non-missing failure with "image pull failed:"', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"error":"i/o timeout"}\n'),
      },
    ]);
    await expect(client(fetch).pullImage?.('ghcr.io/x:v1')).rejects.toMatchObject({
      kind: 'other',
      message: 'image pull failed: i/o timeout',
    });
  });

  it('reads the pull stream through json() when the transport exposes no text()', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: res({ error: 'pull access denied' }),
      },
    ]);
    await expect(client(fetch).pullImage?.('ghcr.io/x:v1')).rejects.toMatchObject({
      kind: 'image_not_found',
      message: 'pull access denied',
    });
  });

  it('lets a per-call registryAuth override the client-level credential', async () => {
    const fetch = fakeFetch([
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
    ]);
    const docker = createDockerClient({
      baseUrl: 'http://127.0.0.1:9234/v1.41',
      fetch,
      registryAuth: 'client-level',
    });
    await docker.pullImage?.('ghcr.io/private/img:v1', { registryAuth: 'per-call' });
    expect(fetch.calls[0]?.init?.headers?.['X-Registry-Auth']).toBe('per-call');
  });
});

describe('findPullStreamError line scanning', () => {
  it('skips a non-JSON progress line and keeps scanning for the failure', () => {
    expect(findPullStreamError('not json at all\n{"error":"denied"}\n')).toBe('denied');
  });

  it('falls back to errorDetail.message when error is not a usable string', () => {
    expect(findPullStreamError('{"error":"","errorDetail":{"message":"toomanyrequests"}}')).toBe(
      'toomanyrequests',
    );
  });

  it('still reports a failure when neither error nor errorDetail is readable', () => {
    expect(findPullStreamError('{"error":{"code":7}}')).toBe('image pull failed');
  });
});

describe('parseUnixBaseUrl normalization (ADR 0003 R2)', () => {
  it('strips a trailing slash from the API-version prefix and the base', () => {
    expect(parseUnixBaseUrl('unix:///var/run/docker.sock:/v1.41/')).toEqual({
      socketPath: '/var/run/docker.sock',
      apiPrefix: '/v1.41',
      base: 'unix:///var/run/docker.sock:/v1.41',
    });
  });

  it('accepts the bare unix: prefix without //', () => {
    expect(parseUnixBaseUrl('unix:/var/run/docker.sock')).toMatchObject({
      socketPath: '/var/run/docker.sock',
      apiPrefix: '',
    });
  });
});

describe('createUnixSocketFetch response shell', () => {
  it('exposes daemon response headers case-insensitively and joins repeated ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-dhdr-'));
    const socketPath = join(dir, 'docker.sock');
    const server = http.createServer((_req, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Set-Cookie', ['a=1', 'b=2']);
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, () => resolve()));
    try {
      const transport = createUnixSocketFetch(parseUnixBaseUrl(`unix://${socketPath}`));
      const response = await transport(`unix://${socketPath}/_ping`, { method: 'GET' });
      expect(response.headers?.get('CONTENT-TYPE')).toBe('application/json');
      expect(response.headers?.get('set-cookie')).toBe('a=1, b=2');
      expect(response.headers?.get('x-not-sent')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openDockerUnixAttach daemon refusal', () => {
  it('surfaces the daemon message when the attach is answered instead of upgraded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-attach-refuse-'));
    const socketPath = join(dir, 'docker.sock');
    const server = http.createServer();
    // Docker answers a rejected attach with an ordinary HTTP response rather
    // than the 101 upgrade, and the secret worker must learn WHY.
    server.on('upgrade', (_request, socket) => {
      socket.on('error', () => undefined);
      const payload = '{"message":"container abc is not running"}';
      socket.end(
        `HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: ${String(
          Buffer.byteLength(payload),
        )}\r\n\r\n${payload}`,
      );
    });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, () => resolve()));
    try {
      await expect(
        openDockerUnixAttach({
          baseUrl: `unix://${socketPath}`,
          containerId: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({
        kind: 'other',
        status: 409,
        message: 'container abc is not running',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a status-only message when the refusal body is not JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verity-attach-refuse2-'));
    const socketPath = join(dir, 'docker.sock');
    const server = http.createServer();
    server.on('upgrade', (_request, socket) => {
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\n\r\nboom');
    });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, () => resolve()));
    try {
      await expect(
        openDockerUnixAttach({
          baseUrl: `unix://${socketPath}`,
          containerId: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({
        kind: 'other',
        status: 500,
        message: 'Docker attach refused HTTP 500',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replaceContainerImage refusal and rollback arms', () => {
  const IMAGE = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    createDockerClient({ baseUrl: 'http://127.0.0.1:9234/v1.41', fetch });

  /** The already-prepared replacement 'new' is discovered by label, so the
   *  pull/create half is skipped and the test states only the rollout arm. */
  const adoptedReplacement: FakeRoute = {
    match: /\/containers\/json\?all=true/,
    method: 'GET',
    resp: res([
      {
        Id: 'new',
        Labels: { 'verity.replacement-for': 'old', 'verity.replacement-name': 'verity-gw-1' },
      },
    ]),
  };
  const originalInspect: FakeRoute = {
    match: /\/containers\/old\/json/,
    method: 'GET',
    resp: res({ Name: '/verity-gw-1', Config: {}, HostConfig: {} }),
  };

  it('refuses to replace a container whose network endpoint has a static address', async () => {
    const fetch = fakeFetch([
      {
        match: /\/containers\/old\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-gw-1',
          Config: {},
          HostConfig: {},
          NetworkSettings: {
            Networks: { 'verity-net': { IPAMConfig: { IPv4Address: '172.20.0.9' } } },
          },
        }),
      },
      { match: /\/containers\/json\?all=true/, method: 'GET', resp: res([]) },
      {
        match: /\/images\/create/,
        method: 'POST',
        resp: textRes('{"status":"Download complete"}\n'),
      },
      { match: /\/images\/.*\/json/, method: 'GET', resp: res({ Config: { Env: [] } }) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toThrow(
      'companion replacement does not support static network endpoint identity',
    );
    expect(fetch.calls.some((call) => /\/containers\/create\?/.test(call.url))).toBe(false);
  });

  it('refuses a source container the daemon reports without a usable name', async () => {
    const fetch = fakeFetch([
      { match: /\/containers\/old\/json/, method: 'GET', resp: res({ Name: 7 }) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toThrow(
      'replacement source container has no valid name',
    );
  });

  it('surfaces a failing replacement lookup instead of creating a second successor', async () => {
    const fetch = fakeFetch([
      originalInspect,
      {
        match: /\/containers\/json\?all=true/,
        method: 'GET',
        resp: res({ message: 'daemon busy' }, { ok: false, status: 500 }),
      },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'daemon busy',
    });
  });

  it('restarts the predecessor and discards the successor when the successor will not start', async () => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      {
        match: /\/containers\/new\/start/,
        method: 'POST',
        resp: res({ message: 'oci runtime create failed' }, { ok: false, status: 500 }),
      },
      { match: /\/containers\/old\/start/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\?force=true&v=false/, method: 'DELETE', resp: res({}) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toMatchObject({
      kind: 'other',
      status: 500,
      message: 'oci runtime create failed',
    });
    // The successor is removed WITHOUT its volumes — the predecessor is coming
    // back and still needs the state they hold.
    expect(
      fetch.calls.some(
        (call) =>
          call.init?.method === 'DELETE' && call.url.endsWith('/containers/new?force=true&v=false'),
      ),
    ).toBe(true);
  });

  it('aggregates both failures when the predecessor cannot be restarted either', async () => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      {
        match: /\/containers\/new\/start/,
        method: 'POST',
        resp: res({ message: 'successor died' }, { ok: false, status: 500 }),
      },
      {
        match: /\/containers\/old\/start/,
        method: 'POST',
        resp: res({ message: 'port already allocated' }, { ok: false, status: 500 }),
      },
    ]);
    const error: unknown = await client(fetch)
      .replaceContainerImage?.('old', IMAGE)
      .then(() => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'companion replacement failed and its predecessor could not be restarted',
    );
    expect((error as AggregateError).errors.map((e: DockerError) => e.message)).toEqual([
      'successor died',
      'port already allocated',
    ]);
  });

  it.each([
    ['never reaches Running', { Running: false }],
    ['reports itself unhealthy', { Running: true, Health: { Status: 'unhealthy' } }],
  ])('rolls back when the successor %s', async (_label, State) => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\/json/, method: 'GET', resp: res({ State }) },
      { match: /\/containers\/new\?force=true&v=false/, method: 'DELETE', resp: res({}) },
      { match: /\/containers\/old\/start/, method: 'POST', resp: res({}, { status: 204 }) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toThrow(
      'replacement container failed its startup readiness window',
    );
    expect(fetch.calls.filter((call) => call.url.endsWith('/containers/old/start'))).toHaveLength(
      1,
    );
  });

  it('promotes a successor that reports itself healthy without waiting out the window', async () => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}, { status: 204 }) },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-gw-1-replacement-old',
          State: { Running: true, Health: { Status: 'healthy' } },
        }),
      },
      {
        match: /\/containers\/old\/rename\?name=verity-gw-1-predecessor-old/,
        method: 'POST',
        resp: res({}),
      },
      {
        match: /\/containers\/new\/rename\?name=verity-gw-1$/,
        method: 'POST',
        resp: res({}),
      },
      { match: /\/containers\/old\?force=true&v=false/, method: 'DELETE', resp: res({}) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).resolves.toBe('new');
    // Exactly one readiness sample: a healthy report ends the window at once.
    expect(fetch.calls.filter((call) => call.url.endsWith('/containers/new/json'))).toHaveLength(2);
  });

  it('rolls the canonical name back to the predecessor when promoting the successor fails', async () => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}, { status: 204 }) },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-gw-1-replacement-old',
          State: { Running: true, Health: { Status: 'healthy' } },
        }),
      },
      {
        match: /\/containers\/old\/rename\?name=verity-gw-1-predecessor-old/,
        method: 'POST',
        resp: res({}),
      },
      {
        match: /\/containers\/new\/rename\?name=verity-gw-1$/,
        method: 'POST',
        resp: res({ message: 'name already in use' }, { ok: false, status: 409 }),
      },
      { match: /\/containers\/old\/rename\?name=verity-gw-1$/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\/stop/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\?force=true&v=false/, method: 'DELETE', resp: res({}) },
      { match: /\/containers\/old\/start/, method: 'POST', resp: res({}, { status: 204 }) },
    ]);
    await expect(client(fetch).replaceContainerImage?.('old', IMAGE)).rejects.toMatchObject({
      kind: 'conflict',
      message: 'name already in use',
    });
    // The predecessor must be back under the canonical name AND running.
    const urls = fetch.calls.map((call) => call.url);
    expect(urls).toContain('http://127.0.0.1:9234/v1.41/containers/old/rename?name=verity-gw-1');
    expect(urls).toContain('http://127.0.0.1:9234/v1.41/containers/old/start');
  });

  it('aggregates a failed promotion with a predecessor that will not come back', async () => {
    const fetch = fakeFetch([
      originalInspect,
      adoptedReplacement,
      { match: /\/containers\/old\/stop/, method: 'POST', resp: res({}, { status: 204 }) },
      { match: /\/containers\/new\/start/, method: 'POST', resp: res({}, { status: 204 }) },
      {
        match: /\/containers\/new\/json/,
        method: 'GET',
        resp: res({
          Name: '/verity-gw-1-replacement-old',
          State: { Running: true, Health: { Status: 'healthy' } },
        }),
      },
      {
        match: /\/containers\/old\/rename\?name=verity-gw-1-predecessor-old/,
        method: 'POST',
        resp: res({}),
      },
      {
        match: /\/containers\/new\/rename\?name=verity-gw-1$/,
        method: 'POST',
        resp: res({ message: 'name already in use' }, { ok: false, status: 409 }),
      },
      { match: /\/containers\/old\/rename\?name=verity-gw-1$/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\/stop/, method: 'POST', resp: res({}) },
      { match: /\/containers\/new\?force=true&v=false/, method: 'DELETE', resp: res({}) },
      {
        match: /\/containers\/old\/start/,
        method: 'POST',
        resp: res({ message: 'predecessor is gone' }, { ok: false, status: 500 }),
      },
    ]);
    const error: unknown = await client(fetch)
      .replaceContainerImage?.('old', IMAGE)
      .then(() => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'companion rename failed and its predecessor could not be restarted',
    );
  });
});
