import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ConnectionSettingsDetail } from '../../../components/settings/ConnectionSettingsDetail';
import { SettingsMessage } from '../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../lib/client';

export default function DetailScreen() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <ConnectionSettingsDetail client={client} section="claude" agentLogin={agentLogin} />
  ) : (
    <SettingsMessage title="Not connected" subtitle="Connect to your Verity server first." />
  );
}
