import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { PersonalAiProviderBoundary } from '../../../components/settings/PersonalAiProviderBoundary';
import { ConnectionSettingsDetail } from '../../../components/settings/ConnectionSettingsDetail';
import { SettingsMessage } from '../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../lib/client';

export default function DetailScreen() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <PersonalAiProviderBoundary client={client} provider="codex" agentLogin={agentLogin}>
      <ConnectionSettingsDetail client={client} section="codex" agentLogin={agentLogin} />
    </PersonalAiProviderBoundary>
  ) : (
    <SettingsMessage title="Not connected" subtitle="Connect to your Verity server first." />
  );
}
