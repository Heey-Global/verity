import { useLocalSearchParams } from 'expo-router';
import { ContextSettings } from '../../components/settings/ContextSettings';
export default function PersonalContextScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  return <ContextSettings kind={kind === 'memory' ? 'memory' : 'instructions'} />;
}
