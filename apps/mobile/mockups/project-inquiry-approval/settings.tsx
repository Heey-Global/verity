import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Button, Row } from '../../components/ui';
import { ignore } from './parts';

/**
 * Project settings › Agents: no switch per project any more. Only the targets
 * the user chose "Always allow" for are listed, each revocable; without any,
 * the section is hidden.
 */
export default function AgentsSettingsMockup() {
  return (
    <View style={styles.root}>
      <SettingsScaffold title="Agents" detail state={{ error: undefined, saving: false }}>
        <SettingsGroup
          title="Functions"
          description="Choose which Verity functions may access this project."
        >
          <SettingsListPanel>
            <SettingsNavRow
              icon="user"
              title="Assistant"
              subtitle="Off, tasks only or tasks and sessions"
              onPress={ignore}
            />
            <SettingsNavRow
              icon="check"
              title="QA"
              subtitle="Off, monitor only or automatic repairs"
              onPress={ignore}
            />
          </SettingsListPanel>
        </SettingsGroup>
        <SettingsGroup
          title="Allowed project inquiries"
          description="Sessions in this project may ask these projects questions without asking you first. Answers are read-only; changes always need your approval."
        >
          <SettingsListPanel>
            <Row
              leading={{ icon: 'folder' }}
              title="Deep-OCR"
              subtitle="Always allowed since 21 Nov"
              trailing={
                <Button label="Revoke" size="compact" variant="secondary" onPress={ignore} />
              }
            />
            <Row
              leading={{ icon: 'folder' }}
              title="K8s"
              subtitle="Always allowed since 18 Nov"
              trailing={
                <Button label="Revoke" size="compact" variant="secondary" onPress={ignore} />
              }
            />
          </SettingsListPanel>
        </SettingsGroup>
      </SettingsScaffold>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
}));
