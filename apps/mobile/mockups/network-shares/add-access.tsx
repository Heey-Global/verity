import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsChoiceRow, SettingsListPanel } from '../../components/settings/SettingsChrome';
import { Button, Sheet, SheetHeaderButton, Text } from '../../components/ui';
import { ignore } from './parts';
import { ProjectFoldersPage } from './project-network-shares';

/** Step 3, still in the same sheet: decide what agents may do in the folder, then add it. Read only is preselected. */
export default function AddAccessMockup() {
  return (
    <ProjectFoldersPage
      overlay={
        <Sheet
          visible
          title="Access to “Projects”"
          headerAction={
            <SheetHeaderButton icon="arrow-left" accessibilityLabel="Back" onPress={ignore} />
          }
          onClose={ignore}
          footer={<Button label="Add folder" fullWidth onPress={ignore} />}
        >
          <View style={styles.stack}>
            <Text variant="body" tone="muted">
              Studio NAS › Projects, including its subfolders
            </Text>
            <SettingsListPanel>
              <SettingsChoiceRow
                title="Read only"
                subtitle="Agents can browse and read files"
                selected
                onPress={ignore}
              />
              <SettingsChoiceRow
                title="Read and write"
                subtitle="Agents can also create and update files"
                selected={false}
                onPress={ignore}
              />
            </SettingsListPanel>
            <Text variant="bodySmall" tone="muted">
              You can change this later. Agents never get more rights than the NAS account allows.
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
