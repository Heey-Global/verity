import { Redirect, useLocalSearchParams } from 'expo-router';

export default function LegacyProviderSettings() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  return (
    <Redirect
      href={{
        pathname: '/settings/ai-accounts/claude',
        params: agentLogin === 'claude' ? { agentLogin } : {},
      }}
    />
  );
}
