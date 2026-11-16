import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, SectionHeader, Text, ToggleRow } from '../../components/ui';
import { BeforeAfter, ignore } from './parts';

/**
 * One proposal before it reaches the Wiki: where it comes from, each change
 * with before and after, every change can be left out. A customer's statement
 * stays attributed instead of becoming the project's own fact.
 */
export default function ProposalMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <Text variant="title">Update from Live meeting 7 Nov</Text>
          <Text variant="footnote" tone="muted">
            Prepared today 06:00 · 3 changes on 2 pages
          </Text>
        </View>

        <SectionHeader title="Sources" />
        <Group>
          <Row
            leading={{ icon: 'mic' }}
            title="Live meeting 7 Nov 2026"
            subtitle="Meeting transcript · with a customer"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'message-circle' }}
            title="Session “Wiki concept”"
            subtitle="Deleted 7 Nov · 2 passages cited"
            navigates
            onPress={ignore}
          />
        </Group>

        <SectionHeader title="Changes · 2 of 3 selected" />
        <Group>
          <ToggleRow
            title="Meetings · new section “After the meeting”"
            subtitle="From your session"
            value
            onValueChange={ignore}
          />
          <View style={styles.change}>
            <BeforeAfter after="After a meeting, Verity files the transcript under Sources and prepares Wiki changes for review." />
          </View>
        </Group>
        <Group>
          <ToggleRow
            title="Navigation concept · one statement replaced"
            subtitle="Matches decision of 7 Nov"
            value
            onValueChange={ignore}
          />
          <View style={styles.change}>
            <BeforeAfter
              before="Knowledge is one entry under Content."
              after="Wiki and Sources are listed directly under Content."
            />
          </View>
        </Group>
        <Group>
          <ToggleRow
            title="Roadmap · customer request added"
            subtitle="Statement by a meeting guest"
            value={false}
            onValueChange={ignore}
          />
          <View style={styles.change}>
            <BeforeAfter after="Customer request (Anna, 7 Nov): export to PDF by March. Not yet planned." />
          </View>
        </Group>
      </ScrollView>
      <View style={styles.footer}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Button label="Reject" variant="secondary" onPress={ignore} fullWidth />
          </View>
          <View style={styles.flex}>
            <Button label="Apply 2 changes" onPress={ignore} fullWidth />
          </View>
        </View>
        <Button
          label="Go through with Verity"
          icon="message-circle"
          variant="text"
          onPress={ignore}
          fullWidth
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  head: { gap: theme.spacing.xs },
  change: { padding: theme.spacing.md },
  footer: {
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: 'row', gap: theme.spacing.sm },
  flex: { flex: 1 },
}));
