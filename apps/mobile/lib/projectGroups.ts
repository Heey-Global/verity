import {
  codeHostForProject,
  sameSnapshotValue,
  type ForgeConnection,
  type ProjectRecord,
  type SessionSummary,
  type DevServer,
  type DevServerDetection,
  type RepoIdentity,
} from '@verity/mobile';
import type { ProjectPortLink } from '../components/ProjectPortChip';
import { devServerUrl } from './devServerUrl';
import { projectOverviewStatus, type ProjectOverviewStatus } from './projectSetup';

export type SessionProjectGroup = {
  id: string;
  title: string;
  subtitle: string;
  /** The single line the row says about what is happening to this project — a
   *  transition in flight, a failure, or an attention line. Shown INSTEAD of
   *  `subtitle`, which is metadata and can wait. */
  status?: ProjectOverviewStatus | undefined;
  portLinks: ProjectPortLink[];
  project?: ProjectRecord | undefined;
  /** Issue links must not invalidate session rows when project status changes. */
  repo?: RepoIdentity | undefined;
  // Set on an "orphan" group — sessions whose project is INACTIVE (`absent`, so
  // filtered out of `GET /projects`). We still hold its id, so the overview can
  // offer the "…" action into the detail screen (where Repair lives) instead of
  // stranding the sessions with no way back.
  inactiveProjectId?: string;
  sessions: SessionSummary[];
};

export function projectGroups(
  projects: ProjectRecord[],
  sessions: SessionSummary[],
  devServersByProject: Map<string, DevServer[]>,
  detectionsByProject: Map<string, DevServerDetection>,
  baseUrl: string | null,
  previous: SessionProjectGroup[] = [],
  connections: readonly ForgeConnection[] | null = null,
): SessionProjectGroup[] {
  const byProject = new Map<string | null, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.projectId ?? null;
    const bucket = byProject.get(key) ?? [];
    bucket.push(session);
    byProject.set(key, bucket);
  }

  const groups: SessionProjectGroup[] = projects.map((project) => {
    const detection = detectionsByProject.get(project.id);
    const portLinks = (devServersByProject.get(project.id) ?? []).flatMap((server) => {
      const url = baseUrl ? devServerUrl(baseUrl, server) : null;
      return server.running && server.hostPort && url
        ? [{ id: server.id, label: server.hostPort, url }]
        : [];
    });
    return {
      id: project.id,
      title: project.kind === 'control_plane' ? 'Verity Control' : project.repo,
      subtitle: project.latestReleaseTag ?? '',
      status: projectOverviewStatus(project, detection),
      portLinks,
      project,
      repo: repoIdentity(project, connections),
      sessions: byProject.get(project.id) ?? [],
    };
  });
  const defaultSessions = byProject.get(null) ?? [];
  if (defaultSessions.length > 0 || groups.length === 0) {
    groups.unshift({
      id: 'default',
      title: 'Default repository',
      subtitle: 'Verity server workspace',
      portLinks: [],
      sessions: defaultSessions,
    });
  }

  const knownProjects = new Set(projects.map((p) => p.id));
  for (const [projectId, projectSessions] of byProject) {
    if (projectId === null || knownProjects.has(projectId)) continue;
    groups.push({
      id: `orphan:${projectId}`,
      title: 'Inactive project',
      subtitle: 'Project unavailable',
      portLinks: [],
      inactiveProjectId: projectId,
      sessions: projectSessions,
    });
  }
  const previousById = new Map(previous.map((group) => [group.id, group]));
  const shared = groups.map((group) => {
    const old = previousById.get(group.id);
    if (!old) return group;
    if (sameSnapshotValue(old.project, group.project)) group.project = old.project;
    if (sameSnapshotValue(old.repo, group.repo)) group.repo = old.repo;
    if (sameSnapshotValue(old.status, group.status)) group.status = old.status;
    if (sameSnapshotValue(old.portLinks, group.portLinks)) group.portLinks = old.portLinks;
    if (
      group.sessions.length === old.sessions.length &&
      group.sessions.every((session, index) => session === old.sessions[index])
    )
      group.sessions = old.sessions;
    return group.title === old.title &&
      group.subtitle === old.subtitle &&
      group.project === old.project &&
      group.repo === old.repo &&
      group.status === old.status &&
      group.portLinks === old.portLinks &&
      group.sessions === old.sessions &&
      group.inactiveProjectId === old.inactiveProjectId
      ? old
      : group;
  });
  return shared.length === previous.length &&
    shared.every((group, index) => group === previous[index])
    ? previous
    : shared;
}

/** Owner/repo plus the web host for a repository project. A Forgejo project
 *  whose connection the app cannot see gets none, so its links stay inert
 *  rather than pointing at github.com. */
function repoIdentity(
  project: ProjectRecord,
  connections: readonly ForgeConnection[] | null,
): RepoIdentity | undefined {
  const host = codeHostForProject(project, connections);
  if (!host) return undefined;
  return {
    owner: project.owner,
    repo: project.repo,
    ...(host.provider === 'github'
      ? {}
      : { host: { provider: host.provider, baseUrl: host.baseUrl } }),
  };
}
