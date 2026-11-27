import { domainTopic, PROJECTS_COLLECTION_TOPIC, type DomainEvent } from '@verity/events';
import type { ProjectChangeFeed, ProjectRecord } from '@verity/store';
import { cachedTrustedToolkitIdentity } from '../runner-boundary-attestation.js';
import { createSandboxUpdateView } from '../sandbox-update-view.js';
import type { SandboxUpdateChecker, SandboxUpdateStatus } from '../sandbox-updates.js';
import type { ServerContext } from '../server-context.js';
import { listedInProjectCollection } from '../server-support.js';
import { reportedToolkitDrift } from '../toolkit-drift.js';
import { ALL_PROJECTS, invalidatedProject } from './invalidation-targets.js';
import { installReleaseChecker } from './release-checker.js';
import { createRevisions } from './revisions.js';

/** Projects whose last published state is remembered. A forgotten project
 * publishes its next change as if seen for the first time, which views apply
 * like any other. */
const MAX_REMEMBERED_PROJECTS = 4_096;

/** How often the update state of watched projects is computed again from
 * what the server already holds. The provisioner's repairs and deferrals
 * change without a store write, and `turnBlocked` and `overdue` turn true by
 * time alone; recomputing costs no Docker, registry or forge call. */
const UPDATE_RECHECK_INTERVAL_MS = 10_000;

/** How long invalidations of one project gather into one `project.changed`. */
const TOUCH_SETTLE_MS = 100;

/** The server's own toolkit identity could not be read. */
const UNREADABLE = Symbol('unreadable');

interface Remembered {
  lifecycle: string;
  name: string;
  setupStatus: string | null;
  image: string;
  release: string;
  drift: string;
  listed: boolean;
}

/** The release fields as the project routes show them. */
const RELEASE_FIELDS = [
  'latestReleaseTag',
  'latestReleaseName',
  'latestReleaseUrl',
  'latestReleasePublishedAt',
] as const;

/**
 * Publishes sandbox and project changes on `project:<id>` (ADR 0033), so Home,
 * the project page and its settings show a sandbox that started, failed, went
 * to sleep or needs an update as soon as the server knows it, instead of at
 * their next read.
 *
 * Sources:
 * - the store's project change feed: every write of a project's state, image,
 *   name or setup status announces the project after it committed. The project
 *   is read again and compared with what was last published, so only real
 *   changes reach views;
 * - the sandbox update checker: every status it computes, for a read or for
 *   the reconciler's tick, is compared with the last one seen for the project.
 *
 * `sandbox.lifecycle` carries the state the project routes show.
 * `project.changed` carries the name, setup status, latest release and toolkit
 * drift. The release changes when a read or the release checker stores a new
 * one; the drift when the image or the lifecycle does. The fields the routes
 * derive from the provisioner at read time (update detail, repair verdicts)
 * travel as `sandbox.update`: the whole `sandboxUpdate` the routes would show,
 * computed by the same view from the checker's last status, whenever it
 * differs from the one last published.
 */
export function installProjectEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: ServerContext,
): void {
  const { deps, domainEvents, lifecycle } = ctx;
  const changes = changeFeedOf(deps.eventStore);
  const updates: SandboxUpdateChecker | undefined = deps.sandboxUpdates;
  const revisions = createRevisions();
  const remembered = new Map<string, Remembered>();
  const updateView = createSandboxUpdateView(deps);
  /** The checker's last status and the project it was last seen with. */
  const lastStatus = new Map<string, SandboxUpdateStatus>();
  const lastProject = new Map<string, ProjectRecord>();
  const publishedUpdate = new Map<string, string>();
  // Cached process-wide on success. A failed lookup is a fault of this server,
  // not news about the project: the verdict last published stands, rather than
  // a banner that disappears and returns with every hiccup.
  const serverToolkitIdentity = (): Promise<string | undefined | typeof UNREADABLE> =>
    (deps.toolkitIdentity ?? cachedTrustedToolkitIdentity)().catch(() => UNREADABLE);

  // One change of a person's access at a time, in the order they committed:
  // an earlier change read before a later one must not publish after it.
  const accessQueues = new Map<string, Promise<void>>();
  /**
   * What one person may read changed. Their open topics are checked again at
   * once, so a project they lost ends its stream now; and the projects whose
   * place on their overview changed are announced to them alone.
   */
  const accessChanged = (userId: string, projectId?: string): Promise<void> => {
    // Before waiting for anything: a project they lost ends its stream now,
    // even behind an earlier change still being checked.
    try {
      ctx.liveHub.authorizationChanged({
        userId,
        ...(projectId === undefined ? {} : { projectId }),
      });
    } catch (error) {
      // The announcement below still tells their devices what changed.
      app.log.warn({ err: error, userId, projectId }, 'verity: live topics not rechecked');
    }
    const next = (accessQueues.get(userId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => publishAccess(userId, projectId));
    // Held for the next change, never rejecting: the caller handles `next`.
    const settled = next
      .catch(() => undefined)
      .finally(() => {
        if (accessQueues.get(userId) === settled) accessQueues.delete(userId);
      });
    accessQueues.set(userId, settled);
    return next;
  };
  const publishAccess = async (userId: string, projectId?: string): Promise<void> => {
    // The change cleared their cached scope; reading it now, before anything
    // is announced, lets the hub know they hold a project they just joined, so
    // its hiding or deletion reaches them too.
    await ctx.liveHub.overviewScope(userId);
    const store = deps.eventStore;
    const projectIds =
      projectId === undefined ? await store.listReadableProjectIds(userId) : [projectId];
    for (const id of projectIds) {
      const readable = await store.hasProjectPermission(userId, id, 'read');
      // Read last, with nothing awaited after it: a hide or deletion during
      // the permission check must not be announced over.
      const project = await store.getProject(id);
      const listed = readable && project !== undefined && listedInProjectCollection(project);
      domainEvents.publish(
        PROJECTS_COLLECTION_TOPIC,
        listed
          ? { t: 'project.listed', projectId: id, rev: revisions.next(), userId }
          : {
              t: 'project.unlisted',
              projectId: id,
              rev: revisions.next(),
              userId,
              ...(project === undefined ? { gone: true } : {}),
            },
      );
    }
  };

  const publish = (projectId: string, event: DomainEvent): void => {
    domainEvents.publish(domainTopic('project', projectId), event);
  };

  /** Publish the project's update state if it differs from the last one. */
  // A checker sweep reports the whole fleet in one go; the provisioner's
  // verdicts are read once for it rather than once per project.
  let sweepVerdicts: ReturnType<typeof updateView.sandboxRepairVerdicts> | undefined;
  const currentVerdicts = () => {
    if (sweepVerdicts === undefined) {
      sweepVerdicts = updateView.sandboxRepairVerdicts();
      queueMicrotask(() => {
        sweepVerdicts = undefined;
      });
    }
    return sweepVerdicts;
  };

  const publishUpdate = (projectId: string, verdicts = currentVerdicts()): void => {
    const status = lastStatus.get(projectId);
    const project = lastProject.get(projectId);
    if (status === undefined || project === undefined) return;
    // `unknown` (a stopped sandbox, a failed inspect or registry read) says
    // nothing about the update, so the last state published stands rather than
    // every viewer's banner changing whenever the registry stumbles. A failed
    // sandbox is the exception: `unknown` is its status, and the routes report
    // it as an update that is not repairing itself.
    if (status.state === 'unknown' && project.state !== 'failed') return;
    if (status.state !== 'unknown' && project.state !== 'active') return;
    const update = updateView.withSelfRepair(project, status, verdicts);
    const fingerprint = JSON.stringify(update);
    if (publishedUpdate.get(projectId) === fingerprint) return;
    bounded(publishedUpdate, projectId, fingerprint);
    publish(projectId, {
      t: 'sandbox.update',
      projectId,
      rev: revisions.next(),
      available: update.state === 'available',
      update: { ...update },
    });
  };

  const check = async (projectId: string): Promise<void> => {
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) {
      const was = remembered.get(projectId);
      remembered.delete(projectId);
      lastStatus.delete(projectId);
      lastProject.delete(projectId);
      publishedUpdate.delete(projectId);
      // Gone from the store: every view that lists it drops it. Announced for
      // a project not seen before too, since only a deletion announces one
      // that no longer exists; the live hub delivers it only to those who
      // held it.
      if (was?.listed !== false) {
        domainEvents.publish(PROJECTS_COLLECTION_TOPIC, {
          t: 'project.unlisted',
          projectId,
          rev: revisions.next(),
          gone: true,
        });
      }
      return;
    }
    // A status from before a lifecycle change says nothing about the sandbox
    // now; a running one is checked again below, a failed one reports
    // `unknown` at the checker's next look. Forgetting what was published too
    // lets the next status go out even when it repeats one from before. In the
    // same step as holding the new record, so that no tick or checker report
    // judges the new record by the old status in between.
    // Keyed on the state alone: a new provision warning changes nothing about
    // the image. A status the checker reported while this read was out may
    // already have been published for the old record; it is dropped here, and
    // the check below asks again for the state read.
    const held = lastProject.get(projectId);
    const stateChanged = held !== undefined && held.state !== project.state;
    if (stateChanged) {
      lastStatus.delete(projectId);
      publishedUpdate.delete(projectId);
    }
    bounded(lastProject, projectId, project);
    const identity = await serverToolkitIdentity();
    const drift = identity === UNREADABLE ? undefined : reportedToolkitDrift(project, identity);
    const previous = remembered.get(projectId);
    const next = rememberedOf(
      project,
      drift === undefined ? (previous?.drift ?? '') : JSON.stringify(drift),
    );
    remember(remembered, projectId, next);
    // Entering the overview, on first sight too: a view that already lists
    // the project ignores it. Leaving it only from a state that was listed: a
    // project first seen unlisted (a synced repository, the control plane the
    // overview adds by its own setting) was never on a view to leave.
    if (next.listed && previous?.listed !== true) {
      domainEvents.publish(PROJECTS_COLLECTION_TOPIC, {
        t: 'project.listed',
        projectId,
        rev: revisions.next(),
      });
    } else if (
      !next.listed &&
      (previous?.listed === true || (previous === undefined && hiddenFromOverview(project)))
    ) {
      domainEvents.publish(PROJECTS_COLLECTION_TOPIC, {
        t: 'project.unlisted',
        projectId,
        rev: revisions.next(),
      });
    }
    if (previous?.lifecycle !== next.lifecycle) {
      const { state, lifecycleState } = publicLifecycle(project);
      publish(projectId, {
        t: 'sandbox.lifecycle',
        projectId,
        rev: revisions.next(),
        state,
        ...(lifecycleState === undefined ? {} : { lifecycleState }),
        warning: project.provisionWarning,
      });
    }
    const patch: Record<string, unknown> = {};
    if (previous?.name !== next.name) patch['name'] = next.name;
    if (previous?.setupStatus !== next.setupStatus && next.setupStatus !== null) {
      patch['setupStatus'] = next.setupStatus;
    }
    // Published on first sight too, like the lifecycle: after a restart the
    // first change of a project a view already shows is seen for the first
    // time. The values are absolute, so repeating one a view holds is harmless.
    if (previous?.release !== next.release) {
      for (const field of RELEASE_FIELDS) patch[field] = project[field];
    }
    if (drift !== undefined && previous?.drift !== next.drift) patch['toolkitDrift'] = drift;
    if (Object.keys(patch).length > 0) {
      publish(projectId, {
        t: 'project.changed',
        projectId,
        rev: revisions.next(),
        patch,
      });
    }
    publishUpdate(projectId);
    // A sandbox that came up or was rebuilt may have changed its update
    // status, and one whose state changed has just lost its last status. Only
    // a running or failed one can be judged; for the others the checker can
    // only answer `unknown`.
    const judged = project.state === 'active' || project.state === 'failed';
    if (
      updates !== undefined &&
      judged &&
      (stateChanged ||
        (project.state === 'active' &&
          (previous?.lifecycle !== next.lifecycle || previous.image !== next.image)))
    ) {
      // Not awaited: a slow registry must not hold back this project's next
      // lifecycle event. The answer arrives through the checker's observer.
      void updates.status(project).catch((error: unknown) => {
        app.log.warn({ err: error, projectId }, 'verity: sandbox update check failed');
      });
    }
  };

  // One check per project at a time, and one more if announced meanwhile: a
  // burst of writes publishes the state it ended in, in revision order.
  const checks = new Map<string, { again: boolean }>();
  const announce = (projectId: string): void => {
    const running = checks.get(projectId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const entry = { again: false };
    checks.set(projectId, entry);
    void (async () => {
      try {
        do {
          entry.again = false;
          await check(projectId).catch((error: unknown) => {
            app.log.warn({ err: error, projectId }, 'verity: project event not published');
          });
        } while (entry.again);
      } finally {
        checks.delete(projectId);
      }
    })();
  };

  if (changes !== undefined) {
    lifecycle.onClose(changes.observe(announce));
    if (typeof changes.observeAccess === 'function') {
      lifecycle.onClose(
        changes.observeAccess((userId, projectId) => {
          void accessChanged(userId, projectId).catch((error: unknown) => {
            app.log.warn({ err: error, userId, projectId }, 'verity: access change not published');
          });
        }),
      );
    }
    // Releases reach the store through it; without a feed nothing would carry
    // them on to views.
    installReleaseChecker(app, ctx);
  }

  // A change the project routes show that no event above describes: a write
  // through the routes (settings, members, QA, secrets, the order), QA and
  // repair state, vulnerability findings. They announce themselves as
  // invalidations; views read the project again on an empty `project.changed`.
  // A burst of them is one event per project.
  const touched = new Set<string>();
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  const flushTouched = (): void => {
    touchTimer = undefined;
    for (const projectId of touched) {
      publish(projectId, { t: 'project.changed', projectId, rev: revisions.next(), patch: {} });
    }
    touched.clear();
  };
  const touch = (projectId: string): void => {
    touched.add(projectId);
    if (touchTimer !== undefined) return;
    touchTimer = setTimeout(flushTouched, TOUCH_SETTLE_MS);
    touchTimer.unref();
  };
  lifecycle.onClose(
    ctx.resources.onInvalidate((path) => {
      const target = invalidatedProject(path);
      if (target === ALL_PROJECTS)
        for (const projectId of domainEvents.watched('project')) touch(projectId);
      else if (target !== undefined) touch(target);
    }),
  );
  lifecycle.onClose(() => {
    if (touchTimer !== undefined) clearTimeout(touchTimer);
  });

  const stopObserving = updates?.observe?.((projectId, status) => {
    const project = lastProject.get(projectId);
    if (project !== undefined) {
      // Only a running sandbox has an image to compare. For any other,
      // `unknown` is the only status that describes it; anything else is a
      // read that began while it still ran and landed late.
      if (project.state !== 'active' && status.state !== 'unknown') return;
      // A running one's `unknown` is a failed inspect or registry read, which
      // says nothing about the update: the last state published stands rather
      // than every banner changing whenever the registry stumbles.
      if (status.state === 'unknown' && project.state !== 'failed') return;
    }
    // Kept for a project not read yet, and judged once its record is held.
    bounded(lastStatus, projectId, status);
    // A project seen before is judged with the record its last check read, so
    // a checker sweep over the whole fleet costs no store read. One not seen
    // yet is read only when someone watches it; the tick catches up one that
    // gains a viewer later.
    if (project !== undefined) publishUpdate(projectId);
    else if (domainEvents.watching(domainTopic('project', projectId))) announce(projectId);
  });
  if (stopObserving !== undefined) lifecycle.onClose(stopObserving);
  if (updates !== undefined) {
    lifecycle.every(
      UPDATE_RECHECK_INTERVAL_MS,
      () => {
        const verdicts = updateView.sandboxRepairVerdicts();
        for (const projectId of domainEvents.watched('project')) {
          if (lastProject.has(projectId)) publishUpdate(projectId, verdicts);
          else if (lastStatus.has(projectId)) announce(projectId);
        }
      },
      { startWhenReady: true },
    );
  }
}

/** The store's change feed, absent from compositions whose store is a test
 * double without one. */
function changeFeedOf(store: object): ProjectChangeFeed | undefined {
  const feed = (store as { projectChanges?: ProjectChangeFeed }).projectChanges;
  return typeof feed?.observe === 'function' ? feed : undefined;
}

/** The lifecycle as the project routes show it: sleep states travel as
 * `lifecycleState` of an `active` project. */
function publicLifecycle(project: ProjectRecord): { state: string; lifecycleState?: string } {
  const sleeping =
    project.state === 'sleeping_starting' ||
    project.state === 'sleeping' ||
    project.state === 'waking';
  return sleeping ? { state: 'active', lifecycleState: project.state } : { state: project.state };
}

/** A project the overview would list but for being hidden: first seen after
 * a restart, its hiding may be what announced it. */
function hiddenFromOverview(project: ProjectRecord): boolean {
  return project.hiddenAt !== null && listedInProjectCollection({ ...project, hiddenAt: null });
}

function lifecycleOf(project: ProjectRecord): string {
  return JSON.stringify([project.state, project.provisionError, project.provisionWarning]);
}

function rememberedOf(project: ProjectRecord, drift: string): Remembered {
  return {
    lifecycle: lifecycleOf(project),
    name: project.name,
    setupStatus: project.setupStatus ?? null,
    image: JSON.stringify([project.imageRef, project.toolkitIdentity]),
    release: JSON.stringify(RELEASE_FIELDS.map((field) => project[field])),
    drift,
    listed: listedInProjectCollection(project),
  };
}

function remember(map: Map<string, Remembered>, projectId: string, value: Remembered): void {
  bounded(map, projectId, value);
}

/** Set as the most recent entry, forgetting the oldest beyond the bound. */
function bounded<T>(map: Map<string, T>, projectId: string, value: T): void {
  map.delete(projectId);
  map.set(projectId, value);
  if (map.size > MAX_REMEMBERED_PROJECTS) map.delete(map.keys().next().value!);
}
