import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Button, Row, StatusDot, Text, useConfirm } from '../../components/ui';

const ignore = () => undefined;
type State = 'blocked' | 'scheduled' | 'recovery';

/** Sample data only: the existing Sandbox settings surface with recovery status. */
export function SandboxUpdateMockup({ state }: { state: State }) {
  const [confirm, confirmation] = useConfirm();
  const recovery = state === 'recovery';
  const scheduled = state === 'scheduled';
  return (
    <SettingsScaffold title="Sandbox" detail state={{ error: undefined, saving: false }}>
      <SettingsGroup
        title="website · Sandbox"
        trailing={<StatusDot intent="ready" label="Running" />}
      >
        <SettingsPanel>
          <Text tone="muted">
            Sessions run inside this workspace. Pausing stops it; your files stay.
          </Text>
          <View style={styles.action}>
            <Button label="Pause" onPress={ignore} />
          </View>
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup
        title="Update"
        trailing={
          <StatusDot
            intent={recovery ? 'needsSetup' : 'optional'}
            label={recovery ? 'Check failed' : scheduled ? 'Tonight' : 'Waiting'}
          />
        }
      >
        <SettingsPanel>
          <Text variant="row">
            {recovery
              ? 'Updated · one service needs attention'
              : scheduled
                ? 'Scheduled for tonight'
                : 'Waiting for a running turn'}
          </Text>
          <Text tone="muted">
            {recovery
              ? 'The sandbox is up to date. The check after the update found that web did not restart.'
              : scheduled
                ? 'A dev server and a shared preview are running. Verity will update between 03:00 and 05:00, server time.'
                : 'A turn is running in this project. The update can start after it finishes; automatic updates never interrupt running turns.'}
          </Text>
          {scheduled ? (
            <Text variant="footnote" tone="muted">
              Dev servers restart automatically. Share URLs and PINs stay the same. A running turn
              will postpone the update.
            </Text>
          ) : null}
          {!recovery ? (
            <View style={styles.action}>
              <Button
                label={scheduled ? 'Update now' : 'Cancel turn and update'}
                variant="secondary"
                onPress={() =>
                  confirm({
                    title: scheduled ? 'Update sandbox now?' : 'Cancel turn and update?',
                    message: scheduled
                      ? 'Dev servers and previews will be briefly interrupted. Dev servers restart automatically; share URLs and PINs stay the same. Verity checks that services recover after the update.'
                      : 'This cancels the running turn. Its current response may be incomplete. Dev servers and previews will also be briefly interrupted. Dev servers restart automatically; share URLs and PINs stay the same. Verity checks recovery after the update.',
                    confirmLabel: scheduled ? 'Update now' : 'Cancel turn and update',
                    destructive: !scheduled,
                    onConfirm: ignore,
                  })
                }
              />
            </View>
          ) : null}
          {recovery ? (
            <Text variant="footnote" tone="muted">
              Updated today at 03:12 · checked at 03:14
            </Text>
          ) : null}
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup title={recovery ? 'Recovery check' : 'Current activity'}>
        <SettingsListPanel>
          {!scheduled && !recovery ? (
            <Row
              title="Agent turn"
              subtitle="Implementing website changes"
              leading={{ icon: 'message-circle' }}
              trailing={<StatusDot intent="transient" label="Running" />}
            />
          ) : null}
          <Row
            title="web"
            subtitle={
              recovery
                ? 'Process exited with code 1. Restart limit reached.'
                : 'Process and listening port verified'
            }
            leading={{ icon: 'terminal' }}
            trailing={
              <StatusDot
                intent={recovery ? 'needsSetup' : 'ready'}
                label={recovery ? 'Crashed' : 'Running'}
              />
            }
          />
          <Row
            title="Website preview"
            subtitle={
              recovery
                ? 'Offline page · URL and PIN preserved'
                : 'Target reachable · public link enabled'
            }
            leading={{ icon: 'link' }}
            trailing={
              <StatusDot
                intent={recovery ? 'optional' : 'ready'}
                label={recovery ? 'Offline' : 'Online'}
              />
            }
          />
        </SettingsListPanel>
      </SettingsGroup>
      {recovery ? (
        <SettingsGroup title="Next step">
          <SettingsPanel>
            <Text tone="muted">
              Open the dev server logs to fix the startup error, then restart web. Its preview will
              come back at the same URL.
            </Text>
            <View style={styles.action}>
              <Button label="Open dev servers" variant="secondary" onPress={ignore} />
            </View>
          </SettingsPanel>
        </SettingsGroup>
      ) : null}
      {confirmation}
    </SettingsScaffold>
  );
}
const styles = StyleSheet.create((theme) => ({
  action: { alignItems: 'flex-start', marginTop: theme.spacing.md },
}));
