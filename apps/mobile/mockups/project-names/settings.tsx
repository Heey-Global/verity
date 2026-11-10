import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
} from '../../components/settings/SettingsChrome';
import { ignore } from './parts';

/**
 * Project settings without the General group: name and description moved to
 * the project head. Repositories is one row listing every connected one.
 */
export default function SettingsMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SettingsGroup title="Context">
        <SettingsListPanel>
          <SettingsNavRow
            icon="file-text"
            title="Instructions"
            subtitle="Project rules outside the code repository"
            onPress={ignore}
          />
          <SettingsNavRow
            icon="book-open"
            title="Memory"
            subtitle="Review and edit project facts"
            onPress={ignore}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Connectors">
        <SettingsListPanel>
          <SettingsNavRow
            icon="git-branch"
            title="Repositories"
            subtitle="heey-global/verity · heey-global/verity-website"
            status={{ intent: 'ready', label: '2 connected' }}
            onPress={ignore}
          />
          <SettingsNavRow
            icon="key"
            title="Doppler"
            subtitle="Choose the environment for this project"
            status={{ intent: 'ready', label: 'dev' }}
            onPress={ignore}
          />
          <SettingsNavRow
            icon="folder"
            title="Google Drive"
            subtitle="Choose the project folders"
            status={{ intent: 'optional', label: 'Not selected' }}
            onPress={ignore}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Runtime">
        <SettingsListPanel>
          <SettingsNavRow
            icon="cpu"
            title="Default model"
            subtitle="Claude Opus 5.5"
            onPress={ignore}
          />
          <SettingsNavRow
            icon="box"
            title="Sandbox"
            subtitle="Container and resources"
            status={{ intent: 'ready', label: 'Running' }}
            onPress={ignore}
          />
        </SettingsListPanel>
      </SettingsGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
}));
