import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectChangeFeed, type ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxUpdateChecker, SandboxUpdateStatus } from '../sandbox-updates.js';
import type { ServerContext } from '../server-context.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';
import { installProjectEvents } from './project-events.js';

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    state: 'cloning',
    provisionError: null,
    provisionWarning: null,
    setupStatus: null,
    imageRef: null,
    toolkitIdentity: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    hiddenAt: null,
    ...overrides,
  } as ProjectRecord;
}

/** What the first sight of the fixture project states besides its name. */
const FIRST_SIGHT = {
  latestReleaseTag: null,
  latestReleaseName: null,
  latestReleaseUrl: null,
  latestReleasePublishedAt: null,
  toolkitDrift: null,
};

function status(state: SandboxUpdateStatus['state']): SandboxUpdateStatus {
  return { state } as SandboxUpdateStatus;
}

function setup() {
  const projectChanges = new ProjectChangeFeed();
  const rows = new Map<string, ProjectRecord>([
    ['p1', projectRecord()],
    ['p2', projectRecord({ id: 'p2', name: 'P2', state: 'active' })],
  ]);
  const observers = new Set<(projectId: string, status: SandboxUpdateStatus) => void>();
  let nextStatus = status('current');
  // Like the real checker, which inspects the running container: a sandbox
  // that is not running cannot be judged.
  const statusCalls = vi.fn(async (project: ProjectRecord) => {
    const reported = project.state === 'active' ? nextStatus : status('unknown');
    for (const observer of observers) observer(project.id, reported);
    return reported;
  });
  const sandboxUpdates: SandboxUpdateChecker = {
    status: statusCalls,
    statusAll: async () => new Map(),
    observe: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
  let identity: string | Error | undefined | Promise<string> = 'toolkit-a';
  const domainEvents = new DomainEventBus();
  const closers: (() => unknown)[] = [];
  const ticks: (() => void)[] = [];
  const getProject = vi.fn(async (id: string) => rows.get(id));
  const readers = new Map<string, Set<string>>([['p1', new Set(['bob'])]]);
  const authorizationChanged = vi.fn();
  const overviewScope = vi.fn(async () => ({ all: true as const }));
  let permission: ((userId: string, projectId: string) => Promise<boolean>) | undefined;
  const failures = new Map<string, { at: number; message: string }>();
  const turnBlocked = new Set<string>();
  const ctx = {
    deps: {
      eventStore: {
        projectChanges,
        getProject,
        hasProjectPermission: async (userId: string, projectId: string) =>
          permission?.(userId, projectId) ?? readers.get(projectId)?.has(userId) === true,
        listReadableProjectIds: async (userId: string) =>
          [...readers].filter(([, users]) => users.has(userId)).map(([id]) => id),
      },
      sandboxUpdates,
      provisioner: {
        sandboxRepairLastFailures: vi.fn(() => failures),
        turnBlockedSandboxes: () => turnBlocked,
      },
      toolkitIdentity: async () => {
        if (identity instanceof Error) throw identity;
        return identity;
      },
    },
    domainEvents,
    liveHub: { authorizationChanged, overviewScope },
    lifecycle: {
      onClose: (stop: () => unknown) => closers.push(stop),
      every: (_ms: number, tick: () => void) => ticks.push(tick),
    },
  } as unknown as ServerContext;
  installProjectEvents({ log: { warn: () => undefined } }, ctx);
  const published: DomainRecord[] = [];
  const watchedRecords: DomainRecord[] = [];
  domainEvents.subscribe('project:p1', undefined, (record) => published.push(record));
  const listing: DomainRecord[] = [];
  domainEvents.subscribe('collection:projects', undefined, (record) => listing.push(record));
  const write = (overrides: Partial<ProjectRecord>) => {
    rows.set('p1', { ...rows.get('p1')!, ...overrides });
    projectChanges.announce('p1');
  };
  const events = () => published.map((record) => record.event);
  return {
    listing: () => listing.map((record) => record.event),
    projectChanges,
    readers,
    authorizationChanged,
    overviewScope,
    setPermission: (next: typeof permission) => {
      permission = next;
    },
    remove: () => {
      rows.delete('p1');
      projectChanges.announce('p1');
    },
    write,
    events,
    statusCalls,
    observers,
    closers,
    setStatus: (next: SandboxUpdateStatus) => (nextStatus = next),
    setIdentity: (next: string | Error | undefined | Promise<string>) => {
      identity = next;
    },
    failures,
    turnBlocked,
    getProject,
    provisionerReads: () =>
      (ctx.deps.provisioner!.sandboxRepairLastFailures as ReturnType<typeof vi.fn>).mock.calls
        .length,
    tick: () => ticks.forEach((tick) => tick()),
    /** Everything but the update state, which these tests do not look at. */
    others: () => published.map((record) => record.event).filter((e) => e.t !== 'sandbox.update'),
    updates: () => published.map((record) => record.event).filter((e) => e.t === 'sandbox.update'),
    updatesOf: (projectId: string) =>
      watchedRecords
        .map((record) => record.event)
        .filter((e) => e.t === 'sandbox.update' && e.projectId === projectId),
    watch: (projectId: string) =>
      domainEvents.subscribe(`project:${projectId}`, undefined, (record) =>
        watchedRecords.push(record),
      ),
  };
}

describe('installProjectEvents', () => {
  it('publishes each lifecycle change once, with sleep states as the routes show them', async () => {
    const w = setup();
    w.write({ state: 'container_starting' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    // Same state written again (a heartbeat-like rewrite): nothing new.
    w.write({ state: 'container_starting' });
    w.write({ state: 'sleeping' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()).toEqual([
      expect.objectContaining({ t: 'sandbox.lifecycle', state: 'container_starting' }),
      // First sight of the project also states its overview fields.
      expect.objectContaining({ t: 'project.changed', patch: { name: 'P1', ...FIRST_SIGHT } }),
      expect.objectContaining({
        t: 'sandbox.lifecycle',
        state: 'active',
        lifecycleState: 'sleeping',
      }),
    ]);
    const revs = w.events().map((event) => event.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    // Neither a starting nor a sleeping sandbox can be judged: no Docker
    // inspect is spent on asking.
    expect(w.statusCalls).not.toHaveBeenCalled();
  });

  it('publishes a failure whose message changed while the state stayed failed', async () => {
    const w = setup();
    w.write({ state: 'failed', provisionError: 'clone failed' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({ state: 'failed', provisionError: 'container stopped' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
  });

  // Home lists a project created, restored or hidden on another device only
  // through these; without them it waits for its next full read.
  it('announces a project entering and leaving the overview on the collection', async () => {
    const w = setup();
    w.write({});
    await vi.waitFor(() =>
      expect(w.listing()).toEqual([
        expect.objectContaining({ t: 'project.listed', projectId: 'p1' }),
      ]),
    );
    // Unchanged visibility announces nothing more.
    w.write({ name: 'Renamed' });
    await vi.waitFor(() => expect(w.events().at(-1)).toMatchObject({ patch: { name: 'Renamed' } }));
    expect(w.listing()).toHaveLength(1);
    w.write({ hiddenAt: new Date('2026-11-27T10:00:00Z') });
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toEqual(
        expect.objectContaining({ t: 'project.unlisted', projectId: 'p1' }),
      ),
    );
    expect(w.listing().at(-1)).not.toHaveProperty('gone');
    w.write({ hiddenAt: null });
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toEqual(expect.objectContaining({ t: 'project.listed' })),
    );
    w.remove();
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toEqual(
        expect.objectContaining({ t: 'project.unlisted', projectId: 'p1', gone: true }),
      ),
    );
  });

  // A repository the installation sync adds stays `absent` and off the
  // overview until someone adds it; announcing it would list the whole
  // installation on every device.
  it('does not list a synced repository nobody added', async () => {
    const w = setup();
    w.write({ state: 'absent' });
    await vi.waitFor(() => expect(w.events().length).toBeGreaterThan(0));
    // Never on a view, so nothing to leave.
    expect(w.listing()).toEqual([]);
    w.write({ overviewVisible: true });
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toEqual(expect.objectContaining({ t: 'project.listed' })),
    );
  });

  // The overview adds the control plane by a setting of its own; an
  // `unlisted` for it would take it off Home after every server restart.
  it('announces nothing for a project first seen off the overview', async () => {
    const w = setup();
    w.write({ kind: 'control_plane', state: 'active' });
    await vi.waitFor(() => expect(w.events().length).toBeGreaterThan(0));
    w.write({ name: 'Renamed' });
    await vi.waitFor(() => expect(w.events().at(-1)).toMatchObject({ patch: { name: 'Renamed' } }));
    expect(w.listing()).toEqual([]);
  });

  // After a restart nothing is remembered; hiding a project nobody touched
  // since must still take it off every other device's Home.
  it('announces the first hide of a project seen for the first time', async () => {
    const w = setup();
    w.write({ state: 'active', hiddenAt: new Date('2026-11-27T10:00:00Z') });
    await vi.waitFor(() =>
      expect(w.listing()).toEqual([
        expect.objectContaining({ t: 'project.unlisted', projectId: 'p1' }),
      ]),
    );
  });

  // A member added on one device must see the project on theirs at once, and
  // one removed must lose it, and its stream, without waiting for a read.
  it('announces a change of access to the person alone, and rechecks their topics', async () => {
    const w = setup();
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.listing()).toHaveLength(1));
    w.projectChanges.announceAccess('bob', 'p1');
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toEqual({
        t: 'project.listed',
        projectId: 'p1',
        rev: expect.any(Number),
        userId: 'bob',
      }),
    );
    expect(w.authorizationChanged).toHaveBeenCalledWith({ userId: 'bob', projectId: 'p1' });

    w.readers.get('p1')!.delete('bob');
    w.projectChanges.announceAccess('bob', 'p1');
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toMatchObject({ t: 'project.unlisted', userId: 'bob' }),
    );

    // An account that became active: every project it may read.
    w.readers.get('p1')!.add('carol');
    w.projectChanges.announceAccess('carol');
    await vi.waitFor(() =>
      expect(w.listing().at(-1)).toMatchObject({
        t: 'project.listed',
        projectId: 'p1',
        userId: 'carol',
      }),
    );
    expect(w.authorizationChanged).toHaveBeenLastCalledWith({ userId: 'carol' });
  });

  // A removal right behind a join must end with the project off the
  // person's overview, however long the join's own check takes.
  it('publishes the access changes of one person in the order they committed', async () => {
    const w = setup();
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.listing()).toHaveLength(1));
    let answer!: (readable: boolean) => void;
    w.setPermission(() => new Promise((resolve) => (answer = resolve)));
    w.projectChanges.announceAccess('bob', 'p1');
    await vi.waitFor(() => expect(answer).toBeDefined());
    w.setPermission(async () => false);
    w.projectChanges.announceAccess('bob', 'p1');
    // Long enough for the removal to publish, were it not waiting its turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer(true);
    await vi.waitFor(() =>
      expect(w.listing().filter((event) => 'userId' in event)).toHaveLength(2),
    );
    expect(
      w
        .listing()
        .filter((event) => 'userId' in event)
        .map((event) => event.t),
    ).toEqual(['project.listed', 'project.unlisted']);
    // Their scope is read anew, so the hub knows what they hold now.
    expect(w.overviewScope).toHaveBeenCalledWith('bob');
  });

  it('publishes renames and setup status as project changes', async () => {
    const w = setup();
    w.write({});
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({ name: 'Renamed' });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()[2]).toEqual(
      expect.objectContaining({ t: 'project.changed', patch: { name: 'Renamed' } }),
    );
  });

  it('publishes a new latest release as a project change', async () => {
    const w = setup();
    w.write({});
    await vi.waitFor(() => expect(w.events()).toHaveLength(2));
    w.write({
      latestReleaseTag: 'v2.0.0',
      latestReleaseName: 'Two',
      latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
      latestReleasePublishedAt: '2026-11-26T10:00:00Z',
    });
    await vi.waitFor(() => expect(w.events()).toHaveLength(3));
    expect(w.events()[2]).toEqual(
      expect.objectContaining({
        t: 'project.changed',
        patch: {
          latestReleaseTag: 'v2.0.0',
          latestReleaseName: 'Two',
          latestReleaseUrl: 'https://github.com/o/r/releases/tag/v2.0.0',
          latestReleasePublishedAt: '2026-11-26T10:00:00Z',
        },
      }),
    );
  });

  it('publishes toolkit drift when a new image changes the verdict', async () => {
    const w = setup();
    w.write({ state: 'active', imageRef: 'img:1', toolkitIdentity: 'toolkit-a' });
    await vi.waitFor(() => expect(w.others()).toHaveLength(2));
    expect(w.others()[1]).toEqual(
      expect.objectContaining({
        patch: expect.objectContaining({
          toolkitDrift: expect.objectContaining({ verdict: 'matches' }),
        }),
      }),
    );
    w.write({ imageRef: 'img:2', toolkitIdentity: 'toolkit-old' });
    await vi.waitFor(() =>
      expect(w.others().at(-1)).toEqual(
        expect.objectContaining({
          t: 'project.changed',
          patch: { toolkitDrift: expect.objectContaining({ verdict: 'drifted' }) },
        }),
      ),
    );
    const count = w.others().length;
    // A sleeping sandbox is not judged; the verdict disappears with it.
    w.write({ state: 'sleeping' });
    await vi.waitFor(() =>
      expect(w.others().slice(count)).toContainEqual(
        expect.objectContaining({ t: 'project.changed', patch: { toolkitDrift: null } }),
      ),
    );
  });

  it('keeps the published drift while the server cannot read its own toolkit', async () => {
    const w = setup();
    w.write({ state: 'active', imageRef: 'img:1', toolkitIdentity: 'toolkit-old' });
    await vi.waitFor(() => expect(w.others()).toHaveLength(2));
    w.setIdentity(new Error('bundle unreadable'));
    w.write({ name: 'Renamed' });
    await vi.waitFor(() => expect(w.others()).toHaveLength(3));
    w.setIdentity('toolkit-a');
    w.write({ name: 'Renamed again' });
    await vi.waitFor(() => expect(w.others()).toHaveLength(4));
    // Neither the failure nor the recovery changed the verdict views hold.
    expect(w.others().filter((event) => 'patch' in event && 'toolkitDrift' in event.patch)).toEqual(
      [
        expect.objectContaining({
          patch: expect.objectContaining({
            toolkitDrift: expect.objectContaining({ verdict: 'drifted' }),
          }),
        }),
      ],
    );
  });

  // After a restart nothing is remembered: the first change of a project a
  // view already shows must still reach it.
  it('publishes a release found before any other change of the project', async () => {
    const w = setup();
    w.write({ latestReleaseTag: 'v3.0.0' });
    await vi.waitFor(() =>
      expect(w.events()).toContainEqual(
        expect.objectContaining({
          t: 'project.changed',
          patch: expect.objectContaining({ latestReleaseTag: 'v3.0.0' }),
        }),
      ),
    );
  });

  it('publishes the state a burst of writes ended in', async () => {
    const w = setup();
    w.write({ state: 'cloning' });
    w.write({ state: 'container_starting' });
    w.write({ state: 'failed', provisionError: 'x' });
    await vi.waitFor(() =>
      expect(w.others().at(-1)).toEqual(
        expect.objectContaining({ t: 'sandbox.lifecycle', state: 'failed' }),
      ),
    );
  });

  it('publishes the update state whenever it changes, from any read of the checker', async () => {
    const w = setup();
    // A sandbox that came up has its update status checked at once.
    w.write({ state: 'active' });
    await vi.waitFor(() =>
      expect(w.updates()).toEqual([
        expect.objectContaining({ available: false, update: { state: 'current' } }),
      ]),
    );
    // A read or a reconciler tick later sees a new image.
    for (const observer of w.observers) observer('p1', status('available'));
    for (const observer of w.observers) observer('p1', status('available'));
    // A failed registry read says nothing about the update.
    for (const observer of w.observers) observer('p1', status('unknown'));
    expect(w.updates()).toEqual([
      expect.objectContaining({ available: false }),
      expect.objectContaining({ available: true, update: { state: 'available' } }),
    ]);
    // The rebuild finished: the new image is recorded and checked again.
    w.setStatus(status('current'));
    w.write({ imageRef: 'image:2' });
    await vi.waitFor(() =>
      expect(w.updates().at(-1)).toEqual(expect.objectContaining({ available: false })),
    );
  });

  // A checker sweep reports every project; reading each from the store would
  // put a fleet-wide read behind every reconciler tick.
  it('judges a reported status with the record it already holds', async () => {
    const w = setup();
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    const reads = w.getProject.mock.calls.length;
    for (const observer of w.observers) observer('p1', status('available'));
    expect(w.updates()).toHaveLength(2);
    expect(w.getProject).toHaveBeenCalledTimes(reads);
  });

  // `unknown` is what the checker reports for a failed sandbox; ignored, the
  // event would never show what the routes show for it: an update that is
  // not repairing itself.
  it('reports a failed sandbox the checker cannot judge as the routes do', async () => {
    const w = setup();
    w.write({ state: 'failed' });
    await vi.waitFor(() => expect(w.events().length).toBeGreaterThan(0));
    for (const observer of w.observers) observer('p1', status('unknown'));
    expect(w.updates()).toEqual([
      expect.objectContaining({ available: false, update: { state: 'unknown' } }),
    ]);
  });

  // After a restart the first sweep reports the whole fleet; reading every
  // project nobody looks at would be a fleet-wide read for no viewer.
  it('reads a project first reported by the checker only once someone watches it', async () => {
    const w = setup();
    for (const observer of w.observers) observer('p2', status('available'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.getProject).not.toHaveBeenCalledWith('p2');
    // Its viewer arrives: the tick reads it once and publishes its state.
    w.watch('p2');
    w.tick();
    await vi.waitFor(() =>
      expect(w.updatesOf('p2')[0]).toEqual(expect.objectContaining({ available: true })),
    );
  });

  // A status from before the sandbox failed would keep the banner showing an
  // update the routes no longer report.
  it('drops a status from before a lifecycle change', async () => {
    const w = setup();
    w.setStatus(status('available'));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    w.failures.set('p1', { at: Date.parse('2026-11-27T08:00:00Z'), message: 'pull failed' });
    w.write({ state: 'failed' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(2));
    // A repair failure the tick sees must not be reported on the old image's
    // `available`, which no read returns any more.
    w.tick();
    expect(w.updates().slice(1)).toEqual([
      expect.objectContaining({
        available: false,
        update: expect.objectContaining({ state: 'unknown' }),
      }),
    ]);
  });

  // The toolkit lookup inside a check can be slow; a tick in that window must
  // not judge the new record by the status from before the change.
  it('judges no new lifecycle by an old status while its check is under way', async () => {
    const w = setup();
    w.setStatus(status('available'));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    let release!: (identity: string) => void;
    w.setIdentity(new Promise<string>((resolve) => (release = resolve)));
    w.failures.set('p1', { at: Date.parse('2026-11-27T08:00:00Z'), message: 'pull failed' });
    const reads = w.getProject.mock.calls.length;
    w.write({ state: 'failed' });
    await vi.waitFor(() => expect(w.getProject.mock.calls.length).toBeGreaterThan(reads));
    await new Promise((resolve) => setImmediate(resolve));
    w.tick();
    release('toolkit-a');
    await vi.waitFor(() => expect(w.updates()).toHaveLength(2));
    // Only the failed sandbox's own status went out, never the old `available`.
    expect(w.updates()[1]).toEqual(
      expect.objectContaining({ update: expect.objectContaining({ state: 'unknown' }) }),
    );
  });

  // A slow registry read that began while the sandbox ran can land after it
  // failed, before or after the status asked for the failed sandbox; taken,
  // it would show an update the routes no longer report.
  it('takes no update status for a sandbox that is not running', async () => {
    const w = setup();
    w.setStatus(status('available'));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    let answer!: (status: SandboxUpdateStatus) => void;
    w.statusCalls.mockImplementationOnce(
      () => new Promise<SandboxUpdateStatus>((resolve) => (answer = resolve)),
    );
    w.write({ state: 'failed' });
    await vi.waitFor(() => expect(answer).toBeDefined());
    // The late answer to the earlier read, before the new one is back...
    for (const observer of w.observers) observer('p1', status('available'));
    expect(w.updates()).toHaveLength(1);
    for (const observer of w.observers) observer('p1', status('unknown'));
    answer(status('unknown'));
    await vi.waitFor(() => expect(w.updates()).toHaveLength(2));
    // ...and after it.
    for (const observer of w.observers) observer('p1', status('available'));
    w.write({ state: 'sleeping' });
    await vi.waitFor(() =>
      expect(w.others().at(-1)).toEqual(expect.objectContaining({ lifecycleState: 'sleeping' })),
    );
    for (const observer of w.observers) observer('p1', status('available'));
    w.tick();
    expect(w.updates()).toHaveLength(2);
    expect(w.updates()[1]).toEqual(
      expect.objectContaining({ update: expect.objectContaining({ state: 'unknown' }) }),
    );
  });

  // Views saw the sandbox fail in between; the same status after it came back
  // is news to them again.
  it('publishes the update state again after the sandbox came back', async () => {
    const w = setup();
    w.setStatus(status('available'));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    w.write({ state: 'failed' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(2));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(3));
    expect(w.updates()[2]).toEqual(expect.objectContaining({ available: true }));
  });

  // The verdicts cover the whole fleet; read per reported project, a sweep
  // would cost the square of the fleet.
  it('reads the provisioner once for a sweep of reports', async () => {
    const w = setup();
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    await Promise.resolve();
    const reads = w.provisionerReads();
    for (const report of ['available', 'current', 'available'] as const) {
      for (const observer of w.observers) observer('p1', status(report));
    }
    expect(w.updates()).toHaveLength(4);
    expect(w.provisionerReads()).toBe(reads + 1);
  });

  // The provisioner changes these without any store write, and a blocked
  // update turns overdue by time alone: without the tick a view would show
  // them only on its next read.
  it('publishes repair failures and blocked updates on its tick', async () => {
    const w = setup();
    w.setStatus(status('available'));
    w.write({ state: 'active' });
    await vi.waitFor(() => expect(w.updates()).toHaveLength(1));
    w.tick();
    expect(w.updates()).toHaveLength(1);

    w.failures.set('p1', { at: Date.parse('2026-11-27T08:00:00Z'), message: 'pull failed' });
    w.tick();
    expect(w.updates().at(-1)).toEqual(
      expect.objectContaining({
        update: expect.objectContaining({
          lastRepairFailure: { at: '2026-11-27T08:00:00.000Z', message: 'pull failed' },
        }),
      }),
    );
    w.turnBlocked.add('p1');
    w.tick();
    expect(w.updates().at(-1)).toEqual(
      expect.objectContaining({
        update: expect.objectContaining({ selfRepair: 'stalled', turnBlocked: true }),
      }),
    );
    expect(w.updates()).toHaveLength(3);
  });

  it('stops publishing when the server closes', async () => {
    const w = setup();
    for (const close of w.closers) close();
    w.write({ state: 'active' });
    for (const observer of w.observers) observer('p1', status('available'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.events()).toEqual([]);
  });

  it('installs on a composition whose store has no change feed', () => {
    const ctx = {
      deps: { eventStore: {} },
      domainEvents: new DomainEventBus(),
      lifecycle: { onClose: () => undefined, every: () => undefined },
    } as unknown as ServerContext;
    expect(() => installProjectEvents({ log: { warn: () => undefined } }, ctx)).not.toThrow();
  });
});

/**
 * Every write of a project's state has to announce the project once it has
 * committed. A writer that does not leaves every live view on the old sandbox
 * state until its next read, and no other test notices.
 */
describe('project state writers', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const sources = ['packages/server/src', 'packages/store/src'].flatMap((dir) =>
    listSources(join(root, dir)).map((file) => ({
      file: relative(root, file),
      text: readFileSync(file, 'utf8'),
    })),
  );

  /** Writers that need no announcement, by file or by file and method, and why. */
  const exempt: Record<string, string> = {
    // Restores a hidden starter project, which views receive as a new entry of
    // the project list rather than as a change of a project they show.
    'packages/store/src/starter-projects.ts ensureReplayStarterProject':
      'restores a hidden project',
    // The in-transaction writer; its callers are checked below.
    'packages/server/src/project-persistence.ts': 'updateProjectStateInTx',
  };

  it('announces every store method that updates a project state', () => {
    const silent: string[] = [];
    for (const { file, text } of sources) {
      for (const method of methodsOf(text)) {
        if (!/updateTable\('projects'\)\s*\.set\(\{[\s\S]*?\bstate\b\s*[,:}]/u.test(method.body)) {
          continue;
        }
        if (`${file} ${method.name}` in exempt || file in exempt) continue;
        if (!/\b(?:changes|projectChanges)\??\.announce\(/u.test(method.body)) {
          silent.push(`${file} ${method.name}`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  // The release and the toolkit identity reach views only as `project.changed`
  // once the read path no longer runs for them; a silent writer would leave a
  // badge or drift banner stale until the next unrelated change.
  it('announces every store method that writes a release or toolkit identity', () => {
    const silent: string[] = [];
    let writers = 0;
    for (const { file, text } of sources) {
      for (const method of methodsOf(text)) {
        if (
          !/updateTable\('projects'\)\s*\.set\(\{(?:(?!\}\))[\s\S])*?\b(?:latest_release_tag|toolkit_identity)\s*:/u.test(
            method.body,
          )
        ) {
          continue;
        }
        writers += 1;
        if (!/\b(?:changes|projectChanges)\??\.announce\(/u.test(method.body)) {
          silent.push(`${file} ${method.name}`);
        }
      }
    }
    expect(writers).toBeGreaterThan(1);
    expect(silent).toEqual([]);
  });

  // The overview drops a hidden or deleted project only through the change
  // feed; a silent writer would leave it on every other device's Home.
  // Who may read a project changes in these writers; a silent one leaves the
  // person's other devices with the old overview, and a removed member's
  // stream open, until something unrelated reads again.
  it('announces every team store method that grants or removes access', () => {
    const team = sources.find(({ file }) => file.endsWith('store/src/project-team.ts'))!;
    // Pending joins: the person is not active yet and reads nothing either way.
    const pending = new Set([
      'revokeInvitation',
      'failJoin',
      'clearExpiredJoinCredentials',
      'redeemInvitation',
    ]);
    const silent: string[] = [];
    let writers = 0;
    for (const method of methodsOf(team.text)) {
      const grants =
        /(?:updateTable|deleteFrom|insertInto)\('project_memberships'\)/u.test(method.body) ||
        /updateTable\('users'\)\s*\.set\(\{(?:(?!\}\))[\s\S])*?\bstatus\s*:/u.test(method.body);
      if (!grants || pending.has(method.name)) continue;
      writers += 1;
      if (!/\bchanges\??\.announceAccess\(/u.test(method.body)) silent.push(method.name);
    }
    expect(writers).toBeGreaterThanOrEqual(3);
    expect(silent).toEqual([]);
  });

  it('announces every store method that hides or deletes a project', () => {
    const silent: string[] = [];
    let writers = 0;
    for (const { file, text } of sources) {
      for (const method of methodsOf(text)) {
        const hides =
          /updateTable\('projects'\)\s*\.set\(\{(?:(?!\}\))[\s\S])*?\bhidden_at\s*:\s*sql`now\(\)`/u.test(
            method.body,
          );
        const deletes = /deleteFrom\('projects'\)/u.test(method.body);
        if (!hides && !deletes) continue;
        // Deletes only the installation sync's placeholder, which is `absent`
        // and never on the overview: there is nothing for a view to drop.
        if (method.name === 'retireInstallationPlaceholder') continue;
        writers += 1;
        if (!/\b(?:changes|projectChanges)\??\.announce\(/u.test(method.body)) {
          silent.push(`${file} ${method.name}`);
        }
      }
    }
    expect(writers).toBeGreaterThan(1);
    expect(silent).toEqual([]);
  });

  it('writes in-transaction states only under a lock that announces after commit', () => {
    const unannounced: string[] = [];
    let calls = 0;
    for (const { file, text } of sources) {
      if (file.endsWith('project-persistence.ts')) continue;
      for (const call of text.matchAll(/\bupdateProjectStateInTx\(/gu)) {
        calls += 1;
        // The nearest transaction opened before the call must be the lock that
        // announces after commit, not a plain one.
        const before = text.slice(0, call.index);
        const opener = [...before.matchAll(/\bwithProjectWrite\(|\.transaction\(\)/gu)].at(-1);
        if (opener?.[0] !== 'withProjectWrite(') unannounced.push(`${file}:${call.index}`);
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(unannounced).toEqual([]);
  });
});

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Top-level functions and class members, split at their declarations; calls
 * inside a body never start a new part. */
function methodsOf(text: string): { name: string; body: string }[] {
  const starts = [
    ...text.matchAll(
      /^(?:(?:export\s+)?(?:async\s+)?function\s+|\s{2}(?:(?:private|protected|public|static|async)\s+)*)(\w+)(?:<[^>]*>)?\(/gmu,
    ),
  ];
  return starts.map((match, index) => ({
    name: match[1]!,
    body: text.slice(match.index, starts[index + 1]?.index ?? text.length),
  }));
}
