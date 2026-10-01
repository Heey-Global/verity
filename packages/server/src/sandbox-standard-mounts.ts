import { join } from 'node:path';

/** One mount contract for provisioning and public-preview eligibility. */
export const STANDARD_MOUNTS = {
  workspace: { target: '/work', writable: true },
  gitConfig: { target: '/work/.git/config', writable: false },
  agentSeed: { target: '/opt/agent-seed', writable: false },
  disabledTokenScript: { target: '/etc/profile.d/gh-token.sh', writable: false },
  runner: { target: '/run/verity-runner', writable: true },
  knowledge: { target: '/knowledge', writable: false },
  insights: { target: '/knowledge/insights', writable: true },
  sharedKnowledge: { target: '/knowledge/shared', writable: false },
  dns: { target: '/etc/resolv.conf', writable: false },
} as const;
export const DEFAULT_AGENT_SEED_SOURCE = '/opt/agent-seed';

export type StandardMount = keyof typeof STANDARD_MOUNTS;

export function standardMountBind(kind: StandardMount, source: string): string {
  const mount = STANDARD_MOUNTS[kind];
  return `${source}:${mount.target}${mount.writable ? '' : ':ro'}`;
}

export function standardDataMountPaths(projectId: string, workspaceSubpath: string) {
  return {
    workspace: workspaceSubpath,
    gitConfig: `${workspaceSubpath}/.git/config`,
    runner: `runners/${projectId}`,
    knowledge: `knowledge/${projectId}`,
    insights: `knowledge/${projectId}/insights`,
    sharedKnowledge: 'knowledge/shared',
    dns: `secrets/dns/resolv.${projectId}.conf`,
  } as const;
}

export function standardKnowledgeBinds(dataRoot: string, projectId: string): string[] {
  const paths = standardDataMountPaths(projectId, '');
  return (['knowledge', 'insights', 'sharedKnowledge'] as const).map((kind) =>
    standardMountBind(kind, join(dataRoot, paths[kind])),
  );
}

export const PUBLIC_SSH_MOUNTS = {
  'id_ed25519.pub': ['/home/dev/.ssh/id_ed25519.pub', '/run/verity/ssh/id_ed25519.pub'],
  known_hosts: ['/home/dev/.ssh/known_hosts', '/run/verity/ssh/known_hosts'],
  allowed_signers: ['/home/dev/.ssh/allowed_signers', '/run/verity/ssh/allowed_signers'],
} as const;

export function publicSshBinds(
  filename: keyof typeof PUBLIC_SSH_MOUNTS,
  source: string,
  includeHome: boolean,
): string[] {
  return PUBLIC_SSH_MOUNTS[filename]
    .filter((_target, index) => includeHome || index > 0)
    .map((target) => `${source}:${target}:ro`);
}

export const GATEWAY_MOUNTS = {
  codex: { directory: '/run/verity/codex', subdir: 'codex', filename: 'config.toml', mode: 0o644 },
  opencode: {
    directory: '/run/verity/opencode-config',
    subdir: 'opencode',
    filename: 'opencode.json',
    mode: 0o644,
  },
} as const;
