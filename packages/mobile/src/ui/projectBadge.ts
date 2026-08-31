import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';

import type { ProjectRecord, ProjectState } from '../api.js';

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

export interface ProjectBadge {
  /** Short human label for the status pill / accessibility label — no Docker jargon. */
  label: string;
  tone: ProjectTone;
  /** Whether the status dot should pulse (Verity is working on the container). */
  pulsing: boolean;
  /** Whether the operator must act: surfaces the Repair action wherever the badge is shown. */
  needsRepair: boolean;
}

// Exhaustive over ProjectState: if the server's state union grows, this stops
// compiling until the new state is given a badge (no silently untyped project).
const BADGES: Record<ProjectState, ProjectBadge> = {
  active: { label: 'Running', tone: 'done', pulsing: false, needsRepair: false },
  cloning: { label: 'Preparing repository…', tone: 'working', pulsing: true, needsRepair: false },
  container_starting: { label: 'Starting…', tone: 'working', pulsing: true, needsRepair: false },
  // `failed` is the only state the reconciler assigns to a project whose container
  // stopped or vanished, so it is always operator-actionable via Repair.
  failed: { label: 'Needs repair', tone: 'danger', pulsing: false, needsRepair: true },
  absent: { label: 'Paused', tone: 'idle', pulsing: false, needsRepair: false },
};

/** `absent` + `setupStatus === 'pending'`: onboarding hasn't provisioned yet, so the
 *  row is mid-setup rather than deliberately paused. */
const SETUP_BADGE: ProjectBadge = {
  label: 'Preparing project…',
  tone: 'working',
  pulsing: true,
  needsRepair: false,
};

const REBUILDING_BADGE: ProjectBadge = {
  label: 'Rebuilding…',
  tone: 'working',
  pulsing: true,
  needsRepair: false,
};

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

/** Map a project's container lifecycle to its indicator descriptor. */
export function projectBadge(
  project: Pick<ProjectRecord, 'state'> & {
    setupStatus?: ProjectRecord['setupStatus'];
    provisionWarning?: ProjectRecord['provisionWarning'];
  },
): ProjectBadge {
  if (
    project.provisionWarning != null &&
    project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING
  )
    return REBUILDING_BADGE;
  if (project.state === 'absent' && project.setupStatus === 'pending') return SETUP_BADGE;
  return BADGES[project.state];
}

/** Single source of truth for "show the Repair action", so the overview row and the
 *  project detail screen can't drift apart on when a project is broken. */
export function projectNeedsRepair(
  project: Pick<ProjectRecord, 'state'> & {
    setupStatus?: ProjectRecord['setupStatus'];
    provisionWarning?: ProjectRecord['provisionWarning'];
  },
): boolean {
  return projectBadge(project).needsRepair;
}
