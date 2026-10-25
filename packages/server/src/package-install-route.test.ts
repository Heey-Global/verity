import { EventEmitter } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Conductor, ExternalPermissionAnswer } from '@verity/session';
import type { EventStore } from '@verity/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
import { registerPackageInstallRoute } from './package-install-route.js';

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

function fixture(initial: 'undecided' | 'protected' | 'skipped' = 'undecided', internal = true) {
  const app = Fastify();
  apps.push(app);
  if (internal) {
    const connections = new EventEmitter();
    markInternalConnections(connections as unknown as Server, binding);
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
  registerPackageInstallRoute(app, {
    capabilities: {
      resolve: async (token: string) => (token === 'good' ? binding : undefined),
    } as unknown as GhTokenCapabilityRegistry,
    store: {
      getSession: async (id: string) =>
        id === 's1' ? { projectId: 'p1' } : id === 'foreign' ? { projectId: 'p2' } : undefined,
      getPackageProtectionDecision: async () => saved,
      setPackageProtectionDecision: save,
    } as unknown as EventStore,
    conductor: { requestExternalPermission: prompt },
    appendNotice: notice,
  });
  const post = (body: Record<string, unknown> = input, token = 'good') =>
    app.inject({
      method: 'POST',
      url: '/internal/package-install',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  return { app, post, prompt, notice, save, saved: () => saved };
}

describe('package install broker', () => {
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
