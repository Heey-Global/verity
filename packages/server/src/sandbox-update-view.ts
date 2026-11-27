import type { ProjectRecord } from '@verity/store';
import type { ProjectActivityReason } from './project-idle-sleep.js';
import type { SandboxUpdateStatus } from './sandbox-updates.js';
import type { ServerDeps } from './server-deps.js';
import { NO_UNREPAIRED_SANDBOXES } from './server-support.js';
import type { SandboxRepairVerdicts } from './server-types.js';

/**
 * A project's sandbox update status as the project routes and the
 * `sandbox.update` event show it: the checker's comparison of image and
 * target, overlaid with what the provisioner knows about repairs, deferrals
 * and recovery. Both read it from here so that a device applying the event
 * sees exactly what a read would return.
 */
export function createSandboxUpdateView(deps: Pick<ServerDeps, 'provisioner'>) {
  /**
   * Qualify an update status with whether Verity's own repair is still working on it.
   *
   * The checker compares images and knows nothing about the reconciler, so it
   * always reports `converging`. Only the provisioner knows which projects the
   * automatic repair has given up on or will never pick up, and only that
   * distinction makes `state: 'available'` worth showing. A Server restart resumes
   * the existing Sandbox generation and queues its stale image until the project is
   * idle, so that waiting period is genuinely an in-flight automatic repair. Optional throughout —
   * a deployment whose provisioner does not reconcile (tests, non-relay setups)
   * keeps `converging`.
   *
   * Normally applied only to an `available` status. The deliberate exception is
   * a failed project the provisioner itself still owes a repair: its recreate may
   * already have removed the old container, so the image checker honestly says
   * `unknown` while the reconciler can still say, independently, that rebuilding
   * has stalled. Other unknowns (custom image, registry failure) remain unknown
   * and converging rather than acquiring a verdict nobody established.
   */
  const withSelfRepair = (
    project: ProjectRecord,
    status: SandboxUpdateStatus,
    verdicts: SandboxRepairVerdicts,
  ): SandboxUpdateStatus => {
    // Reported together, because they answer the same question — is this gap
    // closing on its own? — from the two sides the reconciler can be on. A
    // turn-blocked sandbox also reads `stalled` so that a client which knows
    // nothing of `turnBlocked` still surfaces it rather than showing the
    // reassuring spinner forever; one that does know reads the flag and names the
    // remedy. `available` only: a blocked update the checker cannot even see is
    // not something to report a turn about.
    const durable = deps.provisioner?.sandboxUpdateStates?.().get(project.id);
    const blocked =
      status.state === 'available' &&
      (verdicts.turnBlocked.has(project.id) || !!durable?.reasons.length);
    const unrepaired =
      verdicts.unrepaired.has(project.id) &&
      (status.state === 'available' || (project.state === 'failed' && status.state === 'unknown'));
    // One expression for both reasons, deliberately: they set the SAME two fields,
    // and split branches drifting apart is how a sandbox ends up reported as
    // blocked without the `stalled` that older clients read.
    // Carried with its time whatever the verdict: while a retry waits or builds,
    // the status is `converging` and the failure is plainly an earlier one.
    const failure = status.state === 'current' ? undefined : verdicts.lastFailures?.get(project.id);
    const scheduledTonight =
      !unrepaired &&
      status.state === 'available' &&
      durable?.reasons.length &&
      durable.reasons.every((reason) => reason === 'dev_server' || reason === 'preview');
    status = {
      ...status,
      ...(scheduledTonight ? { scheduledTonight: true } : {}),
      ...(blocked && durable && Date.now() - durable.since >= 24 * 60 * 60_000
        ? { overdue: true }
        : {}),
      ...((status.state === 'current' || durable?.recovery?.state === 'failed') && durable?.recovery
        ? { recovery: durable.recovery }
        : {}),
    };
    const withFailure =
      failure === undefined
        ? status
        : {
            ...status,
            lastRepairFailure: { at: new Date(failure.at).toISOString(), message: failure.message },
          };
    if (!unrepaired && !blocked) return withFailure;
    return {
      ...withFailure,
      selfRepair: 'stalled',
      turnBlocked: blocked,
      blockedBy: blocked
        ? [...(durable?.reasons ?? verdicts.blockers?.get(project.id) ?? [])].filter(
            (reason): reason is ProjectActivityReason =>
              ['turn', 'dev_server', 'preview', 'unknown'].includes(reason),
          )
        : [],
    };
  };
  const sandboxRepairVerdicts = (): SandboxRepairVerdicts => ({
    unrepaired: deps.provisioner?.unrepairedSandboxes?.() ?? NO_UNREPAIRED_SANDBOXES,
    turnBlocked: deps.provisioner?.turnBlockedSandboxes?.() ?? NO_UNREPAIRED_SANDBOXES,
    ...(deps.provisioner?.sandboxUpdateBlockers
      ? { blockers: deps.provisioner.sandboxUpdateBlockers() }
      : {}),
    ...(deps.provisioner?.sandboxRepairLastFailures
      ? { lastFailures: deps.provisioner.sandboxRepairLastFailures() }
      : {}),
  });
  return { withSelfRepair, sandboxRepairVerdicts };
}
