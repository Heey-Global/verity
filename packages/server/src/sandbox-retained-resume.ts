import { join } from 'node:path';
import type { ProjectRecord } from '@verity/store';
import { recordAgentGatewayProjection } from './agent-gateway-projection.js';
import type { ContainerCommandRunner } from './devcontainer-lifecycle.js';
import { DockerError, type ContainerInspect } from './docker.js';
import { SIGNING_BROKER_TOKEN_HASH_LABEL } from './git-signer.js';
import type { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { projectRelayContainerName } from './project-relay-identity.js';
import { projectDefaultSandboxUser } from './project-sandbox.js';
import type { ProvisionerOptions } from './provisioner.js';
import { RUNNER_RUNTIME_GID, RUNNER_RUNTIME_UID } from './runner-boundary-attestation.js';
import { originalSandbox, type ProjectRelayBinding } from './project-relay-lifecycle.js';
import { STANDARD_MOUNTS } from './sandbox-standard-mounts.js';

/** In-container path of the read-only GitHub-token-broker capability file. The
 *  credential helper / gh wrapper read it to authenticate to the token broker. */
export const GH_BROKER_CAPABILITY_FILE = '/run/verity/gh-token-capability';
/** In-container path of the Claude egress client key, readable by the Runner only. */
export const CLAUDE_EGRESS_KEY_FILE = '/run/verity/claude-egress/client.key';
const RUNNER_RUNTIME_TARGET = STANDARD_MOUNTS.runner.target;

/** What resuming a retained Sandbox needs from the provisioner that owns it. */
export interface RetainedResumeHost {
  opts: Pick<
    ProvisionerOptions,
    | 'docker'
    | 'projectRelay'
    | 'store'
    | 'gitSecretRoot'
    | 'claudeEgressIdentity'
    | 'claudeConnectorPort'
    | 'runnerSupervisor'
    | 'dataVolumeRoot'
    | 'dockerHostForBuild'
    | 'runnerRuntimeUid'
    | 'runnerRuntimeGid'
    | 'onContainerStarted'
    | 'beforeRunnerAdmission'
  >;
  containerCommand: ContainerCommandRunner;
  relayBinding(
    project: ProjectRecord,
    generation: string,
    egress: ProjectEgressLifecycle | undefined,
  ): Promise<ProjectRelayBinding>;
  rewriteMountedSecretFile(path: string, contents: string, mode: number): void;
  chownRunnerFile(path: string, ownership: { uid: number; gid: number }): void;
  supervisorReachable(runtimePath: string): Promise<void>;
  /** Forget what the previous start of this Sandbox established. */
  sandboxStarted(project: ProjectRecord): void;
  notifyRunnerReady(project: ProjectRecord): void;
}

/** A resume that did not complete. Its own cleanup already ran: the container is
 *  stopped again and the authority it was given is revoked, unless
 *  {@link cleanupFailures} says otherwise. */
export class RetainedResumeError extends Error {
  constructor(
    override readonly cause: unknown,
    /** The generation's relay container no longer exists, so it can never resume. */
    readonly relayMissing: boolean,
    readonly cleanupFailures: readonly unknown[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RetainedResumeError';
  }
}

/**
 * Start a stopped Sandbox container again in place: wake its relay generation with
 * fresh capabilities, rewrite the secrets mounted into it, start it and bring up
 * its Runner. Shared by wake (a Sandbox put to sleep) and by the restore of a
 * Sandbox that was parked while its replacement started.
 *
 * The caller has proven that `inspect` is the exact retained container, owned by
 * the project, named `project.containerName`, and of `generation`.
 */
export async function resumeRetainedSandbox<T>(
  host: RetainedResumeHost,
  target: {
    project: ProjectRecord;
    inspect: ContainerInspect;
    generation: string;
    egress: ProjectEgressLifecycle | undefined;
    /** Record the Sandbox as running. Inside the resume, so a failure to record it
     *  rolls the start back like any other failure. */
    commit: () => Promise<T>;
  },
): Promise<T> {
  const { project, inspect, generation, egress } = target;
  const relay = host.opts.projectRelay;
  if (relay.reactivate === undefined) throw new Error('project relay does not support wake');
  const reactivate = relay.reactivate.bind(relay);
  let relayAwake = false;
  let relayMissing = false;
  try {
    const activation = await reactivate(await host.relayBinding(project, generation, egress)).catch(
      (error: unknown) => {
        // The retained relay is adopted by its generation-derived name. When
        // it no longer exists (removed by host maintenance, a manual cleanup
        // or an older GC), this generation can never be resumed in place.
        relayMissing =
          error instanceof DockerError &&
          error.kind === 'container_not_found' &&
          error.id ===
            projectRelayContainerName({
              projectId: project.id,
              containerGeneration: generation,
            });
        throw error;
      },
    );
    relayAwake = true;
    if (host.opts.gitSecretRoot !== undefined) {
      const mountedDestinations = new Set(
        (inspect.mounts ?? []).map((mount) => mount.destination).filter(Boolean),
      );
      const oldSigningDigest = inspect.labels?.[SIGNING_BROKER_TOKEN_HASH_LABEL];
      if (oldSigningDigest !== undefined) {
        host.rewriteMountedSecretFile(
          join(host.opts.gitSecretRoot, 'git', `signing_broker_token.${oldSigningDigest}`),
          activation.signingCapability,
          0o600,
        );
      }
      if (mountedDestinations.has(GH_BROKER_CAPABILITY_FILE)) {
        host.rewriteMountedSecretFile(
          join(host.opts.gitSecretRoot, 'git', `gh_token_capability.${project.id}`),
          activation.githubCapability,
          0o600,
        );
      }
      if (
        host.opts.claudeEgressIdentity !== undefined &&
        mountedDestinations.has(CLAUDE_EGRESS_KEY_FILE)
      ) {
        const material = await host.opts.claudeEgressIdentity.sandboxMaterial({
          projectId: project.id,
          userId: await projectDefaultSandboxUser(host.opts.store, project.id),
        });
        host.rewriteMountedSecretFile(
          join(host.opts.gitSecretRoot, 'claude-egress', `egress_ca.${project.id}.crt`),
          material.caCertPem,
          0o644,
        );
        host.rewriteMountedSecretFile(
          join(host.opts.gitSecretRoot, 'claude-egress', `egress_client.${project.id}.crt`),
          material.clientCertPem,
          0o644,
        );
        const keyPath = join(
          host.opts.gitSecretRoot,
          'claude-egress',
          `egress_client.${project.id}.key`,
        );
        host.rewriteMountedSecretFile(keyPath, material.clientKeyPem, 0o600);
        host.chownRunnerFile(keyPath, {
          uid: host.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID,
          gid: host.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID,
        });
        // Sleep revoked the certificate this container was created with, so
        // the one just written in place has a new fingerprint while the
        // container's immutable label still names the revoked one. Record
        // which fingerprint this exact container and generation now holds;
        // without it the woken Sandbox fails Agent Gateway readiness on
        // every turn and is pushed into a full recreate it does not need.
        recordAgentGatewayProjection(host.opts.gitSecretRoot, {
          projectId: project.id,
          containerId: inspect.id,
          containerGeneration: generation,
          fingerprint256: material.fingerprint256,
        });
      }
    }
    if (egress !== undefined) {
      await egress.start(
        { projectId: project.id, containerGeneration: generation },
        'sandbox',
        inspect.id,
      );
      const identity = { projectId: project.id, containerGeneration: generation };
      const address = await egress.connect(identity);
      if (
        !inspect.extraHosts?.length ||
        inspect.extraHosts.some((entry) => !entry.endsWith(`:${address}`))
      ) {
        await egress.prepare(identity);
        throw new Error('Retained relay projection differs from host transport binding');
      }
    } else await host.opts.docker.startContainer(inspect.id);
    const running = await host.opts.docker.inspectContainer(project.containerName);
    if (!running.running) throw new Error('Docker did not report the Sandbox as running');
    host.sandboxStarted(project);
    await host.opts.onContainerStarted?.(project);

    const runnerRuntimePath =
      host.opts.runnerSupervisor === true && host.opts.dataVolumeRoot !== undefined
        ? join(host.opts.dataVolumeRoot, 'runners', project.id)
        : undefined;
    const connectorEnabled =
      host.opts.claudeEgressIdentity !== undefined &&
      host.opts.claudeConnectorPort !== undefined &&
      host.opts.gitSecretRoot !== undefined;
    if ((runnerRuntimePath !== undefined || connectorEnabled) && host.opts.dockerHostForBuild) {
      await host.containerCommand({
        containerName: project.containerName,
        dockerHost: host.opts.dockerHostForBuild,
        user:
          runnerRuntimePath !== undefined
            ? `0:${String(host.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`
            : `${String(host.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}:${String(host.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`,
        workdir: runnerRuntimePath !== undefined ? RUNNER_RUNTIME_TARGET : '/',
        command:
          runnerRuntimePath !== undefined
            ? 'verity-runner-stack-start'
            : 'verity-egress-connector-start --standalone',
      });
    }
    if (runnerRuntimePath !== undefined) {
      await host.supervisorReachable(runnerRuntimePath);
      host.notifyRunnerReady(project);
    }
    await host.opts.beforeRunnerAdmission?.(project);
    return await target.commit();
  } catch (cause) {
    await egress
      ?.prepare({ projectId: project.id, containerGeneration: generation })
      .catch(() => undefined);
    const cleanup = await Promise.allSettled([
      host.opts.docker.stopContainer(project.containerName),
      ...(relayAwake && relay.sleep !== undefined
        ? [relay.sleep(originalSandbox(project.id))]
        : []),
      ...(host.opts.claudeEgressIdentity === undefined
        ? []
        : [host.opts.claudeEgressIdentity.revokeProject(project.id)]),
    ]);
    const cleanupFailures: unknown[] = [];
    for (const result of cleanup) {
      if (result.status === 'rejected') cleanupFailures.push(result.reason as unknown);
    }
    throw new RetainedResumeError(cause, relayMissing, cleanupFailures);
  }
}
