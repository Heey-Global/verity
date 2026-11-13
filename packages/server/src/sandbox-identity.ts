import { createHash } from 'node:crypto';

/**
 * Everything that names one person's sandbox in a project (ADR 0023 §4). The
 * container is the credential boundary, so every per-container resource — the
 * container, its network, its node_modules volume and its Runner runtime
 * directory — is named per sandbox.
 *
 * The project's original sandbox keeps the names it had before sandboxes were
 * per person, so an upgrade recreates nothing. Every other sandbox appends a
 * person tag derived from a hash of the user id: stable, path- and DNS-safe, and
 * revealing nothing about the person.
 */
export interface SandboxIdentity {
  projectId: string;
  userId: string;
  projectDefault: boolean;
  containerName: string;
  networkName: string;
  nodeModulesVolume: string;
  /** Relative to the data volume root. */
  runnerDir: string;
}

/** `u` + 16 hex characters of SHA-256(userId). */
export function sandboxPersonTag(userId: string): string {
  return `u${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16)}`;
}

/** The project network of the original sandbox; see {@link sandboxIdentity}. */
export function projectNetworkName(projectId: string): string {
  const clean = projectId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return `verity-proj-${clean.length > 0 ? clean : 'x'}`;
}

export function projectNodeModulesVolumeName(projectId: string): string {
  return projectNetworkName(projectId).replace(/^verity-proj-/, 'verity-node-modules-');
}

/** The network of one sandbox; see {@link sandboxIdentity}. */
export function sandboxNetworkName(sandbox: {
  projectId: string;
  userId: string;
  projectDefault: boolean;
}): string {
  return sandbox.projectDefault
    ? projectNetworkName(sandbox.projectId)
    : `${projectNetworkName(sandbox.projectId)}--${sandboxPersonTag(sandbox.userId)}`;
}

export function sandboxIdentity(
  project: { id: string; containerName: string },
  sandbox: { userId: string; projectDefault: boolean },
): SandboxIdentity {
  const base = {
    projectId: project.id,
    userId: sandbox.userId,
    projectDefault: sandbox.projectDefault,
  };
  if (sandbox.projectDefault) {
    return {
      ...base,
      containerName: project.containerName,
      networkName: projectNetworkName(project.id),
      nodeModulesVolume: projectNodeModulesVolumeName(project.id),
      runnerDir: `runners/${project.id}`,
    };
  }
  const tag = sandboxPersonTag(sandbox.userId);
  return {
    ...base,
    containerName: `${project.containerName}--${tag}`,
    networkName: sandboxNetworkName({ ...base }),
    nodeModulesVolume: `${projectNodeModulesVolumeName(project.id)}--${tag}`,
    runnerDir: `runners/${tag}/${project.id}`,
  };
}

/**
 * The key under which in-memory state of one sandbox is held (relays, locks,
 * leases). The project's original sandbox keeps its project id as key, so state
 * held for it before sandboxes were per person keeps its meaning.
 */
export function sandboxKey(sandbox: {
  projectId: string;
  userId: string;
  projectDefault: boolean;
}): string {
  return sandbox.projectDefault
    ? sandbox.projectId
    : `${sandbox.projectId}#${sandboxPersonTag(sandbox.userId)}`;
}
