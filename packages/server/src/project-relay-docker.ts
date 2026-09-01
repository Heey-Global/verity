import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { DockerError, type ContainerSpec, type DockerClient } from './docker.js';
import { projectSocketBindingName, type InternalConnectionIdentity } from './internal-listener.js';
import {
  ProjectRelayStartError,
  type ProjectRelayRuntime,
  type ProjectRelayStartContext,
} from './project-relay-lifecycle.js';

const RELAY_BROKER_TARGET = '/run/verity-relay/broker';
const RELAY_CLAUDE_TARGET = '/run/verity-relay/claude';
const RELAY_CODEX_TARGET = '/run/verity-relay/codex';

/** Labels every relay container carries. They are the ONLY thing the superseded
 *  sweep below matches on, so a container Verity did not mint can never be a
 *  target. `docker-gc.ts` mirrors these for its own daily backstop pass. */
const COMPONENT_LABEL = 'verity.component';
const RELAY_COMPONENT = 'project-relay';
/** The value {@link COMPONENT_LABEL} carried before ADR 0013. Relays are found
 *  again only by label, so one minted by an older Verity is invisible to the
 *  sweep below unless it is named here — and would otherwise count as a sandbox
 *  in `servedGenerations`, vouching for its own generation and pinning itself in
 *  place for good. Matched for collection only; `spec.labels` always writes
 *  {@link RELAY_COMPONENT}. */
const LEGACY_RELAY_COMPONENT = 'project-broker-relay';
const SUPERSEDED_RELAY_MIN_AGE_MS = 30 * 60_000;
const PROJECT_ID_LABEL = 'verity.project-id';
const CONTAINER_GENERATION_LABEL = 'verity.container-generation';

export interface DockerProjectRelayOptions {
  docker: DockerClient;
  image: string;
  dataVolume: string;
  dataVolumeRoot: string;
  brokerSocketRoot: string;
  claudeSocketRoot: string;
  codexSocketRoot?: string;
  socketOwnerUid: number;
  relayGid: number;
  projectNetwork(projectId: string): string;
  validateSocketTree?: ((input: SocketTreeValidation) => boolean) | undefined;
  /** Warn sink for the best-effort sweep of superseded relays. Optional: a missing
   *  logger silences the warning, never the sweep. */
  log?: { warn(obj: unknown, msg?: string): void } | undefined;
}

interface SocketTreeValidation {
  dataVolumeRoot: string;
  socketRoot: string;
  bindingDirectory: string;
  socketPath: string;
  ownerUid: number;
  relayGid: number;
}

/** True for a relay Verity minted under either the current or the pre-ADR-0013
 *  component label. */
function isRelayComponent(component: string | undefined): boolean {
  return component === RELAY_COMPONENT || component === LEGACY_RELAY_COMPONENT;
}

/** Build the fixed, generation-labelled name without exposing project slugs. */
export function projectRelayContainerName(identity: InternalConnectionIdentity): string {
  const digest = createHash('sha256')
    .update(`verity-relay:${identity.projectId}\0${identity.containerGeneration}`)
    .digest('hex')
    .slice(0, 24);
  return `verity-relay-${digest}`;
}

/**
 * Docker adapter for the lifecycle transaction. It accepts socket paths only
 * when both live below Verity's mounted data-volume root, then exposes their
 * containing directories read-only at the relay's two compiled-in targets.
 */
export function createDockerProjectRelayStarter(
  options: DockerProjectRelayOptions,
): (context: ProjectRelayStartContext) => Promise<ProjectRelayRuntime> {
  return async (context) => {
    if (!/@sha256:[a-f0-9]{64}$/i.test(options.image)) {
      throw new Error('project relay image must be digest-pinned');
    }
    const name = projectRelayContainerName(context.identity);
    const validateSocketTree = options.validateSocketTree ?? isTrustedSocketTree;
    const brokerSubpath = exactSocketDirectorySubpath(
      context.brokerSocketPath,
      options.brokerSocketRoot,
      options.dataVolumeRoot,
      context.identity,
      'broker.sock',
      'broker',
      options.socketOwnerUid,
      options.relayGid,
      validateSocketTree,
    );
    const claudeSubpath = exactSocketDirectorySubpath(
      context.claudeSocketPath,
      options.claudeSocketRoot,
      options.dataVolumeRoot,
      context.identity,
      'claude.sock',
      'Claude',
      options.socketOwnerUid,
      options.relayGid,
      validateSocketTree,
    );
    const codexSubpath =
      context.codexSocketPath === undefined || options.codexSocketRoot === undefined
        ? undefined
        : exactSocketDirectorySubpath(
            context.codexSocketPath,
            options.codexSocketRoot,
            options.dataVolumeRoot,
            context.identity,
            'codex.sock',
            'Codex',
            options.socketOwnerUid,
            options.relayGid,
            validateSocketTree,
          );
    const spec: ContainerSpec = {
      image: options.image,
      name,
      network: options.projectNetwork(context.identity.projectId),
      user: `65532:${String(options.relayGid)}`,
      restartPolicy: 'no',
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=1m' },
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 32,
      memoryBytes: 64 * 1024 * 1024,
      nanoCpus: 250_000_000,
      labels: {
        [COMPONENT_LABEL]: RELAY_COMPONENT,
        [PROJECT_ID_LABEL]: context.identity.projectId,
        [CONTAINER_GENERATION_LABEL]: context.identity.containerGeneration,
      },
      volumeMounts: [
        {
          volume: options.dataVolume,
          target: RELAY_BROKER_TARGET,
          subpath: brokerSubpath,
          readOnly: true,
        },
        ...(codexSubpath === undefined
          ? []
          : [
              {
                volume: options.dataVolume,
                target: RELAY_CODEX_TARGET,
                subpath: codexSubpath,
                readOnly: true,
              },
            ]),
        {
          volume: options.dataVolume,
          target: RELAY_CLAUDE_TARGET,
          subpath: claudeSubpath,
          readOnly: true,
        },
      ],
    };

    if (context.resumeExisting === true) {
      const existing = await options.docker.inspectContainer(name);
      if (
        existing.labels?.[COMPONENT_LABEL] !== RELAY_COMPONENT ||
        existing.labels?.[PROJECT_ID_LABEL] !== context.identity.projectId ||
        existing.labels?.[CONTAINER_GENERATION_LABEL] !== context.identity.containerGeneration
      ) {
        throw new Error(`refusing to adopt mismatched project relay: ${name}`);
      }
      if (!existing.running) await options.docker.startContainer(existing.id);
      return containerRuntime(options.docker, existing.id);
    }

    const created = await createPullingIfMissing(options.docker, spec);
    try {
      await options.docker.startContainer(created.id);
    } catch (error) {
      const cleanup = await removeRelayContainer(options.docker, created.id);
      if (cleanup.length > 0) {
        throw new ProjectRelayStartError(
          `project relay start and rollback failed: ${context.identity.projectId}; ${cleanup.length} cleanup operation(s) failed`,
          containerRuntime(options.docker, created.id),
          error,
        );
      }
      throw error;
    }

    await sweepSupersededRelays(options, context.identity, created.id);
    return containerRuntime(options.docker, created.id);
  };
}

/**
 * Remove this project's relays from earlier generations, once the replacement is
 * up.
 *
 * `ProjectRelayLifecycle.stop` can only retire a relay THIS process started — it
 * closes over the runtime handle it holds in memory. After a control-plane
 * restart that map is empty, so the previous process's relays survive `stop` and
 * the reconciler's recreate then starts a second one beside each. Sweeping here
 * makes the recreate path self-healing: the relay adapter owns the
 * `verity-relay-*` namespace, so it is the one component that can recognise a
 * superseded sibling without in-memory state.
 *
 * Deliberately AFTER the new relay is running, and only when no sandbox still
 * carries the old generation and the relay is beyond the provisioning grace
 * period. The latter also keeps concurrent starts from deleting each other's
 * not-yet-attached relays.
 *
 * Scoped hard to `component=project-relay` AND this exact project id, so a
 * foreign container, another project's relay, and the generation just started are
 * all unreachable from here. Failures are logged, never thrown: a successful
 * start must not be reported as a failure because cleanup of an already-dead
 * generation did not go through. The daily GC (`docker-gc.ts`) re-attempts the
 * same removal from the daemon's own listing.
 */
async function sweepSupersededRelays(
  options: DockerProjectRelayOptions,
  identity: InternalConnectionIdentity,
  currentId: string,
): Promise<void> {
  if (options.docker.listContainers === undefined) return;
  try {
    const containers = await options.docker.listContainers();
    const servedGenerations = new Set(
      containers.flatMap((container) => {
        if (isRelayComponent(container.labels?.[COMPONENT_LABEL])) return [];
        const projectId = container.labels?.[PROJECT_ID_LABEL];
        const generation = container.labels?.[CONTAINER_GENERATION_LABEL];
        if (!projectId || !generation) return [];
        return [`${projectId}\0${generation}`];
      }),
    );
    const nowMs = Date.now();
    const superseded = containers.filter((container) => {
      const generation = container.labels?.[CONTAINER_GENERATION_LABEL];
      return (
        container.id !== currentId &&
        isRelayComponent(container.labels?.[COMPONENT_LABEL]) &&
        container.labels?.[PROJECT_ID_LABEL] === identity.projectId &&
        generation !== undefined &&
        generation.length > 0 &&
        generation !== identity.containerGeneration &&
        !servedGenerations.has(`${identity.projectId}\0${generation}`) &&
        container.created !== undefined &&
        nowMs - container.created * 1000 >= SUPERSEDED_RELAY_MIN_AGE_MS
      );
    });
    for (const relay of superseded) {
      const failures = await removeRelayContainer(options.docker, relay.id);
      if (failures.length > 0) {
        options.log?.warn(
          { projectId: identity.projectId, relay: relay.names?.[0] ?? relay.id, failures },
          'could not remove a superseded project relay',
        );
      }
    }
  } catch (error) {
    options.log?.warn(
      { projectId: identity.projectId, err: error },
      'could not list containers to sweep superseded project relays',
    );
  }
}

function containerRuntime(docker: DockerClient, id: string): ProjectRelayRuntime {
  return {
    async close(): Promise<void> {
      const failures = await removeRelayContainer(docker, id);
      if (failures.length > 0) {
        throw new AggregateError(failures, `project relay teardown failed: ${id}`);
      }
    },
  };
}

async function createPullingIfMissing(
  docker: DockerClient,
  spec: ContainerSpec,
): Promise<{ id: string }> {
  try {
    return await docker.createContainer(spec);
  } catch (error) {
    if (!(error instanceof DockerError && error.kind === 'image_not_found')) throw error;
    if (docker.pullImage === undefined) throw error;
    await docker.pullImage(spec.image);
    return docker.createContainer(spec);
  }
}

async function removeRelayContainer(docker: DockerClient, id: string): Promise<unknown[]> {
  const results = [
    await cleanupCall(() => docker.stopContainer(id)),
    await cleanupCall(() => docker.removeContainer(id)),
  ];
  return results.flatMap((result) => (result.ok ? [] : [result.error]));
}

async function cleanupCall(
  operation: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    if (error instanceof DockerError && error.kind === 'container_not_found') return { ok: true };
    return { ok: false, error };
  }
}

function exactSocketDirectorySubpath(
  socketPath: string,
  socketRoot: string,
  dataVolumeRoot: string,
  identity: InternalConnectionIdentity,
  socketName: string,
  label: string,
  ownerUid: number,
  relayGid: number,
  validateSocketTree: (input: SocketTreeValidation) => boolean,
): string {
  const expectedDirectory = resolve(socketRoot, projectSocketBindingName(identity));
  if (resolve(socketPath) !== join(expectedDirectory, socketName)) {
    throw new Error(`project relay ${label} socket is not bound to its project generation`);
  }
  if (
    !validateSocketTree({
      dataVolumeRoot: resolve(dataVolumeRoot),
      socketRoot: resolve(socketRoot),
      bindingDirectory: expectedDirectory,
      socketPath: resolve(socketPath),
      ownerUid,
      relayGid,
    })
  ) {
    throw new Error(`project relay ${label} socket directory is not trusted`);
  }
  const absoluteRoot = resolve(dataVolumeRoot);
  const absoluteDirectory = resolve(dirname(socketPath));
  const subpath = relative(absoluteRoot, absoluteDirectory);
  if (subpath === '' || subpath === '..' || subpath.startsWith(`..${sep}`)) {
    throw new Error(`project relay ${label} socket must be below the data-volume root`);
  }
  return subpath.split(sep).join('/');
}

function isTrustedSocketTree(input: SocketTreeValidation): boolean {
  try {
    if (
      realpathSync(input.dataVolumeRoot) !== input.dataVolumeRoot ||
      realpathSync(input.socketRoot) !== input.socketRoot ||
      realpathSync(input.bindingDirectory) !== input.bindingDirectory
    ) {
      return false;
    }
    const root = lstatSync(input.socketRoot);
    const binding = lstatSync(input.bindingDirectory);
    const socket = lstatSync(input.socketPath);
    return (
      root.isDirectory() &&
      !root.isSymbolicLink() &&
      root.uid === input.ownerUid &&
      (root.mode & 0o022) === 0 &&
      binding.isDirectory() &&
      !binding.isSymbolicLink() &&
      binding.uid === input.ownerUid &&
      binding.gid === input.relayGid &&
      (binding.mode & 0o777) === 0o710 &&
      socket.isSocket() &&
      !socket.isSymbolicLink() &&
      socket.uid === input.ownerUid &&
      socket.gid === input.relayGid &&
      (socket.mode & 0o777) === 0o660
    );
  } catch {
    return false;
  }
}
