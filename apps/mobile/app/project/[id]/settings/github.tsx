// Older links and app-link targets name the project's GitHub page; the
// provider-neutral Repository screen replaced it.
import { Redirect, useLocalSearchParams } from 'expo-router';
import { projectIdParam } from '../../../../lib/useProjectDetail';

export default function ProjectGitHubRedirect() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  return (
    <Redirect
      href={{ pathname: '/project/[id]/settings/repository', params: { id: projectIdParam(id) } }}
    />
  );
}
