import type { ProjectRecord } from '@verity/store';
import { DockerError, type ContainerInspect, type DockerClient } from './docker.js';
import {
  CONTAINER_GENERATION_LABEL,
  PROJECT_ID_LABEL,
  containerGenerationOf,
} from './project-relay-migration.js';
import type { ProjectRelayControl, ProvisionerOptions } from './provisioner.js';
import { RetainedResumeError } from './sandbox-retained-resume.js';

/**
 * Keeping the previous Sandbox while its replacement starts.
 *
 * A recreate used to remove the running Sandbox before the replacement had proven
 * it can start. When the replacement then failed — a devcontainer
 * `postCreateCommand` that rejects the new image is enough — the project was left
 * with no Sandbox at all, and neither Repair nor a rebuild could bring it back
 * while the cause persisted. Instead the previous container is parked: put to
 * sleep exactly as an idle Sandbox is, and renamed aside so the replacement can
 * take its name. If the replacement fails, the parked container is renamed back
 * and resumed through the same path as a wake. If it succeeds, the parked one is
 * removed.
 *
 * Parking needs what a wake needs, and nothing a protected generation would:
 * with project egress protection on, the host admits a single generation per
 * project and a wake always demands a fresh one, so those recreates keep the
 * remove-first behaviour.
 */

/** Infix of a parked Sandbox's name: `<containerName>--retained-<generation>`. */
export const RETAINED_SANDBOX_INFIX = '--retained-';

export function retainedSandboxName(containerName: string, generation: string): string {
  return `${containerName}${RETAINED_SANDBOX_INFIX}${generation}`;
}

/** A Sandbox container stopped and renamed aside while its replacement starts. */
export interface ParkedSandbox {
  containerId: string;
  generation: string;
  name: string;
  /** Sleep-compatibility fingerprint taken before parking; a restore requires it unchanged. */
  fingerprint: string;
}

export interface ReplacementRollbackHost {
  docker: DockerClient;
  projectRelay: ProjectRelayControl;
  store: Pick<ProvisionerOptions['store'], 'updateProjectState'>;
  /** The error a failed provisioning step reports. */
  failure(message: string, cause: unknown): Error;
  /** A failure as one short line, for project state and logs. */
  describe(error: unknown): string;
  /** Egress protection is off and the host holds no generation for the project. */
  egressIdle(projectId: string): Promise<boolean>;
  fingerprint(inspect: ContainerInspect): string;
  /** Revoke the Sandbox's authority and stop it, as for sleep. */
  quiesce(project: ProjectRecord): Promise<void>;
  /** Start a retained container again in place, as for wake, then `commit` it. */
  resume(
    project: ProjectRecord,
    inspect: ContainerInspect,
    generation: string,
    commit: () => Promise<void>,
  ): Promise<void>;
}

/** A parked Sandbox that can never be restored: it changed, or its name is taken by
 *  a container that is not the project's. Anything else may be transient. */
export class UnrestorableParkedSandbox extends Error {
  override readonly name = 'UnrestorableParkedSandbox';
}

/** Whether this recreate can keep the previous Sandbox, without touching anything. */
async function parkable(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
): Promise<{ inspect: ContainerInspect; generation: string } | undefined> {
  if (
    host.projectRelay.sleep === undefined ||
    host.projectRelay.reactivate === undefined ||
    host.docker.renameContainer === undefined
  )
    return undefined;
  let inspect: ContainerInspect;
  try {
    inspect = await host.docker.inspectContainer(project.containerName);
  } catch (error) {
    if (error instanceof DockerError && error.kind === 'container_not_found') return undefined;
    throw error;
  }
  const generation = containerGenerationOf(inspect);
  if (!inspect.running || inspect.labels?.[PROJECT_ID_LABEL] !== project.id || !generation)
    return undefined;
  if (!(await host.egressIdle(project.id).catch(() => false))) return undefined;
  return { inspect, generation };
}

/**
 * Park the running Sandbox so a replacement can start under its name. `undefined`
 * when this recreate cannot keep it: the caller then removes it as before.
 */
export async function parkSandboxForReplacement(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
): Promise<ParkedSandbox | undefined> {
  const candidate = await parkable(host, project);
  if (candidate === undefined) return undefined;
  const { inspect, generation } = candidate;
  const fingerprint = host.fingerprint(inspect);
  await host.quiesce(project);
  const name = retainedSandboxName(project.containerName, generation);
  try {
    await host.docker.renameContainer!(inspect.id, name);
  } catch (error) {
    // The caller removes the old container next; release its slept relay too.
    await host.projectRelay
      .discardGeneration?.({
        projectId: project.id,
        containerGeneration: generation,
      })
      .catch((cleanupError: unknown) => {
        console.warn(`Could not discard the slept relay: ${host.describe(cleanupError)}`);
      });
    throw error;
  }
  return { containerId: inspect.id, generation, name, fingerprint };
}

/** {@link parkSandboxForReplacement}, falling back to removing the Sandbox as before
 *  when parking itself fails. */
export async function parkForReplacement(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
): Promise<ParkedSandbox | undefined> {
  try {
    return await parkSandboxForReplacement(host, project);
  } catch (error) {
    console.warn(
      `Could not keep the Sandbox of ${project.id} during its replacement; replacing it without a fallback: ${host.describe(error)}`,
    );
    return undefined;
  }
}

/** Remove a parked Sandbox and its relay generation. Returns what could not be removed. */
export async function discardParkedSandbox(
  host: Pick<ReplacementRollbackHost, 'docker' | 'projectRelay'>,
  projectId: string,
  parked: Pick<ParkedSandbox, 'containerId' | 'generation'>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await host.docker.removeContainer(parked.containerId);
  } catch (error) {
    if (!(error instanceof DockerError && error.kind === 'container_not_found'))
      failures.push(error);
  }
  try {
    await host.projectRelay.discardGeneration?.({
      projectId,
      containerGeneration: parked.generation,
    });
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

/**
 * Put a parked Sandbox back into service under the project's container name. The
 * failed replacement may still hold that name (a start that failed before its
 * own rollback removed it); it is removed first, but only when it is this
 * project's own container.
 */
export async function restoreParkedSandbox(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
  parked: ParkedSandbox,
  /** Record the project as running again; part of the resume, so a failure rolls it back. */
  commit: () => Promise<void>,
): Promise<void> {
  let current: ContainerInspect | undefined;
  try {
    current = await host.docker.inspectContainer(project.containerName);
  } catch (error) {
    if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
  }
  if (current !== undefined && current.id !== parked.containerId) {
    if (current.labels?.[PROJECT_ID_LABEL] !== project.id)
      throw new UnrestorableParkedSandbox('a foreign container holds the Sandbox name');
    await host.docker.removeContainer(current.id);
  }
  const retained = await host.docker.inspectContainer(parked.containerId);
  if (
    retained.running ||
    retained.labels?.[PROJECT_ID_LABEL] !== project.id ||
    containerGenerationOf(retained) !== parked.generation ||
    host.fingerprint(retained) !== parked.fingerprint
  )
    throw new UnrestorableParkedSandbox('the parked Sandbox changed while its replacement started');
  const renamed = current?.id !== parked.containerId;
  if (renamed) await host.docker.renameContainer!(parked.containerId, project.containerName);
  try {
    await host.resume(project, retained, parked.generation, commit);
  } catch (error) {
    // The resume stopped it again. Back under its parked name it stays findable,
    // so a later pass can retry instead of a repair recreating over it.
    if (renamed)
      await host.docker.renameContainer!(parked.containerId, parked.name).catch(() => undefined);
    throw error;
  }
}

export type ReplacementOutcome =
  | { outcome: 'replaced'; project: ProjectRecord; leftovers: unknown[] }
  | { outcome: 'restored'; cause: unknown }
  | { outcome: 'lost'; cause: unknown; restoreError: unknown; leftovers: unknown[] };

/**
 * Run the replacement with the previous Sandbox parked. On success the parked one
 * is discarded; on failure it is restored, and if that fails too it is discarded
 * so nothing is left half-alive.
 */
export async function replaceWithParkedSandbox(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
  parked: ParkedSandbox,
  replace: () => Promise<ProjectRecord>,
  /** Record the project as running on its previous Sandbox, given why the replacement failed. */
  restored: (cause: unknown) => Promise<void>,
): Promise<ReplacementOutcome> {
  let replacement: ProjectRecord;
  try {
    replacement = await replace();
  } catch (cause) {
    try {
      // Protection turned on meanwhile: the parked generation would start outside it.
      if (!(await host.egressIdle(project.id).catch(() => false)))
        throw new UnrestorableParkedSandbox('project egress protection is on');
      await restoreParkedSandbox(host, project, parked, () => restored(cause));
      return { outcome: 'restored', cause };
    } catch (restoreError) {
      const leftovers = await discardParkedSandbox(host, project.id, parked);
      return { outcome: 'lost', cause, restoreError, leftovers };
    }
  }
  const leftovers = await discardParkedSandbox(host, project.id, parked);
  return { outcome: 'replaced', project: replacement, leftovers };
}

/**
 * {@link replaceWithParkedSandbox}, recording the outcome on the project: active on
 * the previous Sandbox with a warning that names the failure, or failed with both
 * errors when the previous Sandbox could not be resumed either. A failed
 * replacement still rejects, so callers (an update, a manual rebuild) report it.
 */
export async function replaceKeepingParked(
  host: ReplacementRollbackHost,
  project: ProjectRecord,
  parked: ParkedSandbox,
  run: () => Promise<ProjectRecord>,
): Promise<ProjectRecord> {
  const warning = (cause: unknown) =>
    `Sandbox update failed: ${host.describe(cause)}. The previous Sandbox was restored.`;
  const result = await replaceWithParkedSandbox(host, project, parked, run, async (cause) => {
    await host.store.updateProjectState(project.id, 'active', null, warning(cause));
  });
  if (result.outcome === 'replaced') {
    if (result.leftovers.length > 0)
      console.warn(
        `The previous Sandbox of ${project.id} was not fully removed after its replacement; the relay sweep removes what is left: ${result.leftovers.map((leftover) => host.describe(leftover)).join('; ')}`,
      );
    return result.project;
  }
  if (result.outcome === 'restored') throw host.failure(warning(result.cause), result.cause);
  const message = `${host.describe(result.cause)}; restoring the previous Sandbox failed: ${host.describe(result.restoreError)}`;
  await host.store.updateProjectState(project.id, 'failed', message);
  throw host.failure(
    message,
    new AggregateError([result.cause, result.restoreError, ...result.leftovers], message, {
      cause: result.cause,
    }),
  );
}

/** A parked Sandbox found in the daemon's inventory, e.g. after a Server restart. */
export interface RetainedSandboxRecord {
  containerId: string;
  generation: string;
}

/** Parked Sandboxes of `project` in a container inventory. */
export function retainedSandboxesOf(
  containers: Awaited<ReturnType<NonNullable<DockerClient['listContainers']>>>,
  project: Pick<ProjectRecord, 'id' | 'containerName'>,
): RetainedSandboxRecord[] {
  const prefix = `${project.containerName}${RETAINED_SANDBOX_INFIX}`;
  return containers.flatMap((container) => {
    const generation = container.labels?.[CONTAINER_GENERATION_LABEL];
    if (container.labels?.[PROJECT_ID_LABEL] !== project.id || !generation) return [];
    const named = (container.names ?? []).some(
      (name) => name.replace(/^\//, '') === `${prefix}${generation}`,
    );
    return named ? [{ containerId: container.id, generation }] : [];
  });
}

/** Whether a failed restore proves the parked Sandbox can never come back. */
function unrestorable(error: unknown): boolean {
  return (
    error instanceof UnrestorableParkedSandbox ||
    (error instanceof RetainedResumeError && error.relayMissing)
  );
}

/**
 * Restore or remove Sandboxes a recreate parked and never finished with — the
 * Server stopped between parking and the outcome. A project left without a
 * running Sandbox gets its parked one back; otherwise the parked one is removed
 * with its relay generation. A restore that fails for a reason that may pass (an
 * unavailable Docker API, a Runner that did not come up) keeps the parked Sandbox
 * for the next pass: it may be the only copy of the project's Sandbox. A recreate
 * still in flight owns its parked Sandbox and is left alone.
 */
export async function reconcileRetainedSandboxes(
  host: ReplacementRollbackHost,
  projects: readonly ProjectRecord[],
  hooks: {
    isProvisioning(projectId: string): boolean;
    /** Run a restore as the project's provisioning attempt. */
    serialize(project: ProjectRecord, restore: () => Promise<void>): Promise<void>;
  },
): Promise<void> {
  const containers = (await host.docker.listContainers?.()) ?? [];
  const failures: unknown[] = [];
  for (const project of projects) {
    if (hooks.isProvisioning(project.id)) continue;
    const retained = retainedSandboxesOf(containers, project);
    if (retained.length === 0) continue;
    let current: ContainerInspect | undefined;
    try {
      current = await host.docker.inspectContainer(project.containerName);
    } catch (error) {
      if (!(error instanceof DockerError && error.kind === 'container_not_found')) {
        failures.push(error);
        continue;
      }
    }
    // A stopped replacement may be new data or an interrupted startup. Preserve
    // both copies until normal repair establishes whether it can run.
    if (current !== undefined && !current.running) continue;
    // A running replacement owns the live name.
    // A vacant name can be left by a restart in any provisioning phase.
    const vacant = current === undefined;
    // Protection may have been turned on while the Server was down; a parked
    // generation would then start outside it.
    let restore = false;
    if (vacant) {
      try {
        restore = await host.egressIdle(project.id);
      } catch (error) {
        // Unknown protection state cannot justify destroying the only copy.
        failures.push(error);
        continue;
      }
    }
    let lost: string | undefined =
      vacant && !restore ? 'project egress protection is on' : undefined;
    for (const parked of retained) {
      if (restore) {
        restore = false;
        try {
          await hooks.serialize(project, async () => {
            // Another provision may have started during the inspect/egress awaits.
            if (hooks.isProvisioning(project.id)) throw new Error('provisioning');
            const inspect = await host.docker.inspectContainer(parked.containerId);
            // Its fingerprint from before the restart is gone; the name, label and
            // generation this Server gave it are what identify it.
            await restoreParkedSandbox(
              host,
              project,
              {
                ...parked,
                name: retainedSandboxName(project.containerName, parked.generation),
                fingerprint: host.fingerprint(inspect),
              },
              async () => {
                await host.store.updateProjectState(
                  project.id,
                  'active',
                  null,
                  'The Server restarted while this Sandbox was being replaced; the previous Sandbox was restored.',
                );
              },
            );
          });
          continue;
        } catch (error) {
          failures.push(error);
          if (!unrestorable(error)) continue;
          lost = host.describe(error);
        }
      }
      failures.push(...(await discardParkedSandbox(host, project.id, parked)));
    }
    // Nothing is left to run: say so instead of leaving the row claiming a Sandbox.
    if (lost !== undefined)
      await host.store.updateProjectState(
        project.id,
        'failed',
        `The Server restarted while this Sandbox was being replaced, and the previous Sandbox could not be restored: ${lost}`,
      );
  }
  if (failures.length > 0) throw new AggregateError(failures, 'parked Sandbox reconcile failed');
}
