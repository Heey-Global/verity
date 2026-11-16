import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, StepIntro, Text } from '../../components/ui';
import { HowItWorks, ignore } from './parts';

/**
 * A Wiki without pages or sources: what the Wiki is for and who does what, then
 * the one action that sets it up in a session with Verity.
 */
export default function EmptyMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <StepIntro
        headline="Your project,"
        accent="explained."
        lead="The Wiki answers what this project is, how it works and why things were decided, without digging through old chats."
      />
      <HowItWorks />
      <View style={styles.actions}>
        <Button label="Set up Wiki" icon="book-open" onPress={ignore} fullWidth />
        <Text variant="footnote" tone="muted" style={styles.center}>
          Verity asks two short questions in a session, then proposes the first topics.
        </Text>
        <View style={styles.secondary}>
          <Button label="Add a source first" variant="secondary" onPress={ignore} fullWidth />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  actions: { gap: theme.spacing.sm },
  center: { textAlign: 'center' },
  secondary: { marginTop: theme.spacing.md },
}));
