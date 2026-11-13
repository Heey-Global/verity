import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Row } from '../../components/ui';
import { ConnectionStrip } from './parts';

const ignore = () => undefined;

/** iPad Settings right after the update: a brief "Connected", no maintenance banner. */
export default function SettingsReconnectedMockup() {
  return (
    <View style={styles.root}>
      <ConnectionStrip state="reconnected" />
      <View style={styles.root}>
        <SettingsScaffold title="Settings" state={{ error: undefined, saving: false }}>
          <SettingsGroup title="Personal context">
            <SettingsListPanel>
              <Row
                title="Instructions"
                subtitle="Your rules across projects"
                leading={{ icon: 'file-text' }}
                navigates
                onPress={ignore}
              />
              <Row
                title="Memory"
                subtitle="Review and edit learned facts"
                leading={{ icon: 'book-open' }}
                navigates
                onPress={ignore}
              />
            </SettingsListPanel>
          </SettingsGroup>
          <SettingsGroup title="Features">
            <SettingsListPanel>
              <Row
                title="Assistant"
                subtitle="Voice notes, mail and calendar, project tasks"
                leading={{ icon: 'user' }}
                navigates
                onPress={ignore}
              />
              <Row
                title="QA · CI supervision"
                subtitle="Project monitoring and repair ownership"
                leading={{ icon: 'activity' }}
                navigates
                onPress={ignore}
              />
              <Row
                title="Connectors"
                subtitle="AI, code, documents and other services"
                leading={{ icon: 'link' }}
                navigates
                onPress={ignore}
              />
              <Row
                title="Server update"
                subtitle="Updated to the latest version"
                leading={{ icon: 'server', intent: 'ready' }}
                navigates
                onPress={ignore}
              />
            </SettingsListPanel>
          </SettingsGroup>
        </SettingsScaffold>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
}));
