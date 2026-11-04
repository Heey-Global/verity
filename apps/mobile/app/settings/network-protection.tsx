import type { VerityClient } from '@verity/mobile';
import { useMemo } from 'react';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Text } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import {
  networkProtectionStatus,
  networkProtectionUnavailableReason,
} from '../../lib/networkProtection';
import {
  retryFailedVeritySettings,
  saveVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

export default function NetworkProtectionScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server to manage network protection."
        screenTitle="Network protection"
      />
    );
  return <NetworkProtectionView client={client} />;
}

function NetworkProtectionView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  const { settings, loading, saving } = useVeritySettings();
  const enabled = settings?.projectEgressEnabled === true;
  const supported =
    settings?.projectEgressEnabled !== undefined && settings?.projectEgressAvailable !== undefined;
  return (
    <SettingsScaffold
      title="Network protection"
      detail
      onRetry={() => {
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        });
      }}
    >
      <SettingsGroup title="Experimental">
        <SettingsListPanel>
          <SettingsToggleRow
            label="Network protection"
            subtitle={networkProtectionStatus(settings)}
            value={enabled}
            disabled={
              loading ||
              saving > 0 ||
              !supported ||
              (!enabled && settings?.projectEgressAvailable !== true)
            }
            onValueChange={(value) => {
              void saveVeritySettings(client, { projectEgressEnabled: value });
            }}
          />
        </SettingsListPanel>
        <Text tone="muted">
          Off by default. Applies to every project from its next container start. Running containers
          keep their current network mode.
        </Text>
        {supported && settings?.projectEgressAvailable === false ? (
          <Text tone="muted">
            {networkProtectionUnavailableReason(settings)} You can turn protection off, but cannot
            turn it on until the service is available.
          </Text>
        ) : null}
        {settings !== null && !supported ? (
          <Text tone="muted">Update your Verity server to manage network protection.</Text>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Before enabling">
        <Text tone="muted">
          Network protection restricts outgoing connections from project containers. Package
          installation is not yet fully verified with protection on. Previews are currently
          unavailable for protected containers. Manage destination approvals in Project → Settings →
          Sandbox.
        </Text>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
