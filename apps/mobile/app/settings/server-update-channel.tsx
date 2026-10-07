// Server release preferences are configured independently of installation.
import { type VerityClient } from '@verity/mobile';
import { useMemo } from 'react';

import { ServerUpdateSection } from '../../components/settings/ServerUpdateSection';
import { SettingsMessage, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { createVerityClient } from '../../lib/client';
import { retryFailedVeritySettings, useLoadVeritySettings } from '../../lib/settingsStore';

export default function ServerUpdateChannelScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage this server."
        screenTitle="Update channel"
      />
    );
  }
  return <ServerUpdateChannelView client={client} />;
}

function ServerUpdateChannelView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  return (
    <SettingsScaffold
      title="Update channel"
      detail
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      <ServerUpdateSection client={client} mode="channel" />
    </SettingsScaffold>
  );
}
