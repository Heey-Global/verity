import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectRecord } from '@verity/store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListeningProcess } from './listening-ports.js';
import type { LocalPreviewShare } from './local-preview-manager.js';
import {
  createManagedDevServerSecretResolver,
  managedDevServerProviderSnapshot,
} from './managed-dev-server-secrets.js';
import {
  ManagedDevServerManager,
  type ManagedDevServerRuntime,
  type ManagedLocalShares,
} from './managed-dev-server-manager.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => ctx.close());

/** A sandbox in memory: started instances listen once `listen()` is called. */
function fakeSandbox() {
  const alive = new Map<string, { exitCode: number | null; alive: boolean }>();
  const listeners: ListeningProcess[] = [];
  const started: Array<{
    instanceId: string;
    command: string;
    workdir: string;
    env: Record<string, string>;
    secrets?: { env: string; value: string }[];
  }> = [];
  const stop = vi.fn<ManagedDevServerRuntime['stopManagedServer']>(async (_project, instanceId) => {
    alive.set(instanceId, { alive: false, exitCode: 143 });
    for (let i = listeners.length - 1; i >= 0; i--)
      if (listeners[i]!.instanceId === instanceId) listeners.splice(i, 1);
  });
  const runtime: ManagedDevServerRuntime = {
    startManagedServer: vi.fn<ManagedDevServerRuntime['startManagedServer']>(
      async (_project, input) => {
        started.push(input);
        alive.set(input.instanceId, { alive: true, exitCode: null });
        return { ok: true as const };
      },
    ),
    stopManagedServer: stop,
    managedServerStatus: vi.fn<ManagedDevServerRuntime['managedServerStatus']>(
      async (_project, instanceId) => alive.get(instanceId) ?? { alive: false, exitCode: null },
    ),
    managedServerLogs: vi.fn<ManagedDevServerRuntime['managedServerLogs']>(
      async () => 'log line\n',
    ),
    listListeningProcesses: vi.fn<ManagedDevServerRuntime['listListeningProcesses']>(async () => [
      ...listeners,
    ]),
  };
  const listen = (instanceId: string, port: number) =>
    listeners.push({
      port,
      bind: 'any',
      pid: 1,
      cwd: '/work',
      command: 'node',
      instanceId,
      sessionId: 's1',
    });
  const crash = (instanceId: string, exitCode: number) => {
    alive.set(instanceId, { alive: false, exitCode });
    for (let i = listeners.length - 1; i >= 0; i--)
      if (listeners[i]!.instanceId === instanceId) listeners.splice(i, 1);
  };
  const recreate = () => {
    alive.clear();
    listeners.splice(0);
  };
  return { runtime, stop, started, listen, crash, recreate, listeners };
}

function fakeShares() {
  const shares: LocalPreviewShare[] = [];
  const ports = new Map<string, number>();
  const create = vi.fn<ManagedLocalShares['create']>(async (sessionId, input) => {
    const share = {
      id: `local-${String(input.networkPort)}`,
      url: `http://verity.local:${String(input.networkPort)}`,
      projectId: 'p1',
      sessionId,
      targetPort: input.targetPort,
      staticPath: null,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
    shares.push(share);
    ports.set(share.id, input.networkPort);
    return share;
  });
  const local: ManagedLocalShares = {
    create,
    stop: async (id) => {
      const index = shares.findIndex((share) => share.id === id);
      if (index >= 0) shares.splice(index, 1);
      return index >= 0;
    },
    list: (sessionId) => shares.filter((share) => share.sessionId === sessionId),
    heldPorts: () => new Map(shares.map((share) => [ports.get(share.id)!, share])),
    portOf: (id) => ports.get(id),
  };
  return { local, create, shares };
}

let now = Date.parse('2026-10-05T10:00:00Z');

let sandbox: ReturnType<typeof fakeSandbox>;

let shares: ReturnType<typeof fakeShares>;

let manager: ManagedDevServerManager;

let supervisionReady = true;

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'local',
    repo: 'demo',
    containerName: 'sandbox',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 's1',
    worktree: '/clone/s1',
    model: 'm',
    projectId: 'p1',
  });
  await ctx.store.createSession({
    sessionId: 's2',
    worktree: '/clone/s2',
    model: 'm',
    projectId: 'p1',
  });
  sandbox = fakeSandbox();
  shares = fakeShares();
  supervisionReady = true;
  manager = new ManagedDevServerManager({
    store: ctx.store,
    runtime: sandbox.runtime,
    canSupervise: () => supervisionReady,
    localShares: shares.local,
    networkPorts: [8100, 8101],
    sandboxWorktree: (_project: ProjectRecord, worktree: string) =>
      worktree.replace('/clone', '/work'),
    now: () => now,
  });
});

afterEach(() => manager.close());

const instanceOf = async (sessionId = 's1') => (await manager.view(sessionId))[0]!.instance!;

describe('managed servers with secret bindings', () => {
  const secretBindings = [{ secretAlias: 'ATTENDEE_API_KEY', env: 'API_KEY' }];
  let projectBindings: typeof ctx.store.projectDopplerBindings;
  const withResolver = async (
    resolveSecrets: NonNullable<
      ConstructorParameters<typeof ManagedDevServerManager>[0]['resolveSecrets']
    >,
    agentPerson?: (sessionId: string) => Promise<string | null | undefined>,
    localShares?: ManagedLocalShares,
  ) => {
    await manager.close();
    projectBindings = ctx.store.projectDopplerBindings;
    if (!(await projectBindings.list('p1')).length)
      await ctx.store.updateProjectSettings('p1', {
        dopplerProject: 'test',
        dopplerConfig: 'test',
      });
    manager = new ManagedDevServerManager({
      store: ctx.store,
      runtime: sandbox.runtime,
      resolveSecrets,
      ...(agentPerson !== undefined ? { agentPerson } : {}),
      ...(localShares !== undefined ? { localShares } : {}),
      providerSnapshot: async (projectId, bindings) =>
        managedDevServerProviderSnapshot(await projectBindings.list(projectId), bindings),
      networkPorts: [8100, 8101],
      sandboxWorktree: (_project, worktree) => worktree.replace('/clone', '/work'),
      now: () => now,
    });
  };

  it('rejects a provider change between display and confirmation without saving approval', async () => {
    await ctx.store.updateProjectSettings('p1', {
      dopplerProject: 'demo',
      dopplerConfig: 'staging',
    });
    const resolveSecrets = vi.fn(async () => [{ env: 'API_KEY', value: 'synthetic' }]);
    await withResolver(resolveSecrets);
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    const seen = {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    };
    await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'production' });
    await expect(manager.approve('s1', 'api', seen)).rejects.toThrow('provider');
    expect(await ctx.store.managedDevServers.approvedProviderAuthority(entry.id)).toBeUndefined();
    expect(resolveSecrets).not.toHaveBeenCalled();
    expect(sandbox.started).toHaveLength(0);
    const refreshed = (await manager.view('s1'))[0]!;
    expect(refreshed.providerSnapshot).toMatchObject({
      provider: 'doppler',
      project: 'demo',
      config: 'production',
    });
    await manager.approve('s1', 'api', { ...seen, providerSnapshot: refreshed.providerSnapshot });
    await manager.start('s1', 'api', 'agent');
    expect(sandbox.started).toHaveLength(1);
  });

  for (const failure of ['missing-snapshot', 'missing-provider', 'lookup-error'] as const) {
    it(`does not save approval with ${failure}`, async () => {
      await withResolver(async () => []);
      const entry = await manager.add('s1', {
        name: 'api',
        command: 'node server.mjs',
        secretBindings,
      });
      const seen = {
        command: entry.command,
        workdir: '.',
        secretBindings,
        ...(failure === 'missing-snapshot'
          ? {}
          : { providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot }),
      };
      if (failure === 'lookup-error' || failure === 'missing-provider') {
        await manager.close();
        manager = new ManagedDevServerManager({
          store: ctx.store,
          runtime: sandbox.runtime,
          providerSnapshot: async () => {
            if (failure === 'lookup-error') throw new Error('private diagnostic');
            return undefined;
          },
          networkPorts: [8100],
          sandboxWorktree: (_project, worktree) => worktree,
        });
      }
      await expect(manager.approve('s1', 'api', seen)).rejects.toThrow('provider');
      expect(await ctx.store.managedDevServers.approvedProviderAuthority(entry.id)).toBeUndefined();
      expect(sandbox.started).toHaveLength(0);
    });
  }

  // A provider change must not launch a process with stale secret authority.
  for (const change of ['unchanged', 'during-resolution'] as const) {
    const check = it;
    check(
      `rechecks provider binding before starting a secret-bearing server: ${change}`,
      async () => {
        await ctx.store.updateProjectSettings('p1', {
          dopplerProject: 'demo',
          dopplerConfig: 'staging',
        });
        const resolveSecret = vi.fn(async () => {
          if (change === 'during-resolution')
            await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'production' });
          return Buffer.from('synthetic-staging-value');
        });
        await withResolver(
          createManagedDevServerSecretResolver({
            getProjectBindings: (projectId) => ctx.store.projectDopplerBindings.list(projectId),
            resolveSecret,
          }),
        );
        const entry = await manager.add('s1', {
          name: 'api',
          command: 'node server.mjs',
          secretBindings,
        });
        await manager.approve('s1', 'api', {
          command: entry.command,
          workdir: '.',
          secretBindings,
          providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
        });
        await manager.start('s1', 'api', 'agent');
        expect(resolveSecret).toHaveBeenCalledWith({
          projectId: 'p1',
          connectionId: 'legacy-doppler',
          dopplerProject: 'demo',
          dopplerConfig: 'staging',
          secretName: 'ATTENDEE_API_KEY',
          person: { userId: null },
        });
        if (change === 'unchanged') {
          expect(sandbox.started).toHaveLength(1);
          expect(sandbox.started[0]!.secrets).toEqual([
            { env: 'API_KEY', value: 'synthetic-staging-value' },
          ]);
        } else {
          expect((await ctx.store.getProjectSettings('p1'))?.dopplerConfig).toBe('production');
          expect(sandbox.started).toHaveLength(0);
        }
      },
    );
  }

  it('requires displayed binding approval for agent starts and resolves fresh values at restart', async () => {
    const resolveSecrets = vi.fn(async () => [
      { env: 'API_KEY', value: `synthetic-value-${resolveSecrets.mock.calls.length}` },
    ]);
    await withResolver(resolveSecrets);
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    await expect(manager.start('s1', 'api', 'agent')).rejects.toThrow('approve');
    expect(resolveSecrets).not.toHaveBeenCalled();
    await expect(
      manager.approve('s1', 'api', { command: entry.command, workdir: '.' }),
    ).rejects.toThrow('changed');
    await manager.approve('s1', 'api', {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    });
    await manager.start('s1', 'api', 'agent');
    expect(resolveSecrets).toHaveBeenCalledWith(
      'p1',
      secretBindings,
      (await manager.view('s1'))[0]!.providerSnapshot?.authority,
      null,
    );
    expect(sandbox.started[0]!.secrets).toEqual([{ env: 'API_KEY', value: 'synthetic-value-1' }]);
    expect(sandbox.started[0]!.env).not.toHaveProperty('API_KEY');
    await manager.restart('s1', 'api', 'agent');
    expect(sandbox.started[1]!.secrets).toEqual([{ env: 'API_KEY', value: 'synthetic-value-2' }]);
    const instance = (await ctx.store.managedDevServers.listInstances({ serverId: entry.id }))[0]!;
    expect(instance.lastRunSecretBindings).toEqual(secretBindings);
    expect(JSON.stringify(await manager.view('s1'))).not.toContain('synthetic-value');
  });

  for (const change of ['provider', 'legacy', 'lookup-error', 'recovery'] as const) {
    it(`requires fresh provider approval after ${change}`, async () => {
      await ctx.store.updateProjectSettings('p1', {
        dopplerProject: 'demo',
        dopplerConfig: 'staging',
      });
      const resolveSecrets = vi.fn(async () => [{ env: 'API_KEY', value: 'synthetic' }]);
      await withResolver(resolveSecrets);
      const entry = await manager.add('s1', {
        name: 'api',
        command: 'node server.mjs',
        secretBindings,
      });
      await manager.approve('s1', 'api', {
        command: entry.command,
        workdir: '.',
        secretBindings,
        providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
      });
      if (change === 'recovery') {
        await manager.start('s1', 'api', 'agent');
        sandbox.recreate();
        resolveSecrets.mockClear();
      }
      if (change === 'legacy')
        await ctx.db
          .updateTable('managed_dev_servers')
          .set({ approved_provider_authority: JSON.stringify(['demo', 'staging']) })
          .where('id', '=', entry.id)
          .execute();
      else if (change === 'lookup-error')
        vi.spyOn(projectBindings, 'list').mockRejectedValueOnce(new Error('lookup unavailable'));
      else await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'production' });
      if (change === 'recovery') await manager.tick();
      else await manager.start('s1', 'api', 'agent');
      expect(resolveSecrets).not.toHaveBeenCalled();
      expect(sandbox.started).toHaveLength(change === 'recovery' ? 1 : 0);
      if (change !== 'lookup-error') expect((await manager.view('s1'))[0]!.approved).toBe(false);
      await manager.approve('s1', 'api', {
        command: entry.command,
        workdir: '.',
        secretBindings,
        providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
      });
      await manager.start('s1', 'api', 'agent');
      expect(resolveSecrets).toHaveBeenCalledOnce();
    });
  }

  it.each(['replacement', 'rotation', 'recreation'] as const)(
    'requires new approval after %s of a referenced connection',
    async (change) => {
      await ctx.store.updateProjectSettings('p1', { dopplerProject: 'demo', dopplerConfig: 'dev' });
      const resolveSecrets = vi.fn(async () => []);
      await withResolver(resolveSecrets);
      await ctx.db
        .insertInto('doppler_connections')
        .values([
          { id: 'billing', label: 'Billing', token: null },
          { id: 'other', label: 'Other', token: null },
        ])
        .execute();
      const target = { dopplerProject: 'billing', dopplerConfig: 'production' };
      const binding = await ctx.store.projectDopplerBindings.add('p1', {
        ...target,
        connectionId: 'billing',
      });
      const qualified = [
        ...secretBindings,
        { secretAlias: 'billing/production/API_KEY', env: 'BILLING_KEY' },
      ];
      const entry = await manager.add('s1', {
        name: 'api',
        command: 'node server.mjs',
        secretBindings: qualified,
      });
      const seen = {
        command: entry.command,
        workdir: '.',
        secretBindings: qualified,
        providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
      };
      await manager.approve('s1', 'api', seen);

      // Approval covers only the connections used by the requested secrets.
      await ctx.db
        .updateTable('doppler_connections')
        .set({ token_revision: '00000000-0000-4000-8000-000000000010' })
        .where('id', '=', 'other')
        .execute();
      expect((await manager.view('s1'))[0]!.approved).toBe(true);
      if (change !== 'rotation') {
        await ctx.store.projectDopplerBindings.remove('p1', binding.id);
        await ctx.store.projectDopplerBindings.add('p1', {
          ...target,
          connectionId: change === 'replacement' ? 'other' : 'billing',
        });
      } else {
        await ctx.db
          .updateTable('doppler_connections')
          .set({ token_revision: '00000000-0000-4000-8000-000000000011' })
          .where('id', '=', 'billing')
          .execute();
      }
      const refreshed = (await manager.view('s1'))[0]!;
      expect(refreshed.approved).toBe(false);
      expect(refreshed.providerSnapshot?.project).toBe(seen.providerSnapshot?.project);
      expect(refreshed.providerSnapshot?.config).toBe(seen.providerSnapshot?.config);
      expect(refreshed.providerSnapshot?.authority).not.toBe(seen.providerSnapshot?.authority);
      await expect(manager.approve('s1', 'api', seen)).rejects.toThrow('provider');
      await manager.start('s1', 'api', 'agent');
      expect(resolveSecrets).not.toHaveBeenCalled();
      expect(sandbox.started).toHaveLength(0);

      await manager.approve('s1', 'api', { ...seen, providerSnapshot: refreshed.providerSnapshot });
      await manager.start('s1', 'api', 'agent');
      expect(sandbox.started).toHaveLength(1);
    },
  );

  it('uses effective provider approval for the instance and its local switch', async () => {
    await withResolver(async () => [{ env: 'API_KEY', value: 'synthetic' }]);
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    await manager.approve('s1', 'api', {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    });
    await manager.start('s1', 'api', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    expect((await manager.view('s1'))[0]).toMatchObject({
      approved: true,
      instance: { state: 'running', awaitingApproval: false, localOn: true },
    });
    await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'production' });
    expect((await manager.view('s1'))[0]).toMatchObject({
      approved: false,
      instance: { state: 'running', awaitingApproval: true, localOn: false },
    });
  });

  it.each(['drift', 'reapproved', 'legacy', 'retry stop'] as const)(
    'stops obsolete secret-bearing runs and removes local access after %s',
    async (change) => {
      await withResolver(
        async () => [{ env: 'API_KEY', value: 'synthetic' }],
        undefined,
        shares.local,
      );
      const entry = await manager.add('s1', {
        name: 'api',
        command: 'node server.mjs',
        secretBindings,
      });
      const approve = async () => {
        const view = (await manager.view('s1'))[0]!;
        await manager.approve('s1', 'api', {
          command: entry.command,
          workdir: '.',
          secretBindings,
          providerSnapshot: view.providerSnapshot,
        });
        return view.providerSnapshot?.authority;
      };
      const authority = await approve();
      await manager.start('s1', 'api', 'agent');
      const run = sandbox.started[0]!;
      sandbox.listen(run.instanceId, Number(run.env.PORT));
      await manager.tick();
      expect(shares.shares).toHaveLength(1);
      expect(
        (await ctx.store.managedDevServers.getInstance(run.instanceId))?.lastRunProviderAuthority,
      ).toBe(authority);

      if (change === 'legacy')
        await ctx.store.managedDevServers.updateInstance(run.instanceId, {
          lastRunProviderAuthority: null,
        });
      else await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'production' });
      if (change === 'reapproved') expect(await approve()).not.toBe(authority);
      expect((await manager.view('s1'))[0]!.instance).toMatchObject({
        localOn: false,
        awaitingApproval: true,
        url: null,
        localShareId: null,
      });
      expect(sandbox.started).toHaveLength(1);
      if (change === 'retry stop') {
        sandbox.stop.mockRejectedValueOnce(new Error('Docker unavailable'));
        await manager.tick();
        expect((await instanceOf()).desired).toBe('running');
        expect(shares.shares).toHaveLength(0);
      }
      await manager.tick();
      expect(shares.shares).toHaveLength(0);
      expect(sandbox.stop).toHaveBeenCalledWith(expect.anything(), run.instanceId);
      expect((await instanceOf()).state).toBe('stopped');
      if (change === 'reapproved') {
        await manager.start('s1', 'api', 'agent');
        expect(sandbox.started).toHaveLength(2);
      }
    },
  );

  it('never launches a partial secret set or stores resolver diagnostics', async () => {
    await withResolver(async () => {
      throw new Error('synthetic-private-value');
    });
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    await manager.approve('s1', 'api', {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    });
    await manager.start('s1', 'api', 'agent');
    expect(sandbox.started).toHaveLength(0);
    expect((await instanceOf()).state).toBe('crashed');
    expect(JSON.stringify(await manager.view('s1'))).not.toContain('synthetic-private-value');
  });

  it('recovers with the last approved mapping rather than an unapproved edit', async () => {
    const resolveSecrets = vi.fn(async () => [{ env: 'API_KEY', value: 'synthetic-value' }]);
    await withResolver(resolveSecrets);
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    await manager.approve('s1', 'api', {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    });
    await manager.start('s1', 'api', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    await manager.update('s1', 'api', {
      secretBindings: [{ secretAlias: 'EXPO_TOKEN', env: 'OTHER_KEY' }],
    });
    expect((await instanceOf()).restartToApply).toBe(true);
    sandbox.recreate();
    now += 6000;
    await manager.tick();
    const authority = await ctx.store.managedDevServers.approvedProviderAuthority(entry.id);
    expect(resolveSecrets.mock.calls).toEqual([
      ['p1', secretBindings, authority, null],
      ['p1', secretBindings, authority, null],
    ]);
    expect(sandbox.started[1]!.secrets).toEqual([{ env: 'API_KEY', value: 'synthetic-value' }]);
    await expect(manager.restart('s1', 'api', 'agent')).rejects.toThrow('approve');
  });

  // ADR 0023 §3: a server's secrets resolve through the connection of the person it
  // was started for. Recovery must keep that person, never whoever is around later.
  it('resolves with the starting person and keeps them on recovery', async () => {
    const resolveSecrets = vi.fn<(...args: unknown[]) => Promise<{ env: string; value: string }[]>>(
      async () => [{ env: 'API_KEY', value: 'synthetic-value' }],
    );
    let runningFor: string | null | undefined = 'lena';
    await withResolver(resolveSecrets, async () => runningFor);
    const entry = await manager.add('s1', {
      name: 'api',
      command: 'node server.mjs',
      secretBindings,
    });
    await manager.approve(
      's1',
      'api',
      {
        command: entry.command,
        workdir: '.',
        secretBindings,
        providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
      },
      { approvedBy: 'lena' },
    );
    await manager.start('s1', 'api', 'agent');
    const run = sandbox.started[0]!;
    sandbox.listen(run.instanceId, Number(run.env.PORT));
    await manager.tick();
    runningFor = 'mia';
    sandbox.recreate();
    now += 6000;
    await manager.tick();
    expect(resolveSecrets.mock.calls.map((call) => call[3])).toEqual(['lena', 'lena']);
    expect(
      (await ctx.store.managedDevServers.listInstances({ serverId: entry.id }))[0]!.lastRunUserId,
    ).toBe('lena');

    // Lena's approval does not let the administrator run it with his secrets,
    // and refusing must not stop the server Lena runs.
    const stopsBefore = (sandbox.runtime.stopManagedServer as unknown as { mock?: unknown })
      ? vi.spyOn(sandbox.runtime, 'stopManagedServer')
      : undefined;
    await expect(manager.restart('s1', 'api', 'operator', 'admin')).rejects.toThrow(
      'approve this server yourself',
    );
    expect(stopsBefore).not.toHaveBeenCalled();
    stopsBefore?.mockRestore();
    await manager.approve(
      's1',
      'api',
      {
        command: entry.command,
        workdir: '.',
        secretBindings,
        providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
      },
      { approvedBy: 'admin' },
    );
    await manager.restart('s1', 'api', 'operator', 'admin');
    expect(resolveSecrets.mock.calls.at(-1)?.[3]).toBe('admin');

    runningFor = undefined;
    await expect(manager.restart('s1', 'api', 'agent')).rejects.toThrow('no running turn');

    // An approval nobody is recorded for is no one's: it no longer counts as the
    // installation's administrator's, which would start it with their secrets
    // unreviewed. Earlier approvals got their approver by migration instead.
    await manager.approve('s1', 'api', {
      command: entry.command,
      workdir: '.',
      secretBindings,
      providerSnapshot: (await manager.view('s1'))[0]!.providerSnapshot,
    });
    const administrator = '00000000-0000-4000-8000-000000000001';
    await expect(manager.restart('s1', 'api', 'operator', administrator)).rejects.toThrow(
      'approve this server yourself',
    );
  });
});
