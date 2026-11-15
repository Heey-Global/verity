import { useUnistyles } from 'react-native-unistyles';

import { AgentProviderIcon } from '../../components/AgentProviderIcon';

export { ignore, Page } from '../team-invitations/parts';

export function ProviderMark({ provider }: { provider: 'claude' | 'codex' | 'opencode' }) {
  const { theme } = useUnistyles();
  return <AgentProviderIcon provider={provider} color={theme.colors.action} size={18} />;
}
