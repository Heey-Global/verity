import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import type { ProjectLifecycleState, ProjectRecord, SandboxUpdate } from '../api.js';

/**
 * Presentation adapter for a project's container lifecycle, mirroring
 * `sessionBadge` for sessions: pure TS (no React Native / theme) so the mapping
 * stays unit-testable, while the RN layer resolves a `tone` to a theme color and
 * decides how to draw the dot.
 *
 * The tone set is deliberately a SUBSET of the session `BadgeTone`s, because
 * projects and sessions share the same 18px dot gutter in the overview and must
 * not give the same color two meanings one row apart:
 *
 * - `done` (green)     — the sandbox container is running.
 * - `working` (magenta, pulsing) — Verity is doing something to the container
 *   (cloning, starting, finishing setup). Same signal as the session
 *   `WorkingDot`: magenta + pulse always means "work in progress".
 * - `danger` (raspberry) — the container is not there and the operator must
 *   Repair it.
 * - `idle` (grey)      — deliberately paused, nothing wrong.
 *
 * `active` (blue) is NOT used here: in the session list blue is the unread-message
 * dot, so a blue project dot would read as "new message in this project".
 */
export type ProjectTone = 'idle' | 'working' | 'done' | 'danger';

/**
 * The one phrase every transitional project label is built from.
 *
 * Two things ride on saying it the same way every time. It is the only place the
 * overview reminds anyone that their code is running inside an isolated sandbox
 * rather than on the Server, and a vocabulary that says "sandbox" in one row,
 * "project" in the next and "container" in a third reads as three different
 * subsystems reporting rather than one. So: `<verb> secure workspace…`, always,
 * and short enough to survive a single line on a phone.
 */
const WORKSPACE = 'secure workspace';

export interface ProjectBadge {
  /** Short human label for the status pill / accessibility label — no Docker jargon. */
  label: string;
  tone: ProjectTone;
  /** Whether the status dot should pulse (Verity is working on the container). */
  pulsing: boolean;
  /** Whether the operator must act: surfaces the Repair action wherever the badge is shown. */
  needsRepair: boolean;
  /** Compact replacement for the dot when a stable lifecycle state has a
   * familiar symbol. The app maps this semantic value to its icon set. */
  symbol?: 'sleep';
}

// Exhaustive over ProjectLifecycleState: if the server's lifecycle union grows, this stops
// compiling until the new state is given a badge (no silently untyped project).
const BADGES: Record<ProjectLifecycleState, ProjectBadge> = {
  active: { label: 'Running', tone: 'done', pulsing: false, needsRepair: false },
  cloning: { label: 'Preparing repository…', tone: 'working', pulsing: true, needsRepair: false },
  container_starting: {
    label: `Starting ${WORKSPACE}…`,
    tone: 'working',
    pulsing: true,
    needsRepair: false,
  },
  sleeping_starting: {
    label: `Pausing ${WORKSPACE}…`,
    tone: 'working',
    pulsing: true,
    needsRepair: false,
  },
  sleeping: {
    label: 'Sleeping',
    tone: 'idle',
    pulsing: false,
    needsRepair: false,
    symbol: 'sleep',
  },
  waking: { label: `Waking ${WORKSPACE}…`, tone: 'working', pulsing: true, needsRepair: false },
  // `failed` is the only state the reconciler assigns to a project whose container
  // stopped or vanished, so it is always operator-actionable via Repair.
  failed: { label: 'Needs repair', tone: 'danger', pulsing: false, needsRepair: true },
  absent: { label: 'Paused', tone: 'idle', pulsing: false, needsRepair: false },
};

/** `absent` + `setupStatus === 'pending'`: onboarding hasn't provisioned yet, so the
 *  row is mid-setup rather than deliberately paused. */
const SETUP_BADGE: ProjectBadge = {
  label: `Preparing ${WORKSPACE}…`,
  tone: 'working',
  pulsing: true,
  needsRepair: false,
};

/** Exported so the project detail screen can label its own optimistic "rebuild
 *  pressed" state with the same words the badge would use once the server
 *  confirms it, instead of keeping a third copy of them. */
export const REBUILDING_PROJECT_BADGE: ProjectBadge = {
  label: `Rebuilding ${WORKSPACE}…`,
  tone: 'working',
  pulsing: true,
  needsRepair: false,
};

/** `sandboxUpdate.state === 'available'` with `selfRepair: 'converging'`: the
 *  Server is recreating this container onto the current image right now. That is
 *  Verity working on the container, so it takes the same magenta pulse as every
 *  other transition rather than a second, spinner-shaped progress vocabulary of
 *  its own. An update that has STOPPED moving on its own is not this — it keeps
 *  the row's action glyph (see `sandboxUpdateIndicator`), because there the
 *  operator has something to do. */
const UPDATING_BADGE: ProjectBadge = {
  label: `Updating ${WORKSPACE}…`,
  tone: 'working',
  pulsing: true,
  needsRepair: false,
};

/**
 * Whether Verity is recreating this project's container by itself, right now.
 *
 * The complement of {@link sandboxUpdateNeedsAttention}, and deliberately so: an
 * update either moves on its own (pulse, nothing to do) or has stopped moving
 * (glyph, something to do), never both. `turnBlocked` is excluded for that
 * reason — the recreate is ready and is holding off until a live turn ends, so
 * pulsing for it would promise a rebuild that is not running.
 */
export function sandboxUpdateConverging(update: SandboxUpdate | undefined): boolean {
  return update?.state === 'available' && update.selfRepair === 'converging' && !update.turnBlocked;
}

/** A session pinned to a project that `GET /projects` no longer returns. This can
 *  be a soft-deleted project, which the repair endpoint deliberately rejects.
 *  Keep the row visible for its sessions but do not advertise an invalid repair. */
export const UNAVAILABLE_PROJECT_BADGE: ProjectBadge = {
  label: 'Unavailable',
  tone: 'idle',
  pulsing: false,
  needsRepair: false,
};

/** Groups that are not backed by a project row at all (the default server workspace).
 *  Nothing to repair — there is no container lifecycle to report. */
export const UNTRACKED_PROJECT_BADGE: ProjectBadge = {
  label: 'Default workspace',
  tone: 'idle',
  pulsing: false,
  needsRepair: false,
};

/**
 * The badge for the project's lifecycle state alone, ignoring background work.
 *
 * Exported for the setup wizard, whose step number comes from the same lifecycle
 * state: an image rebuild or a container update can be in flight while cloning,
 * and a step labelled "Rebuilding secure workspace…" would number one thing and
 * name another. Everything the operator sees outside the wizard wants
 * {@link projectBadge}, which layers background work on top of this.
 */
export function projectLifecycleBadge(
  project: Pick<ProjectRecord, 'state' | 'lifecycleState'> & {
    setupStatus?: ProjectRecord['setupStatus'];
  },
): ProjectBadge {
  const state = project.lifecycleState ?? project.state;
  if (state === 'absent' && project.setupStatus === 'pending') return SETUP_BADGE;
  return BADGES[state];
}

/** Map a project's container lifecycle to its indicator descriptor. */
export function projectBadge(
  project: Pick<ProjectRecord, 'state' | 'lifecycleState'> & {
    setupStatus?: ProjectRecord['setupStatus'];
    provisionWarning?: ProjectRecord['provisionWarning'];
    sandboxUpdate?: ProjectRecord['sandboxUpdate'];
  },
): ProjectBadge {
  const badge = projectLifecycleBadge(project);
  // A container the reconciler marked `failed` is gone, whatever else was running
  // in the background when it went. Repair is the answer and it must reach both
  // the dot and the row's text, so neither override may bury it — a project that
  // still carries a rebuild warning used to render a reassuring magenta
  // "Rebuilding secure workspace…" over an error the operator had to act on.
  if (badge.needsRepair) return badge;
  if (
    project.provisionWarning != null &&
    project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING
  )
    return REBUILDING_PROJECT_BADGE;
  // Only over a settled, healthy container. Every other state already reports
  // work in progress, and the lifecycle transition the operator just triggered
  // is the more immediate answer to "what is happening".
  if (badge.tone === 'done' && sandboxUpdateConverging(project.sandboxUpdate))
    return UPDATING_BADGE;
  return badge;
}

/** Single source of truth for "show the Repair action", so the overview row and the
 *  project detail screen can't drift apart on when a project is broken. */
export function projectNeedsRepair(
  project: Pick<ProjectRecord, 'state' | 'lifecycleState'> & {
    setupStatus?: ProjectRecord['setupStatus'];
    provisionWarning?: ProjectRecord['provisionWarning'];
  },
): boolean {
  return projectBadge(project).needsRepair;
}
