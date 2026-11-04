import { useLocalSearchParams } from 'expo-router';
import { ContextSettings } from '../../../../components/settings/ContextSettings';
import { projectIdParam } from '../../../../lib/useProjectDetail';
export default function ProjectContextScreen() {
  const { id, kind } = useLocalSearchParams<{ id: string | string[]; kind: string }>();
  return (
    <ContextSettings
      projectId={projectIdParam(id)}
      kind={kind === 'memory' ? 'memory' : 'instructions'}
    />
  );
}
