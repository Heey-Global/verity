// Updates: Verity's server replacing itself, and the app's own updates. Reached
// from the overview banner, the update push, and the Settings index.
import { type VerityClient } from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { useMemo } from 'react';

import { ServerUpdateSection } from '../../components/settings/ServerUpdateSection';
import { AppUpdateSection } from '../../components/settings/AppUpdateSection';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Card, CardHead } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import { retryFailedVeritySettings, useLoadVeritySettings } from '../../lib/settingsStore';

export default function ServerUpdateScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    // The app's own updates do not depend on a server, so they stay reachable.
    return (
      <SettingsScaffold title="Updates" detail>
        <SettingsGroup title="Server">
          <Card stacked>
            <CardHead
              title="Not connected"
              subtitle="Configure your Verity server address in setup to manage this server."
            />
          </Card>
        </SettingsGroup>
        <AppGroup />
      </SettingsScaffold>
    );
  }
  return <ServerUpdateView client={client} />;
}

function AppGroup() {
  return (
    <SettingsGroup title="App">
      <AppUpdateSection />
    </SettingsGroup>
  );
}

function ServerUpdateView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  return (
    <SettingsScaffold
      title="Updates"
      detail
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      <SettingsGroup title="Server">
        <ServerUpdateSection client={client} />
        <SettingsListPanel>
          <SettingsNavRow
            icon="settings"
            title="Update channel"
            subtitle="Stable releases or prereleases"
            onPress={() => router.push('/settings/server-update-channel' as Href)}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <AppGroup />
    </SettingsScaffold>
  );
}
