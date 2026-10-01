// Server update: Verity replacing itself. Reached from the overview banner, the
// update push, and the Settings index.
import { type VerityClient } from '@verity/mobile';
import { useMemo } from 'react';

import { ServerUpdateSection } from '../../components/settings/ServerUpdateSection';
import { SettingsMessage, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { createVerityClient } from '../../lib/client';

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
  return (
    <SettingsScaffold title="Server update" detail>
      <ServerUpdateSection client={client} />
    </SettingsScaffold>
  );
}
