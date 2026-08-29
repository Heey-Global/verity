import {
  PROJECT_IMAGE_REBUILDING_WARNING,
  type DevServerDetection,
  type ProjectRecord,
} from '@verity/mobile';

export interface ProjectSetupStatus {
  label: string;
  step: number;
  total: number;
  intent: 'progress' | 'ready' | 'error';
}

export function projectSetupStatus(
  project: ProjectRecord,
  detection?: DevServerDetection | null,
): ProjectSetupStatus {
  switch (project.state) {
    case 'absent':
      return project.setupStatus === 'pending'
        ? { label: 'Preparing project…', step: 0, total: 5, intent: 'progress' }
        : { label: 'Paused', step: 0, total: 5, intent: 'ready' };
    case 'cloning':
      return { label: 'Preparing repository…', step: 1, total: 5, intent: 'progress' };
    case 'container_starting':
      return {
        label: 'Starting secure workspace…',
        step: 2,
        total: 5,
        intent: 'progress',
      };
    case 'failed':
      return { label: 'Project setup needs attention', step: 0, total: 5, intent: 'error' };
    case 'active': {
      if (!detection) {
        return { label: 'Detecting Dev Server…', step: 3, total: 5, intent: 'progress' };
      }
      const found = detection.suggestions.filter(({ status }) => status !== 'missing').length;
      return {
        label:
          found === 0
            ? 'No Dev Server found'
            : `${String(found)} Dev Server${found === 1 ? '' : 's'} found`,
        step: 4,
        total: 5,
        intent: 'ready',
      };
    }
  }
}

export function hasUnreviewedDevServers(detection?: DevServerDetection | null): boolean {
  return Boolean(
    detection &&
    detection.fingerprint !== detection.reviewedFingerprint &&
    detection.suggestions.some(({ status }) => status === 'new' || status === 'changed'),
  );
}

export function projectOverviewSetupLabel(
  project: ProjectRecord,
  detection?: DevServerDetection | null,
): string | undefined {
  // A failed project explains itself: the reconciler writes an operator-facing
  // reason ("Sandbox container stopped — Repair to restart it."), which says far
  // more than the generic setup-step label, so it wins over every other line here.
  if (project.state === 'failed')
    return project.provisionError ?? projectSetupStatus(project).label;
  if (project.setupStatus === 'pending') return projectSetupStatus(project, detection).label;
  if (project.state !== 'active') return projectSetupStatus(project).label;
  if (hasUnreviewedDevServers(detection)) return projectSetupStatus(project, detection).label;
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
export function hasActionableToolkitDrift(project: ProjectRecord): boolean {
  const drift = project.toolkitDrift;
  return drift?.verdict === 'drifted' && drift.carrier === 'devcontainer';
}

/**
 * The attention line for a project that is otherwise running fine.
 *
 * Kept separate from {@link projectOverviewSetupLabel} on purpose: that function
 * answers "where is setup", and correctly returns nothing for a healthy active
 * project. "This project is running, and something about it still needs looking
 * at" is a different question, and folding it into the setup label would make a
 * running project report a setup step it is not in.
 *
 * `provisionWarning` wins over drift when both apply: it is a specific finding
 * about this project's own provisioning run, while the drift verdict is a
 * statement about the toolkit its image was judged against.
 */
export function projectOverviewWarning(project: ProjectRecord): string | undefined {
  // A failed project already surfaces `provisionError` through the setup label,
  // and stacking a second attention line on the same row buries it.
  if (project.state === 'failed') return undefined;
  if (
    project.provisionWarning != null &&
    project.provisionWarning === PROJECT_IMAGE_REBUILDING_WARNING
  )
    return 'Rebuilding image…';
  if (project.provisionWarning) return project.provisionWarning;
  // Not "outdated" and not "will fail": toolkit identities are content hashes
  // with no ordering, and the identity covers the boundary policy too, so a
  // mismatch establishes that the recorded verdict was made under conditions
  // that no longer hold — stale, not refuted.
  if (hasActionableToolkitDrift(project)) return 'Sandbox toolkit needs re-checking';
  return undefined;
}

/**
 * The full drift explanation for the project's Environment panel, where there is
 * room to say what the verdict means and what — if anything — repairs it.
 *
 * Wider than {@link hasActionableToolkitDrift} on purpose. The overview chip is
 * a call to action and so narrows to the population a repair fixes; this is the
 * screen someone opens *about this project*, and there "no verdict was ever
 * recorded" and "this needs a new base image" are both answers worth having.
 *
 * The two carriers are never merged into one sentence: re-provisioning rebuilds
 * and re-attests a `devcontainer` image, but for a `base-image` project it only
 * re-attests — it cannot change what the image contains. Saying otherwise would
 * send half the fleet through a rebuild that cannot fix them.
 */
export function toolkitDriftNotice(project: ProjectRecord): string | undefined {
  const drift = project.toolkitDrift;
  if (!drift) return undefined;
  if (drift.verdict === 'matches') return undefined;
  if (drift.verdict === 'unknown') {
    // Deliberately does not name a cause. `unknown` covers three of them — the
    // image was never compared, the comparison failed, or the server could not
    // read its own toolkit to compare against — and the wire carries no way to
    // tell them apart. Naming one would be wrong two thirds of the time; what
    // is true in all three is that nothing rules drift out.
    //
    // For the same reason it says nothing about what this project has on
    // record: when the server cannot read its own bundle, a project with a
    // perfectly good recorded identity still lands here, and telling its owner
    // that nothing is recorded would send them after their own environment for
    // a fault on the other side of the comparison.
    return (
      'This environment has not been compared against a verified sandbox toolkit, ' +
      'so drift cannot be ruled out.'
    );
  }
  const remedy =
    drift.carrier === 'devcontainer'
      ? 'Repairing this environment rebuilds and re-attests it.'
      : 'Repairing re-attests it, but cannot change what the image contains — if its toolkit ' +
        'is genuinely stale, only a rebuilt base image fixes it.';
  return (
    'This environment was last verified against a different toolkit or boundary policy than ' +
    'this server ships, so its attestation verdict no longer holds and needs re-checking. ' +
    remedy
  );
}

export function hasPendingProjectSetup(projects: ProjectRecord[]): boolean {
  return projects.some(
    ({ setupStatus, state }) =>
      state !== 'failed' &&
      (setupStatus === 'pending' || state === 'cloning' || state === 'container_starting'),
  );
}
