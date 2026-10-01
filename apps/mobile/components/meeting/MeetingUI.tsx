import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Colors = ReturnType<typeof useUnistyles>['theme']['colors'];

// Speakers keep one color for the whole meeting; accents appear only as rings and dots.
export function speakerTone(colors: Colors, speaker: number): string {
  const palette = [
    colors.primary,
    colors.accent,
    colors.tone.done,
    colors.tone.danger,
    colors.textMuted,
  ];
  return palette[speaker % palette.length]!;
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionLabel}>{children}</Text>
      {right ? <Text style={styles.sectionHint}>{right}</Text> : null}
    </View>
  );
}

export function SpeakerAvatar({
  initial,
  tone,
  active = false,
  dashed = false,
  size = 40,
  caption,
  detail,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  onPress,
  onLongPress,
}: {
  initial: string;
  tone: string;
  active?: boolean;
  dashed?: boolean;
  size?: number;
  caption?: string;
  detail?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={disabled || !onPress}
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.avatarColumn}
    >
      <View
        style={[
          styles.avatarHalo,
          { width: size + 10, height: size + 10, borderRadius: (size + 10) / 2 },
          active && { borderColor: tone },
        ]}
      >
        <View
          style={[
            styles.avatar,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: tone,
              borderStyle: dashed ? 'dashed' : 'solid',
            },
          ]}
        >
          <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initial}</Text>
        </View>
      </View>
      {caption ? (
        <Text style={[styles.avatarCaption, active && styles.avatarCaptionActive]}>{caption}</Text>
      ) : null}
      {detail ? <Text style={styles.avatarDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

export type CardAction = {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
};

export function ActionRow({ actions }: { actions: CardAction[] }) {
  if (!actions.length) return null;
  return (
    <View style={styles.actions}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          disabled={action.disabled}
          onPress={action.onPress}
          style={[action.primary ? styles.primaryAction : styles.quietAction]}
        >
          <Text style={action.primary ? styles.primaryActionText : styles.quietActionText}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function NoticedCard({
  label,
  tone,
  time,
  quote,
  title,
  body,
  source,
  working = false,
  actions = [],
}: {
  label: string;
  tone: string;
  time?: string;
  quote?: string;
  title: string;
  body?: string;
  source?: string | null;
  working?: boolean;
  actions?: CardAction[];
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={[styles.cardLabel, { color: tone }]}>{label}</Text>
        {working ? <ActivityIndicator size="small" color={tone} /> : null}
        {time ? <Text style={styles.cardTime}>{time}</Text> : null}
      </View>
      {quote ? <Text style={styles.cardQuote}>{quote}</Text> : null}
      <Text style={styles.cardTitle}>{title}</Text>
      {body ? <Text style={styles.cardBody}>{body}</Text> : null}
      {source ? <Text style={styles.cardSource}>{source}</Text> : null}
      <ActionRow actions={actions} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  sectionHint: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  avatarColumn: { alignItems: 'center', gap: 2, minWidth: 48 },
  avatarHalo: {
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  avatarText: { color: theme.colors.text, fontWeight: '700' },
  avatarCaption: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  avatarCaptionActive: { color: theme.colors.text },
  avatarDetail: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: { width: 7, height: 7, borderRadius: 4 },
  cardLabel: { flex: 1, fontSize: theme.text.xs, fontWeight: '700', letterSpacing: 1.2 },
  cardTime: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  cardQuote: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  cardTitle: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 },
  cardBody: { color: theme.colors.text, fontSize: theme.text.sm, lineHeight: 20 },
  cardSource: { color: theme.colors.accent, fontSize: theme.text.xs },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing.md,
    marginTop: theme.spacing.xs,
  },
  primaryAction: {
    borderColor: theme.colors.primary,
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  primaryActionText: { color: theme.colors.primary, fontWeight: '700' },
  quietAction: { paddingHorizontal: theme.spacing.xs, paddingVertical: theme.spacing.sm },
  quietActionText: { color: theme.colors.textMuted },
}));
