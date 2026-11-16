import type { EventStore, ProjectRecord, SessionRecord } from '@verity/store';

/** Explicit Pause removes the sandbox; automatic sleep retains background monitoring. */
export function permitsBackgroundPr(project: ProjectRecord | undefined): boolean {
  return project !== undefined && project.hiddenAt === null && project.state !== 'absent';
}

export async function sessionPermitsBackgroundPr(
  store: Pick<EventStore, 'getProject'>,
  session: SessionRecord,
): Promise<boolean> {
  return (
    session.projectId === null || permitsBackgroundPr(await store.getProject(session.projectId))
  );
}

/** Lifecycle timestamps also detect pause/resume between two monitor ticks. */
export function createPrBackgroundPolicy(options: {
  store: Pick<EventStore, 'getProject'>;
  invalidate(session: SessionRecord): void;
}) {
  const generations = new Map<string, string>();
  return {
    async allows(session: SessionRecord): Promise<boolean> {
      if (session.projectId === null) return true;
      const project = await options.store.getProject(session.projectId);
      const generation = `${session.projectId}:${project?.state}:${project?.stateChangedAt.getTime()}:${project?.hiddenAt?.getTime()}`;
      const previous = generations.get(session.worktree);
      if (previous !== generation) {
        generations.set(session.worktree, generation);
        options.invalidate(session);
      }
      return permitsBackgroundPr(project);
    },
    prune(live: ReadonlySet<string>): void {
      for (const key of generations.keys()) if (!live.has(key)) generations.delete(key);
    },
  };
}
