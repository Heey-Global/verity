import { useMemo } from 'react';
import { ConnectionSettingsDetail } from '../../components/settings/ConnectionSettingsDetail';
import { SettingsMessage } from '../../components/settings/SettingsChrome';
import { createVerityClient } from '../../lib/client';

export default function DetailScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <ConnectionSettingsDetail client={client} section="remote" />
  ) : (
    <SettingsMessage title="Not connected" subtitle="Connect to your Verity server first." />
  );
}
