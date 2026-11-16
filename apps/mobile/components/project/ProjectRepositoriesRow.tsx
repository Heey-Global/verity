import type { RepositoryPullRequests } from '@verity/mobile';
import { router } from 'expo-router';

import { repositoriesOverview } from '../../lib/projectRepositories';
import { Row, StatusTag } from '../ui';

/**
 * The project's repositories in its Content: open pull requests across all of them,
 * counted from the code host. The icon turns red while one fails or conflicts; the
 * count beside it stays neutral so the row does not shout.
 */
export function ProjectRepositoriesRow({
  projectId,
  repositories,
}: {
  projectId: string;
  repositories: readonly RepositoryPullRequests[];
}) {
  const { subtitle, attention } = repositoriesOverview(repositories);
  return (
    <Row
      leading={{
        icon: 'git-pull-request',
        ...(attention > 0 ? { intent: 'needsSetup' as const } : {}),
      }}
      title="Repositories"
      subtitle={subtitle}
      trailing={
        attention > 0 ? (
          <StatusTag intent="needsSetup" label={`${String(attention)} need you`} muted />
        ) : undefined
      }
      navigates
      onPress={() =>
        router.push({ pathname: '/project/[id]/repositories', params: { id: projectId } })
      }
    />
  );
}
