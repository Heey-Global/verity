import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Sheet, Text, ToggleRow } from '../../components/ui';
import { ignore } from './parts';

/**
 * Deleting a finished session. Deleting means done, not worthless: by default
 * the session leaves your lists at once but stays in the database until the
 * next maintenance run has read it. Nothing is copied; only the passages a
 * confirmed proposal cites are kept under Sources. The app draws it as the
 * shared `ConfirmSheet` with its optional switch (`deleteSessionRequest`).
 */
export default function DeleteMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Group>
          <Row
            leading={{ icon: 'terminal' }}
            title="Fix session crash"
            subtitle="Merged · 1 h ago"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'terminal' }}
            title="Home composer alignment"
            subtitle="Working · 4 min ago"
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <Sheet
        visible
        title="Delete session?"
        onClose={ignore}
        showClose={false}
        footer={
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button label="Cancel" variant="secondary" onPress={ignore} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button label="Delete" variant="destructive" onPress={ignore} fullWidth />
            </View>
          </View>
        }
      >
        <Text variant="body" tone="muted">
          This removes “Fix session crash”, its history and worktree.
        </Text>
        <Group>
          <ToggleRow
            title="Use for the Wiki"
            subtitle="Verity reviews it for the Wiki before it is removed"
            value
            onValueChange={ignore}
          />
        </Group>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.spacing.lg },
  buttons: { flexDirection: 'row', gap: theme.spacing.sm },
  flex: { flex: 1 },
}));
