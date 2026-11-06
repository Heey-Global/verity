import type { VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { Row } from '../ui';
import { useTaskPreferences } from '../../lib/taskPreferences';
import { useTasks } from '../../lib/tasksStore';

/** "3 open · 5 GitHub issues"; issues only once GitHub answered for the project. */
export function projectTasksLine(open: number, issues: number | null): string {
  const tasks = open === 0 ? 'No open tasks' : `${String(open)} open`;
  if (issues === null) return tasks;
  return `${tasks} · ${String(issues)} GitHub ${issues === 1 ? 'issue' : 'issues'}`;
}

/**
 * The project's tasks on its Overview: how many of the operator's own tasks are
 * open here and, with GitHub connected, how many issues — the same store and
 * issue read as the list behind the V. A tap opens the project's Tasks screen.
 */
export function ProjectTasksRow({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const { tasks } = useTasks();
  // Tasks switched off in Settings: no row leading to a list nobody keeps.
  const enabled = useTaskPreferences().enabled;
  const [issues, setIssues] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setIssues(null);
    // Inside the promise, so a client without the read fails like a failed read.
    void Promise.resolve()
      .then(() => client.listProjectGitHubIssues(projectId))
      .then(
        (result) => {
          if (active) setIssues(result.connected ? result.issues.length : null);
        },
        // Without an answer the row still counts the tasks; the screen retries.
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [client, projectId]);
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
