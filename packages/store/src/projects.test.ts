import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeletedProjectError, isLocalProject } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

/**
 * Multi-repo fleet-registry store coverage (concept §19, #174). The projects
 * table is a cache of the GitHub-App-installation repos + the Verity-side
 * `verity-<owner>--<repo>` container lifecycle state. These tests pin the schema
 * invariants (UNIQUE(owner,repo), UNIQUE(container_name), lowercase-persist,
 * nullable project_id on sessions with ON DELETE SET NULL) and the EventStore
 * API contract (upsert idempotency, state transitions, listing).
 */
describe('EventStore — projects', () => {
  const sampleProject = {
    id: () => randomUUID(),
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global-verity',
    state: 'absent' as const,
  };

  it('inserts a new project and reads it back by id and by (owner, repo)', async () => {
    const id = sampleProject.id();
    const created = await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    expect(created).toMatchObject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'absent',
      provisionError: null,
      provisionWarning: null,
      hiddenAt: null,
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const byId = await ctx.store.getProject(id);
    expect(byId?.id).toBe(id);

    const byKey = await ctx.store.getProjectByOwnerRepo('heey-global', 'verity');
    expect(byKey?.id).toBe(id);
  });

  it('upsert is idempotent on (owner, repo) and refreshes derived fields without clobbering state', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    // Provisioning worker transitions to cloning, then active.
    await ctx.store.updateProjectState(id, 'cloning');
    await ctx.store.updateProjectState(id, 'active');

    // Re-sync from GitHub happens mid-provisioning; the upsert must NOT clobber
    // the worker-owned state — only `container_name` and `image_ref` refresh.
    const afterResync = await ctx.store.upsertProject({
      id: randomUUID(), // a different id is supplied; (owner, repo) match triggers the UPDATE branch
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: 'ghcr.io/heey-global/dev-base:2026.06@sha256:abc',
      state: 'absent', // the GitHub sync always sees 'absent'; the worker's 'active' MUST survive
    });
    expect(afterResync.id).toBe(id); // the original row id is retained
    expect(afterResync.state).toBe('active'); // worker state preserved
    expect(afterResync.imageRef).toBe('ghcr.io/heey-global/dev-base:2026.06@sha256:abc'); // refreshed
  });

  it('records the effective image without replacing the configured override', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      imageRef: 'custom:configured',
      state: 'absent',
    });

    await ctx.store.recordProjectImageRef(id, 'custom:configured@sha256:resolved', null);

    const record = await ctx.store.getProject(id);
    expect(record?.imageRef).toBe('custom:configured@sha256:resolved');
    // Exposed on the record, not just stored: the toolkit drift report reads it
    // to tell an image Verity built from one the operator only pinned.
    expect(record?.imageOverrideRef).toBe('custom:configured');
    const row = await ctx.db
      .selectFrom('projects')
      .select('image_override_ref')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.image_override_ref).toBe('custom:configured');
  });

  // The image and the toolkit it was judged against are one verdict. Recording
  // the image while leaving a stale toolkit identity behind would produce a row
  // claiming a match that nothing established.
  it('records the toolkit identity alongside the image it was verified against', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    // Never provisioned: unknown, not "matches whatever runs now".
    expect((await ctx.store.getProject(id))?.toolkitIdentity).toBeNull();

    await ctx.store.recordProjectImageRef(id, 'base:1', 'sha256:toolkit-a');
    expect((await ctx.store.getProject(id))?.toolkitIdentity).toBe('sha256:toolkit-a');

    // A new image never inherits the previous image's verdict. The identity is
    // a required argument precisely so a caller that verified nothing has to say
    // so — an omission would install an unverified image under an all-clear that
    // was made about a different one.
    await ctx.store.recordProjectImageRef(id, 'base:2', null);
    expect((await ctx.store.getProject(id))?.imageRef).toBe('base:2');
    expect((await ctx.store.getProject(id))?.toolkitIdentity).toBeNull();
  });

  // An operator pin replaces the image without anything attesting the new one.
  // Leaving the old identity in place would let the new image inherit an
  // all-clear it never earned — and a sync pass with no opinion on the image
  // must not disturb a verdict that still holds.
  it('clears the toolkit identity when a pin replaces the image, and only then', async () => {
    const id = sampleProject.id();
    const base = {
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    } as const;
    await ctx.store.upsertProject(base);
    await ctx.store.recordProjectImageRef(id, 'base:1', 'sha256:toolkit-a');

    await ctx.store.upsertProject(base); // sync pass: no opinion on the image
    expect((await ctx.store.getProject(id))?.toolkitIdentity).toBe('sha256:toolkit-a');

    const pinned = await ctx.store.upsertProject({ ...base, imageRef: 'custom:pinned' });
    expect(pinned.imageRef).toBe('custom:pinned');
    expect(pinned.toolkitIdentity).toBeNull();

    // Re-pinning the same image is not a new image. A settings save that
    // changed nothing else must not throw away a verdict that still describes
    // what is running — that would report the project as unverified until its
    // next provisioning, about an image that was in fact checked and passed.
    await ctx.store.recordProjectImageRef(id, 'custom:pinned', 'sha256:toolkit-b');
    const repinned = await ctx.store.upsertProject({ ...base, imageRef: 'custom:pinned' });
    expect(repinned.toolkitIdentity).toBe('sha256:toolkit-b');
  });

  it('leaves stateChangedAt alone when a sync upsert refreshes the row', async () => {
    // The stale-provisioning sweep ages a stuck `cloning`/`container_starting`
    // row off `stateChangedAt`. The installation sync runs far more often than
    // that grace period and preserves `state`, so it must not refresh the clock
    // — otherwise a project whose container start failed never looks stale and
    // stays stranded mid-transition instead of being demoted to `failed`.
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    const starting = await ctx.store.updateProjectState(id, 'container_starting');
    expect(starting?.stateChangedAt).toBeInstanceOf(Date);

    const afterResync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });

    expect(afterResync.state).toBe('container_starting');
    expect(afterResync.stateChangedAt.getTime()).toBe(starting?.stateChangedAt.getTime());
    // `updated_at` DID move — which is exactly why the sweep cannot use it.
    expect(afterResync.updatedAt.getTime()).toBeGreaterThanOrEqual(
      afterResync.stateChangedAt.getTime(),
    );
  });

  it('moves stateChangedAt on every state write, including a repeat of the same state', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    await ctx.store.updateProjectState(id, 'container_starting');
    // An unrelated sync pass pushes `updated_at` ahead of `state_changed_at`.
    const synced = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    // A repeat write is a FRESH provisioning attempt entering that phase, so it
    // legitimately restarts the grace period — the clock has to catch back up
    // past the sync's bump rather than staying where the first write left it.
    const second = await ctx.store.updateProjectState(id, 'container_starting');

    expect(second?.stateChangedAt.getTime()).toBeGreaterThanOrEqual(synced.updatedAt.getTime());
    expect(second?.stateChangedAt.getTime()).toBe(second?.updatedAt.getTime());
  });

  it('upsert migrates legacy deterministic dev container names to canonical verity names', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global--verity',
      state: 'active',
    });

    const afterSync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-heey-global--verity',
      state: 'absent',
    });

    expect(afterSync.id).toBe(id);
    expect(afterSync.containerName).toBe('verity-heey-global--verity');
    expect(afterSync.state).toBe('active');
  });

  it('upsert migrates the older single-separator dev container name', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const afterSync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-heey-global--verity',
      state: 'absent',
    });

    expect(afterSync.containerName).toBe('verity-heey-global--verity');
  });

  it('upsert preserves a custom adopted container name across sync', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'dev-heey-k8s',
      state: 'active',
    });

    const afterSync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'dev-heey-global--k8s',
      state: 'absent',
    });

    expect(afterSync.id).toBe(id);
    expect(afterSync.containerName).toBe('dev-heey-k8s');
    expect(afterSync.state).toBe('active');
  });

  it('upsert omitting imageRef preserves an existing pin (no-op on conflict)', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: 'ghcr.io/heey-global/dev-base:2026.06@sha256:abc',
      state: 'active',
    });
    // Second sync from GitHub (slice-2 path) omits imageRef → the pin must
    // survive. NULL in the input would explicitly clear it; undefined means
    // "no opinion, leave what's there". Critical for slice-3 per-repo overrides.
    await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    expect((await ctx.store.getProject(id))?.imageRef).toBe(
      'ghcr.io/heey-global/dev-base:2026.06@sha256:abc',
    );
  });

  it('upsert with imageRef=null explicitly clears the pin (operator unpin)', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: 'ghcr.io/heey-global/dev-base:2026.06@sha256:abc',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null, // explicit clear
      state: 'absent',
    });
    expect((await ctx.store.getProject(id))?.imageRef).toBeNull();
  });

  it("UNIQUE(owner, repo) is unreachable via upsertProject (it's idempotent)", async () => {
    // upsertProject has ON CONFLICT (owner, repo) DO UPDATE, so a second upsert
    // of the same (owner, repo) just refreshes the existing row — no throw, the
    // row count stays at 1. The DB constraint is a backstop against direct
    // writers (manual ops, buggy parallel workers) bypassing upsert; that path
    // is tested below.
    const firstId = sampleProject.id();
    await ctx.store.upsertProject({
      id: firstId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    const secondResync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    expect(secondResync.id).toBe(firstId); // same row retained
    expect(await ctx.store.listProjects()).toHaveLength(1);
  });

  it('UNIQUE(owner, repo) refuses a direct second-row INSERT that bypasses upsert', async () => {
    const { sql } = await import('kysely');
    await ctx.store.upsertProject({
      id: sampleProject.id(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    // Bypassing upsert: a raw INSERT with a freshly-minted id but the same
    // (owner, repo)Tuple — the DB's unique index must reject it.
    await expect(
      sql`insert into projects (id, owner, repo, container_name, state)
          values (${randomUUID()}, 'heey-global', 'verity', 'dev-other', 'absent')`.execute(ctx.db),
    ).rejects.toThrow(/projects_owner_repo_uniq|unique/i);
  });

  it('UNIQUE(container_name) refuses two projects whose container_name collides', async () => {
    // Owner `foo` + repo `bar-baz` and owner `foo-bar` + repo `baz` both derive
    // the same hyphen-slug `dev-foo-bar-baz` if canonicalization doesn't keep
    // the separator boundary; the UNIQUE(container_name) backstop ensures the
    // DB refuses rather than letting two daemon-name-colliding rows coexist.
    await ctx.store.upsertProject({
      id: sampleProject.id(),
      owner: 'foo',
      repo: 'bar-baz',
      containerName: 'dev-foo-bar-baz',
      state: 'absent',
    });
    await expect(
      ctx.store.upsertProject({
        id: randomUUID(),
        owner: 'foo-bar',
        repo: 'baz',
        containerName: 'dev-foo-bar-baz',
        state: 'absent',
      }),
    ).rejects.toThrow(/projects_container_name_unique|unique/i);
  });

  it('updateProjectState transitions state and binds provisionError; returning row reflects it', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });

    await ctx.store.updateProjectState(id, 'cloning');
    expect((await ctx.store.getProject(id))?.state).toBe('cloning');

    await ctx.store.updateProjectState(id, 'failed', 'git clone 404');
    const failed = await ctx.store.getProject(id);
    expect(failed?.state).toBe('failed');
    expect(failed?.provisionError).toBe('git clone 404');

    // Retrying: null clears the error on the way back to cloning.
    await ctx.store.updateProjectState(id, 'cloning', null);
    const retry = await ctx.store.getProject(id);
    expect(retry?.state).toBe('cloning');
    expect(retry?.provisionError).toBeNull();
  });

  it('updateProjectState returns undefined for an unknown project id', async () => {
    const result = await ctx.store.updateProjectState(randomUUID(), 'active');
    expect(result).toBeUndefined();
  });

  it('updateProjectReleaseStatus persists the release cache without touching state', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    await ctx.store.updateProjectState(id, 'active');

    await ctx.store.updateProjectReleaseStatus(id, {
      tag: 'v1.4.0',
      name: 'Release 1.4.0',
      url: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
      publishedAt: '2026-07-01T10:00:00Z',
    });

    const project = await ctx.store.getProject(id);
    expect(project).toMatchObject({
      state: 'active', // release write left the worker-owned state untouched
      latestReleaseTag: 'v1.4.0',
      latestReleaseName: 'Release 1.4.0',
      latestReleaseUrl: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
      latestReleasePublishedAt: '2026-07-01T10:00:00Z',
    });

    // A repo whose latest release is later cleared (all null) round-trips too.
    await ctx.store.updateProjectReleaseStatus(id, {
      tag: null,
      name: null,
      url: null,
      publishedAt: null,
    });
    const cleared = await ctx.store.getProject(id);
    expect(cleared?.latestReleaseTag).toBeNull();
  });

  it('a freshly inserted project has a null release cache', async () => {
    const id = sampleProject.id();
    const created = await ctx.store.upsertProject({
      id,
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    expect(created).toMatchObject({
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
    });
  });

  it('listProjects returns rows deterministic-to-listing: re-call yields identical order', async () => {
    // The query is ORDER BY (created_at, id); even with distinct `now()` per
    // insertion, repeated listProjects calls return the SAME order (stable
    // lister across page boundaries) — pinned here without asserting a
    // specific ordering that would entangle on PGlite's now() granularity.
    const ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids) {
      await ctx.store.upsertProject({
        id,
        owner: `owner-${id.slice(0, 8)}`,
        repo: 'a-repo',
        containerName: `dev-owner-${id.slice(0, 8)}-a-repo`,
        state: 'absent',
      });
    }
    const first = await ctx.store.listProjects();
    const second = await ctx.store.listProjects();
    expect(first.map((p) => p.id)).toEqual(second.map((p) => p.id));
    expect(first).toHaveLength(3);
  });

  it('reorderProjects persists operator-defined overview order', async () => {
    const ids = ['p-order-a', 'p-order-b', 'p-order-c'];
    for (const id of ids) {
      await ctx.store.upsertProject({
        id,
        owner: `owner-${id}`,
        repo: 'repo',
        containerName: `dev-owner-${id}-repo`,
        state: 'active',
      });
    }

    await ctx.store.reorderProjects(['p-order-c', 'p-order-a', 'p-order-b']);

    expect((await ctx.store.listProjects()).map((p) => p.id)).toEqual([
      'p-order-c',
      'p-order-a',
      'p-order-b',
    ]);
  });

  it('setProjectCollapsed persists the overview fold state; defaults to false', async () => {
    await ctx.store.upsertProject({
      id: 'p-collapse',
      owner: 'owner-collapse',
      repo: 'repo',
      containerName: 'dev-owner-collapse-repo',
      state: 'active',
    });

    const [fresh] = await ctx.store.listProjects();
    expect(fresh?.collapsed).toBe(false);

    const updated = await ctx.store.setProjectCollapsed('p-collapse', true);
    expect(updated).toBe(true);
    expect((await ctx.store.listProjects())[0]?.collapsed).toBe(true);

    await ctx.store.setProjectCollapsed('p-collapse', false);
    expect((await ctx.store.listProjects())[0]?.collapsed).toBe(false);
  });

  it('setProjectCollapsed returns false for an unknown project', async () => {
    expect(await ctx.store.setProjectCollapsed('missing', true)).toBe(false);
  });

  it('persists the guided setup status across reads', async () => {
    const created = await ctx.store.upsertProject({
      id: 'p-setup',
      owner: 'setup-owner',
      repo: 'repo',
      containerName: 'verity-setup-owner--repo',
      state: 'active',
    });
    expect(created.setupStatus).toBe('complete');

    expect((await ctx.store.setProjectSetupStatus('p-setup', 'pending'))?.setupStatus).toBe(
      'pending',
    );
    expect((await ctx.store.getProject('p-setup'))?.setupStatus).toBe('pending');
    expect((await ctx.store.setProjectSetupStatus('p-setup', 'secrets_skipped'))?.setupStatus).toBe(
      'secrets_skipped',
    );
  });

  it('includes interrupted pending projects in overview reordering', async () => {
    for (const [id, state] of [
      ['p-active', 'active'],
      ['p-pending', 'absent'],
    ] as const) {
      await ctx.store.upsertProject({
        id,
        owner: id,
        repo: 'repo',
        containerName: `verity-${id}--repo`,
        state,
      });
    }
    await ctx.store.setProjectSetupStatus('p-pending', 'pending');

    expect((await ctx.store.reorderProjects(['p-pending', 'p-active'])).map((p) => p.id)).toEqual([
      'p-pending',
      'p-active',
    ]);
  });

  it('reorderProjects rejects duplicate ids', async () => {
    await expect(ctx.store.reorderProjects(['p1', 'p1'])).rejects.toThrow(/duplicate/i);
  });

  it('reorderProjects rejects partial visible project lists', async () => {
    for (const id of ['p-order-visible-a', 'p-order-visible-b']) {
      await ctx.store.upsertProject({
        id,
        owner: `owner-${id}`,
        repo: 'repo',
        containerName: `dev-owner-${id}-repo`,
        state: 'active',
      });
    }
    await ctx.store.upsertProject({
      id: 'p-order-picker-only',
      owner: 'owner-picker-only',
      repo: 'repo',
      containerName: 'dev-owner-picker-only-repo',
      state: 'absent',
    });

    await expect(ctx.store.reorderProjects(['p-order-visible-b'])).rejects.toThrow(
      /every visible project/i,
    );
    await expect(
      ctx.store.reorderProjects(['p-order-visible-b', 'p-order-visible-a']),
    ).resolves.toHaveLength(3);
  });

  it('createSession writes project_id; getSession/listSessions round-trip it', async () => {
    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const sessionId = randomUUID();
    await ctx.store.createSession({
      sessionId,
      worktree: '/wt/agent-' + sessionId.slice(0, 8),
      model: 'claude-sonnet-4-6',
      projectId,
    });

    expect((await ctx.store.getSession(sessionId))?.projectId).toBe(projectId);
    const all = await ctx.store.listSessions();
    expect(all.find((s) => s.sessionId === sessionId)?.projectId).toBe(projectId);
  });

  it('createSession without projectId leaves it NULL (migration-safe pre-existing sessions)', async () => {
    const sessionId = randomUUID();
    await ctx.store.createSession({
      sessionId,
      worktree: '/wt/no-project-' + sessionId.slice(0, 8),
      model: 'claude-sonnet-4-6',
    });
    expect((await ctx.store.getSession(sessionId))?.projectId).toBeNull();
  });

  it('setSessionProject binds a session to a project after creation; null clears it', async () => {
    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const sessionId = randomUUID();
    await ctx.store.createSession({
      sessionId,
      worktree: '/wt/later-bound-' + sessionId.slice(0, 8),
      model: 'claude-sonnet-4-6',
    });
    expect((await ctx.store.getSession(sessionId))?.projectId).toBeNull();

    const ok = await ctx.store.setSessionProject(sessionId, projectId);
    expect(ok).toBe(true);
    expect((await ctx.store.getSession(sessionId))?.projectId).toBe(projectId);

    const cleared = await ctx.store.setSessionProject(sessionId, null);
    expect(cleared).toBe(true);
    expect((await ctx.store.getSession(sessionId))?.projectId).toBeNull();
  });

  it('setSessionProject returns false for an unknown session', async () => {
    const ok = await ctx.store.setSessionProject(randomUUID(), null);
    expect(ok).toBe(false);
  });

  it('setSessionProject refuses a soft-deleted project', async () => {
    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'hidden-binding',
      containerName: 'dev-heey-global-hidden-binding',
      state: 'active',
    });
    const sessionId = randomUUID();
    await ctx.store.createSession({
      sessionId,
      worktree: `/wt/${sessionId}`,
      model: 'claude-sonnet-4-6',
    });
    await ctx.store.hideProject(projectId);

    await expect(ctx.store.setSessionProject(sessionId, projectId)).rejects.toBeInstanceOf(
      DeletedProjectError,
    );
    expect((await ctx.store.getSession(sessionId))?.projectId).toBeNull();
  });

  it('stores global Verity git identity and signing paths', async () => {
    const created = await ctx.store.updateVeritySettings({
      gitUserName: ' h-teske ',
      gitUserEmail: ' developer@example.com ',
      gitSshPrivateKeyPath: ' /data/dev/.shared/github/id_ed25519 ',
      gitSshPrivateKey: ' private-key ',
      gitSshPublicKeyPath: ' /data/dev/.shared/github/id_ed25519.pub ',
      gitSshPublicKey: ' public-key ',
      gitKnownHostsPath: ' /data/dev/.shared/github/known_hosts ',
      gitKnownHosts: ' github.com ssh-ed25519 AAA ',
      gitAllowedSignersPath: ' /data/dev/.shared/github/allowed_signers ',
      gitAllowedSigners: ' *@heey.global key ',
    });

    expect(created).toMatchObject({
      gitUserName: 'h-teske',
      gitUserEmail: 'developer@example.com',
      gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
      gitSshPrivateKey: 'private-key',
      gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
      gitSshPublicKey: 'public-key',
      gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
      gitKnownHosts: 'github.com ssh-ed25519 AAA',
      gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
      gitAllowedSigners: '*@heey.global key',
    });

    const updated = await ctx.store.updateVeritySettings({
      gitUserName: 'Holger',
      gitKnownHostsPath: '',
      gitKnownHosts: '',
    });

    expect(updated).toMatchObject({
      gitUserName: 'Holger',
      gitUserEmail: 'developer@example.com',
      gitKnownHostsPath: null,
      gitKnownHosts: null,
      gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
      gitAllowedSigners: '*@heey.global key',
    });
    await expect(ctx.store.getVeritySettings()).resolves.toMatchObject(updated);
  });

  it('stores project settings, trims blank values to null, and preserves omitted fields', async () => {
    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    const created = await ctx.store.updateProjectSettings(projectId, {
      dopplerTokenRef: '  doppler://verity/prod  ',
      dopplerToken: ' doppler-token-fixture ',
      defaultBranch: ' main ',
      defaultModel: 'claude-sonnet-4-6',
    });

    expect(created).toMatchObject({
      projectId,
      dopplerTokenRef: 'doppler://verity/prod',
      dopplerToken: 'doppler-token-fixture',
      defaultBranch: 'main',
      defaultModel: 'claude-sonnet-4-6',
    });
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);

    const updated = await ctx.store.updateProjectSettings(projectId, { defaultModel: null });
    expect(updated).toMatchObject({
      dopplerTokenRef: 'doppler://verity/prod',
      dopplerToken: 'doppler-token-fixture',
      defaultBranch: 'main',
      defaultModel: null,
    });
    expect(await ctx.store.getProjectSettings(projectId)).toMatchObject({
      projectId,
      defaultModel: null,
    });
  });

  it('project settings return undefined for an unknown project and cascade when the project is deleted', async () => {
    expect(
      await ctx.store.updateProjectSettings(randomUUID(), { defaultBranch: 'main' }),
    ).toBeUndefined();

    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.updateProjectSettings(projectId, { defaultBranch: 'main' });

    const { sql } = await import('kysely');
    await sql`delete from projects where id = ${projectId}`.execute(ctx.db);

    expect(await ctx.store.getProjectSettings(projectId)).toBeUndefined();
  });

  it('persists owner/repo/container_name lowercased, regardless of input case', async () => {
    const id = sampleProject.id();
    const created = await ctx.store.upsertProject({
      id,
      owner: 'Heey-Global',
      repo: 'VERITY',
      containerName: 'dev-Heey-Global-VERITY',
      state: 'absent',
    });
    expect(created.owner).toBe('heey-global');
    expect(created.repo).toBe('verity');
    expect(created.containerName).toBe('dev-heey-global-verity');

    // Lookup with mixed-case input resolves to the same row (lookup form is
    // lowercase-normalised too, mirroring persistence).
    const byKey = await ctx.store.getProjectByOwnerRepo('HEEY-GLOBAL', 'Verity');
    expect(byKey?.id).toBe(id);
  });

  it('CHECK constraint refuses a raw INSERT with non-lowercased owner/repo', async () => {
    const { sql } = await import('kysely');
    await expect(
      sql`insert into projects (id, owner, repo, container_name, state)
          values (${randomUUID()}, 'Heey-Global', 'verity', 'dev-x', 'absent')`.execute(ctx.db),
    ).rejects.toThrow(/projects_lowercase_check|check/i);
  });

  it('deleteProject deletes settings and leaves bound sessions intact (SET NULL)', async () => {
    const projectId = sampleProject.id();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.updateProjectSettings(projectId, { defaultBranch: 'main' });
    const sessionId = randomUUID();
    await ctx.store.createSession({
      sessionId,
      worktree: '/wt/survives-' + sessionId.slice(0, 8),
      model: 'claude-sonnet-4-6',
      projectId,
    });

    await expect(ctx.store.deleteProject(projectId)).resolves.toBe(true);

    expect(await ctx.store.getProject(projectId)).toBeUndefined();
    expect(await ctx.store.getProjectSettings(projectId)).toBeUndefined();
    const session = await ctx.store.getSession(sessionId);
    expect(session).toBeDefined(); // session survived
    expect(session?.projectId).toBeNull();
    await expect(ctx.store.deleteProject(projectId)).resolves.toBe(false);
  });

  it('hideProject soft-deletes: excluded from listProjects but still found by id', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });

    await expect(ctx.store.hideProject(id)).resolves.toBe(true);

    // Gone from the picker's list…
    expect(await ctx.store.listProjects()).toHaveLength(0);
    // …but the row survives (stable id/settings) and is markable as hidden.
    const hidden = await ctx.store.getProject(id);
    expect(hidden?.id).toBe(id);
    expect(hidden?.hiddenAt).toBeInstanceOf(Date);
    // includeHidden surfaces it for the bootstrap "is the registry empty?" check.
    expect(await ctx.store.listProjects({ includeHidden: true })).toHaveLength(1);
  });

  it('hideProject returns false for an unknown project id', async () => {
    await expect(ctx.store.hideProject(randomUUID())).resolves.toBe(false);
  });

  // Deleting a project reaps its sessions. A spawn that was already provisioning
  // when the delete ran would insert its session afterwards and outlive the
  // project — reappearing in the overview as an "Inactive project" orphan — so
  // the insert refuses a hidden project outright.
  it('createSession refuses a project that has been soft-deleted', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.hideProject(id);

    await expect(
      ctx.store.createSession({
        sessionId: 's-late',
        worktree: '/wt/late',
        model: 'm',
        projectId: id,
      }),
    ).rejects.toBeInstanceOf(DeletedProjectError);
    expect(await ctx.store.getSession('s-late')).toBeUndefined();

    // A live project is unaffected, and so is a session with no project at all.
    await ctx.store.upsertProject({
      id: 'p-live',
      owner: 'heey-global',
      repo: 'other',
      containerName: 'dev-heey-global-other',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-live',
      worktree: '/wt/live',
      model: 'm',
      projectId: 'p-live',
    });
    await ctx.store.createSession({ sessionId: 's-free', worktree: '/wt/free', model: 'm' });
    expect(await ctx.store.getSession('s-live')).toBeDefined();
    expect(await ctx.store.getSession('s-free')).toBeDefined();
  });

  it('installation-sync upsert (no restore) does NOT resurrect a hidden project', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.hideProject(id);

    // The GitHub-installation sync re-upserts every installation repo on each
    // GET /projects with state='absent' and no `restore` — a hidden project
    // must stay hidden (this is the whole point of the soft-delete marker).
    const afterSync = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    expect(afterSync.id).toBe(id);
    expect(afterSync.hiddenAt).toBeInstanceOf(Date); // still hidden
    expect(await ctx.store.listProjects()).toHaveLength(0); // stays out of the picker
  });

  it('upsert with restore un-hides a previously soft-deleted project (POST /projects re-add)', async () => {
    const id = sampleProject.id();
    await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.hideProject(id);

    const restored = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
      restore: true,
    });
    expect(restored.id).toBe(id); // same row
    expect(restored.hiddenAt).toBeNull(); // un-hidden
    expect(await ctx.store.listProjects()).toHaveLength(1); // back in the picker
  });

  it('tracks whether an absent project belongs in the overview', async () => {
    const id = sampleProject.id();
    const pickerOnly = await ctx.store.upsertProject({
      id,
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    expect(pickerOnly.overviewVisible).toBe(false);

    const visible = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
      restore: true,
      overviewVisible: true,
    });
    expect(visible.id).toBe(id);
    expect(visible.overviewVisible).toBe(true);

    const synced = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    expect(synced.overviewVisible).toBe(true);
  });

  it('records an explicit clone directory for a project created without GitHub', async () => {
    const id = randomUUID();
    const created = await ctx.store.upsertProject({
      id,
      owner: 'local',
      repo: 'my-project',
      containerName: 'verity-local--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
      state: 'absent',
    });
    expect(created.kind).toBe('local');
    expect(created.cloneDir).toBe('local-my-project');
    expect(isLocalProject(created)).toBe(true);
  });

  it('derives the clone directory (null) for an ordinary GitHub project', async () => {
    const created = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: sampleProject.owner,
      repo: sampleProject.repo,
      containerName: sampleProject.containerName,
      state: 'absent',
    });
    expect(created.cloneDir).toBeNull();
    expect(isLocalProject(created)).toBe(false);
  });

  it('never rewrites an existing row\u2019s clone directory on re-upsert', async () => {
    const id = randomUUID();
    await ctx.store.upsertProject({
      id,
      owner: 'local',
      repo: 'my-project',
      containerName: 'verity-local--my-project',
      kind: 'local',
      cloneDir: 'local-my-project',
      state: 'absent',
    });
    const again = await ctx.store.upsertProject({
      id: randomUUID(),
      owner: 'local',
      repo: 'my-project',
      containerName: 'verity-local--my-project',
      cloneDir: 'somewhere-else',
      state: 'absent',
    });
    expect(again.id).toBe(id);
    expect(again.cloneDir).toBe('local-my-project');
  });

  describe('linkProjectToGitHub', () => {
    const createLocal = async (): Promise<string> => {
      const id = randomUUID();
      await ctx.store.upsertProject({
        id,
        owner: 'local',
        repo: 'my-project',
        containerName: 'verity-local--my-project',
        kind: 'local',
        cloneDir: 'local-my-project',
        state: 'active',
      });
      return id;
    };

    it('rewrites owner/repo/kind while pinning the clone directory in place', async () => {
      const id = await createLocal();
      const linked = await ctx.store.linkProjectToGitHub(id, {
        owner: 'heey-global',
        repo: 'verity',
      });
      expect(linked).toMatchObject({
        id,
        owner: 'heey-global',
        repo: 'verity',
        kind: 'github',
        // Unchanged: session worktree paths are persisted under this directory.
        cloneDir: 'local-my-project',
        // Unchanged: the container keeps its name so nothing else has to be renamed.
        containerName: 'verity-local--my-project',
        state: 'active',
      });
      expect(isLocalProject(linked!)).toBe(false);
    });

    it('lowercases the link target', async () => {
      const id = await createLocal();
      const linked = await ctx.store.linkProjectToGitHub(id, {
        owner: 'Heey-Global',
        repo: 'Verity',
      });
      expect(linked).toMatchObject({ owner: 'heey-global', repo: 'verity' });
    });

    it('lets only the first link request reserve a local project identity', async () => {
      const id = await createLocal();
      const first = await ctx.store.linkProjectToGitHub(id, {
        owner: 'heey-global',
        repo: 'verity',
      });
      const second = await ctx.store.linkProjectToGitHub(id, {
        owner: 'heey-global',
        repo: 'other',
      });
      expect(first?.kind).toBe('github');
      expect(second).toBeUndefined();
      expect(await ctx.store.getProject(id)).toMatchObject({
        owner: 'heey-global',
        repo: 'verity',
      });
    });

    it('blocks installation upserts while a local project reserves the GitHub target', async () => {
      const id = await createLocal();
      await expect(
        ctx.store.reserveProjectIdentity(id, { owner: 'heey-global', repo: 'verity' }),
      ).resolves.toBe(true);
      // Re-acquiring after a process restart is idempotent for the same project.
      await expect(
        ctx.store.reserveProjectIdentity(id, { owner: 'heey-global', repo: 'verity' }),
      ).resolves.toBe(true);
      await expect(
        ctx.store.upsertProject({
          id: randomUUID(),
          owner: 'heey-global',
          repo: 'verity',
          containerName: 'verity-heey-global--verity',
          state: 'absent',
        }),
      ).rejects.toMatchObject({ code: '23505' });
      await ctx.store.releaseProjectIdentity(id, { owner: 'heey-global', repo: 'verity' });
      await expect(
        ctx.store.upsertProject({
          id: randomUUID(),
          owner: 'heey-global',
          repo: 'verity',
          containerName: 'verity-heey-global--verity',
          state: 'absent',
        }),
      ).resolves.toMatchObject({ owner: 'heey-global', repo: 'verity' });
    });

    it('pins a previously-derived clone directory rather than letting it move', async () => {
      const id = randomUUID();
      await ctx.store.upsertProject({
        id,
        owner: 'local',
        repo: 'legacy',
        containerName: 'verity-local--legacy',
        kind: 'local',
        state: 'absent',
      });
      const linked = await ctx.store.linkProjectToGitHub(id, {
        owner: 'heey-global',
        repo: 'verity',
      });
      expect(linked?.cloneDir).toBe('local-legacy');
    });

    it('returns undefined for an unknown project', async () => {
      const missing = randomUUID();
      await expect(
        ctx.store.linkProjectToGitHub(missing, { owner: 'heey-global', repo: 'verity' }),
      ).resolves.toBeUndefined();
      await expect(
        ctx.store.reserveProjectIdentity(randomUUID(), {
          owner: 'heey-global',
          repo: 'verity',
        }),
      ).resolves.toBe(false);
    });

    it('surfaces a conflict when another project already owns the target pair', async () => {
      await ctx.store.upsertProject({
        id: randomUUID(),
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        // `active` rather than `absent`: an absent GitHub row with no sessions is
        // an installation-sync placeholder, which links now adopt instead of
        // colliding with (see the adoption tests below).
        state: 'active',
      });
      const id = await createLocal();
      await expect(
        ctx.store.linkProjectToGitHub(id, { owner: 'heey-global', repo: 'verity' }),
      ).rejects.toThrow();
    });

    // The installation sync mints a row for every repository the GitHub App can
    // see, which is exactly the set of repositories a link can push to. Without
    // adoption, Verity's own bookkeeping makes linking permanently impossible.
    it('adopts the installation-sync placeholder holding the target identity', async () => {
      const placeholder = randomUUID();
      await ctx.store.upsertProject({
        id: placeholder,
        owner: 'heey-global',
        repo: 'immobilien',
        containerName: 'verity-heey-global--immobilien',
        state: 'absent',
      });
      const id = await createLocal();

      await expect(
        ctx.store.reserveProjectIdentity(id, { owner: 'heey-global', repo: 'immobilien' }),
      ).resolves.toBe(true);
      await expect(
        ctx.store.createSession({
          sessionId: randomUUID(),
          worktree: `/wt/reserved-${randomUUID()}`,
          model: 'claude-sonnet-4-6',
          projectId: placeholder,
        }),
      ).rejects.toThrow();
      const linked = await ctx.store.linkProjectToGitHub(id, {
        owner: 'heey-global',
        repo: 'immobilien',
      });

      expect(linked).toMatchObject({ owner: 'heey-global', repo: 'immobilien', kind: 'github' });
      // The placeholder is gone rather than lingering as a second row for the
      // same repository — a re-sync re-finds this project by (owner, repo).
      expect(await ctx.store.getProject(placeholder)).toBeUndefined();
      const forRepo = (await ctx.store.listProjects({ includeHidden: true })).filter(
        (p) => p.owner === 'heey-global' && p.repo === 'immobilien',
      );
      expect(forRepo.map((p) => p.id)).toEqual([id]);
    });

    // Sessions are `ON DELETE SET NULL`, so adopting a project that was actually
    // worked in would silently orphan its transcripts instead of failing.
    it('refuses to adopt an absent project that still has sessions', async () => {
      const worked = randomUUID();
      await ctx.store.upsertProject({
        id: worked,
        owner: 'example-org',
        repo: 'sample-app',
        containerName: 'verity-example-org--sample-app',
        state: 'absent',
      });
      const sessionId = randomUUID();
      await ctx.store.createSession({
        sessionId,
        worktree: '/wt/adopt-' + sessionId.slice(0, 8),
        model: 'claude-sonnet-4-6',
        projectId: worked,
      });
      const id = await createLocal();

      await expect(
        ctx.store.reserveProjectIdentity(id, { owner: 'example-org', repo: 'sample-app' }),
      ).resolves.toBe(false);
      await expect(
        ctx.store.linkProjectToGitHub(id, { owner: 'example-org', repo: 'sample-app' }),
      ).rejects.toThrow();
      expect(await ctx.store.getProject(worked)).toBeDefined();
      expect((await ctx.store.getSession(sessionId))?.projectId).toBe(worked);
    });

    it('refuses to adopt an explicitly added project even when it is absent', async () => {
      const added = randomUUID();
      await ctx.store.upsertProject({
        id: added,
        owner: 'heey-global',
        repo: 'paused-project',
        containerName: 'verity-heey-global--paused-project',
        state: 'absent',
        overviewVisible: true,
      });
      const id = await createLocal();

      await expect(
        ctx.store.reserveProjectIdentity(id, {
          owner: 'heey-global',
          repo: 'paused-project',
        }),
      ).resolves.toBe(false);
      expect(await ctx.store.getProject(added)).toBeDefined();
    });

    it('refuses to adopt a sync placeholder with dependent configuration', async () => {
      const configured = randomUUID();
      await ctx.store.upsertProject({
        id: configured,
        owner: 'heey-global',
        repo: 'configured-placeholder',
        containerName: 'verity-heey-global--configured-placeholder',
        state: 'absent',
      });
      await ctx.store.updateProjectSettings(configured, { defaultBranch: 'develop' });
      const id = await createLocal();

      await expect(
        ctx.store.reserveProjectIdentity(id, {
          owner: 'heey-global',
          repo: 'configured-placeholder',
        }),
      ).resolves.toBe(false);
      expect(await ctx.store.getProjectSettings(configured)).toMatchObject({
        defaultBranch: 'develop',
      });
    });

    // A hidden placeholder is the reported trap: the UI's delete is a soft
    // delete that keeps both the row and its identity claim, so before adoption
    // "delete it and try again" could never clear the way.
    it('adopts a placeholder the operator soft-deleted', async () => {
      const placeholder = randomUUID();
      await ctx.store.upsertProject({
        id: placeholder,
        owner: 'heey-global',
        repo: 'immobilien',
        containerName: 'verity-heey-global--immobilien',
        state: 'absent',
      });
      await ctx.store.hideProject(placeholder);
      const id = await createLocal();

      await expect(
        ctx.store.reserveProjectIdentity(id, { owner: 'heey-global', repo: 'immobilien' }),
      ).resolves.toBe(true);
      await expect(
        ctx.store.linkProjectToGitHub(id, { owner: 'heey-global', repo: 'immobilien' }),
      ).resolves.toMatchObject({ owner: 'heey-global', repo: 'immobilien' });
      expect(await ctx.store.getProject(placeholder)).toBeUndefined();
    });
  });
});
