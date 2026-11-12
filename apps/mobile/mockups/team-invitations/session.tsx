import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Card, IconButton, Row, Text } from '../../components/ui';
import { Avatar, ignore, ProviderMark } from './parts';

function Author({ initials, name, via, you = false }: { initials: string; name: string; via: string; you?: boolean }) {
  return (
    <View style={styles.author}>
      <Avatar initials={initials} you={you} />
      <Text variant="label">{name}</Text>
      <Text variant="caption" tone="muted">
        {via}
      </Text>
    </View>
  );
}

/**
 * A shared session: every turn shows who sent it and through whose AI
 * connection it ran; the composer runs on the reader's own connection.
 */
export default function SharedSessionMockup() {
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text variant="title" numberOfLines={1}>
          Release notes 4.92
        </Text>
        <Text variant="bodySmall" tone="muted">
          verity · shared with 3 people
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.messages}>
        <Row
          leading={{ icon: 'users', quiet: true }}
          title="Shared session"
          subtitle="Everyone on verity sees this history. Each turn runs on the sender's own AI connection."
          wrap
        />
        <Author initials="HT" name="Holger" via="Codex gpt-6.1-sol" />
        <Card stacked>
          <Text variant="body">Draft the release notes for 4.92 from the merged pull requests.</Text>
        </Card>
        <Text variant="body">
          Draft ready in docs/releases/4.92.md: 11 changes, grouped by app, server and Uplink.
        </Text>
        <Author initials="LS" name="You" via="Claude Opus 5.5" you />
        <Card stacked>
          <Text variant="body">Shorten the Uplink section and link the pairing fix.</Text>
        </Card>
        <Row
          leading={{ icon: 'loader', intent: 'action' }}
          title="Agent working for you"
          subtitle="Holger and Anna see progress · Anna's message waits for this turn"
        />
      </ScrollView>
      <View style={styles.composer}>
        <Text variant="body" tone="faint">
          Message this agent…
        </Text>
        <View style={styles.composeActions}>
          <IconButton icon="plus" accessibilityLabel="Add attachment" onPress={ignore} />
          <ProviderMark provider="claude" />
          <Text variant="bodySmall" tone="muted">
            Your Claude · Opus 5.5
          </Text>
          <View style={styles.spacer} />
          <IconButton icon="arrow-up" accessibilityLabel="Send message" onPress={ignore} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  head: {
    padding: theme.spacing.lg,
    gap: theme.spacing.xxs,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  messages: { padding: theme.spacing.lg, gap: theme.spacing.md },
  author: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  composer: {
    margin: theme.spacing.md,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  composeActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  spacer: { flex: 1 },
}));
