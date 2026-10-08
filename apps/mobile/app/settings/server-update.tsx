// Server update: Verity replacing itself. Reached from the overview banner, the
// update push, and the Settings index.
import { type VerityClient } from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { useMemo } from 'react';

import { ServerUpdateSection } from '../../components/settings/ServerUpdateSection';
import {
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { createVerityClient } from '../../lib/client';
import { retryFailedVeritySettings, useLoadVeritySettings } from '../../lib/settingsStore';

export default function ServerUpdateScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage this server."
        screenTitle="Server update"
      />
    );
  }
  return <ServerUpdateView client={client} />;
}

function ServerUpdateView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  return (
    <SettingsScaffold
      title="Server update"
      detail
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      <ServerUpdateSection client={client} />
      <SettingsListPanel>
        <SettingsNavRow
          icon="settings"
          title="Update channel"
          subtitle="Stable releases or prereleases"
          onPress={() => router.push('/settings/server-update-channel' as Href)}
        />
      </SettingsListPanel>
    </SettingsScaffold>
  );
}
