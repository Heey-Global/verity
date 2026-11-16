import {
  removeLegacyProjectNetwork,
  removePersonalSandboxNetwork,
} from './project-network-cleanup.js';
import { originalSandbox } from './project-relay-lifecycle.js';
import {
  projectNodeModulesVolumeName,
  sandboxIdentity,
  sandboxPersonTag,
} from './sandbox-identity.js';
import { PROJECT_TEARDOWN_REASON } from './project-state.js';
import { backupLifecycle } from './backup/lifecycle.js';
import { statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Kysely } from 'kysely';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ClaudeEgressIdentityService } from './claude-egress-identity.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { Database, EventStore, ProjectRecord } from '@verity/store';
import { DockerError, type DockerClient } from './docker.js';
import { getProjectInTx, updateProjectStateInTx, withProjectLock } from './project-persistence.js';
import { ProvisioningError, projectClonePath, type ProjectRelayControl } from './provisioner.js';

/** Deprovision a project (§19.8): stop + remove the container, transition the
 *  store row back to `state='absent'`. Optionally `purge=true` ALSO removes the
 *  bind-mount clone path (irreversibly — the operator explicitly chose this;
 *  the design says keep is the default, force-clean is explicit). */
export interface Deprovisioner {
  deprovision(projectId: string, opts: { purge: boolean }): Promise<ProjectRecord>;
}

/** Run `task` under a deadline. A task that never settles keeps running — there
 *  is nothing to cancel it with — but it stops being awaited, which is what the
 *  caller needs: a teardown that hangs must not hold the deletion open forever.
 *
 *  `task` is invoked INSIDE the promise chain so a synchronous throw surfaces as
 *  a rejection rather than escaping past the deadline. */
async function withTimeout(task: () => unknown, ms: number, label: string): Promise<void> {
  const running = (async () => {
    await task();
  })();
  // The race is over once the deadline wins, so a rejection arriving after it
  // has no handler left. Claim it here to keep it off `unhandledRejection`.
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class DeprovisionerImpl implements Deprovisioner {
  constructor(
    private readonly store: EventStore,
    private readonly db: Kysely<Database>,
    private readonly docker: DockerClient,
    private readonly cloneRoot: string,
    /** Probe used only by the purge steps. "Nothing there" is the normal answer
     *  for an already-cleaned project, but any OTHER stat failure — EACCES on a
     *  parent directory, an I/O error — means a directory may well exist and be
     *  left behind, so it propagates to the purge step's reporter instead of
     *  passing for "already gone". */
    private readonly isDir: (p: string) => boolean = (p) => {
      try {
        return statSync(p).isDirectory();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw cause;
      }
    },
    private readonly removeDir: (p: string) => void = (p) =>
      rmSync(p, { recursive: true, force: true }),
    /** GitHub-token broker registry (security review). When present, deprovision
     *  revokes the project's capability so a leaked capability stops redeeming at
     *  the broker immediately on teardown, not only on server restart. */
    private readonly ghTokenCapabilities?: GhTokenCapabilityRegistry | undefined,
    /** Persistent per-project Runner roots. Purge removes the matching project
     * directory; keep-mode deliberately retains it for later reattach/reprovision. */
    private readonly runnerRuntimeRoot?: string | undefined,
    /** Claude-egress identity service. When present, deprovision drops the
     *  project's client certificate so a copy that leaked out of the torn-down
     *  sandbox can no longer authenticate to the egress gateway. */
    private readonly claudeEgressIdentity?: ClaudeEgressIdentityService | undefined,
    /** Stop the generation-bound relay before completing deprovision. */
    private readonly projectRelay?: Pick<ProjectRelayControl, 'stop'> | undefined,
    /** Fence externally reachable generation-bound resources through teardown. */
    private readonly withTeardown?:
      | ((project: ProjectRecord, mutation: () => Promise<ProjectRecord>) => Promise<ProjectRecord>)
      | undefined,
    /** Report a resource-cleanup step that failed. Those steps are best-effort
     *  (see {@link deprovisionProject}), so this is the only place their failure
     *  becomes visible — wire it to the server log. Credential revocation is not
     *  reported here: it stays fail-closed and surfaces as a rejected request. */
    private readonly onTeardownFailure?:
      ((project: ProjectRecord, step: string, cause: unknown) => void) | undefined,
    /** Commit-signing capability registry. Revoked fail-closed on teardown so a
     *  leaked capability cannot keep signing once the project is gone — the
     *  relay's own revocation rides on a best-effort `stop`, so this repeats it. */
    private readonly signingCapabilities?: SigningCapabilityRegistry | undefined,
    /** Per-step budget for teardown. A step that never settles would block the
     *  deletion exactly as durably as one that throws — the relay's `stop` queues
     *  behind an in-flight start, and a filesystem call can block on stuck I/O —
     *  so every step is bounded and the deprovision moves on. Generous by
     *  design: the Docker client already caps its own calls at 30s. */
    private readonly teardownStepTimeoutMs: number = 60_000,
  ) {}

  async deprovision(projectId: string, opts: { purge: boolean }): Promise<ProjectRecord> {
    // Read the row up front (unlocked) to know what to tear down.
    const project = await this.store.getProject(projectId);
    if (project === undefined) {
      throw new ProvisioningError('project gone mid-deprovision');
    }
    const teardown = () => this.deprovisionProject(projectId, project, opts);
    return backupLifecycle.mutate([projectId], () =>
      this.withTeardown ? this.withTeardown(project, teardown) : teardown(),
    );
  }

  private async deprovisionProject(
    projectId: string,
    project: ProjectRecord,
    opts: { purge: boolean },
  ): Promise<ProjectRecord> {
    // A failed or interrupted deletion must never look like an accidentally lost container.
    await withProjectLock(this.db, projectId, async (tx) => {
      await updateProjectStateInTx(tx, projectId, 'failed', PROJECT_TEARDOWN_REASON);
      await tx.deleteFrom('sandbox_repair_intents').where('project_id', '=', projectId).execute();
    });
    // Best-effort teardown runs OUTSIDE the `SELECT … FOR UPDATE` lock — the
    // same rule the provision path follows (git clone + docker create/start are
    // unlocked, §19.3). Docker stop/remove can BLOCK for a long time on a stuck
    // container or a busy daemon; holding those awaits inside the lock would pin
    // the projects-row lock `idle in transaction`, pile up every other project
    // write behind it, and exhaust the server's DB pool — hanging even simple
    // reads (e.g. /onboarding/status, the app's launch gate).
    //
    // Teardown splits into two classes, and the split is a security boundary.
    //
    // (1) RESOURCE CLEANUP is best-effort. Stopping a container, closing the
    // relay's listeners, and removing the clone/runtime directories reclaim
    // host resources; none of them is what authorizes a sandbox. These are also
    // the steps that fail for reasons no retry can fix — a wedged Docker daemon,
    // a clone directory whose files the sandbox user owns (EACCES). Letting one
    // of those throw used to abort the whole request: `DELETE /projects/:id`
    // hides the row only AFTER this resolves, so the project was never deleted,
    // and every retry re-ran the same failing step — permanently undeletable.
    // Failures are reported through `onTeardownFailure` so the leftover
    // container or directory is visible in the log and can be cleaned up by
    // hand. A 404 (container already gone) is not a failure at all.
    //
    // (2) CREDENTIAL REVOCATION below stays fail-closed and DOES abort the
    // deprovision. Those are the authorities a copy that leaked out of the
    // sandbox can still redeem, so hiding a project whose capabilities are
    // unrevoked would turn a delete into silent, lasting access. Each is a
    // DELETE against the very database the state transition and `hideProject`
    // must write to next, so a failure that persists across retries is a
    // database outage — under which the deletion could not have completed
    // anyway. Blocking here therefore costs no deletability that was not
    // already lost, and it is deliberately NOT relaxed to keep a project
    // removable.
    const bounded = (step: string, run: () => unknown): Promise<void> =>
      withTimeout(run, this.teardownStepTimeoutMs, `teardown step '${step}'`);
    const bestEffort = async (
      step: string,
      run: () => unknown,
      ignore: (cause: unknown) => boolean = () => false,
    ): Promise<void> => {
      try {
        await bounded(step, run);
      } catch (cause) {
        if (ignore(cause)) return;
        // The reporter is the last thing standing between a swallowed failure
        // and the log; a throwing logger must not resurrect the abort this
        // whole branch exists to prevent.
        try {
          this.onTeardownFailure?.(project, step, cause);
        } catch {
          // Nowhere left to report to.
        }
      }
    };
    const containerGone = (cause: unknown): boolean =>
      cause instanceof DockerError && cause.kind === 'container_not_found';

    await bestEffort(
      'container-stop',
      () => this.docker.stopContainer(project.containerName),
      containerGone,
    );
    await bestEffort(
      'container-remove',
      () => this.docker.removeContainer(project.containerName),
      containerGone,
    );
    // `stop` revokes the relay's signing + GitHub capabilities AND closes its
    // listeners/runtime, reporting either kind of failure as one AggregateError,
    // so its throw does not say which half failed. Swallow it for the listeners'
    // sake and re-run both capability revocations below, fail-closed — a relay
    // socket that outlives a revoked capability serves nothing.
    //
    // The bound frees THIS request, not the relay: `ProjectRelayLifecycle`
    // serializes per project id, and a `stop` that never settles leaves that
    // project's tail unresolved. So a later restore of the same id (the row and
    // its id survive the soft delete) queues its relay start behind the wedged
    // tail, and `close()` — which drains every tail — waits on it too. Both
    // follow from the wedge itself and predate this branch: any relay operation
    // that hangs does the same, whoever started it. What changes here is that
    // the deletion no longer joins the queue, and the timeout is reported
    // through `onTeardownFailure`, so the wedged relay is in the log instead of
    // showing up later as an unexplained hang.
    await bestEffort('relay-stop', () => this.projectRelay?.stop(originalSandbox(project.id)));
    await bestEffort('network-remove', () => removeLegacyProjectNetwork(this.docker, project.id));
    // Every person's own sandbox of the project goes with it (ADR 0023 §4): its
    // container, relay and network now, its runtime and volume on purge below.
    // Their capabilities and certificates are revoked project-wide further down.
    const personalSandboxes = (await this.store.projectSandboxes.list(project.id))
      .filter((sandbox) => !sandbox.projectDefault)
      .map((sandbox) => sandboxIdentity(project, sandbox));
    for (const sandbox of personalSandboxes) {
      const tag = sandboxPersonTag(sandbox.userId);
      await bestEffort(
        `personal-container-stop ${tag}`,
        () => this.docker.stopContainer(sandbox.containerName),
        containerGone,
      );
      await bestEffort(
        `personal-container-remove ${tag}`,
        () => this.docker.removeContainer(sandbox.containerName),
        containerGone,
      );
      await bestEffort(`personal-relay-stop ${tag}`, () =>
        this.projectRelay?.stop({
          projectId: project.id,
          userId: sandbox.userId,
          projectDefault: false,
        }),
      );
      await bestEffort(`personal-network-remove ${tag}`, () =>
        removePersonalSandboxNetwork(this.docker, project.id, sandbox.networkName, tag),
      );
      await bestEffort(`personal-sandbox-state ${tag}`, () =>
        this.store.projectSandboxes.setState(project.id, sandbox.userId, 'absent'),
      );
    }
    // The purge seams are synchronous by type (`statSync`/`rmSync` by default),
    // and no timer in the process — including this step's own bound — fires
    // while a synchronous call blocks the event loop. The bound therefore
    // covers only what an injected async seam awaits; a filesystem call that
    // truly wedges would have to be moved off the main thread to be
    // interruptible at all, which is a separate change and not one this branch
    // regresses (the same `rmSync` ran here before). What this branch does fix
    // is the failure mode that actually occurs: a purge that THROWS — EACCES on
    // files owned by the sandbox user is the common one — is reported and no
    // longer aborts the deletion.
    if (opts.purge) {
      const clonePath = projectClonePath(this.cloneRoot, project);
      await bestEffort('clone-purge', () => {
        if (this.isDir(clonePath)) this.removeDir(clonePath);
      });
      if (this.runnerRuntimeRoot !== undefined) {
        const runtimePath = join(this.runnerRuntimeRoot, project.id);
        await bestEffort('runner-runtime-purge', () => {
          if (this.isDir(runtimePath)) this.removeDir(runtimePath);
        });
      }
      // After container-remove above: the daemon refuses to remove a volume a
      // container still references. Named, so the disk GC never reclaims it —
      // this is its only way out.
      await bestEffort('node-modules-volume-remove', () =>
        this.docker.removeVolume?.(projectNodeModulesVolumeName(project.id)),
      );
      for (const sandbox of personalSandboxes) {
        const tag = sandboxPersonTag(sandbox.userId);
        if (this.runnerRuntimeRoot !== undefined) {
          // `<runners>/<tag>/<projectId>`: the person's other projects stay.
          const runtimePath = join(this.runnerRuntimeRoot, tag, project.id);
          await bestEffort(`personal-runner-runtime-purge ${tag}`, () => {
            if (this.isDir(runtimePath)) this.removeDir(runtimePath);
          });
        }
        await bestEffort(`personal-node-modules-volume-remove ${tag}`, () =>
          this.docker.removeVolume?.(sandbox.nodeModulesVolume),
        );
      }
    }

    // Every authority the sandbox held, revoked together. Each call is STARTED
    // before any one of them is awaited (the rule `ProjectRelayLifecycle.teardown`
    // follows): these registries are independent, so a wedged one must not stop
    // the others from being revoked — sequential awaits would leave a leaked
    // GitHub capability redeeming just because the signing registry was slow.
    // Failures are aggregated and rethrown so the caller still fails closed.
    //
    //  - signing: a leaked copy stops signing through the broker. Redundant with
    //    a successful `relay.stop`, which is exactly the point — that call is
    //    best-effort above, so this is the one that has to hold.
    //  - github: a capability that leaked out of the (now torn-down) sandbox can
    //    no longer redeem installation tokens.
    //  - claude-egress: a leaked client key can no longer authenticate to the
    //    egress gateway.
    // Each call goes through a thunk: a registry that throws SYNCHRONOUSLY —
    // before it ever returns the promise its signature advertises — would
    // otherwise escape while the array is still being built, and take the
    // revocations after it with it. The same bound as the cleanup steps applies,
    // but it resolves the opposite way: a revocation that never settles becomes
    // a failure, so the deletion is refused rather than hanging the request.
    const revoke = (name: string, run: () => Promise<void> | undefined): Promise<void> =>
      withTimeout(run, this.teardownStepTimeoutMs, `${name} revocation`);
    const revocations = await Promise.allSettled([
      revoke('signing capability', () => this.signingCapabilities?.revokeProject(project.id)),
      revoke('github capability', () => this.ghTokenCapabilities?.revokeProject(project.id)),
      revoke('claude-egress identity', () => this.claudeEgressIdentity?.revokeProject(project.id)),
    ]);
    const revocationFailures = revocations.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (revocationFailures.length > 0) {
      throw new AggregateError(
        revocationFailures,
        `project credential revocation failed: ${project.id}`,
      );
    }

    // Only the state-machine transition runs under the row lock — a short
    // critical section with no external I/O, so it cannot hang the pool.
    return withProjectLock(this.db, projectId, async (tx) => {
      const current = await getProjectInTx(tx, projectId);
      if (current === undefined) {
        throw new ProvisioningError('project gone mid-deprovision');
      }
      const updated = await updateProjectStateInTx(tx, projectId, 'absent');
      return updated as ProjectRecord;
    });
  }
}
