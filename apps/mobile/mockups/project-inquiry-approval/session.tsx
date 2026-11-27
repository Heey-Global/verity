import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '../../components/ui';
import { InquiryApprovalCard } from './parts';

/**
 * The asking session: the agent's request to another project waits as a card
 * under its message, like a secret request, and runs once it is allowed here.
 */
export default function SessionInquiryMockup() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.transcript}>
        <View style={styles.userMessage}>
          <Text variant="body">
            Frag mal bei Deep-OCR nach, ob die Dokumente jetzt vom Backup ausgeschlossen sind.
          </Text>
        </View>
        <Text variant="body">
          Ich frage im Projekt Deep-OCR nach. Die Anfrage wartet auf deine Freigabe.
        </Text>
        <InquiryApprovalCard
          from={{ project: 'Verity', session: 'Backup-Ausschluss prüfen', here: true }}
        />
      </ScrollView>
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
        <Text variant="body" tone="faint">
          Message the agent…
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  transcript: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
}));
