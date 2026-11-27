import type { ServerContext } from '../server-context.js';
import { projectHasReleases, releaseDiffers } from '../server-support.js';

/** How often the watched projects are looked at. The release service keeps a
 * repository's answer for five minutes, so the forge sees at most one read per
 * repository in that window; a shorter tick only shortens the delay after it. */
const RELEASE_CHECK_INTERVAL_MS = 60_000;

/**
 * Keeps the latest release of every watched project current without a read
 * (ADR 0033). GitHub announces no releases without webhooks, so the server
 * looks, but only for projects someone has open: a project topic with a
 * subscriber. A changed release is stored like a read stores it, and the
 * store's change feed turns it into `project.changed` for every device.
 *
 * The overview and detail reads keep their own lookup for clients that do not
 * subscribe; both share the release service's cache.
 */
export function installReleaseChecker(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: ServerContext,
  options: { intervalMs?: number } = {},
): { check: () => Promise<void> } {
  const { deps, domainEvents, lifecycle } = ctx;
  const refresh = deps.refreshLatestRelease;
  let running: Promise<void> | undefined;

  const checkProject = async (projectId: string): Promise<void> => {
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined || !projectHasReleases(project) || refresh === undefined) return;
    // Near the forge quota the badge waits; interactive reads still look.
    if ((await deps.deferBackgroundForgeReads?.(projectId).catch(() => false)) === true) return;
    const fresh = await refresh(project.owner, project.repo);
    // `undefined` is "unknown" (no token, a failed read): keep what is stored.
    if (fresh === undefined || !releaseDiffers(project, fresh)) return;
    await deps.eventStore.updateProjectReleaseStatus(project.id, {
      tag: fresh?.tag ?? null,
      name: fresh?.name ?? null,
      url: fresh?.url ?? null,
      publishedAt: fresh?.publishedAt ?? null,
    });
  };

  const check = (): Promise<void> => {
    running ??= (async () => {
      // One project at a time: a large fleet must not burst the forge.
      for (const projectId of domainEvents.watched('project')) {
        await checkProject(projectId).catch((error: unknown) => {
          app.log.warn({ err: error, projectId }, 'verity: release check failed');
        });
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  if (refresh !== undefined) {
    lifecycle.every(options.intervalMs ?? RELEASE_CHECK_INTERVAL_MS, () => void check(), {
      startWhenReady: true,
    });
    lifecycle.onClose(() => running);
  }
  return { check };
}
