import type { Backend } from '@verity/session';
import { createSealableSecretCipher, type ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { AuditLog } from './audit-log.js';
import type { AuditRecorder } from './audit-recorder.js';
import { createAuthTokenRegistry } from './auth.js';
import type { ReleaseSummary } from './github.js';
import { CONTAINER_STOPPED_REASON } from './project-state.js';
import {
  AmbiguousGitPushError,
  DEVCONTAINER_IMAGE_PREFIX,
  ProvisioningError,
} from './provisioner.js';
import type { SandboxUpdateStatus } from './sandbox-updates.js';
import {
  app,
  AVAILABLE_SANDBOX_UPDATE,
  availableSandboxUpdates,
  bus,
  cancelTurn,
  clearQueue,
  closeSession,
  conductor,
  ctx,
  dispatchTurn,
  isBusy,
  worktreeRoot,
  ZERO_USAGE,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

describe('GET /projects (#174)', () => {
  it('lists all available repository-cache rows for pickers', async () => {
    await ctx.store.upsertProject({
      id: 'p-picker',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global--verity',
      state: 'absent',
    });

    const res = await app.inject({ method: 'GET', url: '/github/repositories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      {
        id: 'p-picker',
        owner: 'heey-global',
        repo: 'verity',
        state: 'absent',
      },
    ]);
  });
  it('hides already-registered (non-absent) projects from the picker list', async () => {
    // `p-absent` was never added; `p-active` is an existing project. The picker
    // must offer only the former so added projects don't reappear as duplicates.
    await ctx.store.upsertProject({
      id: 'p-absent',
      owner: 'heey-global',
      repo: 'available',
      containerName: 'dev-heey-global--available',
      state: 'absent',
    });
    await ctx.store.upsertProject({
      id: 'p-active',
      owner: 'heey-global',
      repo: 'added',
      containerName: 'dev-heey-global--added',
      state: 'active',
    });
    const res = await app.inject({ method: 'GET', url: '/github/repositories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ id: 'p-absent', repo: 'available', state: 'absent' }]);
  });
  it('hides absent repository-cache rows from the overview project list', async () => {
    await ctx.store.upsertProject({
      id: 'p-local',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global--verity',
      state: 'absent',
    });

    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('checks sandbox updates once for the whole overview, not once per project', async () => {
    // The overview polls several times a minute per client, and the update
    // check reaches ghcr.io. A per-project call multiplied one registry answer
    // by the project count on every one of those polls.
    for (const id of ['p-one', 'p-two', 'p-three']) {
      await ctx.store.upsertProject({
        id,
        owner: 'heey-global',
        repo: id,
        containerName: `dev-heey-global--${id}`,
        state: 'active',
      });
    }
    const checker = availableSandboxUpdates();
    const overview = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: checker,
    });

    const res = await overview.inject({ method: 'GET', url: '/projects' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(3);
    expect(checker.status).not.toHaveBeenCalled();
    expect(checker.statusAll).toHaveBeenCalledTimes(1);
    expect(checker.statusAll.mock.calls[0]?.[0].map((project) => project.id)).toEqual([
      'p-one',
      'p-two',
      'p-three',
    ]);
    await overview.close();
  });

  it('reports converging self-repair by default and stalled only when the provisioner says so', async () => {
    // The overview icon hangs off this bit. The checker never sets it — it
    // compares images and knows nothing about the reconciler — so a deployment
    // whose provisioner does not classify sandboxes must still read as
    // "converging", not as a fault.
    await ctx.store.upsertProject({
      id: 'p-stalled',
      owner: 'heey-global',
      repo: 'stalled',
      containerName: 'dev-heey-global--stalled',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p-fine',
      owner: 'heey-global',
      repo: 'fine',
      containerName: 'dev-heey-global--fine',
      state: 'active',
    });
    const withoutProvisioner = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: availableSandboxUpdates(),
    });
    const plain: Array<{ sandboxUpdate: { selfRepair: string } }> = (
      await withoutProvisioner.inject({ method: 'GET', url: '/projects' })
    ).json();
    expect(plain.map((project) => project.sandboxUpdate.selfRepair)).toEqual([
      'converging',
      'converging',
    ]);
    await withoutProvisioner.close();

    const overview = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: availableSandboxUpdates(),
      provisioner: {
        provision: vi.fn(),
        unrepairedSandboxes: () => new Set(['p-stalled']),
      },
    });
    const body: Array<{ id: string; sandboxUpdate: { selfRepair: string } }> = (
      await overview.inject({ method: 'GET', url: '/projects' })
    ).json();
    expect(
      Object.fromEntries(
        body.map((project) => [project.id, project.sandboxUpdate.selfRepair] as const),
      ),
    ).toEqual({ 'p-stalled': 'stalled', 'p-fine': 'converging' });
    await overview.close();
  });

  it('reports a stalled failed rebuild even when the image status is unknown', async () => {
    const project = await ctx.store.upsertProject({
      id: 'p-failed-rebuild',
      owner: 'heey-global',
      repo: 'failed-rebuild',
      containerName: 'dev-heey-global--failed-rebuild',
      state: 'failed',
    });
    const unknown: SandboxUpdateStatus = {
      ...AVAILABLE_SANDBOX_UPDATE,
      state: 'unknown',
      kind: null,
      category: null,
      reason: 'project is not active',
      current: null,
      target: null,
    };
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: {
        status: vi.fn(async () => unknown),
        statusAll: vi.fn(async () => new Map([[project.id, unknown]])),
      },
      provisioner: {
        provision: vi.fn(),
        unrepairedSandboxes: () => new Set([project.id]),
      },
    });

    const body: Array<{ id: string; sandboxUpdate: SandboxUpdateStatus }> = (
      await server.inject({ method: 'GET', url: '/projects' })
    ).json();
    expect(body[0]?.sandboxUpdate).toMatchObject({ state: 'unknown', selfRepair: 'stalled' });
    await server.close();
  });

  it('stamps the same self-repair verdict on the single-project routes', async () => {
    // The overview is not the only surface that reads the bit: the detail screen
    // renders the summary from it, and the setup-status PATCH is what the app
    // holds onto after finishing onboarding. All three have to agree, or the
    // project screen contradicts the icon that sent the operator to it.
    for (const id of ['p-stalled', 'p-fine']) {
      await ctx.store.upsertProject({
        id,
        owner: 'heey-global',
        repo: id,
        containerName: `dev-heey-global--${id}`,
        state: 'active',
      });
    }
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: availableSandboxUpdates(),
      provisioner: {
        provision: vi.fn(),
        unrepairedSandboxes: () => new Set(['p-stalled']),
      },
    });

    for (const [id, expected] of [
      ['p-stalled', 'stalled'],
      ['p-fine', 'converging'],
    ]) {
      const detail: { project: { sandboxUpdate: { selfRepair: string } } } = (
        await server.inject({ method: 'GET', url: `/projects/${id}` })
      ).json();
      expect(detail.project.sandboxUpdate.selfRepair).toBe(expected);

      const patched: { sandboxUpdate: { selfRepair: string } } = (
        await server.inject({
          method: 'PATCH',
          url: `/projects/${id}/setup-status`,
          payload: { status: 'complete' },
        })
      ).json();
      expect(patched.sandboxUpdate.selfRepair).toBe(expected);
    }
    await server.close();
  });

  it('reports a turn-blocked update on every surface, as stalled AND as blocked', async () => {
    // Two silent failures meet here. The first: the reconciler defers the
    // recreate around a live turn forever by design, and without this overlay the
    // app is told `converging` — "Verity is rebuilding this sandbox" — about a
    // rebuild that starts only once the operator cancels the turn.
    //
    // The second is why `selfRepair` is set as well. Installed apps parse that
    // field with a closed enum, so the blocked state cannot BE a new member; the
    // glyph those apps already draw is the `stalled` one, and dropping it here
    // would leave every app older than this change silent about a wait only the
    // operator can end. Newer apps read `turnBlocked` and say something truer.
    for (const id of ['p-blocked', 'p-fine']) {
      await ctx.store.upsertProject({
        id,
        owner: 'heey-global',
        repo: id,
        containerName: `dev-heey-global--${id}`,
        state: 'active',
      });
    }
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: availableSandboxUpdates(),
      provisioner: {
        provision: vi.fn(),
        unrepairedSandboxes: () => new Set<string>(),
        turnBlockedSandboxes: () => new Set(['p-blocked']),
      },
    });

    const overview: Array<{ id: string; sandboxUpdate: SandboxUpdateStatus }> = (
      await server.inject({ method: 'GET', url: '/projects' })
    ).json();
    expect(
      Object.fromEntries(
        overview.map(
          (project) =>
            [
              project.id,
              [project.sandboxUpdate.selfRepair, project.sandboxUpdate.turnBlocked],
            ] as const,
        ),
      ),
    ).toEqual({ 'p-blocked': ['stalled', true], 'p-fine': ['converging', false] });

    for (const [id, blocked] of [
      ['p-blocked', true],
      ['p-fine', false],
    ] as const) {
      const detail: { project: { sandboxUpdate: SandboxUpdateStatus } } = (
        await server.inject({ method: 'GET', url: `/projects/${id}` })
      ).json();
      expect(detail.project.sandboxUpdate.turnBlocked).toBe(blocked);

      const patched: { sandboxUpdate: SandboxUpdateStatus } = (
        await server.inject({
          method: 'PATCH',
          url: `/projects/${id}/setup-status`,
          payload: { status: 'complete' },
        })
      ).json();
      expect(patched.sandboxUpdate.turnBlocked).toBe(blocked);
    }
    await server.close();
  });

  it('does not report a blocked turn about a sandbox that has nothing to update', async () => {
    // The reconciler's deferral counter is pruned a tick after the turn ends or
    // the update lands, so it can still name a project whose update has already
    // gone through. Overlaying the report onto a `current` sandbox would tell the
    // operator to cancel a turn to apply an update that is no longer missing.
    const project = await ctx.store.upsertProject({
      id: 'p-current',
      owner: 'heey-global',
      repo: 'current',
      containerName: 'dev-heey-global--current',
      state: 'active',
    });
    const current: SandboxUpdateStatus = { ...AVAILABLE_SANDBOX_UPDATE, state: 'current' };
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: {
        status: vi.fn(async () => current),
        statusAll: vi.fn(async () => new Map([[project.id, current]])),
      },
      provisioner: {
        provision: vi.fn(),
        unrepairedSandboxes: () => new Set<string>(),
        turnBlockedSandboxes: () => new Set([project.id]),
      },
    });

    const body: Array<{ sandboxUpdate: SandboxUpdateStatus }> = (
      await server.inject({ method: 'GET', url: '/projects' })
    ).json();
    expect(body[0]?.sandboxUpdate).toMatchObject({
      state: 'current',
      selfRepair: 'converging',
      turnBlocked: false,
    });
    await server.close();
  });

  it('keeps Verity Control out of the batch and still answers for it', async () => {
    // Control-plane rows never had a sandbox update check; batching must not
    // hand them one, nor lose the answer for the projects that do get checked.
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
    await ctx.store.upsertProject({
      id: 'p-active',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global--verity',
      state: 'active',
      overviewVisible: true,
    });
    const checker = availableSandboxUpdates();
    const overview = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sandboxUpdates: checker,
    });

    const body: Array<Record<string, unknown>> = (
      await overview.inject({ method: 'GET', url: '/projects' })
    ).json();

    expect(checker.statusAll.mock.calls[0]?.[0].map((project) => project.id)).toEqual(['p-active']);
    expect(body.map((project) => project.id)).toEqual(['verity-control', 'p-active']);
    expect(body[0]?.sandboxUpdate).toMatchObject({ state: 'unknown' });
    expect(body[1]?.sandboxUpdate).toMatchObject({ state: 'available', target: 'new' });
    await overview.close();
  });

  it('hides Verity Control from the overview until advanced mode is enabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(await ctx.store.getProject('verity-control')).toBeUndefined();
  });

  it('adds Verity Control as the first overview project when advanced mode is enabled', async () => {
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
    await ctx.store.upsertProject({
      id: 'p-active',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global--verity',
      state: 'active',
      overviewVisible: true,
    });

    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    const body: Array<Record<string, unknown>> = res.json();
    expect(body.map((project) => project.id)).toEqual(['verity-control', 'p-active']);
    expect(body[0]).toMatchObject({
      id: 'verity-control',
      kind: 'control_plane',
      owner: 'verity',
      repo: 'control',
      state: 'active',
      setupStatus: 'complete',
    });
    expect(body[0]).not.toHaveProperty('hiddenAt');
    expect(body[1]).not.toHaveProperty('kind');
  });

  it('self-heals Verity Control back to active when the overview is loaded', async () => {
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
    await ctx.store.upsertProject({
      id: 'verity-control',
      kind: 'control_plane',
      owner: 'verity',
      repo: 'control',
      containerName: 'verity-control',
      state: 'failed',
      overviewVisible: true,
    });

    const res = await app.inject({ method: 'GET', url: '/projects' });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({
      id: 'verity-control',
      kind: 'control_plane',
      state: 'active',
      setupStatus: 'complete',
    });
    await expect(ctx.store.getProject('verity-control')).resolves.toMatchObject({
      state: 'active',
      provisionError: null,
      setupStatus: 'complete',
    });
  });

  it('keeps explicitly added paused projects in the overview and out of the picker', async () => {
    await ctx.store.upsertProject({
      id: 'p-paused',
      owner: 'heey-global',
      repo: 'paused',
      containerName: 'dev-heey-global--paused',
      state: 'absent',
      overviewVisible: true,
    });

    const overview = await app.inject({ method: 'GET', url: '/projects' });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject([{ id: 'p-paused', repo: 'paused', state: 'absent' }]);

    const picker = await app.inject({ method: 'GET', url: '/github/repositories' });
    expect(picker.statusCode).toBe(200);
    expect(picker.json()).toEqual([]);
  });

  it('offers soft-deleted absent projects in the picker so re-add can restore them', async () => {
    await ctx.store.upsertProject({
      id: 'p-deleted',
      owner: 'heey-global',
      repo: 'deleted',
      containerName: 'dev-heey-global--deleted',
      state: 'absent',
      overviewVisible: true,
    });
    await ctx.store.hideProject('p-deleted');

    const overview = await app.inject({ method: 'GET', url: '/projects' });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual([]);

    const picker = await app.inject({ method: 'GET', url: '/github/repositories' });
    expect(picker.statusCode).toBe(200);
    expect(picker.json()).toMatchObject([{ id: 'p-deleted', repo: 'deleted', state: 'absent' }]);
  });

  it('returns the provider list when configured (ProjectRecord shape round-trip)', async () => {
    const projects: ProjectRecord[] = [
      {
        id: 'p1',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        imageRef: null,
        state: 'absent',
        provisionError: null,
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
        createdAt: new Date('2026-06-26T00:00:00.000Z'),
        updatedAt: new Date('2026-06-26T00:00:00.000Z'),
        stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      },
      {
        id: 'p2',
        owner: 'heey-global',
        repo: 'dev-server',
        containerName: 'dev-heey-global-dev-server',
        imageRef: null,
        state: 'failed',
        provisionError: 'git clone 404',
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
        createdAt: new Date('2026-06-26T00:00:00.000Z'),
        updatedAt: new Date('2026-06-26T00:00:00.000Z'),
        stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      },
    ];
    const withProjects = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listProjects: () => Promise.resolve(projects),
    });
    try {
      const res = await withProjects.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'p2',
        owner: 'heey-global',
        repo: 'dev-server',
        state: 'failed',
        provisionError: 'git clone 404',
        provisionWarning: null,
      });
      // `hiddenAt` is an internal soft-delete marker — never on the public wire.
      expect(body[0]).not.toHaveProperty('hiddenAt');
    } finally {
      await withProjects.close();
    }
  });

  it('projects sleep states through an additive field for older clients', async () => {
    const project = await ctx.store.upsertProject({
      id: 'p-sleeping-wire',
      owner: 'heey-global',
      repo: 'sleeping-wire',
      containerName: 'dev-heey-global-sleeping-wire',
      state: 'sleeping',
    });
    const withProjects = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listProjects: () => Promise.resolve([project]),
    });
    try {
      const res = await withProjects.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject([
        { id: project.id, state: 'active', lifecycleState: 'sleeping' },
      ]);
      expect(res.json()[0]).not.toHaveProperty('sleepCompatibilityFingerprint');
    } finally {
      await withProjects.close();
    }
  });

  // The startup drift report only reaches a server log. These carry the same
  // verdict per project onto the wire so the app can show it.
  describe('toolkit drift on the project wire shape', () => {
    const CURRENT = 'sha256:current';
    const projectRow = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
      id: 'p-drift',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: `ghcr.io/heey-global/${DEVCONTAINER_IMAGE_PREFIX}verity:latest`,
      state: 'active',
      provisionError: null,
      provisionWarning: null,
      toolkitIdentity: CURRENT,
      hiddenAt: null,
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
      createdAt: new Date('2026-06-26T00:00:00.000Z'),
      updatedAt: new Date('2026-06-26T00:00:00.000Z'),
      stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      ...overrides,
    });

    const driftOf = async (
      project: ProjectRecord,
      toolkitIdentity: () => Promise<string | undefined> = () => Promise.resolve(CURRENT),
    ): Promise<unknown> => {
      const server = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        listProjects: () => Promise.resolve([project]),
        toolkitIdentity,
      });
      try {
        const body = (await server.inject({ method: 'GET', url: '/projects' })).json<
          { toolkitDrift: unknown }[]
        >();
        return body[0]?.toolkitDrift;
      } finally {
        await server.close();
      }
    };

    it('reports a matching image as matching, and a stale one as drifted', async () => {
      expect(await driftOf(projectRow())).toEqual({
        verdict: 'matches',
        carrier: 'devcontainer',
      });
      expect(await driftOf(projectRow({ toolkitIdentity: 'sha256:other' }))).toEqual({
        verdict: 'drifted',
        carrier: 'devcontainer',
      });
    });

    // No verdict, and never "matches": base-image projects are never attested,
    // so `unknown` is their permanent state, and a banner on it would be always
    // on for most of the fleet with nothing that clears it.
    it('carries no verdict for an unrecorded toolkit identity', async () => {
      expect(await driftOf(projectRow({ toolkitIdentity: null }))).toBeNull();
    });

    // A Server that ships no bundle cannot compare. That is a deployment fault
    // reported by the startup log — not a per-project banner, and not an all-clear.
    it('carries no verdict when this Server ships no toolkit bundle', async () => {
      expect(await driftOf(projectRow(), () => Promise.resolve(undefined))).toBeNull();
    });

    // A broken bundle read is a deployment fault, not a reason to 500 the whole
    // project list. It must not become `matches` either: on the wire it carries
    // no verdict, and the fault is announced by the server log below.
    it('degrades to no verdict when the bundle cannot be read, and still serves the list', async () => {
      expect(await driftOf(projectRow(), () => Promise.reject(new Error('EACCES')))).toBeNull();
    });

    // `isDriftReportable` declines these rows. null carries no verdict — never
    // `matches` — so nothing downstream can read it as a verified toolkit.
    it('is null for a row the drift report declines to judge', async () => {
      expect(await driftOf(projectRow({ state: 'failed' }))).toBeNull();
    });

    // Degrading quietly would hide the packaging or mount fault behind a fleet
    // of missing verdicts with nothing anywhere saying why. But the cache
    // drops a rejected read, so every project on every poll retries it — logging
    // per project would bury the line in its own repetition.
    it('logs an unreadable bundle once while it stays unreadable', async () => {
      const server = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        listProjects: () => Promise.resolve([projectRow(), projectRow({ id: 'p-drift-2' })]),
        toolkitIdentity: () => Promise.reject(new Error('EACCES')),
      });
      const logged = vi.spyOn(server.log, 'error');
      try {
        await server.inject({ method: 'GET', url: '/projects' });
        await server.inject({ method: 'GET', url: '/projects' });
        const toolkitLines = logged.mock.calls.filter(([, message]) =>
          String(message).includes('bundled sandbox toolkit'),
        );
        expect(toolkitLines).toHaveLength(1);
      } finally {
        logged.mockRestore();
        await server.close();
      }
    });

    // Detail is the screen that shows the full notice and offers Repair, so the
    // verdict has to reach it too — the list route carrying it is not enough.
    it('carries the verdict on the project detail route as well', async () => {
      await ctx.store.upsertProject({
        id: 'p-drift-detail',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        state: 'active',
      });
      await ctx.store.recordProjectImageRef(
        'p-drift-detail',
        `ghcr.io/heey-global/${DEVCONTAINER_IMAGE_PREFIX}verity:latest`,
        'sha256:recorded-elsewhere',
      );
      const server = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        toolkitIdentity: () => Promise.resolve(CURRENT),
      });
      try {
        const res = await server.inject({ method: 'GET', url: '/projects/p-drift-detail' });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ project: { toolkitDrift: unknown } }>().project.toolkitDrift).toEqual({
          verdict: 'drifted',
          carrier: 'devcontainer',
        });
      } finally {
        await server.close();
      }
    });
  });

  it('returns an empty list (200, not 503) when the provider yields none', async () => {
    const withProjects = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listProjects: () => Promise.resolve([]),
    });
    try {
      const res = await withProjects.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await withProjects.close();
    }
  });

  it('persists project overview order', async () => {
    await ctx.store.upsertProject({
      id: 'p-order-a',
      owner: 'heey-global',
      repo: 'alpha',
      containerName: 'dev-heey-global--alpha',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p-order-b',
      owner: 'heey-global',
      repo: 'beta',
      containerName: 'dev-heey-global--beta',
      state: 'active',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/order',
      payload: { ids: ['p-order-b', 'p-order-a'] },
    });
    expect(res.statusCode).toBe(200);
    const reordered: Array<{ id: string }> = res.json();
    expect(reordered.map((project) => project.id)).toEqual(['p-order-b', 'p-order-a']);

    const listed = await app.inject({ method: 'GET', url: '/projects' });
    const listedProjects: Array<{ id: string }> = listed.json();
    expect(listedProjects.map((project) => project.id)).toEqual(['p-order-b', 'p-order-a']);
  });

  it('rejects duplicate project ids when reordering', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/order',
      payload: { ids: ['p1', 'p1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'duplicate project id' });
  });

  it('rejects stale partial project order payloads', async () => {
    await ctx.store.upsertProject({
      id: 'p-order-visible-a',
      owner: 'heey-global',
      repo: 'visible-a',
      containerName: 'dev-heey-global--visible-a',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p-order-visible-b',
      owner: 'heey-global',
      repo: 'visible-b',
      containerName: 'dev-heey-global--visible-b',
      state: 'active',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/order',
      payload: { ids: ['p-order-visible-b'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'project order must include every visible project exactly once',
    });
  });

  it('persists a project collapse state and reflects it on GET /projects', async () => {
    await ctx.store.upsertProject({
      id: 'p-collapse',
      owner: 'heey-global',
      repo: 'gamma',
      containerName: 'dev-heey-global--gamma',
      state: 'active',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-collapse/collapsed',
      payload: { collapsed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'p-collapse', collapsed: true });

    const listed = await app.inject({ method: 'GET', url: '/projects' });
    const listedProjects: Array<{ id: string; collapsed?: boolean }> = listed.json();
    expect(listedProjects.find((project) => project.id === 'p-collapse')?.collapsed).toBe(true);
  });

  it('answers a collapse write from the written row while the fleet list is stale', async () => {
    await ctx.store.upsertProject({
      id: 'p-collapse-stale',
      owner: 'heey-global',
      repo: 'delta',
      containerName: 'dev-heey-global--delta',
      state: 'active',
    });
    // The memoised fleet list the embedded server serves for its cache window:
    // taken before the write, it still reports the group as open.
    const stale = await ctx.store.listProjects();
    const invalidateProjectList = vi.fn();
    const withStaleList = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      listProjects: () => Promise.resolve(stale),
      invalidateProjectList,
    });
    try {
      const res = await withStaleList.inject({
        method: 'PATCH',
        url: '/projects/p-collapse-stale/collapsed',
        payload: { collapsed: true },
      });
      expect(res.statusCode).toBe(200);
      // Echoing the stale list here is what folded overview groups back open.
      expect(res.json()).toMatchObject({ id: 'p-collapse-stale', collapsed: true });
      expect(invalidateProjectList).toHaveBeenCalledTimes(1);
    } finally {
      await withStaleList.close();
    }
  });

  it('returns 404 when collapsing an unknown project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/does-not-exist/collapsed',
      payload: { collapsed: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('persists a session seen mark monotonically and reflects it on GET /sessions', async () => {
    await ctx.store.createSession({ sessionId: 's-seen', worktree: '/wt/s-seen', model: 'm' });
    await ctx.store.appendEvent('s-seen', { t: 'status', state: 'awaiting_input' });
    await ctx.store.appendEvent('s-seen', { t: 'text', delta: 'hi' });
    await ctx.store.appendEvent('s-seen', { t: 'text', delta: ' there' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-seen/seen',
      payload: { eventCount: 2, counterVersion: 'agent-text-v2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: 's-seen', lastSeenEventCount: 2 });

    // A stale mark must not move it backward.
    const stale = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-seen/seen',
      payload: { eventCount: 1, counterVersion: 'agent-text-v2' },
    });
    expect(stale.json()).toMatchObject({ lastSeenEventCount: 2 });

    const listed = await app.inject({ method: 'GET', url: '/sessions' });
    const summary = listed
      .json<Array<{ sessionId: string; lastSeenEventCount?: number | null }>>()
      .find((session) => session.sessionId === 's-seen');
    expect(summary?.lastSeenEventCount).toBe(2);
  });

  it('updates listener snapshots without making session summaries unread', async () => {
    const sessionId = 's-listener-unread';
    await ctx.store.createSession({ sessionId, worktree: '/wt/listener', model: 'm' });
    await ctx.store.appendEvent(sessionId, { t: 'text', delta: 'read' });
    await app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}/seen`,
      payload: { eventCount: 1, counterVersion: 'agent-text-v2' },
    });
    await ctx.store.appendEvent(sessionId, { t: 'dev_servers_changed', devServers: [] });
    const listed = await app.inject({ method: 'GET', url: '/sessions' });
    expect(
      listed.json<Array<{ sessionId: string }>>().find((s) => s.sessionId === sessionId),
    ).toMatchObject({
      eventCount: 1,
      lastSeenEventCount: 1,
    });
    const detail = await app.inject({ method: 'GET', url: `/sessions/${sessionId}` });
    expect(detail.json()).toMatchObject({
      eventCount: 1,
      lastSeenEventCount: 1,
      agentTextCounterVersion: 'agent-text-v2',
    });
    await ctx.store.appendEvent(sessionId, { t: 'text', delta: 'new message' });
    const unread = await app.inject({ method: 'GET', url: `/sessions/${sessionId}` });
    expect(unread.json()).toMatchObject({ eventCount: 2, lastSeenEventCount: 1 });
  });

  it('rejects stale all-event read marks without hiding unread messages', async () => {
    const sessionId = 's-stale-read-count';
    await ctx.store.createSession({ sessionId, worktree: '/wt/stale', model: 'm' });
    await ctx.store.appendEvent(sessionId, { t: 'text', delta: 'read' });
    await ctx.store.setSessionSeen(sessionId, 1);
    await ctx.store.appendEvent(sessionId, { t: 'dev_servers_changed', devServers: [] });
    await ctx.store.appendEvent(sessionId, { t: 'text', delta: 'unread' });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}/seen`,
      payload: { eventCount: 3, counterVersion: 'agent-text-v2' },
    });
    expect(stale.statusCode).toBe(409);
    expect((await ctx.store.getSession(sessionId))!.lastSeenEventCount).toBe(1);
    // The legacy count can also overlap the new count; an upper bound cannot detect it.
    const overlapping = await app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}/seen`,
      payload: { eventCount: 2 },
    });
    expect(overlapping.statusCode).toBe(409);
    expect((await ctx.store.getSession(sessionId))!.lastSeenEventCount).toBe(1);
    const oldVersion = await app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}/seen`,
      payload: { eventCount: 2, counterVersion: 'dev-servers-excluded-v1' },
    });
    expect(oldVersion.statusCode).toBe(409);
    expect((await ctx.store.getSession(sessionId))!.lastSeenEventCount).toBe(1);
    const valid = await app.inject({
      method: 'PATCH',
      url: `/sessions/${sessionId}/seen`,
      payload: { eventCount: 2, counterVersion: 'agent-text-v2' },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ lastSeenEventCount: 2 });
  });

  it('returns 404 when marking an unknown session seen', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/does-not-exist/seen',
      payload: { eventCount: 1, counterVersion: 'agent-text-v2' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('persists a resolved release, keeps it on a cold lookup, and clears it on a confirmed 404', async () => {
    await ctx.store.upsertProject({
      id: 'p-rel',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    // Drives the fake latestRelease dep through its tristate: a summary, then
    // UNKNOWN (undefined), then CONFIRMED-none (null).
    let latest: ReleaseSummary | null | undefined = {
      tag: 'v1.4.0',
      name: 'Release 1.4.0',
      url: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
      publishedAt: '2026-07-01T10:00:00Z',
    };
    const withRelease = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      latestRelease: () => latest,
      refreshLatestRelease: () => Promise.resolve(latest),
    });
    try {
      // Resolved → persisted to the row AND served on the wire.
      const first = await withRelease.inject({ method: 'GET', url: '/projects' });
      expect(first.json()[0]).toMatchObject({
        latestReleaseTag: 'v1.4.0',
        latestReleaseName: 'Release 1.4.0',
        latestReleaseUrl: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
        latestReleasePublishedAt: '2026-07-01T10:00:00Z',
      });
      expect((await ctx.store.getProject('p-rel'))?.latestReleaseTag).toBe('v1.4.0');

      // Detail view also refreshes/persists; it must not depend on the overview
      // being opened first after a release changes.
      latest = {
        tag: 'v1.5.0',
        name: 'Release 1.5.0',
        url: 'https://github.com/heey-global/verity/releases/tag/v1.5.0',
        publishedAt: '2026-07-02T10:00:00Z',
      };
      const detail = await withRelease.inject({ method: 'GET', url: '/projects/p-rel' });
      expect(detail.json().project).toMatchObject({
        latestReleaseTag: 'v1.5.0',
        latestReleaseName: 'Release 1.5.0',
      });
      expect((await ctx.store.getProject('p-rel'))?.latestReleaseTag).toBe('v1.5.0');

      // Cold/unknown (undefined) → keep serving the persisted value; no clear.
      latest = undefined;
      const second = await withRelease.inject({ method: 'GET', url: '/projects' });
      expect(second.json()[0]).toMatchObject({ latestReleaseTag: 'v1.5.0' });
      expect((await ctx.store.getProject('p-rel'))?.latestReleaseTag).toBe('v1.5.0');

      // Confirmed no release (null — e.g. the release was deleted on GitHub) →
      // the stale persisted tag is cleared rather than pinned forever.
      latest = null;
      const third = await withRelease.inject({ method: 'GET', url: '/projects' });
      expect(third.json()[0]).toMatchObject({ latestReleaseTag: null });
      expect((await ctx.store.getProject('p-rel'))?.latestReleaseTag).toBeNull();
    } finally {
      await withRelease.close();
    }
  });

  it('falls back to the awaited release provider when the nonblocking cache is unknown', async () => {
    await ctx.store.upsertProject({
      id: 'p-async-rel',
      owner: 'heey-global',
      repo: 'sample-app-automation',
      containerName: 'dev-example-org-sample-app-automation',
      state: 'active',
    });
    const withRelease = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      latestRelease: () => undefined,
      refreshLatestRelease: () =>
        Promise.resolve({
          tag: 'v1.12.7',
          name: 'Release 1.12.7',
          url: 'https://github.com/example-org/sample-app-automation/releases/tag/v1.12.7',
          publishedAt: '2026-07-04T10:00:00Z',
        }),
    });
    try {
      const res = await withRelease.inject({ method: 'GET', url: '/projects' });
      expect(res.json()[0]).toMatchObject({ latestReleaseTag: 'v1.12.7' });
      expect((await ctx.store.getProject('p-async-rel'))?.latestReleaseTag).toBe('v1.12.7');
    } finally {
      await withRelease.close();
    }
  });
});

describe('POST /projects', () => {
  it('creates a manually-added project from owner/repo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { repo: 'heey-global/dev-server' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      project: {
        owner: 'heey-global',
        repo: 'dev-server',
        containerName: 'verity-heey-global--dev-server',
        imageRef: null,
        state: 'absent',
        provisionError: null,
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
      },
    });
    expect(await ctx.store.getProjectByOwnerRepo('heey-global', 'dev-server')).toMatchObject({
      repo: 'dev-server',
      state: 'absent',
    });
  });

  it('accepts GitHub URL input and image overrides', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { repo: 'https://github.com/heey-global/verity.git', imageRef: 'image:test' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      project: {
        owner: 'heey-global',
        repo: 'verity',
        imageRef: 'image:test',
      },
    });
  });

  it('400s invalid project identifiers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { repo: '../..' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid project' });
  });

  it('creates a project with no GitHub repository from a typed name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { kind: 'local', name: 'My New Project' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      project: {
        kind: 'local',
        owner: '__local__',
        repo: 'my-new-project',
        containerName: 'verity-__local__--my-new-project',
        state: 'absent',
      },
    });
    // Pinned at creation so linking to GitHub later cannot move the clone out
    // from under the session worktrees persisted inside it.
    expect(await ctx.store.getProjectByOwnerRepo('__local__', 'my-new-project')).toMatchObject({
      kind: 'local',
      cloneDir: '__local__-my-new-project',
    });
  });

  it('400s a local project name that has no legal slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { kind: 'local', name: '!!!' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid project name' });
  });

  // Unlike the GitHub path, a local add must not double as a restore: the name is
  // operator-typed, so adopting a same-named row would hand back someone else's
  // clone and sessions.
  it('409s a local project name that is already taken', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { kind: 'local', name: 'twice' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { kind: 'local', name: 'Twice' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'a project with that name already exists' });
  });

  it('atomically rejects one of two concurrent local creates for the same slug', async () => {
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/projects',
        payload: { kind: 'local', name: 'Concurrent' },
      }),
      app.inject({
        method: 'POST',
        url: '/projects',
        payload: { kind: 'local', name: 'Concurrent' },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const matches = (await ctx.store.listProjects({ includeHidden: true })).filter(
      (project) => project.owner === '__local__' && project.repo === 'concurrent',
    );
    expect(matches).toHaveLength(1);
  });
});

describe('GET /projects/:id (#174)', () => {
  it('404s an unknown project id', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project missing not found' });
  });

  // Detail owns the Repair action, so it must not serve a stale `active` for a
  // container that has already died — that showed "Pause" for a dead sandbox until
  // the next overview poll happened to reconcile it.
  it('serves the live container state, not the cached row', async () => {
    await ctx.store.upsertProject({
      id: 'p-stale',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const reconcileProjectState = vi.fn(async (project: ProjectRecord) => ({
      ...project,
      state: 'failed' as const,
      provisionError: CONTAINER_STOPPED_REASON,
    }));
    const fresh = buildServer({ eventStore: ctx.store, bus, conductor, reconcileProjectState });

    const res = await fresh.inject({ method: 'GET', url: '/projects/p-stale' });

    expect(res.statusCode).toBe(200);
    expect(reconcileProjectState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-stale', state: 'active' }),
    );
    expect(res.json()).toMatchObject({
      project: { id: 'p-stale', state: 'failed', provisionError: CONTAINER_STOPPED_REASON },
    });
    await fresh.close();
  });

  it('falls back to the cached row when the container check fails', async () => {
    await ctx.store.upsertProject({
      id: 'p-docker-down',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const fresh = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      reconcileProjectState: () => Promise.reject(new Error('docker unreachable')),
    });

    const res = await fresh.inject({ method: 'GET', url: '/projects/p-docker-down' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ project: { id: 'p-docker-down', state: 'active' } });
    await fresh.close();
  });

  it('returns project detail with only sessions bound to that project', async () => {
    await ctx.store.upsertProject({
      id: 'p-detail',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p-other',
      owner: 'heey-global',
      repo: 'dev-server',
      containerName: 'dev-heey-global-dev-server',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project',
      worktree: worktreeRoot,
      model: 'm',
      projectId: 'p-detail',
    });
    await ctx.store.updateProjectSettings('p-detail', {
      dopplerTokenRef: 'doppler://verity/prod',
      defaultBranch: 'main',
      defaultModel: 'claude-sonnet-4-6',
    });
    await ctx.store.appendEvent('s-project', { t: 'status', state: 'running' });
    await ctx.store.createSession({
      sessionId: 's-other',
      worktree: '/wt/other',
      model: 'm',
      projectId: 'p-other',
    });
    await ctx.store.createSession({ sessionId: 's-none', worktree: '/wt/none', model: 'm' });

    const res = await app.inject({ method: 'GET', url: '/projects/p-detail' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      project: {
        id: 'p-detail',
        owner: 'heey-global',
        repo: 'verity',
        state: 'active',
      },
      settings: {
        projectId: 'p-detail',
        defaultBranch: 'main',
        defaultModel: 'claude-sonnet-4-6',
      },
      sessions: [
        {
          sessionId: 's-project',
          projectId: 'p-detail',
          status: 'running',
          usage: ZERO_USAGE,
          resumable: true,
        },
      ],
    });
    expect(JSON.stringify(res.json())).not.toContain('doppler://verity/prod');
  });

  it('returns null settings before a project has saved settings', async () => {
    await ctx.store.upsertProject({
      id: 'p-no-settings',
      owner: 'heey-global',
      repo: 'empty',
      containerName: 'dev-heey-global-empty',
      state: 'absent',
    });

    const res = await app.inject({ method: 'GET', url: '/projects/p-no-settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ settings: null, sessions: [] });
  });
});

describe('POST /projects/:id/link-github', () => {
  const createLocal = async (id: string, state: 'absent' | 'active' = 'absent'): Promise<void> => {
    await ctx.store.upsertProject({
      id,
      owner: '__local__',
      repo: 'my-project',
      containerName: 'verity-__local__--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
      state,
    });
  };

  function fakeProvisioner(overrides: Record<string, unknown> = {}) {
    return {
      provision: vi.fn(),
      linkCloneToGitHub: vi.fn(async () => ({})),
      withProjectExclusiveMutation: async <T>(_projectId: string, mutation: () => Promise<T>) =>
        mutation(),
      recreateContainer: vi.fn(
        async (projectId: string) => (await ctx.store.getProject(projectId))!,
      ),
      ...overrides,
    };
  }

  it('links through the selected Forgejo connection without adopting another connection repository', async () => {
    await createLocal('p-forge-link');
    for (const id of ['forge-first', 'forge-second'])
      await ctx.store.forgeConnections.upsert({
        id,
        provider: 'forgejo',
        baseUrl: 'https://forge.test/prefix',
        label: id,
        personalToken: 'fixture',
        githubAppId: null,
        githubAppInstallationId: null,
        githubAppPrivateKey: null,
      });
    await ctx.store.createProject({
      id: 'other-forge-project',
      kind: 'forgejo',
      forgeConnectionId: 'forge-second',
      owner: 'owner',
      repo: 'repo',
      containerName: 'other-forge',
      state: 'active',
    });
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('forge-admin');
    const provisioner = fakeProvisioner();
    const ghTokenMint = vi.fn(() => Promise.resolve('server-only-fixture'));
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint,
      authRegistry: registry,
      forgejoEnabled: true,
    });
    try {
      const response = await a.inject({
        method: 'POST',
        url: '/projects/p-forge-link/link',
        headers: { authorization: `Bearer ${token}` },
        payload: { repo: 'https://forge.test/prefix/owner/repo.git', connectionId: 'forge-first' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        project: {
          kind: 'forgejo',
          forgeConnectionId: 'forge-first',
          owner: 'owner',
          repo: 'repo',
          cloneDir: 'local-my-project',
        },
      });
      expect(ghTokenMint).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        forgeConnectionId: 'forge-first',
        kind: 'forgejo',
      });
      expect((await ctx.store.getProject('other-forge-project'))?.forgeConnectionId).toBe(
        'forge-second',
      );
    } finally {
      await a.close();
    }
  });

  it('503s when the provisioner cannot link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/p1/link-github',
      payload: { repo: 'heey-global/verity' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'linking a project to GitHub is not configured' });
  });

  it('pushes the clone, rewrites the identity, and recreates the sandbox', async () => {
    await createLocal('p-link', 'active');
    const provisioner = fakeProvisioner();
    const ghTokenMint = vi.fn(async () => 'gh-token');
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-link/link-github',
        payload: { repo: 'https://github.com/heey-global/verity.git' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        project: { id: 'p-link', owner: 'heey-global', repo: 'verity', kind: 'github' },
      });
      // Scoped to the TARGET repo, not the project\u2019s current local identity.
      expect(ghTokenMint).toHaveBeenCalledWith({ owner: 'heey-global', repo: 'verity' });
      expect(provisioner.linkCloneToGitHub).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-link', kind: 'local' }),
        { owner: 'heey-global', repo: 'verity' },
        'gh-token',
      );
      expect(provisioner.recreateContainer).toHaveBeenCalledWith('p-link', {
        confirmWarnings: true,
        initiator: { kind: 'user', userId: null },
      });
      // The clone never moves: session worktree paths are persisted under it.
      expect(await ctx.store.getProject('p-link')).toMatchObject({
        kind: 'github',
        cloneDir: 'local-my-project',
      });
    } finally {
      await a.close();
    }
  });

  it('returns the pull request the history arrived on, so the operator merges it', async () => {
    await createLocal('p-link-pr', 'active');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => ({
        importBranch: 'verity/import-main',
        pullRequest: { number: 12, url: 'https://github.com/heey-global/verity/pull/12' },
      })),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-link-pr/link-github',
        payload: { repo: 'heey-global/verity' },
      });

      expect(res.statusCode).toBe(200);
      // Without this the app reports "connected" while the files sit on a branch
      // nobody has been told about.
      expect(res.json()).toMatchObject({
        project: { id: 'p-link-pr', kind: 'github' },
        importBranch: 'verity/import-main',
        pullRequest: { number: 12, url: 'https://github.com/heey-global/verity/pull/12' },
      });
    } finally {
      await a.close();
    }
  });

  it('reports a branch whose pull request could not be opened', async () => {
    await createLocal('p-link-nopr', 'active');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => ({
        importBranch: 'verity/import-main',
        pullRequestError: 'GitHub declined to open the pull request: rules',
      })),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-link-nopr/link-github',
        payload: { repo: 'heey-global/verity' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        importBranch: 'verity/import-main',
        pullRequestError: 'GitHub declined to open the pull request: rules',
      });
      expect(res.json()).not.toHaveProperty('pullRequest');
    } finally {
      await a.close();
    }
  });

  it('does not recreate a sandbox that was never started', async () => {
    await createLocal('p-absent');
    const provisioner = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-absent/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(200);
      expect(provisioner.recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('503s before reserving or pushing when target-scoped authentication is unavailable', async () => {
    await createLocal('p-no-auth');
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-no-auth/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: 'GitHub authentication is unavailable for this repository',
      });
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
      await expect(
        ctx.db
          .selectFrom('project_identity_claims')
          .selectAll()
          .where('owner', '=', 'heey-global')
          .where('repo', '=', 'verity')
          .execute(),
      ).resolves.toEqual([]);
    } finally {
      await a.close();
    }
  });

  it('keeps the local identity when publishing the clone fails', async () => {
    await createLocal('p-push-fails');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => {
        throw new ProvisioningError('the GitHub repository is not empty');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-push-fails/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'the GitHub repository is not empty' });
      expect(await ctx.store.getProject('p-push-fails')).toMatchObject({
        owner: '__local__',
        repo: 'my-project',
        kind: 'local',
      });
    } finally {
      await a.close();
    }
  });

  it('keeps the local slug reserved until a failed publication finishes', async () => {
    await createLocal('p-race');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => {
        entered();
        await gate;
        throw new ProvisioningError('publication failed');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const linking = a.inject({
        method: 'POST',
        url: '/projects/p-race/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      await started;
      const concurrentCreate = await a.inject({
        method: 'POST',
        url: '/projects',
        payload: { kind: 'local', name: 'My Project' },
      });
      expect(concurrentCreate.statusCode).toBe(409);
      release();
      expect((await linking).statusCode).toBe(409);
      expect(await ctx.store.getProject('p-race')).toMatchObject({
        owner: '__local__',
        repo: 'my-project',
        kind: 'local',
      });
    } finally {
      await a.close();
    }
  });

  it('retries finalization after publication succeeded but persistence failed', async () => {
    await createLocal('p-finalize');
    const provisioner = fakeProvisioner();
    const originalLink = ctx.store.linkProjectToGitHub.bind(ctx.store);
    const persistenceFailure = new Error('simulated database outage');
    const linkSpy = vi
      .spyOn(ctx.store, 'linkProjectToGitHub')
      .mockRejectedValueOnce(persistenceFailure)
      .mockImplementation(originalLink);
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const first = await a.inject({
        method: 'POST',
        url: '/projects/p-finalize/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(first.statusCode).toBe(409);
      expect(first.json().error).toMatch(/published.*retry/);
      expect(await ctx.store.getProject('p-finalize')).toMatchObject({ kind: 'local' });

      const retry = await a.inject({
        method: 'POST',
        url: '/projects/p-finalize/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(retry.statusCode).toBe(200);
      expect(await ctx.store.getProject('p-finalize')).toMatchObject({
        kind: 'github',
        owner: 'heey-global',
        repo: 'verity',
      });
    } finally {
      linkSpy.mockRestore();
      await a.close();
    }
  });

  it('404s an unknown project', async () => {
    const provisioner = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/unknown/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(404);
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('409s when the project mutation barrier finds an active turn', async () => {
    await createLocal('p-busy');
    const provisioner = fakeProvisioner({
      withProjectExclusiveMutation: vi.fn(async () => {
        throw new ProvisioningError('project p-busy has a turn in flight');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-busy/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/turn in flight/);
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('409s a project that already has a GitHub repository', async () => {
    await ctx.store.upsertProject({
      id: 'p-github',
      owner: 'heey-global',
      repo: 'dev-server',
      containerName: 'verity-heey-global--dev-server',
      state: 'active',
    });
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-github/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'this project is already backed by a GitHub repository',
      });
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('400s an invalid or reserved link target', async () => {
    await createLocal('p-bad');
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      for (const repo of ['../..', '__local__/other']) {
        const res = await a.inject({
          method: 'POST',
          url: '/projects/p-bad/link-github',
          payload: { repo },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid repository' });
      }
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  // (owner, repo) is UNIQUE, so an unchecked link would fail in the DB AFTER the
  // push already happened.
  it('409s before pushing when another project owns the target pair', async () => {
    await ctx.store.upsertProject({
      id: 'p-existing',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-heey-global--verity',
      state: 'active',
    });
    await createLocal('p-dup');
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-dup/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'heey-global/verity is already registered as a project',
      });
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  // The installation sync registers every repository the GitHub App can see —
  // including one created seconds ago for exactly this purpose. Reporting that
  // bookkeeping row as "already registered" made linking unreachable for every
  // repository the route could actually push to.
  it('adopts the installation-sync placeholder for the target repository', async () => {
    await ctx.store.upsertProject({
      id: 'p-placeholder',
      owner: 'heey-global',
      repo: 'immobilien',
      containerName: 'verity-heey-global--immobilien',
      state: 'absent',
    });
    await createLocal('p-adopt', 'active');
    const provisioner = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: vi.fn(async () => 'gh-token'),
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-adopt/link-github',
        payload: { repo: 'heey-global/immobilien' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        project: { id: 'p-adopt', owner: 'heey-global', repo: 'immobilien', kind: 'github' },
      });
      expect(provisioner.linkCloneToGitHub).toHaveBeenCalled();
      expect(await ctx.store.getProject('p-placeholder')).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  // The narrow half of adoption: a project someone actually worked in is a real
  // conflict, and it must be refused BEFORE the push rather than by deleting
  // the row out from under its sessions.
  it('409s before pushing when the target project has sessions', async () => {
    await ctx.store.upsertProject({
      id: 'p-worked-in',
      owner: 'example-org',
      repo: 'sample-app',
      containerName: 'verity-example-org--sample-app',
      state: 'absent',
    });
    await ctx.store.createSession({
      sessionId: 's-worked-in',
      worktree: '/wt/worked-in',
      model: 'claude-sonnet-4-6',
      projectId: 'p-worked-in',
    });
    await createLocal('p-collide', 'active');
    const provisioner = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: vi.fn(async () => 'gh-token'),
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-collide/link-github',
        payload: { repo: 'example-org/sample-app' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'example-org/sample-app is already registered as a project',
      });
      expect(provisioner.linkCloneToGitHub).not.toHaveBeenCalled();
      expect(await ctx.store.getProject('p-worked-in')).toBeDefined();
    } finally {
      await a.close();
    }
  });

  // A failed push must leave the project local and retryable rather than pointing
  // at a repository it never reached. A sync placeholder remains intact too:
  // reservation only borrows its claim until publication succeeds.
  it('keeps the project local when the push fails', async () => {
    await ctx.store.upsertProject({
      id: 'p-fail-placeholder',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-heey-global--verity',
      state: 'absent',
    });
    await createLocal('p-fail');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => {
        throw new ProvisioningError('pushing main to heey-global/verity failed');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-fail/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'pushing main to heey-global/verity failed' });
      expect(await ctx.store.getProject('p-fail')).toMatchObject({
        kind: 'local',
        owner: '__local__',
        repo: 'my-project',
      });
      expect(await ctx.store.getProject('p-fail-placeholder')).toBeDefined();
      expect(
        await ctx.db
          .selectFrom('project_identity_claims')
          .select('project_id')
          .where('owner', '=', 'heey-global')
          .where('repo', '=', 'verity')
          .executeTakeFirst(),
      ).toEqual({ project_id: 'p-fail-placeholder' });
    } finally {
      await a.close();
    }
  });

  it('releases the durable target claim after a generic pre-push failure', async () => {
    await createLocal('p-git-fails');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => {
        throw new Error('git setup failed');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-git-fails/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(500);
      await expect(
        ctx.db
          .selectFrom('project_identity_claims')
          .selectAll()
          .where('owner', '=', 'heey-global')
          .where('repo', '=', 'verity')
          .execute(),
      ).resolves.toEqual([]);
    } finally {
      await a.close();
    }
  });

  it('retains the durable target claim after an ambiguous push result', async () => {
    await createLocal('p-ambiguous');
    const provisioner = fakeProvisioner({
      linkCloneToGitHub: vi.fn(async () => {
        throw new AmbiguousGitPushError('push result is ambiguous');
      }),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      ghTokenMint: async () => 'gh-token',
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-ambiguous/link-github',
        payload: { repo: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(409);
      await expect(
        ctx.db
          .selectFrom('project_identity_claims')
          .select('project_id')
          .where('owner', '=', 'heey-global')
          .where('repo', '=', 'verity')
          .executeTakeFirst(),
      ).resolves.toEqual({ project_id: 'p-ambiguous' });

      const differentTarget = await a.inject({
        method: 'POST',
        url: '/projects/p-ambiguous/link-github',
        payload: { repo: 'heey-global/other' },
      });
      expect(differentTarget.statusCode).toBe(409);
      expect(provisioner.linkCloneToGitHub).toHaveBeenCalledTimes(1);
      await expect(
        ctx.db
          .selectFrom('project_identity_claims')
          .select(['owner', 'repo'])
          .where('project_id', '=', 'p-ambiguous')
          .where('owner', '<>', '__local__')
          .execute(),
      ).resolves.toEqual([{ owner: 'heey-global', repo: 'verity' }]);
    } finally {
      await a.close();
    }
  });
});

describe('POST /projects/:id/deprovision (#174)', () => {
  function fakeDeprovisioner() {
    return {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
        id: projectId,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        imageRef: null,
        state: 'absent',
        provisionError: null,
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
        createdAt: new Date('2026-06-26T00:00:00.000Z'),
        updatedAt: new Date('2026-06-26T00:00:00.000Z'),
        stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      })),
    };
  }

  it('503s when no deprovisioner is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/p1/deprovision',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'multi-repo provisioning is not configured' });
  });

  it('404s for an unknown project id', async () => {
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/unknown/deprovision',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project unknown not found' });
      expect(d.deprovision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('refuses to deprovision while a project session is busy', async () => {
    await ctx.store.upsertProject({
      id: 'p-busy-deprovision',
      owner: 'acme',
      repo: 'busy',
      containerName: 'verity-acme--busy',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'busy-deprovision-session',
      worktree: '/work/busy-deprovision-session',
      model: 'claude-sonnet',
      projectId: 'p-busy-deprovision',
    });
    isBusy.mockImplementation((id) => id === 'busy-deprovision-session');
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-busy-deprovision/deprovision',
      });
      expect(res.statusCode).toBe(409);
      expect(d.deprovision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('calls deprovisioner with purge=false by default', async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p1/deprovision',
      });
      expect(res.statusCode).toBe(200);
      expect(d.deprovision).toHaveBeenCalledWith('p1', { purge: false });
      expect(res.json()).toMatchObject({
        project: { id: 'p1', state: 'absent' },
      });
    } finally {
      await a.close();
    }
  });

  it('forwards purge=true from query string', async () => {
    await ctx.store.upsertProject({
      id: 'p2',
      owner: 'heey-global',
      repo: 'dev-server',
      containerName: 'dev-heey-global-dev-server',
      state: 'active',
    });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p2/deprovision?purge=true',
      });
      expect(res.statusCode).toBe(200);
      expect(d.deprovision).toHaveBeenCalledWith('p2', { purge: true });
    } finally {
      await a.close();
    }
  });

  it('forwards purge=false from query string without purging', async () => {
    await ctx.store.upsertProject({
      id: 'p-false',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-false/deprovision?purge=false',
      });
      expect(res.statusCode).toBe(200);
      expect(d.deprovision).toHaveBeenCalledWith('p-false', { purge: false });
    } finally {
      await a.close();
    }
  });

  it('returns 500 when the deprovisioner throws', async () => {
    await ctx.store.upsertProject({
      id: 'p3',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const d = fakeDeprovisioner();
    d.deprovision.mockRejectedValue(new Error('docker boom'));
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p3/deprovision',
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
    } finally {
      await a.close();
    }
  });
});

describe('POST /projects/:id/sleep and /wake', () => {
  it('runs explicit sleep and wake through the provisioner', async () => {
    await ctx.store.upsertProject({
      id: 'p-sleep-route',
      owner: 'heey-global',
      repo: 'sleep-route',
      containerName: 'dev-heey-global-sleep-route',
      state: 'active',
    });
    const sleepProject = vi.fn(async (id: string) =>
      ctx.store.updateProjectSleepState(id, 'sleeping', {
        sleepCompatibilityFingerprint: 'sha256:test',
        sleepingSince: new Date(),
        wakeStartedAt: null,
      }),
    );
    const wakeProject = vi.fn(async (id: string) =>
      ctx.store.updateProjectSleepState(id, 'active', {
        sleepCompatibilityFingerprint: null,
        sleepingSince: null,
        wakeStartedAt: null,
      }),
    );
    const provisioner = {
      provision: vi.fn(),
      sleepProject: async (id: string) => (await sleepProject(id))!,
      wakeProject: async (id: string) => (await wakeProject(id))!,
    };
    const server = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const slept = await server.inject({ method: 'POST', url: '/projects/p-sleep-route/sleep' });
      expect(slept.statusCode).toBe(200);
      expect(slept.json()).toMatchObject({
        project: { state: 'active', lifecycleState: 'sleeping' },
      });
      expect(sleepProject).toHaveBeenCalledOnce();

      const woke = await server.inject({ method: 'POST', url: '/projects/p-sleep-route/wake' });
      expect(woke.statusCode).toBe(200);
      expect(woke.json()).toMatchObject({ project: { state: 'active' } });
      expect(wakeProject).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('rejects an active wake when a sandbox mutation prevents takeover', async () => {
    await ctx.store.upsertProject({
      id: 'p-wake-mutation',
      owner: 'test',
      repo: 'wake-mutation',
      containerName: 'wake-mutation',
      state: 'active',
    });
    const provisioner = {
      provision: vi.fn(),
      wakeProject: vi.fn(),
      tryBeginProjectSandboxActivity: vi.fn(() => false),
      endProjectSandboxActivity: vi.fn(),
    };
    const server = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/projects/p-wake-mutation/wake',
      });
      expect(response.statusCode).toBe(409);
      expect(provisioner.endProjectSandboxActivity).not.toHaveBeenCalled();
      expect(provisioner.wakeProject).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('keeps a stuck waking project a conflict when no wake is in flight', async () => {
    await ctx.store.upsertProject({
      id: 'p-stuck-waking',
      owner: 'heey-global',
      repo: 'stuck-waking',
      containerName: 'dev-heey-global-stuck-waking',
      state: 'waking',
    });
    const provisioner = {
      provision: vi.fn(),
      sleepProject: vi.fn(),
      wakeProject: vi.fn(),
      // The real provisioner refuses a `waking` row it has no attempt for, e.g. after a restart.
      ensureProjectSandboxAwake: vi.fn(async (id: string) => {
        throw new ProvisioningError(`project ${id} is waking`);
      }),
    };
    const server = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/projects/p-stuck-waking/wake',
      });
      expect(response.statusCode).toBe(409);
      expect(provisioner.ensureProjectSandboxAwake).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('rejects a transition from the wrong lifecycle state', async () => {
    await ctx.store.upsertProject({
      id: 'p-failed-sleep-route',
      owner: 'heey-global',
      repo: 'failed-sleep-route',
      containerName: 'dev-heey-global-failed-sleep-route',
      state: 'failed',
    });
    const provisioner = {
      provision: vi.fn(),
      sleepProject: vi.fn(),
      wakeProject: vi.fn(),
    };
    const server = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/projects/p-failed-sleep-route/sleep',
      });
      expect(response.statusCode).toBe(409);
      expect(provisioner.sleepProject).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('DELETE /projects/:id', () => {
  function fakeDeprovisioner() {
    return {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
        id: projectId,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        imageRef: null,
        state: 'absent',
        provisionError: null,
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
        createdAt: new Date('2026-06-26T00:00:00.000Z'),
        updatedAt: new Date('2026-06-26T00:00:00.000Z'),
        stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      })),
    };
  }

  it.each([false, true])(
    'runs image cleanup only after hiding, without making cleanup failure undo deletion (%s)',
    async (fail) => {
      await ctx.store.upsertProject({
        id: 'p-image-delete',
        owner: 'org',
        repo: 'repo',
        containerName: 'dev-image-delete',
        state: 'active',
      });
      let hiddenAtCleanup: Date | null | undefined;
      const cleanup = vi.fn(async (id: string) => {
        hiddenAtCleanup = (await ctx.store.getProject(id))?.hiddenAt;
        if (fail) throw new Error('image busy');
      });
      const a = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        deprovisioner: fakeDeprovisioner(),
        onProjectHidden: cleanup,
      });
      try {
        const res = await a.inject({ method: 'DELETE', url: '/projects/p-image-delete' });
        expect(res.statusCode).toBe(200);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith('p-image-delete');
        expect(hiddenAtCleanup).toBeInstanceOf(Date);
        expect((await ctx.store.getProject('p-image-delete'))?.hiddenAt).toBeInstanceOf(Date);
      } finally {
        await a.close();
      }
    },
  );

  it('records the deletion in the audit trail before the image cleanup', async () => {
    await ctx.store.upsertProject({
      id: 'p-audit-delete',
      owner: 'org',
      repo: 'repo',
      containerName: 'dev-audit-delete',
      state: 'active',
    });
    const order: string[] = [];
    const projectDeleted = vi.fn(async () => void order.push('audit'));
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: fakeDeprovisioner(),
      onProjectHidden: async () => void order.push('cleanup'),
      audit: {
        recorder: { projectDeleted } as unknown as AuditRecorder,
        log: {} as AuditLog,
      },
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-audit-delete' });
      expect(res.statusCode).toBe(200);
      expect(projectDeleted).toHaveBeenCalledExactlyOnceWith({
        projectId: 'p-audit-delete',
        projectLabel: 'org/repo',
        initiator: { kind: 'user', userId: null },
      });
      expect(order).toEqual(['audit', 'cleanup']);
    } finally {
      await a.close();
    }
  });

  it('purges the container and soft-deletes (hides) the store row', async () => {
    await ctx.store.upsertProject({
      id: 'p-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createDevServer({ projectId: 'p-delete', name: 'Web' });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-delete' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projectId: 'p-delete' });
      expect(d.deprovision).toHaveBeenCalledWith('p-delete', { purge: true });
      // Soft-delete: the row survives (hidden) so the installation-sync can't
      // resurrect it, but it drops out of the picker's listProjects.
      expect((await ctx.store.getProject('p-delete'))?.hiddenAt).toBeInstanceOf(Date);
      expect(await ctx.store.listProjects()).toHaveLength(0);
    } finally {
      await a.close();
    }
  });

  // The project's sessions used to outlive it: they stayed bound to the hidden
  // row, so `GET /sessions` kept returning them while `GET /projects` did not,
  // and the overview parked them under a permanent "Inactive project" group.
  it("deletes the project's own sessions and leaves every other session alone", async () => {
    await ctx.store.upsertProject({
      id: 'p-session-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p-session-keep',
      owner: 'heey-global',
      repo: 'other',
      containerName: 'dev-heey-global-other',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-doomed',
      worktree: '/wt/doomed',
      model: 'm',
      projectId: 'p-session-delete',
    });
    await ctx.store.createSession({
      sessionId: 's-neighbour',
      worktree: '/wt/neighbour',
      model: 'm',
      projectId: 'p-session-keep',
    });
    await ctx.store.createSession({ sessionId: 's-default', worktree: '/wt/default', model: 'm' });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-delete' });
      expect(res.statusCode).toBe(200);
      expect((await ctx.store.listSessions()).map((s) => s.sessionId).sort()).toEqual([
        's-default',
        's-neighbour',
      ]);
    } finally {
      await a.close();
    }
  });

  it('spends one transcript-purge budget across the whole project, not one per session', async () => {
    // The per-session bound multiplies: fifty sessions on a wedged data volume would be
    // fifty ten-second waits inside a single request, which is the stall the bound was
    // added to prevent. Both purges are still ATTEMPTED — what a used-up budget gives up
    // is the waiting, and the files it leaves are the startup sweep's to collect.
    await ctx.store.upsertProject({
      id: 'p-purge-budget',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    for (const sessionId of ['s-purge-a', 's-purge-b']) {
      await ctx.store.createSession({
        sessionId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
        projectId: 'p-purge-budget',
      });
    }
    const purged: string[] = [];
    const purge = vi.fn((sessionId: string) => {
      purged.push(sessionId);
      return new Promise<void>(() => undefined);
    });
    const d = fakeDeprovisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: d,
      purgeSessionArtifacts: purge,
    });
    isBusy.mockReturnValue(false);
    const startedAt = Date.now();
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-purge-budget' });
      expect(res.statusCode).toBe(200);
      expect([...purged].sort()).toEqual(['s-purge-a', 's-purge-b']);
      expect(await ctx.store.listSessions()).toHaveLength(0);
      // One budget of 10 s, not two: the margin between the two readings is the whole
      // assertion, so this stays far away from both.
      expect(Date.now() - startedAt).toBeLessThan(16_000);
    } finally {
      await a.close();
    }
  }, 30_000);

  // `purge: true` deletes the clone root and every session worktree under it, so
  // a turn still in flight would be writing into a directory being removed. The
  // rows outlive the purge on purpose — see the failed-deprovision test below.
  it('stops the sessions before the purge removes their worktrees', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-order',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-busy',
      worktree: '/wt/busy',
      model: 'm',
      projectId: 'p-session-order',
    });
    isBusy.mockImplementation((id) => id === 's-busy');
    const base = fakeDeprovisioner();
    let stoppedAtPurge: string[] | undefined;
    const d = {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        stoppedAtPurge = closeSession.mock.calls.map(([sessionId]) => sessionId);
        return base.deprovision(projectId);
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-order' });
      expect(res.statusCode).toBe(200);
      // A busy session is force-settled rather than refused: there is nothing
      // left to finish the turn against once the sandbox goes. Its backlog goes
      // first, so the cancelled turn's settle cannot drain a queued successor
      // into the worktree the purge is about to remove.
      expect(stoppedAtPurge).toEqual(['s-busy']);
      expect(clearQueue).toHaveBeenCalledWith('s-busy');
      expect(cancelTurn).toHaveBeenCalledWith('s-busy');
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      isBusy.mockImplementation(() => false);
      await a.close();
    }
  });

  // The rows are the transcripts. Destroying them before the deprovision is
  // known to have worked would burn the history for a delete that then failed
  // and stayed retryable — so the delete only quiesces first, and deletes once
  // the teardown is through.
  it('keeps the sessions when the deprovision fails, having only stopped them', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-teardown-fail',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-survivor',
      worktree: '/wt/survivor',
      model: 'm',
      projectId: 'p-session-teardown-fail',
    });
    const d = {
      deprovision: vi.fn(async (): Promise<ProjectRecord> => {
        throw new Error('could not revoke the project credential');
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-teardown-fail' });
      expect(res.statusCode).toBe(500);
      expect((await ctx.store.listSessions()).map((s) => s.sessionId)).toEqual(['s-survivor']);
      expect((await ctx.store.getProject('p-session-teardown-fail'))?.hiddenAt).toBeNull();
      // Quiesced all the same: the turn had to stop before the purge could run,
      // and the retry finishes the job.
      expect(closeSession).toHaveBeenCalledWith('s-survivor');
    } finally {
      await a.close();
      await ctx.store.deleteSession('s-survivor');
    }
  });

  // One wedged step must not silently skip the others: a session whose queue
  // cannot be cleared still has a running turn and an open backend. Its row then
  // stays — the transcript is the only durable trace of an agent nobody managed
  // to stop, and a stray session beats destroying that history.
  it('cancels and closes a session even when clearing its queue fails', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-step-fail',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-wedged',
      worktree: '/wt/wedged',
      model: 'm',
      projectId: 'p-session-step-fail',
    });
    isBusy.mockImplementation((id) => id === 's-wedged');
    clearQueue.mockRejectedValue(new Error('queue store unavailable'));
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-step-fail' });
      expect(res.statusCode).toBe(200);
      expect(cancelTurn).toHaveBeenCalledWith('s-wedged');
      expect(closeSession).toHaveBeenCalledWith('s-wedged');
      // Kept, deliberately: the queue could not be dropped, so the backlog may
      // still drain into a turn, and deleting the row would take the transcript
      // with it. The project itself is gone all the same.
      expect((await ctx.store.listSessions()).map((s) => s.sessionId)).toEqual(['s-wedged']);
      expect((await ctx.store.getProject('p-session-step-fail'))?.hiddenAt).toBeInstanceOf(Date);
    } finally {
      isBusy.mockImplementation(() => false);
      clearQueue.mockResolvedValue([]);
      await a.close();
    }
  });

  // A spawn that raced the deprovision lands after the first pass listed the
  // sessions; the pass after the hide catches it, and from then on the spawn
  // path refuses the hidden project.
  it('reaps a session that appeared while the project was being deprovisioned', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-race',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const base = fakeDeprovisioner();
    const d = {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        await ctx.store.createSession({
          sessionId: 's-raced',
          worktree: '/wt/raced',
          model: 'm',
          projectId: 'p-session-race',
        });
        return base.deprovision(projectId);
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-race' });
      expect(res.statusCode).toBe(200);
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // The window between the first quiesce pass and the purge is the dangerous
  // one: the project row is still visible and still `active`, so nothing in the
  // store would stop a turn from being dispatched into a worktree the purge is
  // about to remove.
  it('refuses a turn for one of its sessions while the teardown is running', async () => {
    await ctx.store.upsertProject({
      id: 'p-turn-race',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-turn-race',
      worktree: '/wt/turn-race',
      model: 'm',
      projectId: 'p-turn-race',
    });
    const base = fakeDeprovisioner();
    let turnDuringTeardown: { statusCode: number; body: unknown } | undefined;
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: {
        deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
          const res = await a.inject({
            method: 'POST',
            url: '/sessions/s-turn-race/turns',
            payload: { prompt: 'keep going' },
          });
          turnDuringTeardown = { statusCode: res.statusCode, body: res.json() };
          return base.deprovision(projectId);
        }),
      },
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-turn-race' });
      expect(res.statusCode).toBe(200);
      expect(turnDuringTeardown).toEqual({
        statusCode: 409,
        body: { error: 'session is being deleted with its project' },
      });
      expect(dispatchTurn).not.toHaveBeenCalled();
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // An accepted plan is also a turn: it must respect the deletion fence.
  it('refuses plan implementation while the project teardown is running', async () => {
    await ctx.store.upsertProject({
      id: 'p-plan-race',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-plan-race',
      worktree: '/wt/plan-race',
      model: 'm',
      projectId: 'p-plan-race',
    });
    await ctx.store.setSessionPlanning('s-plan-race', 'active');
    await ctx.store.presentSessionPlan('s-plan-race', 'Delete fence plan');
    const base = fakeDeprovisioner();
    let turnDuringTeardown: { statusCode: number; body: unknown } | undefined;
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: {
        deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
          const res = await a.inject({
            method: 'POST',
            url: '/sessions/s-plan-race/planning',
            payload: { action: 'implement', planningRevision: 1 },
          });
          turnDuringTeardown = { statusCode: res.statusCode, body: res.json() };
          return base.deprovision(projectId);
        }),
      },
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-plan-race' });
      expect(res.statusCode).toBe(200);
      expect(turnDuringTeardown).toEqual({
        statusCode: 409,
        body: { error: 'invalid request' },
      });
      expect(dispatchTurn).not.toHaveBeenCalled();
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // Same window, from the other side: `hiddenAt` is only set after the
  // deprovision, so a spawn admitted before it would build its worktree inside
  // the clone root being purged.
  it('refuses a spawn for the project while the teardown is running', async () => {
    await ctx.store.upsertProject({
      id: 'p-spawn-race',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const base = fakeDeprovisioner();
    // The guard fires before the spawn reaches any of these; they exist only so
    // the route gets past its "multi-repo provisioning is not configured" 503.
    const p = {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
        ...(await base.deprovision(projectId)),
        state: 'active',
      })),
    };
    let spawnDuringTeardown: { statusCode: number; body: unknown } | undefined;
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: (_project: unknown, selected: Backend) => selected,
      deprovisioner: {
        deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
          const res = await a.inject({
            method: 'POST',
            url: '/sessions',
            payload: { projectId: 'p-spawn-race' },
          });
          spawnDuringTeardown = { statusCode: res.statusCode, body: res.json() };
          return base.deprovision(projectId);
        }),
      },
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-spawn-race' });
      expect(res.statusCode).toBe(200);
      expect(spawnDuringTeardown).toEqual({
        statusCode: 404,
        body: { error: 'project p-spawn-race is not in the fleet registry' },
      });
      expect(p.provision).not.toHaveBeenCalled();
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // The guard only turns NEW spawns away. One already past it is creating a
  // worktree inside the clone root `purge: true` is about to remove, and the
  // store lock that keeps its session row out covers the row, not the
  // filesystem — so the teardown waits for it.
  it('waits for a spawn admitted just before it', async () => {
    await ctx.store.upsertProject({
      id: 'p-spawn-wait',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const order: string[] = [];
    let inWorktreeAdd: () => void = () => undefined;
    let releaseWorktreeAdd: () => void = () => undefined;
    const spawnParked = new Promise<void>((resolve) => {
      inWorktreeAdd = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWorktreeAdd = resolve;
    });
    const projectWorktrees = {
      add: vi.fn(async () => {
        inWorktreeAdd();
        await gate;
        order.push('worktree-added');
        return '/data/dev/heey-global-verity/.verity-sessions/agent-waited';
      }),
      remove: vi.fn(async () => undefined),
    };
    const base = fakeDeprovisioner();
    const d = {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        order.push('deprovisioned');
        return base.deprovision(projectId);
      }),
    };
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: d,
      provisioner: {
        provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
          ...(await base.deprovision(projectId)),
          state: 'active',
        })),
      },
      projectCloneRoot: '/data/dev/',
      projectBackend: (_project: unknown, selected: Backend) => selected,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/waited'), remove: vi.fn(async () => undefined) },
    });
    try {
      const spawn = a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-spawn-wait' },
      });
      await spawnParked;
      const del = a.inject({ method: 'DELETE', url: '/projects/p-spawn-wait' });
      // Give the delete every chance to run ahead of the parked spawn.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(d.deprovision).not.toHaveBeenCalled();
      releaseWorktreeAdd();
      const [spawned, deleted] = await Promise.all([spawn, del]);
      expect(spawned.statusCode).toBe(201);
      expect(deleted.statusCode).toBe(200);
      // The worktree existed before the purge could remove the clone root, and
      // the session it belongs to is reaped with the project.
      expect(order).toEqual(['worktree-added', 'deprovisioned']);
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // The wait above is bounded, and what it is waiting for is an HTTP handler
  // creating a worktree — so blowing the budget means something is wedged. The
  // purge must not go ahead then: unlike a session that will not quiesce, a
  // spawn writing into the clone root has no backstop that stops it.
  it('gives up instead of purging under a spawn that will not settle', async () => {
    await ctx.store.upsertProject({
      id: 'p-spawn-wedged',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    let inWorktreeAdd: () => void = () => undefined;
    let releaseWorktreeAdd: () => void = () => undefined;
    const spawnParked = new Promise<void>((resolve) => {
      inWorktreeAdd = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWorktreeAdd = resolve;
    });
    const base = fakeDeprovisioner();
    const d = fakeDeprovisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: d,
      provisioner: {
        provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
          ...(await base.deprovision(projectId)),
          state: 'active',
        })),
      },
      projectCloneRoot: '/data/dev/',
      projectBackend: (_project: unknown, selected: Backend) => selected,
      projectWorktrees: () => ({
        add: vi.fn(async () => {
          inWorktreeAdd();
          await gate;
          return '/data/dev/heey-global-verity/.verity-sessions/agent-wedged';
        }),
        remove: vi.fn(async () => undefined),
      }),
      worktrees: { add: vi.fn(async () => '/wt/wedged'), remove: vi.fn(async () => undefined) },
      projectDeleteSpawnWaitMs: 20,
    });
    try {
      const spawn = a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-spawn-wedged' },
      });
      await spawnParked;
      const deleted = await a.inject({ method: 'DELETE', url: '/projects/p-spawn-wedged' });
      expect(deleted.statusCode).toBe(409);
      expect(deleted.json()).toEqual({
        error: 'project p-spawn-wedged still has a session spawn in flight; try again',
      });
      // Nothing was torn down, so the project is simply still there — the
      // operator can delete it again once the spawn has landed.
      expect(d.deprovision).not.toHaveBeenCalled();
      expect((await ctx.store.getProject('p-spawn-wedged'))?.hiddenAt).toBeNull();
      releaseWorktreeAdd();
      expect((await spawn).statusCode).toBe(201);
    } finally {
      releaseWorktreeAdd();
      await a.close();
    }
  });

  // Provisioning outlives the request that starts it (`202` + a background
  // clone and build), and the delete deliberately does not wait for it. So the
  // provision has to check on the way out: without that, it would finish into a
  // hidden project and leave a live container behind a row nobody can see.
  it('tears down a project that finished provisioning after it was deleted', async () => {
    await ctx.store.upsertProject({
      id: 'p-late-provision',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    let releaseProvision: () => void = () => undefined;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const base = fakeDeprovisioner();
    const d = fakeDeprovisioner();
    const p = {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        await provisionGate;
        return { ...(await base.deprovision(projectId)), state: 'active' };
      }),
    };
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: d,
      provisioner: p,
      projectCloneRoot: '/data/dev/',
      projectBackend: (_project: unknown, selected: Backend) => selected,
    });
    try {
      const spawn = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-late-provision' },
      });
      expect(spawn.statusCode).toBe(202);
      expect(p.provision).toHaveBeenCalledTimes(1);
      // The delete does not wait for the clone and the image build — that would
      // hold the request open for minutes.
      const deleted = await a.inject({ method: 'DELETE', url: '/projects/p-late-provision' });
      expect(deleted.statusCode).toBe(200);
      expect(d.deprovision).toHaveBeenCalledTimes(1);
      releaseProvision();
      await vi.waitFor(() => expect(d.deprovision).toHaveBeenCalledTimes(2));
      expect(d.deprovision).toHaveBeenLastCalledWith('p-late-provision', { purge: true });
    } finally {
      releaseProvision();
      await a.close();
    }
  });

  // The compensating teardown above removes a container and a clone, so it may
  // only run on a project that was actually read as gone. A store that is
  // briefly unreachable must not look like a deleted project.
  it('keeps a freshly provisioned project when it cannot check whether it was deleted', async () => {
    await ctx.store.upsertProject({
      id: 'p-check-fails',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    let releaseProvision: () => void = () => undefined;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const base = fakeDeprovisioner();
    const d = fakeDeprovisioner();
    const p = {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        await provisionGate;
        return { ...(await base.deprovision(projectId)), state: 'active' };
      }),
    };
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: d,
      provisioner: p,
      projectCloneRoot: '/data/dev/',
      projectBackend: (_project: unknown, selected: Backend) => selected,
    });
    const getProject = vi.spyOn(ctx.store, 'getProject');
    try {
      const spawn = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-check-fails' },
      });
      expect(spawn.statusCode).toBe(202);
      getProject.mockRejectedValue(new Error('store unreachable'));
      releaseProvision();
      await vi.waitFor(() => expect(getProject).toHaveBeenCalledWith('p-check-fails'));
      // Nothing else is coming; give a wrong teardown time to happen.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(d.deprovision).not.toHaveBeenCalled();
    } finally {
      getProject.mockRestore();
      releaseProvision();
      await a.close();
    }
  });

  // Two deletes of one project would race over the same container and clone
  // root, and — because the teardown flags are keyed by project id — whichever
  // finished first would clear the other's mid-purge and reopen the window.
  it('joins a concurrent delete of the same project instead of tearing it down twice', async () => {
    await ctx.store.upsertProject({
      id: 'p-double-tap',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-double-tap',
      worktree: '/wt/double-tap',
      model: 'm',
      projectId: 'p-double-tap',
    });
    const base = fakeDeprovisioner();
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inDeprovision = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = {
      deprovision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        started();
        await gate;
        return base.deprovision(projectId);
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const first = a.inject({ method: 'DELETE', url: '/projects/p-double-tap' });
      await inDeprovision;
      // Sent while the first is parked inside its deprovision.
      const second = a.inject({ method: 'DELETE', url: '/projects/p-double-tap' });
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(one.statusCode).toBe(200);
      // The joiner replays the same answer, rather than getting a 404 for a
      // project the first request had just hidden.
      expect(two.statusCode).toBe(200);
      expect(two.json()).toEqual({ projectId: 'p-double-tap' });
      // One teardown, not two.
      expect(d.deprovision).toHaveBeenCalledTimes(1);
      expect(await ctx.store.listSessions()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  // The flags cover the teardown window only. A delete that fails leaves the
  // project visible and retryable, so its sessions have to work again.
  it('lets its sessions take turns again after a failed teardown', async () => {
    await ctx.store.upsertProject({
      id: 'p-turn-restored',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-turn-restored',
      worktree: '/wt/turn-restored',
      model: 'm',
      projectId: 'p-turn-restored',
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      deprovisioner: {
        deprovision: vi.fn(async (): Promise<ProjectRecord> => {
          throw new Error('could not revoke the project credential');
        }),
      },
    });
    try {
      expect(
        (await a.inject({ method: 'DELETE', url: '/projects/p-turn-restored' })).statusCode,
      ).toBe(500);
      const res = await a.inject({
        method: 'POST',
        url: '/sessions/s-turn-restored/turns',
        payload: { prompt: 'carry on' },
      });
      expect(res.statusCode).toBe(202);
      expect(dispatchTurn).toHaveBeenCalled();
    } finally {
      await a.close();
      await ctx.store.deleteSession('s-turn-restored');
    }
  });

  it('a session that cannot be deleted does not block the project delete', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-stuck',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-stuck',
      worktree: '/wt/stuck',
      model: 'm',
      projectId: 'p-session-stuck',
    });
    const stuckStore = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === 'deleteSession') {
          return () => Promise.reject(new Error('session store unavailable'));
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: stuckStore, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/p-session-stuck' });
      // The stray session is the symptom this reaping fixes — not a reason to
      // make the project undeletable again.
      expect(res.statusCode).toBe(200);
      expect((await ctx.store.getProject('p-session-stuck'))?.hiddenAt).toBeInstanceOf(Date);
      expect(d.deprovision).toHaveBeenCalledWith('p-session-stuck', { purge: true });
    } finally {
      await a.close();
      await ctx.store.deleteSession('s-stuck');
    }
  });

  it('does not touch the sessions when the delete is refused with 503', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-503',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-503',
      worktree: '/wt/503',
      model: 'm',
      projectId: 'p-session-503',
    });

    const res = await app.inject({ method: 'DELETE', url: '/projects/p-session-503' });

    expect(res.statusCode).toBe(503);
    expect((await ctx.store.listSessions()).map((s) => s.sessionId)).toContain('s-503');
  });

  it('a re-sync of the same repo does NOT resurrect a deleted project', async () => {
    await ctx.store.upsertProject({
      id: 'p-resurrect',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      await a.inject({ method: 'DELETE', url: '/projects/p-resurrect' });
      // Simulate the GitHub-installation sync re-upserting the still-installed
      // repo (state='absent', no restore) — the whole bug this fix addresses.
      await ctx.store.upsertProject({
        id: 'ignored-new-id',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        state: 'absent',
      });
      expect(await ctx.store.listProjects()).toHaveLength(0); // stays gone
    } finally {
      await a.close();
    }
  });

  it('404s unknown projects without cleanup', async () => {
    const d = fakeDeprovisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, deprovisioner: d });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/projects/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project missing not found' });
      expect(d.deprovision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('hides absent projects without a deprovisioner', async () => {
    await ctx.store.upsertProject({
      id: 'p-absent-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });

    const res = await app.inject({ method: 'DELETE', url: '/projects/p-absent-delete' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectId: 'p-absent-delete' });
    expect((await ctx.store.getProject('p-absent-delete'))?.hiddenAt).toBeInstanceOf(Date);
    expect(await ctx.store.listProjects()).toHaveLength(0);
  });

  it('503s active projects when no deprovisioner is configured', async () => {
    await ctx.store.upsertProject({
      id: 'p-active-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const res = await app.inject({ method: 'DELETE', url: '/projects/p-active-delete' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'multi-repo provisioning is not configured' });
    expect(await ctx.store.getProject('p-active-delete')).toBeDefined();
  });
});

describe('POST /projects/:id/repair', () => {
  function fakeProvisioner() {
    return {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
        id: projectId,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        imageRef: null,
        state: 'active',
        provisionError: null,
        provisionWarning: null,
        hiddenAt: null,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleaseUrl: null,
        latestReleasePublishedAt: null,
        createdAt: new Date('2026-06-26T00:00:00.000Z'),
        updatedAt: new Date('2026-06-26T00:00:00.000Z'),
        stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
      })),
    };
  }

  it('503s when no provisioner is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/p1/repair',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'multi-repo provisioning is not configured' });
  });

  it('404s for an unknown project id', async () => {
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/unknown/repair',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project unknown not found' });
      expect(provisioner.provision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('503s without queuing repair when the secret store is sealed', async () => {
    await ctx.store.upsertProject({
      id: 'p-repair-sealed',
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'verity-heey-global--k8s',
      state: 'failed',
    });
    const provisioner = fakeProvisioner();
    const sealed = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      secretCipher: createSealableSecretCipher(),
    });
    try {
      const res = await sealed.inject({
        method: 'POST',
        url: '/projects/p-repair-sealed/repair',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'secret store is sealed', status: 'sealed' });
      expect(provisioner.provision).not.toHaveBeenCalled();
      expect(await ctx.store.getProject('p-repair-sealed')).toMatchObject({ state: 'failed' });
    } finally {
      await sealed.close();
    }
  });

  it('queues repair provisioning and returns the cloning project immediately', async () => {
    await ctx.store.upsertProject({
      id: 'p-repair',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'failed',
    });
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/p-repair/repair',
      });
      expect(res.statusCode).toBe(202);
      expect(provisioner.provision).toHaveBeenCalledWith('p-repair', {
        confirmWarnings: false,
        initiator: { kind: 'user', userId: null },
      });
      expect(res.json()).toMatchObject({
        project: { id: 'p-repair', state: 'cloning', provisionError: null },
      });
    } finally {
      await a.close();
    }
  });

  it('404s for a soft-deleted project instead of resurrecting it', async () => {
    await ctx.store.upsertProject({
      id: 'p-repair-hidden',
      owner: 'heey-global',
      repo: 'website',
      containerName: 'verity-heey-global--website',
      state: 'failed',
    });
    await ctx.store.hideProject('p-repair-hidden');
    const provisioner = fakeProvisioner();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({ method: 'POST', url: '/projects/p-repair-hidden/repair' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project p-repair-hidden not found' });
      expect(provisioner.provision).not.toHaveBeenCalled();
      // Still hidden, still failed — repair never touched it.
      const still = await ctx.store.getProject('p-repair-hidden');
      expect(still?.hiddenAt).not.toBeNull();
      expect(still?.state).toBe('failed');
    } finally {
      await a.close();
    }
  });
});
