import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';

export const ignore = () => undefined;

export function Fill({ children }: { children: ReactNode }) {
  return <View style={styles.root}>{children}</View>;
}

/** Sample data only: the shares a server administrator connected centrally. */
export const SHARES = [
  {
    name: 'Studio NAS',
    address: 'nas.studio.lan/team',
    usage: 'Used in 2 projects',
    status: { intent: 'ready', label: 'Connected' },
  },
  {
    name: 'Archive',
    address: 'nas2.lan/archive',
    usage: 'Used in 1 project',
    status: { intent: 'needsSetup', label: 'Unreachable' },
  },
] as const;

/**
 * Settings › Connectors › Network shares, laid out like the Google settings:
 * one row per connection, a sheet for its actions, and an add row at the end.
 */
export function NetworkSharesPage({ overlay }: { overlay?: ReactNode }) {
  return (
    <Fill>
      <SettingsScaffold title="Network shares" detail state={{ error: undefined, saving: false }}>
        <SettingsGroup
          title="Shares"
          description="Connect an SMB share once, for example a folder on a Synology or other NAS. Then choose in each project which folders its agents may use."
        >
          <SettingsListPanel>
            {SHARES.map((share) => (
              <SettingsNavRow
                key={share.name}
                icon="hard-drive"
                title={share.name}
                subtitle={`${share.address} · ${share.usage}`}
                status={share.status}
                onPress={ignore}
              />
            ))}
            <SettingsNavRow title="Add network share" icon="plus" onPress={ignore} />
          </SettingsListPanel>
        </SettingsGroup>
      </SettingsScaffold>
      {overlay}
    </Fill>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
}));
