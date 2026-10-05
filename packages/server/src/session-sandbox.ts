import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { ProjectRecord } from '@verity/store';
import {
  DockerError,
  type ContainerInspect,
  type ContainerSpec,
  type DockerClient,
} from './docker.js';

export const SESSION_SANDBOX_LABEL = 'verity.session-id';
export function sessionContainerName(sessionId: string): string {
  return `verity-session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

export function sessionNodeModulesVolumeName(sessionId: string): string {
  return `${sessionContainerName(sessionId)}-node-modules`;
}

export interface SessionSandboxInput {
  sessionId: string;
  project: ProjectRecord;
  worktree: string;
  /** Private runtime and credential mounts, prepared by the trusted server. */
  runtimeMounts?: NonNullable<ContainerSpec['volumeMounts']>;
  runtimeBinds?: string[];
  env?: string[];
  workspaceMount?: NonNullable<ContainerSpec['volumeMounts']>[number];
}

const READ_ONLY_TARGETS = new Set([
  '/run/verity-control-identity',
  '/run/verity/gh-token-capability',
  '/run/verity/ssh/signing_broker_token',
  '/run/verity/claude-egress/ca.crt',
  '/run/verity/claude-egress/client.crt',
  '/run/verity/claude-egress/client.key',
  '/run/verity/codex/config.toml',
  '/run/verity/opencode-config',
  '/opt/agent-seed',
  '/etc/profile.d/gh-token.sh',
  '/etc/resolv.conf',
  '/knowledge',
  '/knowledge/shared',
  '/run/verity/ssh/known_hosts',
  '/run/verity/ssh/allowed_signers',
  '/run/verity/ssh/id_ed25519.pub',
  '/home/dev/.ssh/known_hosts',
  '/home/dev/.ssh/allowed_signers',
  '/home/dev/.ssh/id_ed25519.pub',
]);

/** Inherit only reviewed read-only infrastructure; never inherit the parent workspace. */
export function sessionSandboxSpec(
  parent: ContainerInspect,
  input: SessionSandboxInput,
): ContainerSpec {
  if (
    !parent.image ||
    !parent.mounts ||
    parent.privileged !== false ||
    parent.deviceCount !== 0 ||
    parent.capAdd?.some(
      (capability) => !['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP'].includes(capability),
    ) ||
    parent.networkMode === 'host' ||
    parent.networkMode?.startsWith('container:')
  ) {
    throw new Error('Project sandbox cannot safely provide an isolated session template');
  }
  const binds: string[] = [];
  const volumeMounts: NonNullable<ContainerSpec['volumeMounts']> = [];
  for (const mount of parent.mounts) {
    const target = mount.destination;
    if (!target) throw new Error('Sandbox mount has no destination');
    if (
      target === '/var/run/docker.sock' ||
      target === '/srv/verity/sessions' ||
      target === '/work' ||
      target === '/work/.git/config' ||
      target === '/work/node_modules' ||
      target === '/run/verity-runner'
    )
      continue;
    if (
      (mount.readWrite !== false && target !== '/knowledge/insights') ||
      (!READ_ONLY_TARGETS.has(target) && target !== '/knowledge/insights')
    ) {
      throw new Error(`Unsupported shared sandbox mount: ${target}`);
    }
    if (mount.type === 'volume' && mount.name) {
      volumeMounts.push({
        volume: mount.name,
        target,
        readOnly: mount.readWrite === false,
        ...(mount.subpath ? { subpath: mount.subpath } : {}),
      });
    } else if (mount.type === 'bind' && mount.source) {
      binds.push(`${mount.source}:${target}${mount.readWrite === false ? ':ro' : ''}`);
    } else throw new Error(`Unsupported sandbox mount type: ${target}`);
  }
  if (input.workspaceMount) {
    if (input.workspaceMount.target !== '/work' || input.workspaceMount.readOnly) {
      throw new Error('Session workspace mount must be writable at /work');
    }
    volumeMounts.push(input.workspaceMount);
  } else binds.push(`${input.worktree}:/work`);
  binds.push(...(input.runtimeBinds ?? []));
  volumeMounts.push(...(input.runtimeMounts ?? []));
  volumeMounts.push({
    volume: sessionNodeModulesVolumeName(input.sessionId),
    target: '/work/node_modules',
  });
  const inheritedEnv = (parent.env ?? []).filter(
    (entry) =>
      !entry.startsWith('VERITY_SESSION_ID=') &&
      !entry.startsWith('VERITY_ISOLATED_SESSION_ID=') &&
      !entry.startsWith('VERITY_SIGNING_DOCKER_CONTAINER=') &&
      !entry.startsWith('VERITY_GH_TOKEN_DOCKER_CONTAINER=') &&
      !entry.startsWith('VERITY_NODE_MODULES_INSTALL='),
  );
  const spec: ContainerSpec = {
    name: sessionContainerName(input.sessionId),
    image: parent.imageId ?? parent.image,
    binds,
    volumeMounts,
    labels: {
      ...parent.labels,
      [SESSION_SANDBOX_LABEL]: input.sessionId,
      'verity.project-id': input.project.id,
    },
    env: [
      ...inheritedEnv,
      ...(input.env ?? []),
      `VERITY_SESSION_ID=${input.sessionId}`,
      `VERITY_ISOLATED_SESSION_ID=${input.sessionId}`,
      `VERITY_SIGNING_DOCKER_CONTAINER=${sessionContainerName(input.sessionId)}`,
      `VERITY_GH_TOKEN_DOCKER_CONTAINER=${sessionContainerName(input.sessionId)}`,
    ],
    ...(parent.user ? { user: parent.user } : {}),
    ...(parent.entrypoint ? { entrypoint: parent.entrypoint } : {}),
    ...(parent.command ? { command: parent.command } : {}),
    ...(parent.runtime ? { runtime: parent.runtime } : {}),
    ...(parent.networkMode ? { network: parent.networkMode } : {}),
    additionalNetworks: Object.keys(parent.networks ?? {}).filter(
      (network) => network !== parent.networkMode,
    ),
    ...(parent.extraHosts ? { extraHosts: parent.extraHosts } : {}),
    ...(parent.sysctls ? { sysctls: parent.sysctls } : {}),
    capDrop: ['ALL'],
    ...(parent.ulimits ? { ulimits: parent.ulimits } : {}),
    ...(parent.capAdd ? { capAdd: parent.capAdd } : {}),
    securityOpt: parent.securityOpt ?? ['no-new-privileges:true'],
    ...(parent.groupAdd ? { groupAdd: parent.groupAdd } : {}),
    ...(parent.memoryBytes ? { memoryBytes: parent.memoryBytes } : {}),
    ...(parent.memorySwapBytes !== undefined ? { memorySwapBytes: parent.memorySwapBytes } : {}),
    ...(parent.nanoCpus ? { nanoCpus: parent.nanoCpus } : {}),
    ...(parent.cpuShares ? { cpuShares: parent.cpuShares } : {}),
    ...(parent.pidsLimit ? { pidsLimit: parent.pidsLimit } : {}),
    ...(parent.tmpfs ? { tmpfs: parent.tmpfs } : {}),
    ...(parent.readOnlyRootfs !== undefined ? { readOnlyRootfs: parent.readOnlyRootfs } : {}),
    ...(parent.init !== undefined ? { init: parent.init } : {}),
    restartPolicy: 'unless-stopped',
  };
  spec.labels!['verity.session-contract'] = createHash('sha256')
    .update(JSON.stringify(spec))
    .digest('hex');
  return spec;
}

export interface SessionSandboxProvisionerOptions {
  docker: DockerClient;
  dataVolumeName?: string;
  dataVolumeRoot: string;
  prepareRuntime: (
    project: ProjectRecord,
    sessionId: string,
    runtimePath: string,
  ) => Promise<{
    binds?: string[];
    volumeMounts?: NonNullable<ContainerSpec['volumeMounts']>;
    env?: string[];
  }>;
  bootstrap: (
    project: ProjectRecord,
    runtimePath: string,
    workspace: { path: string; waitForPostCreate: boolean; freshContainer: boolean },
  ) => Promise<void>;
}

export class SessionSandboxProvisioner {
  private readonly pending = new Map<string, Promise<ProjectRecord>>();
  constructor(private readonly options: SessionSandboxProvisionerOptions) {}
  private get docker(): DockerClient {
    return this.options.docker;
  }
  runtimePath(sessionId: string, projectId: string): string {
    if (!projectId) throw new Error('Project ID is required');
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID');
    return join(this.options.dataVolumeRoot, 'runners', `session-${sessionId}`);
  }
  ensure(
    project: ProjectRecord,
    session: { sessionId: string; worktree: string },
  ): Promise<ProjectRecord> {
    const input = { ...session, project };
    const existing = this.pending.get(input.sessionId);
    if (existing) return existing;
    const operation = this.ensureOnce(input).finally(() => this.pending.delete(input.sessionId));
    this.pending.set(input.sessionId, operation);
    return operation;
  }
  private async ensureOnce(input: SessionSandboxInput): Promise<ProjectRecord> {
    const name = sessionContainerName(input.sessionId);
    const runtimePath = this.runtimePath(input.sessionId, input.project.id);
    const prepared = await this.options.prepareRuntime(input.project, input.sessionId, runtimePath);
    const runtime: ProjectRecord = { ...input.project, containerName: name, state: 'active' };
    const toVolume = (source: string, target: string) => {
      const subpath = relative(this.options.dataVolumeRoot, source);
      if (subpath.startsWith('..') || subpath.startsWith('/'))
        throw new Error('Session path escapes data volume');
      return { volume: this.options.dataVolumeName!, target, subpath };
    };
    const isolatedInput: SessionSandboxInput = {
      ...input,
      ...(this.options.dataVolumeName
        ? {
            workspaceMount: toVolume(input.worktree, '/work'),
            runtimeBinds: prepared.binds ?? [],
            runtimeMounts: [
              ...(prepared.volumeMounts ?? []),
              toVolume(runtimePath, '/run/verity-runner'),
            ],
          }
        : {
            runtimeBinds: [...(prepared.binds ?? []), `${runtimePath}:/run/verity-runner`],
            runtimeMounts: prepared.volumeMounts ?? [],
          }),
      ...(prepared.env ? { env: prepared.env } : {}),
    };
    if (!this.docker.ensureVolume) throw new Error('Private dependency volumes are unavailable');
    await this.docker.ensureVolume(sessionNodeModulesVolumeName(input.sessionId), {
      labels: { [SESSION_SANDBOX_LABEL]: input.sessionId, 'verity.project-id': input.project.id },
    });
    const parent = await this.docker.inspectContainer(input.project.containerName);
    const spec = sessionSandboxSpec(parent, isolatedInput);
    let freshContainer = false;
    try {
      const current = await this.docker.inspectContainer(name);
      if (
        current.labels?.[SESSION_SANDBOX_LABEL] !== input.sessionId ||
        current.labels['verity.project-id'] !== input.project.id
      ) {
        throw new Error('Session sandbox ownership mismatch');
      }
      if (
        (current.imageId ?? current.image) !== spec.image ||
        current.labels['verity.session-contract'] !== spec.labels!['verity.session-contract']
      ) {
        if (current.running) await this.docker.stopContainer(name);
        await this.docker.removeContainer(name);
        throw new DockerError({ kind: 'container_not_found', id: name });
      }
      if (
        current.privileged !== false ||
        current.deviceCount !== 0 ||
        !current.env?.includes(`VERITY_ISOLATED_SESSION_ID=${input.sessionId}`) ||
        !current.capDrop?.includes('ALL') ||
        JSON.stringify([...(current.capAdd ?? [])].sort()) !==
          JSON.stringify([...(spec.capAdd ?? [])].sort()) ||
        JSON.stringify([...(current.securityOpt ?? [])].sort()) !==
          JSON.stringify([...(spec.securityOpt ?? [])].sort())
      ) {
        throw new Error('Session sandbox security contract mismatch');
      }
      const expected = [
        ...(spec.binds ?? []).map((bind) => {
          const [source, destination, mode] = bind.split(':');
          return { type: 'bind', source, destination, readWrite: mode !== 'ro' };
        }),
        ...(spec.volumeMounts ?? []).map((mount) => ({
          type: 'volume',
          name: mount.volume,
          destination: mount.target,
          subpath: mount.subpath,
          readWrite: !mount.readOnly,
        })),
      ];
      if (
        !current.mounts ||
        current.mounts.length !== expected.length ||
        expected.some(
          (mount) =>
            !current.mounts!.some(
              (actual) =>
                actual.type === mount.type &&
                actual.destination === mount.destination &&
                actual.readWrite === mount.readWrite &&
                (mount.type === 'bind'
                  ? actual.source === ('source' in mount ? mount.source : undefined)
                  : actual.name === ('name' in mount ? mount.name : undefined) &&
                    (actual.subpath ?? '') === ('subpath' in mount ? (mount.subpath ?? '') : '')),
            ),
        )
      ) {
        throw new Error('Session sandbox mount contract mismatch');
      }
      if (!current.running) await this.docker.startContainer(name);
    } catch (error) {
      if (!(error instanceof DockerError) || error.kind !== 'container_not_found') throw error;
      await this.docker.createContainer(spec);
      freshContainer = true;
      try {
        await this.docker.startContainer(name);
      } catch (cause) {
        await this.docker.removeContainer(name).catch(() => undefined);
        throw cause;
      }
    }
    await this.options.bootstrap(runtime, runtimePath, {
      path: input.worktree,
      freshContainer,
      waitForPostCreate: (spec.command ?? []).some((command) =>
        command.includes('/tmp/verity-post-create-complete'),
      ),
    });
    return runtime;
  }
  async stop(sessionId: string, projectId: string): Promise<void> {
    await this.pending.get(sessionId)?.catch(() => undefined);
    const name = sessionContainerName(sessionId);
    try {
      const current = await this.docker.inspectContainer(name);
      if (
        current.labels?.[SESSION_SANDBOX_LABEL] !== sessionId ||
        current.labels['verity.project-id'] !== projectId
      )
        throw new Error('Session sandbox ownership mismatch');
      if (current.running) await this.docker.stopContainer(name);
      if ((await this.docker.inspectContainer(name)).running)
        throw new Error('Session sandbox did not stop');
    } catch (error) {
      if (!(error instanceof DockerError) || error.kind !== 'container_not_found') throw error;
    }
  }
  async remove(sessionId: string): Promise<void> {
    await this.pending.get(sessionId)?.catch(() => undefined);
    const name = sessionContainerName(sessionId);
    try {
      const current = await this.docker.inspectContainer(name);
      if (current.labels?.[SESSION_SANDBOX_LABEL] !== sessionId)
        throw new Error('Session sandbox ownership mismatch');
      await this.docker.removeContainer(name);
    } catch (error) {
      if (!(error instanceof DockerError) || error.kind !== 'container_not_found') throw error;
    }
    await this.docker.removeVolume?.(sessionNodeModulesVolumeName(sessionId));
  }
}
