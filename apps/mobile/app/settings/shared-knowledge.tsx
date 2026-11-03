import { useLocalSearchParams } from 'expo-router';
import { SharedKnowledgeSettings } from '../../components/settings/SharedKnowledgeSettings';

export default function SharedKnowledgeScreen() {
  const { path } = useLocalSearchParams<{ path?: string }>();
  return <SharedKnowledgeSettings key={path ?? ''} initialPath={path} />;
}
