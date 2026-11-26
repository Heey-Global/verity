import { domainTopic, type DomainEvent } from '@verity/events';
import type { ProjectChangeFeed, ProjectRecord } from '@verity/store';
import { cachedTrustedToolkitIdentity } from '../runner-boundary-attestation.js';
import type { SandboxUpdateChecker } from '../sandbox-updates.js';
import type { ServerContext } from '../server-context.js';
import { reportedToolkitDrift } from '../toolkit-drift.js';
import { installReleaseChecker } from './release-checker.js';
import { createRevisions } from './revisions.js';

/** Projects whose last published state is remembered. A forgotten project
 * publishes its next change as if seen for the first time, which views apply
 * like any other. */
const MAX_REMEMBERED_PROJECTS = 4_096;

interface Remembered {
  lifecycle: string;
  name: string;
  setupStatus: string | null;
  image: string;
  release: string;
  drift: string;
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
 * stay behind the read, which views repeat when an event arrives.
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
  const updateAvailable = new Map<string, boolean>();
  // Cached process-wide on success; a failure compares as "cannot judge", the
  // same verdict the project routes show for it.
  const serverToolkitIdentity = (): Promise<string | undefined> =>
    (deps.toolkitIdentity ?? cachedTrustedToolkitIdentity)().catch(() => undefined);

  const publish = (projectId: string, event: DomainEvent): void => {
    domainEvents.publish(domainTopic('project', projectId), event);
  };

  const check = async (projectId: string): Promise<void> => {
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) {
      remembered.delete(projectId);
      updateAvailable.delete(projectId);
      return;
    }
    const drift = reportedToolkitDrift(project, await serverToolkitIdentity());
    const next = rememberedOf(project, drift);
    const previous = remembered.get(projectId);
    remember(remembered, projectId, next);
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
    // A project seen for the first time is already in every snapshot a view
    // reads when it subscribes; only a change after that is news.
    if (previous !== undefined && previous.release !== next.release) {
      for (const field of RELEASE_FIELDS) patch[field] = project[field];
    }
    if (previous !== undefined && previous.drift !== next.drift) patch['toolkitDrift'] = drift;
    if (Object.keys(patch).length > 0) {
      publish(projectId, {
        t: 'project.changed',
        projectId,
        rev: revisions.next(),
        patch,
      });
    }
    // A sandbox that came up or was rebuilt may have changed its update
    // status; checking it here reports through the checker's observer.
    if (
      updates !== undefined &&
      project.state === 'active' &&
      (previous?.lifecycle !== next.lifecycle || previous.image !== next.image)
    ) {
      // Not awaited: a slow registry must not hold back this project's next
      // lifecycle event.
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
    // Releases reach the store through it; without a feed nothing would carry
    // them on to views.
    installReleaseChecker(app, ctx);
  }

  const stopObserving = updates?.observe?.((projectId, status) => {
    // `unknown` (a stopped sandbox, a failed inspect or registry read) says
    // nothing about the update; publishing it would make every viewer read
    // again whenever the registry stumbles.
    if (status.state === 'unknown') return;
    const available = status.state === 'available';
    const previous = updateAvailable.get(projectId);
    updateAvailable.delete(projectId);
    updateAvailable.set(projectId, available);
    if (updateAvailable.size > MAX_REMEMBERED_PROJECTS) {
      updateAvailable.delete(updateAvailable.keys().next().value!);
    }
    // The first status seen after a start is already in every snapshot a view
    // reads when it subscribes.
    if (previous === undefined || previous === available) return;
    publish(projectId, {
      t: 'sandbox.update',
      projectId,
      rev: revisions.next(),
      available,
    });
  });
  if (stopObserving !== undefined) lifecycle.onClose(stopObserving);
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

function rememberedOf(project: ProjectRecord, drift: unknown): Remembered {
  return {
    lifecycle: JSON.stringify([project.state, project.provisionError, project.provisionWarning]),
    name: project.name,
    setupStatus: project.setupStatus ?? null,
    image: JSON.stringify([project.imageRef, project.toolkitIdentity]),
    release: JSON.stringify(RELEASE_FIELDS.map((field) => project[field])),
    drift: JSON.stringify(drift),
  };
}

function remember(map: Map<string, Remembered>, projectId: string, value: Remembered): void {
  map.delete(projectId);
  map.set(projectId, value);
  if (map.size > MAX_REMEMBERED_PROJECTS) map.delete(map.keys().next().value!);
}
