import type { ProjectRecord, SessionSummary } from '@verity/mobile';

export function isLinkableSession(
  candidate: Pick<SessionSummary, 'sessionId' | 'projectId' | 'resumable'>,
  sessionId: string,
  projects: readonly Pick<ProjectRecord, 'id' | 'state' | 'kind'>[],
): boolean {
  return (
    candidate.sessionId !== sessionId &&
    candidate.projectId !== null &&
    candidate.resumable !== false &&
    projects.some(
      (project) =>
        project.id === candidate.projectId &&
        project.state === 'active' &&
        project.kind !== 'control_plane',
    )
  );
}
