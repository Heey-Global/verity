import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from '../../components/CodeHostIcon';
import { SettingsGroup } from '../../components/settings/SettingsChrome';
import { Button, Group, IconButton, Row, Text, TextField } from '../../components/ui';
import { ignore } from './parts';

/**
 * New project: a name, and optionally repositories in the same step. The
 * first repository chosen fills an empty name as a suggestion; more can be
 * added here or later on the project page.
 */
export default function CreateMockup() {
  const { theme } = useUnistyles();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsGroup title="Project">
          <TextField
            label="Project name"
            value="Verity Plattform"
            onChangeText={ignore}
            placeholder="My project"
            maxLength={100}
          />
        </SettingsGroup>
        <SettingsGroup
          title="Repositories"
          description="Optional. You can connect more later on the project page."
        >
          <Group>
            <Row
              leading={{
                element: <CodeHostIcon provider="github" color={theme.colors.action} />,
              }}
              title="heey-global/verity"
              subtitle="GitHub"
              trailing={
                <IconButton
                  icon="x"
                  accessibilityLabel="Remove heey-global/verity"
                  onPress={ignore}
                />
              }
            />
            <Row
              leading={{ icon: 'plus' }}
              title="Add repository"
              subtitle="GitHub or Forgejo"
              navigates
              onPress={ignore}
            />
          </Group>
        </SettingsGroup>
        <Text variant="footnote" tone="faint">
          Without a repository, Verity keeps the project's code in a Git repository on this server.
        </Text>
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Create project" onPress={ignore} fullWidth />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  footer: { padding: theme.spacing.lg },
}));
