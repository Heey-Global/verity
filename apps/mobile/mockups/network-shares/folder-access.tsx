import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsChoiceRow, SettingsListPanel } from '../../components/settings/SettingsChrome';
import { Button, Sheet, Text } from '../../components/ui';
import { ignore } from './parts';
import { ProjectFoldersPage } from './project-network-shares';

/** Tapping a folder: choose what agents may do there, or remove the folder. */
export default function FolderAccessMockup() {
  return (
    <ProjectFoldersPage
      overlay={
        <Sheet
          visible
          title="Briefs"
          onClose={ignore}
          footer={
            <Button label="Remove from project" variant="destructive" fullWidth onPress={ignore} />
          }
        >
          <View style={styles.stack}>
            <Text variant="body" tone="muted">
              Studio NAS › Projects › Briefs
            </Text>
            <SettingsListPanel>
              <SettingsChoiceRow
                title="Read only"
                subtitle="Agents can browse and read files"
                selected={false}
                onPress={ignore}
              />
              <SettingsChoiceRow
                title="Read and write"
                subtitle="Agents can also create and update files"
                selected
                onPress={ignore}
              />
            </SettingsListPanel>
            <Text variant="bodySmall" tone="muted">
              Removing the folder only ends this project’s access. The files stay on the share.
            </Text>
          </View>
        </Sheet>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.md },
}));
