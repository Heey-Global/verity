import { Stack } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../components/Icon';
import { MeetingWave } from '../../components/meeting/MeetingWave';
import { NoticedCard, SectionLabel, SpeakerAvatar } from '../../components/meeting/MeetingUI';
import { Button, IconButton, Text } from '../../components/ui';
import type { MockupSpec } from '../types';

const ignore = () => undefined;

/** A stopped recorder retains its transcript while server finalization is unresolved. */
export default function MeetingSyncErrorMockup() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + theme.spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <IconButton icon="chevron-down" accessibilityLabel="Minimize meeting" onPress={ignore} />
        <View style={styles.fill}>
          <Text variant="row" numberOfLines={1}>
            Product planning
          </Text>
          <Text variant="subtitle" tone="muted">
            Recording stopped · 04:28
          </Text>
        </View>
        <IconButton icon="more-horizontal" accessibilityLabel="Meeting options" onPress={ignore} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <MeetingWave active={false} />
        <NoticedCard
          tone={theme.colors.attention}
          label="Sync needs attention"
          title="Server end not confirmed"
          body="Recording has stopped on this device. Your transcript is saved here. Sync failed, so we cannot confirm that the meeting has ended on the server."
        >
          <View style={styles.actions}>
            <Button label="End on server" onPress={ignore} fullWidth />
            <Text variant="footnote" tone="muted">
              Keep the transcript already received by the server and end the meeting there.
            </Text>
            <Button
              label="Retry sync"
              variant="secondary"
              icon="refresh-cw"
              onPress={ignore}
              fullWidth
            />
            <Text variant="footnote" tone="muted">
              Try sending the saved transcript again.
            </Text>
          </View>
        </NoticedCard>
        <View style={styles.saved}>
          <Icon name="check-circle" size={16} color={theme.colors.success} />
          <Text variant="subtitle" tone="muted">
            Transcript saved on this device
          </Text>
        </View>
        <View style={styles.block}>
          <SectionLabel right="04:28">TRANSCRIPT</SectionLabel>
          <View style={styles.turn}>
            <SpeakerAvatar initial="A" tone={theme.colors.action} size={28} />
            <View style={styles.words}>
              <Text variant="subtitle" tone="muted">
                Alex · 03:42
              </Text>
              <Text variant="body">
                Let’s keep the first release focused on the calendar and meeting notes.
              </Text>
            </View>
          </View>
          <View style={styles.turn}>
            <SpeakerAvatar initial="J" tone={theme.colors.success} size={28} />
            <View style={styles.words}>
              <Text variant="subtitle" tone="muted">
                Jamie · 04:06
              </Text>
              <Text variant="body">
                Agreed. I’ll bring the revised schedule to our next review.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, theme.spacing.md) }]}>
        <Text variant="footnote" tone="muted">
          You can leave this screen. Your transcript stays saved.
        </Text>
      </View>
    </View>
  );
}

export const meetingRecoverySpec: MockupSpec = {
  id: 'meeting-recovery',
  title: 'Meeting recovery',
  screens: {
    'sync-error': { title: 'Meeting sync recovery', Component: MeetingSyncErrorMockup },
  },
};

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  fill: { flex: 1, gap: theme.spacing.xxs },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.lg,
  },
  actions: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  saved: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  block: { gap: theme.spacing.md },
  turn: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  words: { flex: 1, gap: theme.spacing.xs },
  footer: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
}));
