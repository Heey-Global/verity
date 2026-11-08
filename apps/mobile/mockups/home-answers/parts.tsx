import type { InboxAction, InboxItem } from '@verity/mobile';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VerityHeader } from '../../components/home/HomeInbox';
import { HomeTabBar } from '../../components/home/HomeTabBar';
import { AnswerSheet } from '../../components/project/AnswerSheet';
import {
  Button,
  Card,
  CardHead,
  Group,
  Row,
  SectionHeader,
  StatusTag,
  Text,
} from '../../components/ui';

export const ignore = () => undefined;
const answers = (labels: string[]): InboxAction[] =>
  labels.map((label) => ({ kind: 'answer', label, answer: label, sessionId: 'sample' }));
const longAnswers = answers([
  'Variante 1: Admin-Bot @ops mit Token in Doppler bauen',
  'Variante 2: Kurzlebiges Token über die Datenbank bauen',
]);
const question: InboxItem = {
  key: 'sample',
  kind: 'question',
  tag: 'Question',
  tone: 'attention',
  title: 'Wie soll der Runner die Synapse-Admin-Rechte bekommen?',
  context: 'heey-global/k8s · FluffyChat Gerät löschen',
  message: 'Wie soll der Runner die Synapse-Admin-Rechte bekommen?',
  actions: longAnswers,
  at: 0,
};

/** Proposed Home answer layout; only sample data and existing UI components. */
export function HomeSample({
  short = false,
  opened = false,
}: {
  short?: boolean;
  opened?: boolean;
}) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <VerityHeader summary="2 questions · 1 plan to review" />
        <SectionHeader title="For you" />
        <Card stacked>
          <CardHead
            title={short ? 'Welche Umgebung soll ich verwenden?' : question.title}
            subtitle={question.context}
            trailing={<StatusTag intent="needsSetup" label="Question" />}
            onDismiss={ignore}
          />
          <View style={styles.actions}>
            {short ? (
              answers(['Staging', 'Production']).map((action) => (
                <Button
                  key={action.label}
                  label={action.label}
                  size="small"
                  variant="secondary"
                  onPress={ignore}
                />
              ))
            ) : (
              <Button
                label="2 answers"
                icon="chevron-down"
                size="small"
                variant="secondary"
                onPress={ignore}
              />
            )}
            <Button label="Own answer" size="small" variant="secondary" onPress={ignore} />
          </View>
        </Card>
        <Card stacked>
          <CardHead
            title="Plan ready for review"
            subtitle="heey-global/wavelength-app · Renovate-PRs prüfen"
            trailing={<StatusTag intent="optional" label="Plan" />}
            onDismiss={ignore}
          />
          <Text variant="bodySmall" tone="muted">
            Implementation waits for your approval.
          </Text>
          <View style={styles.actions}>
            <Button label="Review plan" size="small" variant="secondary" onPress={ignore} />
          </View>
        </Card>
        <SectionHeader title="Updates" />
        <Group>
          <Row
            title="Release Checker"
            subtitle="heey-global/verity · PR #2352 merged"
            leading={{ icon: 'check-circle', intent: 'ready' }}
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={3} bottomInset={0} />
      <AnswerSheet
        item={opened ? question : null}
        answers={longAnswers}
        onAnswer={ignore}
        onOpenSession={ignore}
        onClose={ignore}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
