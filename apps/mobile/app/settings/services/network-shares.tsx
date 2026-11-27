import { useMemo } from 'react';

import { NetworkShareConnections } from '../../../components/settings/NetworkShareConnections';
import { SettingsMessage, SettingsScaffold } from '../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../lib/client';

export default function NetworkSharesScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <SettingsScaffold title="Network shares" detail>
      <NetworkShareConnections client={client} />
    </SettingsScaffold>
  ) : (
    <SettingsMessage title="Not connected" subtitle="Connect to your Verity server first." />
  );
}
