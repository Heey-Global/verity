// Starts a project's Wiki maintenance run when something new happened there,
// never on a fixed schedule. A project with no open occasions costs one query
// per pass and no model call. The house pattern for periodic server work: one
// unref'd timer, an overlap guard, state read at run time and a stop function.
import type { EventStore, ProjectRecord } from '@verity/store';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The rules a run waits for; exported so tests and docs name the same values. */
export const WIKI_MAINTENANCE_RULES = {
  /** A burst of occasions settles into one run this long after the newest. */
  settleMs: 2 * HOUR_MS,
  /** At most one run per project in this interval. */
  minIntervalMs: 20 * HOUR_MS,
  /** A sleeping project is woken once its oldest occasion is this old… */
  sleepingAgeMs: 3 * DAY_MS,
  /** …or this many occasions are open. */
  sleepingCount: 20,
  /** Occasions of a project without a Wiki are discarded after this long. */
  noWikiRetentionMs: 30 * DAY_MS,
} as const;

const PASS_INTERVAL_MS = 15 * 60 * 1000;

export const WIKI_MAINTENANCE_SESSION_NAME = 'Wiki maintenance';
export const WIKI_MAINTENANCE_DISPLAY_PROMPT = 'Wiki maintenance run';

/**
 * The fixed assignment of every run. The steps live in the `wiki-maintain`
 * Skill so they change with it; this only starts them.
 */
export const WIKI_MAINTENANCE_PROMPT =
  'This is an automatic Wiki maintenance run; nobody is reading along. Load the wiki-maintain ' +
  'Skill and follow its "Maintenance run" steps: read the open occasions with ' +
  'verity_wiki_read_occasions, turn what belongs in the Wiki into proposals with ' +
  'verity_wiki_propose in mode maintenance, then close the occasions you read with ' +
  'verity_wiki_close_occasions. This turn is read-only: read Wiki pages and sources with ' +
  'ordinary file tools under /knowledge, change no file, do not try to leave plan mode or ' +
  'present a plan, and ask no questions. End with one short sentence on what you proposed.';

export type WikiMaintenanceDecision =
  | { run: true }
  | {
      run: false;
      reason: 'nothing_open' | 'state' | 'settling' | 'interval' | 'sleeping' | 'busy';
    };

/**
 * Whether a project's open occasions warrant a run now. Pure: every input is
 * read by the caller at run time, so a test drives it with a fixed clock.
 */
export function decideWikiMaintenance(input: {
  state: ProjectRecord['state'];
  pending: { count: number; oldestAt: Date | null; newestAt: Date | null };
  lastRunAt: Date | null;
  busy: boolean;
  now: number;
}): WikiMaintenanceDecision {
  const { pending, now } = input;
  const rules = WIKI_MAINTENANCE_RULES;
  if (pending.count === 0 || pending.newestAt === null || pending.oldestAt === null)
    return { run: false, reason: 'nothing_open' };
  // A paused, failed or still provisioning project is never woken for its Wiki.
  if (input.state !== 'active' && input.state !== 'sleeping')
    return { run: false, reason: 'state' };
  if (now - pending.newestAt.getTime() < rules.settleMs) return { run: false, reason: 'settling' };
  if (input.lastRunAt !== null && now - input.lastRunAt.getTime() < rules.minIntervalMs)
    return { run: false, reason: 'interval' };
  if (
    input.state === 'sleeping' &&
    now - pending.oldestAt.getTime() < rules.sleepingAgeMs &&
    pending.count < rules.sleepingCount
  )
    return { run: false, reason: 'sleeping' };
  if (input.busy) return { run: false, reason: 'busy' };
  return { run: true };
}

export interface WikiMaintenanceTriggerDeps {
  store: Pick<EventStore, 'wikiOccasions' | 'wikiMaintenance' | 'getProject'>;
  /** Whether the project's Wiki was set up (it has `index.md`). */
  hasWiki(projectId: string): Promise<boolean>;
  isProjectBusy(projectId: string): Promise<boolean>;
  /** The project's maintenance session, created on first use; undefined when it cannot start yet. */
  ensureSession(project: ProjectRecord): Promise<string | undefined>;
  /** Starts the run's turn; not accepted when the session is busy or gone. */
  dispatch(sessionId: string): Promise<{ accepted: boolean }>;
  log: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
  /** Injectable clock (ms) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface WikiMaintenanceTrigger {
  /** Stop the timer and wait for a pass in progress; safe to call repeatedly. */
  stop(): Promise<void>;
  /** Run one pass (test seam; does not touch the timer). */
  runOnce(): Promise<void>;
}

export function startWikiMaintenanceTrigger(
  deps: WikiMaintenanceTriggerDeps,
  options: { timer?: boolean } = {},
): WikiMaintenanceTrigger {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | undefined;
  let stopped = false;

  const visit = async (projectId: string): Promise<void> => {
    const project = await deps.store.getProject(projectId);
    if (!project || project.hiddenAt !== null || project.kind === 'control_plane') return;
    const at = now();
    if (!(await deps.hasWiki(projectId))) {
      const discarded = await deps.store.wikiOccasions.discardOpenBefore(
        projectId,
        new Date(at - WIKI_MAINTENANCE_RULES.noWikiRetentionMs),
      );
      if (discarded > 0)
        deps.log.info({ projectId, discarded }, 'wiki occasions discarded: no Wiki set up');
      return;
    }
    const pending = await deps.store.wikiOccasions.pending(projectId);
    const previous = (await deps.store.wikiMaintenance.get(projectId))?.lastRunAt ?? null;
    const base = { state: project.state, pending, lastRunAt: previous, now: at };
    // The busy probe lists every session, so it runs only once nothing else says wait.
    if (!decideWikiMaintenance({ ...base, busy: false }).run) return;
    if (!decideWikiMaintenance({ ...base, busy: await deps.isProjectBusy(projectId) }).run) return;
    const claimedAt = new Date(at);
    const claimed = await deps.store.wikiMaintenance.claimRun(
      projectId,
      claimedAt,
      new Date(at - WIKI_MAINTENANCE_RULES.minIntervalMs),
    );
    if (!claimed) return;
    let started = false;
    try {
      const sessionId = await deps.ensureSession(project);
      if (sessionId !== undefined) started = (await deps.dispatch(sessionId)).accepted;
      if (started)
        deps.log.info(
          { projectId, sessionId, open: pending.count },
          'wiki maintenance run started',
        );
      else deps.log.warn({ projectId, sessionId }, 'wiki maintenance run could not start');
    } finally {
      // A run that never started must not hold the interval for 20 hours.
      if (!started) await deps.store.wikiMaintenance.releaseRun(projectId, claimedAt, previous);
    }
  };

  const pass = async (): Promise<void> => {
    const projectIds = await deps.store.wikiOccasions.projectsWithOpen(new Date(now()));
    for (const projectId of projectIds) {
      if (stopped) return;
      try {
        await visit(projectId);
      } catch (err) {
        deps.log.warn({ err, projectId }, 'wiki maintenance check failed');
      }
    }
  };

  const runOnce = (): Promise<void> => {
    if (running || stopped) return running ?? Promise.resolve();
    running = pass()
      .catch((err: unknown) => deps.log.warn({ err }, 'wiki maintenance pass failed'))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const timer =
    options.timer === false ? undefined : setInterval(() => void runOnce(), PASS_INTERVAL_MS);
  timer?.unref();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      await running;
    },
    runOnce,
  };
}
