import { DEVCONTAINER_ROOT_USER_WARNING, PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import type { ProjectLifecycleState, ProjectRecord, SessionSummary } from '../api.js';
import { sandboxUpdateNeedsAttention } from './sandboxUpdate.js';
import { sessionAgentMark, type SessionAgentMark } from './sessionTile.js';
import { sessionWorkActive } from './sessionWork.js';

/**
 * A project card's status, in the session rows' vocabulary: the tile's colour
 * is the project itself, the corner is its agents ({@link projectAgentMark}),
 * and every word lives in the subtitle.
 *
 * Three states and no more, because the card answers one question — can I work
 * in this project right now? `running` yes; `paused` not at the moment, and
 * nothing is wrong (paused, asleep, on the way up); `error` not until someone
 * repairs it. Work Verity does on a running sandbox in the background — an
 * update converging, an image rebuild — does not change that answer, so it does
 * not change the card: right after a Server deploy it is true of every project
 * at once, and a list that lights up for it teaches people to ignore it.
 */
export type ProjectCardStateKind = 'running' | 'paused' | 'error';

export interface ProjectCardNote {
  label: string;
  /** `attention` when the person has something to do or check. */
  tone: 'muted' | 'attention';
}

export interface ProjectCardState {
  state: ProjectCardStateKind;
  /** A short phrase for the end of the subtitle; the full text stays on the project page. */
  note?: ProjectCardNote;
}

type CardProject = Pick<
  ProjectRecord,
  'state' | 'lifecycleState' | 'provisionError' | 'provisionWarning'
> & {
  setupStatus?: ProjectRecord['setupStatus'];
  sandboxUpdate?: ProjectRecord['sandboxUpdate'];
  toolkitDrift?: ProjectRecord['toolkitDrift'];
};

// Exhaustive over the lifecycle union: a new server state stops this compiling
// until someone decides which of the three it is.
const LIFECYCLE: Record<ProjectLifecycleState, ProjectCardState> = {
  active: { state: 'running' },
  cloning: { state: 'paused', note: { label: 'Preparing…', tone: 'muted' } },
  container_starting: { state: 'paused', note: { label: 'Starting…', tone: 'muted' } },
  waking: { state: 'paused', note: { label: 'Waking…', tone: 'muted' } },
  sleeping_starting: { state: 'paused', note: { label: 'Pausing…', tone: 'muted' } },
  sleeping: { state: 'paused', note: { label: 'asleep', tone: 'muted' } },
  absent: { state: 'paused' },
  // The only state the reconciler gives a project whose container stopped or
  // vanished; its reason is added below.
  failed: { state: 'error', note: { label: 'Needs repair', tone: 'attention' } },
};

/**
 * The first clause of a provisioning error. The reconciler writes sentences
 * like "Sandbox container stopped — Repair to restart it." and build failures
 * like "Devcontainer build failed: <log line>"; the card has room for the part
 * before the dash or colon, and the project page shows the rest.
 */
export function shortProvisionReason(error: string | null | undefined): string | undefined {
  const first = error
    ?.split(/ — | – |: |\. |\n/, 1)[0]
    ?.trim()
    .replace(/\.$/, '');
  return first ? first : undefined;
}

/** The project's own state on its card. */
export function projectCardState(project: CardProject): ProjectCardState {
  const lifecycle = project.lifecycleState ?? project.state;
  if (lifecycle === 'absent' && project.setupStatus === 'pending')
    return { state: 'paused', note: { label: 'Preparing…', tone: 'muted' } };
  const base = LIFECYCLE[lifecycle];
  if (base.state === 'error') {
    const reason = shortProvisionReason(project.provisionError);
    return {
      state: 'error',
      note: { label: reason ? `Needs repair · ${reason}` : 'Needs repair', tone: 'attention' },
    };
  }
  if (base.state !== 'running') return base;
  const warning = runningWarning(project);
  return warning ? { state: 'running', note: { label: warning, tone: 'attention' } } : base;
}

/** A short name for what should be checked on a project that runs. */
function runningWarning(project: CardProject): string | undefined {
  const update = project.sandboxUpdate;
  if (sandboxUpdateNeedsAttention(update))
    return update.selfRepair === 'stalled' ? 'Update stuck' : 'Update waiting';
  const warning = project.provisionWarning;
  // A rebuild in progress is background work, not a finding.
  if (warning && warning !== PROJECT_IMAGE_REBUILDING_WARNING)
    return warning === DEVCONTAINER_ROOT_USER_WARNING ? 'Runs as root' : 'Check workspace';
  if (hasActionableToolkitDrift(project)) return 'Toolkit check';
  return undefined;
}

/**
 * Whether a drift verdict is worth putting in front of someone on the overview.
 *
 * Only a `drifted` verdict on a `devcontainer` image qualifies, and both halves
 * are load-bearing.
 *
 * `unknown` is excluded because it has no remedy to offer: it covers images that
 * are never attested by design as well as ones that failed the comparison, and
 * the client cannot tell those apart (see the note on the unknown line in
 * `packages/server/src/toolkit-drift.ts`). A chip that cannot terminate is a
 * chip people learn to ignore.
 *
 * `base-image` is excluded for the opposite reason: the verdict is real, but no
 * action available in Verity changes what that image contains — only a rebuilt
 * base image does. It stays visible in the project's own runtime panel, where
 * there is room to say so, rather than in a row-level chip that would read as a
 * to-do.
 *
 * A fleet-wide drift is the normal state right after a Server deploy, so this
 * deliberately narrows to the population a re-provision actually repairs.
 */
export function hasActionableToolkitDrift(project: Pick<ProjectRecord, 'toolkitDrift'>): boolean {
  const drift = project.toolkitDrift;
  return drift?.verdict === 'drifted' && drift.carrier === 'devcontainer';
}

/**
 * The agents' mark on a project's tile: the most urgent mark any of its sessions
 * would carry on its own row. It is computed by {@link sessionAgentMark} itself
 * over the project's sessions folded together, so a project and a session can
 * never rank waiting, working and new differently.
 *
 * `waiting` is whether something in the project waits for the person (a
 * question, an approval, a review): that is what the subtitle's "waiting for
 * you" counts, and the corner's "?" must not disagree with it.
 */
export function projectAgentMark(input: {
  sessions: readonly SessionSummary[];
  unread: ReadonlySet<string>;
  waiting: boolean;
}): SessionAgentMark | undefined {
  const { sessions, unread } = input;
  const awaiting = input.waiting || sessions.some(({ status }) => status === 'awaiting_input');
  const working = sessions.some(sessionWorkActive);
  return sessionAgentMark({
    status: awaiting ? 'awaiting_input' : 'idle',
    working,
    // A working session's unread mark gives way to its working one, as on its row.
    unread: sessions.some(
      (session) => !sessionWorkActive(session) && unread.has(session.sessionId),
    ),
  });
}
