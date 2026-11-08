import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Conductor, ExternalPermissionAnswer } from '@verity/session';
import type { EventStore } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
import { registerPackageInstallRoute } from './package-install-route.js';
import { npmInstallGrant } from './package-install-grants.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const binding = { projectId: 'p1', containerGeneration: 'g1', owner: 'o', repo: 'r' };
const input = {
  action: 'check',
  sessionId: 's1',
  manager: 'npm',
  command: 'npm install express',
  supported: true,
  protected: false,
  configFile: '/work/.npmrc',
};
const allow = (action: string): ExternalPermissionAnswer => ({
  decision: { behavior: 'allow', updatedInput: { action } },
  decidedBy: 'card',
});
const verifyInput = {
  ...input,
  action: 'verify',
  packages: [{ name: 'example', version: '1.0.0' }],
  minimumAgeDays: 3,
};
function packageMetadata(published: unknown): BrokeredHttpStreamTransport {
  return async () =>
    Object.assign(
      Readable.from([
        JSON.stringify({
          name: 'example',
          versions: {
            '1.0.0': {
              name: 'example',
              version: '1.0.0',
              dist: {
                tarball: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
                integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
              },
            },
          },
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': published },
        }),
      ]),
      { statusCode: 200, headers: {} },
    ) as IncomingMessage;
}

function fixture(
  initial: 'undecided' | 'protected' | 'skipped' = 'undecided',
  internal = true,
  packageTransport?: BrokeredHttpStreamTransport,
) {
  const app = Fastify();
  apps.push(app);
  const generation = new AbortController();
  if (internal) {
    const connections = new EventEmitter();
    markInternalConnections(connections as unknown as Server, binding, generation.signal);
    app.addHook('onRequest', async (request) => {
      connections.emit('connection', request.raw.socket);
    });
  }
  let saved = initial;
  const save = vi.fn((_projectId: string, value: 'protected' | 'skipped') => {
    saved = value;
    return Promise.resolve();
  });
  const prompt = vi
    .fn<Conductor['requestExternalPermission']>()
    .mockResolvedValue(allow('configure'));
  const notice = vi.fn<(sessionId: string, text: string) => Promise<void>>().mockResolvedValue();
  const resolve = vi.fn(async (token: string) => (token === 'good' ? binding : undefined));
  registerPackageInstallRoute(app, {
    capabilities: { resolve } as unknown as GhTokenCapabilityRegistry,
    store: {
      getSession: async (id: string) =>
        id === 's1' ? { projectId: 'p1' } : id === 'foreign' ? { projectId: 'p2' } : undefined,
      getPackageProtectionDecision: async () => saved,
      setPackageProtectionDecision: save,
    } as unknown as EventStore,
    conductor: { requestExternalPermission: prompt },
    appendNotice: notice,
    ...(packageTransport ? { packageTransport } : {}),
  });
  const post = (body: Record<string, unknown> = input, token = 'good') =>
    app.inject({
      method: 'POST',
      url: '/internal/package-install',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  return { app, post, prompt, notice, save, resolve, generation, saved: () => saved };
}

describe('package install broker', () => {
  it('verifies locked releases even after a saved Skip and does not persist an exception', async () => {
    const f = fixture('skipped', true, packageMetadata('2030-01-01T00:00:00Z'));
    f.prompt.mockResolvedValue(allow('install'));
    const result = (await f.post(verifyInput)).json<{ action: string; installToken: string }>();
    expect(result.action).toBe('continue');
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        allowStandingGrant: false,
        input: expect.objectContaining({
          supported: false,
          command: expect.stringContaining('example@1.0.0: available 2030-01-04T00:00:00.000Z'),
        }),
      }),
    );
    expect(npmInstallGrant(result.installToken)?.policy.exceptions.has('example@1.0.0')).toBe(true);
    expect(f.saved()).toBe('skipped');
    expect(f.save).not.toHaveBeenCalled();
    await f.post(verifyInput);
    expect(f.prompt).toHaveBeenCalledTimes(2);
  });

  it('requires the specific install exception action and cancels denial', async () => {
    const f = fixture('protected', true, packageMetadata('2030-01-01T00:00:00Z'));
    f.prompt.mockResolvedValueOnce(allow('configure'));
    expect((await f.post(verifyInput)).json()).toEqual({ action: 'cancel' });
    f.prompt.mockResolvedValueOnce({
      decision: { behavior: 'deny', message: 'Declined.' },
      decidedBy: 'card',
    });
    expect((await f.post(verifyInput)).json()).toEqual({ action: 'cancel' });
    expect(f.save).not.toHaveBeenCalled();
  });

  it('grants eligible packages without prompting and revokes a completed install', async () => {
    const f = fixture('protected', true, packageMetadata('2020-01-01T00:00:00Z'));
    const result = (await f.post(verifyInput)).json<{ action: string; installToken: string }>();
    expect(result.action).toBe('continue');
    expect(f.prompt).not.toHaveBeenCalled();
    expect(npmInstallGrant(result.installToken)?.policy.packages).toEqual(
      new Set(['example@1.0.0']),
    );
    expect(
      (await f.post({ ...input, action: 'complete', installToken: result.installToken })).json(),
    ).toEqual({ action: 'complete' });
    expect(npmInstallGrant(result.installToken)).toBeUndefined();
    expect(
      (await f.post({ ...input, action: 'complete', installToken: result.installToken }))
        .statusCode,
    ).toBe(409);
  });

  it.each([undefined, null, 'not-a-date', '2026-02-30T00:00:00Z'])(
    'blocks unverifiable publication time %j without offering an exception',
    async (published) => {
      const f = fixture('skipped', true, packageMetadata(published));
      const result = await f.post(verifyInput);
      expect(result.statusCode).toBe(409);
      expect(result.json().error).toContain('example@1.0.0');
      expect(f.prompt).not.toHaveBeenCalled();
    },
  );

  it('preserves a stronger release age and validates verify inputs', async () => {
    const f = fixture(
      'protected',
      true,
      packageMetadata(new Date(Date.now() - 4 * 86400_000).toISOString()),
    );
    f.prompt.mockResolvedValue(allow('install'));
    const response = (await f.post({ ...verifyInput, minimumAgeDays: 7 })).json<{
      installToken: string;
    }>();
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(npmInstallGrant(response.installToken)?.policy.minimumAgeDays).toBe(7);
    expect((await f.post({ ...verifyInput, minimumAgeDays: 0 })).statusCode).toBe(400);
    expect((await f.post({ ...verifyInput, manager: 'pip' })).statusCode).toBe(400);
    expect(
      (await f.post({ ...verifyInput, packages: [{ name: '../escape', version: '1.0.0' }] }))
        .statusCode,
    ).toBe(400);
  });

  it('fails closed when provider metadata cannot be retrieved', async () => {
    const f = fixture('protected', true, async () => {
      throw new Error('offline');
    });
    expect((await f.post(verifyInput)).statusCode).toBe(502);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it('reuses publication facts briefly while rechecking floors and never caching exceptions', async () => {
    const transport = vi
      .fn<BrokeredHttpStreamTransport>()
      .mockImplementation(packageMetadata(new Date(Date.now() - 4 * 86400_000).toISOString()));
    const f = fixture('protected', true, transport);
    expect((await f.post(verifyInput)).statusCode).toBe(200);
    f.prompt.mockResolvedValue(allow('install'));
    await f.post({ ...verifyInput, minimumAgeDays: 7 });
    await f.post({ ...verifyInput, minimumAgeDays: 7 });
    expect(transport).toHaveBeenCalledOnce();
    expect(f.prompt).toHaveBeenCalledTimes(2);
    f.resolve.mockResolvedValueOnce(undefined);
    expect((await f.post(verifyInput)).statusCode).toBe(401);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
    try {
      expect((await f.post(verifyInput)).statusCode).toBe(200);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('does not cache missing publication times or failed provider responses', async () => {
    const transport = vi
      .fn<BrokeredHttpStreamTransport>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(packageMetadata(undefined))
      .mockImplementation(packageMetadata('2020-01-01T00:00:00Z'));
    const f = fixture('protected', true, transport);
    expect((await f.post(verifyInput)).statusCode).toBe(502);
    expect((await f.post(verifyInput)).statusCode).toBe(409);
    expect((await f.post(verifyInput)).statusCode).toBe(200);
    expect((await f.post(verifyInput)).statusCode).toBe(200);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('bounds publication facts instead of retaining every encountered release', async () => {
    let currentVersions: string[] = [];
    const transport = vi.fn<BrokeredHttpStreamTransport>().mockImplementation(
      async () =>
        Object.assign(
          Readable.from([
            JSON.stringify({
              name: 'example',
              versions: Object.fromEntries(
                currentVersions.map((version) => [
                  version,
                  {
                    version,
                    dist: {
                      tarball: 'https://registry.npmjs.org/example/-/example.tgz',
                      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
                    },
                  },
                ]),
              ),
              'dist-tags': {},
              time: Object.fromEntries(
                currentVersions.map((version) => [version, '2020-01-01T00:00:00Z']),
              ),
            }),
          ]),
          { statusCode: 200, headers: {} },
        ) as IncomingMessage,
    );
    const f = fixture('protected', true, transport);
    for (const [start, count] of [
      [0, 5000],
      [5000, 5000],
      [10000, 1],
      [0, 1],
    ]) {
      currentVersions = Array.from({ length: count! }, (_, index) => `1.0.${start! + index}`);
      const response = await f.post({
        ...verifyInput,
        packages: currentVersions.map((version) => ({ name: 'example', version })),
      });
      expect(response.statusCode).toBe(200);
    }
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('keeps a saved Skip authoritative when another manager already has protection', async () => {
    const f = fixture('skipped');
    expect((await f.post({ ...input, manager: 'pip', protected: true })).json()).toEqual({
      action: 'continue',
    });
    expect(f.saved()).toBe('skipped');
    expect((await f.post()).json()).toEqual({ action: 'continue' });
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it('cancels an abandoned install request without saving a project decision', async () => {
    const f = fixture();
    let appeared!: () => void;
    let aborted!: () => void;
    const card = new Promise<void>((done) => {
      appeared = done;
    });
    const closed = new Promise<void>((done) => {
      aborted = done;
    });
    f.prompt.mockImplementation(
      ({ signal }) =>
        new Promise((done) => {
          signal?.addEventListener(
            'abort',
            () => {
              done({
                decision: { behavior: 'deny', message: 'Install client disconnected.' },
                decidedBy: 'card',
              });
              aborted();
            },
            { once: true },
          );
          appeared();
        }),
    );
    const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const client = httpRequest(`${url}/internal/package-install`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify(input));
    await card;
    client.destroy();
    await closed;
    expect(f.saved()).toBe('undecided');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });
  it('requires a project-bound internal capability and a session in that project', async () => {
    const f = fixture();
    expect((await f.post(input, 'bad')).statusCode).toBe(401);
    expect((await fixture('undecided', false).post()).statusCode).toBe(401);
    expect((await f.post({ ...input, sessionId: 'foreign' })).statusCode).toBe(404);
    expect((await f.post({ ...input, manager: 'unknown' })).statusCode).toBe(400);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it('holds the command until a card decision and records protection only after approved setup is confirmed', async () => {
    const f = fixture();
    let decide!: (answer: ExternalPermissionAnswer) => void;
    let appeared!: () => void;
    const card = new Promise<void>((done) => {
      appeared = done;
    });
    f.prompt.mockImplementation(() => {
      appeared();
      return new Promise((done) => {
        decide = done;
      });
    });
    let returned = false;
    const check = f.post().then((response) => {
      returned = true;
      return response;
    });
    await card;
    expect(returned).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'verity_package_install',
        allowStandingGrant: false,
        input: expect.objectContaining({ configFile: '.npmrc', command: input.command }),
      }),
    );
    decide(allow('configure'));
    const response = await check;
    const decision = response.json<{ action: string; setupToken: string }>();
    expect(decision.action).toBe('configure');
    expect(f.saved()).toBe('undecided');
    expect((await f.post({ ...input, action: 'configured', protected: true })).statusCode).toBe(
      409,
    );
    expect(f.saved()).toBe('undecided');
    expect(
      (
        await f.post({
          ...input,
          action: 'configured',
          protected: true,
          setupToken: decision.setupToken,
        })
      ).json(),
    ).toEqual({ action: 'continue' });
    expect(f.saved()).toBe('protected');
    expect(f.notice).toHaveBeenCalledWith('s1', '3-day delay set up · .npmrc');
  });

  it('does not revive a revoked generation when a delayed permission card allows installation', async () => {
    const f = fixture();
    f.prompt.mockImplementation(async () => {
      f.resolve.mockResolvedValue(undefined);
      return allow('skip');
    });
    expect((await f.post()).json()).toEqual({ action: 'cancel' });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('cancels pending setup when its listener generation is retired', async () => {
    const f = fixture();
    f.prompt.mockImplementation(async ({ signal }) => {
      f.generation.abort();
      expect(signal?.aborted).toBe(true);
      return allow('configure');
    });
    expect((await f.post()).json()).toEqual({ action: 'cancel' });
    expect(f.save).not.toHaveBeenCalled();
  });

  it('rejects revoked authority before accepting a previously approved setup token', async () => {
    const f = fixture();
    const approved = (await f.post()).json<{ setupToken: string }>();
    f.resolve.mockResolvedValue(undefined);
    expect(
      (
        await f.post({
          ...input,
          action: 'configured',
          protected: true,
          setupToken: approved.setupToken,
        })
      ).statusCode,
    ).toBe(401);
    expect(f.save).not.toHaveBeenCalled();
  });

  it('saves Skip once across later installs and preserves existing configs', async () => {
    const f = fixture();
    f.prompt.mockResolvedValue(allow('skip'));
    expect((await f.post()).json()).toEqual({ action: 'continue' });
    expect(f.saved()).toBe('skipped');
    expect((await f.post({ ...input, manager: 'pip', supported: false })).json()).toEqual({
      action: 'continue',
    });
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });

  it('recognizes existing effective protection without asking', async () => {
    const f = fixture();
    expect((await f.post({ ...input, protected: true })).json()).toEqual({ action: 'continue' });
    expect(f.saved()).toBe('protected');
    expect(f.prompt).not.toHaveBeenCalled();
    const next = (await f.post({ ...input, manager: 'uv', configFile: '/work/uv.toml' })).json<{
      action: string;
    }>();
    expect(next.action).toBe('configure');
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it('serializes simultaneous installs and reuses the setup choice before config confirmation', async () => {
    const f = fixture();
    let decide!: (answer: ExternalPermissionAnswer) => void;
    let appeared!: () => void;
    const card = new Promise<void>((done) => {
      appeared = done;
    });
    f.prompt.mockImplementation(() => {
      appeared();
      return new Promise((done) => {
        decide = done;
      });
    });
    const first = f.post();
    await card;
    const second = f.post({ ...input, manager: 'uv', configFile: '/work/uv.toml' });
    decide(allow('configure'));
    expect((await first).json<{ action: string }>().action).toBe('configure');
    expect((await second).json<{ action: string }>().action).toBe('configure');
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });

  it('does not save an unanswered, denied, or invalid decision as Skip', async () => {
    const f = fixture();
    f.prompt.mockResolvedValue({
      decision: { behavior: 'deny', message: 'Cancelled.' },
      decidedBy: 'card',
    });
    expect((await f.post()).json()).toEqual({ action: 'cancel' });
    f.prompt.mockResolvedValue(allow('unrecognized'));
    expect((await f.post()).json()).toEqual({ action: 'cancel' });
    expect(f.saved()).toBe('undecided');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('offers unsupported versions only an explicit install or cancel decision', async () => {
    const f = fixture();
    f.prompt.mockResolvedValue(allow('configure'));
    expect((await f.post({ ...input, supported: false, protected: true })).json()).toEqual({
      action: 'cancel',
    });
    expect(f.saved()).toBe('undecided');
    f.prompt.mockResolvedValue(allow('install'));
    expect((await f.post({ ...input, supported: false })).json()).toEqual({ action: 'continue' });
    expect(f.saved()).toBe('skipped');
  });

  it('binds setup confirmation to its session, manager, and configuration and consumes it once', async () => {
    const f = fixture();
    const { setupToken } = (await f.post()).json<{ setupToken: string }>();
    const confirmation = { ...input, action: 'configured', protected: true, setupToken };
    expect((await f.post({ ...confirmation, configFile: '/other/.npmrc' })).statusCode).toBe(409);
    expect((await f.post({ ...confirmation, manager: 'pip' })).statusCode).toBe(409);
    expect((await f.post(confirmation)).statusCode).toBe(200);
    expect((await f.post(confirmation)).statusCode).toBe(409);
  });
});
