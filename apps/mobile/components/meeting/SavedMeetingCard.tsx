import { MeetingWave } from './MeetingWave';
import { meetingPalette } from './meetingPalette';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedMeetingCard as Card } from '../../lib/meetingSavedCard';
import { Icon } from '../Icon';

export function SavedMeetingCard({
  card,
  onOpenLegacy,
}: {
  card: Card;
  onOpenLegacy?: (() => void) | undefined;
}) {
  const { theme } = useUnistyles();
  const colors = meetingPalette(theme.colors);
  const metrics = [
    card.durationMinutes === undefined ? null : `${card.durationMinutes} min`,
    card.people === undefined ? null : `${card.people} people`,
    card.answers === undefined ? null : `${card.answers} answers`,
    card.notes === undefined ? null : `${card.notes} notes`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open meeting: ${card.title}`}
      disabled={!card.meetingId && !onOpenLegacy}
      onPress={() => {
        if (card.sessionId && card.meetingId)
          router.push({
            pathname: '/meeting/[sessionId]',
            params: { sessionId: card.sessionId, meetingId: card.meetingId },
          });
        else onOpenLegacy?.();
      }}
      style={styles.card}
    >
      <View style={{ width: 56 }}>
        <MeetingWave active={false} />
      </View>
      <View style={styles.body}>
        <Text style={styles.label}>MEETING SAVED</Text>
        <Text style={styles.title}>{card.title}</Text>
        {metrics ? <Text style={styles.metrics}>{metrics}</Text> : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.primary} />
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => {
  const colors = meetingPalette(theme.colors);
  return {
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 16,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    body: { flex: 1, gap: 4 },
    label: { color: colors.tone.done, fontSize: theme.text.xs, fontWeight: '700' },
    title: { color: colors.text, fontSize: theme.text.md, fontWeight: '700' },
    metrics: { color: colors.textMuted, fontSize: theme.text.xs },
  };
});
