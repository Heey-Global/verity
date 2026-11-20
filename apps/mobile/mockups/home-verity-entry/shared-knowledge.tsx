import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, Row, Text } from '../../components/ui';

const ignore = () => undefined;

/**
 * What the row at the end of Home opens directly: the Shared knowledge browser
 * as KnowledgeFolder draws its first level, unchanged. Sample content only.
 */
export default function SharedKnowledgeMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="subtitle" tone="muted">
          Reference material shared across projects. Agents can read it from every project.
          Administrators can edit supported text files; original sources remain protected.
        </Text>
        <Group>
          <Row title="Wiki" leading={{ icon: 'book-open' }} navigates onPress={ignore} />
          <Row title="Sources" leading={{ icon: 'paperclip' }} navigates onPress={ignore} />
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
}));
