import { useLocalSearchParams } from 'expo-router';
import { SharedKnowledgeSettings } from '../../../components/settings/SharedKnowledgeSettings';
import { projectIdParam } from '../../../lib/useProjectDetail';

export default function ProjectKnowledgeScreen() {
  const { id, path } = useLocalSearchParams<{ id: string | string[]; path?: string }>();
  const projectId = projectIdParam(id);
  return (
    <SharedKnowledgeSettings
      key={JSON.stringify([projectId, path])}
      projectId={projectId}
      initialPath={path}
    />
  );
}
