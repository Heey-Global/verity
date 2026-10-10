import { meetingPalette } from './meetingPalette';
import { useId, type ReactNode } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseInline } from '@verity/mobile';

import { Icon } from '../Icon';

type Colors = ReturnType<typeof meetingPalette>;

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

export function MeetingMetrics({ values }: { values: { label: string; value: number }[] }) {
  const { theme } = useUnistyles();
  const colors = meetingPalette(theme.colors);
  const gradient = useId();
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {values.map(({ label, value }, index) => (
        <View
          key={label}
          accessible
          accessibilityLabel={`${value} ${label}`}
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 18,
            backgroundColor: colors.surfaceAlt,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Svg width="100%" height={30} viewBox="0 0 80 30" accessibilityElementsHidden>
            <Defs>
              <LinearGradient id={`${gradient}-${index}`} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={colors.accent} />
                <Stop offset="0.5" stopColor="#a968f3" />
                <Stop offset="1" stopColor={colors.primary} />
              </LinearGradient>
            </Defs>
            <SvgText
              x={40}
              y={23}
              textAnchor="middle"
              fontSize={22}
              fontWeight="800"
              fill={`url(#${gradient}-${index})`}
            >
              {value}
            </SvgText>
          </Svg>
          <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600' }}>{label}</Text>
        </View>
      ))}
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

function ActionRow({ actions }: { actions: CardAction[] }) {
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
  prominent = false,
  onDismiss,
  dismissLabel = 'Dismiss',
  onToggle,
  children,
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
  /** The title is the subject of the card, such as the question being researched. */
  prominent?: boolean;
  /** Shows a close button in the header that removes the card. */
  onDismiss?: () => void;
  dismissLabel?: string;
  children?: ReactNode;
  onToggle?: () => void;
}) {
  const gradient = useId();
  const { theme } = useUnistyles();
  const colors = meetingPalette(theme.colors);
  return (
    <View style={styles.card}>
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, top: 18, bottom: 18, width: 3 }}
      >
        <Svg width="3" height="100%">
          <Defs>
            <LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={tone} />
              <Stop offset="1" stopColor={colors.primary} />
            </LinearGradient>
          </Defs>
          <Rect width="3" height="100%" rx="1.5" fill={`url(#${gradient})`} />
        </Svg>
      </View>
      <View style={styles.cardHeader}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={[styles.cardLabel, { color: tone }]}>{label}</Text>
        {working ? <ActivityIndicator size="small" color={tone} /> : null}
        {time ? <Text style={styles.cardTime}>{time}</Text> : null}
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
            hitSlop={10}
            onPress={onDismiss}
          >
            <Icon name="x" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {quote ? <Text style={styles.cardQuote}>{quote}</Text> : null}
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle meeting answer"
          onPress={onToggle}
        >
          <Text style={prominent ? styles.cardQuestion : styles.cardTitle}>{title}</Text>
          {children}
        </Pressable>
      ) : (
        <Text style={prominent ? styles.cardQuestion : styles.cardTitle}>{title}</Text>
      )}
      {body ? <Text style={styles.cardBody}>{body}</Text> : null}
      {!onToggle ? children : null}
      {source ? <Text style={styles.cardSource}>{source}</Text> : null}
      <ActionRow actions={actions} />
    </View>
  );
}

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

// Meeting answers are short Markdown bullet lists. Lines keep their own row so bullets
// never run together, and inline bold and links render instead of showing raw markup.
export function MeetingAnswerText({ text }: { text: string }) {
  const { theme } = useUnistyles();
  const colors = meetingPalette(theme.colors);
  const lines = text.split('\n').filter((line) => line.trim());
  return (
    <View style={styles.answer} testID="meeting-answer">
      {lines.map((line, index) => {
        const bullet = BULLET.exec(line);
        const content = (bullet ? line.slice(bullet[0].length) : line).replace(/^\s*#{1,6}\s+/, '');
        return (
          <View key={index} style={styles.answerLine}>
            {bullet ? <Text style={styles.answerBullet}>•</Text> : null}
            <Text style={styles.answerText}>
              {parseInline(content).map((span, spanIndex) =>
                span.t === 'bold' ? (
                  <Text key={spanIndex} style={styles.answerStrong}>
                    {span.text}
                  </Text>
                ) : span.t === 'link' ? (
                  <Text
                    key={spanIndex}
                    accessibilityRole={span.external ? 'link' : undefined}
                    style={{ color: colors.accent }}
                    onPress={span.external ? () => void Linking.openURL(span.url) : undefined}
                  >
                    {span.text}
                  </Text>
                ) : (
                  // Single-asterisk emphasis is not parsed; drop its markers rather than show them.
                  span.text.replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])/g, '$1$2')
                ),
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = meetingPalette(theme.colors);
  return {
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontSize: theme.text.xs,
      fontWeight: '700',
      letterSpacing: 1.2,
    },
    sectionHint: { color: colors.textFaint, fontSize: theme.text.xs },
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
      backgroundColor: colors.surface,
    },
    avatarText: { color: colors.text, fontWeight: '700' },
    avatarCaption: { color: colors.textMuted, fontSize: theme.text.xs },
    avatarCaptionActive: { color: colors.text },
    avatarDetail: { color: colors.textFaint, fontSize: theme.text.xs },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 22,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    dot: { width: 7, height: 7, borderRadius: 4 },
    cardLabel: { flex: 1, fontSize: theme.text.xs, fontWeight: '700', letterSpacing: 1.2 },
    cardTime: { color: colors.textFaint, fontSize: theme.text.xs },
    cardQuote: { color: colors.textMuted, fontSize: theme.text.sm },
    cardTitle: { color: colors.text, fontSize: theme.text.md, lineHeight: 22 },
    cardQuestion: {
      color: colors.text,
      fontSize: theme.text.lg,
      fontWeight: '700',
      lineHeight: 24,
    },
    answer: { gap: theme.spacing.xs },
    answerLine: { flexDirection: 'row', gap: theme.spacing.sm },
    answerBullet: { color: colors.textMuted, fontSize: theme.text.md, lineHeight: 22 },
    answerText: { flex: 1, color: colors.text, fontSize: theme.text.md, lineHeight: 22 },
    answerStrong: { fontWeight: '700' },
    cardBody: { color: colors.text, fontSize: theme.text.sm, lineHeight: 20 },
    cardSource: { color: colors.accent, fontSize: theme.text.xs },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing.md,
      marginTop: theme.spacing.xs,
    },
    primaryAction: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
      borderWidth: 1,
      borderRadius: theme.radius.pill,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    primaryActionText: { color: colors.onPrimary, fontWeight: '700' },
    quietAction: { paddingHorizontal: theme.spacing.xs, paddingVertical: theme.spacing.sm },
    quietActionText: { color: colors.textMuted },
  };
});
