import type { ProjectRecord, RepositoryIssues, VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { Row } from '../ui';
import { useTaskPreferences } from '../../lib/taskPreferences';
import { useTasks } from '../../lib/tasksStore';

/** Open issues across the repositories that answered, named by their code host
 *  when they share one; null while none has answered. */
export function issueSummary(
  repositories: RepositoryIssues[],
): { count: number; host: 'GitHub' | 'Forgejo' | null } | null {
  const answered = repositories.filter((repository) => repository.status === 'ok');
  if (answered.length === 0) return null;
  const kinds = new Set(answered.map((repository) => repository.kind));
  return {
    count: answered.reduce((sum, repository) => sum + repository.issues.length, 0),
    host: kinds.size > 1 ? null : kinds.has('forgejo') ? 'Forgejo' : 'GitHub',
  };
}

/** "3 open · 5 GitHub issues"; issues only once a code host answered for the project. */
export function projectTasksLine(
  open: number,
  issues: { count: number; host: 'GitHub' | 'Forgejo' | null } | null,
): string {
  const tasks = open === 0 ? 'No open tasks' : `${String(open)} open`;
  if (issues === null) return tasks;
  const noun = issues.count === 1 ? 'issue' : 'issues';
  return `${tasks} · ${String(issues.count)} ${issues.host === null ? '' : `${issues.host} `}${noun}`;
}

/**
 * The project's tasks on its Overview: how many of the operator's own tasks are
 * open here and, with GitHub connected, how many issues — the same store and
 * issue read as the list behind the V. A tap opens the project's Tasks screen.
 */
export function ProjectTasksRow({
  client,
  project,
}: {
  client: VerityClient;
  project: Pick<ProjectRecord, 'id' | 'kind' | 'owner' | 'repo'>;
}) {
  const projectId = project.id;
  const { tasks } = useTasks();
  // Tasks switched off in Settings: no row leading to a list nobody keeps.
  const enabled = useTaskPreferences().enabled;
  const [issues, setIssues] = useState<ReturnType<typeof issueSummary>>(null);
  useEffect(() => {
    let active = true;
    setIssues(null);
    // Inside the promise, so a client without the read fails like a failed read.
    void Promise.resolve()
      .then(() => client.listProjectIssues(project))
      .then(
        (repositories) => {
          if (active) setIssues(issueSummary(repositories));
        },
        // Without an answer the row still counts the tasks; the screen retries.
        () => undefined,
      );
    return () => {
      active = false;
    };
    // The project's identity is its id and its default repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, project.kind, project.owner, project.repo]);
  const open = tasks.filter(
    (task) =>
      task.projectId === projectId &&
      task.origin !== 'agent' &&
      task.status !== 'done' &&
      task.status !== 'dropped',
  ).length;
  if (!enabled) return null;
  return (
    <Row
      leading={{ icon: 'check-square' }}
      title="Tasks"
      subtitle={projectTasksLine(open, issues)}
      navigates
      onPress={() => router.push({ pathname: '/project/[id]/tasks', params: { id: projectId } })}
    />
  );
}
