import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Sheet, SheetHeaderButton, Text } from '../../components/ui';
import { ignore } from './parts';
import { ProjectFoldersPage } from './project-network-shares';

/**
 * Step 2 of "Add folder", in the same sheet as step 1: browse the share and
 * take the open folder. Back returns to the previous folder or step.
 */
export default function ChooseFolderMockup() {
  return (
    <ProjectFoldersPage
      overlay={
        <Sheet
          visible
          title="Projects"
          headerAction={
            <SheetHeaderButton icon="arrow-left" accessibilityLabel="Back" onPress={ignore} />
          }
          onClose={ignore}
          footer={<Button label="Use this folder" fullWidth onPress={ignore} />}
        >
          <View style={styles.stack}>
            <Text variant="body" tone="muted">
              Studio NAS › Projects
            </Text>
            <Group>
              <Row title="Briefs" leading={{ icon: 'folder' }} navigates onPress={ignore} />
              <Row title="Reviews" leading={{ icon: 'folder' }} navigates onPress={ignore} />
              <Row title="Templates" leading={{ icon: 'folder' }} navigates onPress={ignore} />
            </Group>
          </View>
        </Sheet>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.md },
}));
