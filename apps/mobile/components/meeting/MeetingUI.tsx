import { useEffect, useId, useState, type ReactNode } from 'react';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Linking,
  Pressable,
  Text,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseInline } from '@verity/mobile';

import { Icon } from '../Icon';
import { Button } from '../ui';

// Both themes' literal color types, widened so one helper accepts either.
type ThemeColors = ReturnType<typeof useUnistyles>['theme']['colors'];
type Colors = {
  [Key in keyof ThemeColors]: ThemeColors[Key] extends string ? string : ThemeColors[Key];
};

// Speakers keep one color for the whole meeting; accents appear only as rings and dots.
// Signature is left out: in a meeting, pink is Verity's.
export function speakerTone(colors: Colors, speaker: number): string {
  const palette = [colors.action, colors.success, colors.textMuted, colors.attention];
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
  const colors = theme.colors;
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
                <Stop offset="0" stopColor={colors.signature} />
                <Stop offset="0.5" stopColor="#a968f3" />
                <Stop offset="1" stopColor={colors.action} />
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
          <Text style={{ color: colors.textMuted, ...theme.typography.label }}>{label}</Text>
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
        <Button
          key={action.label}
          label={action.label}
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          variant="text"
          size="compact"
          disabled={action.disabled === true}
          onPress={action.onPress}
        />
      ))}
    </View>
  );
}

/** Who a card responds to and when, as shown in its header. */
export type CardAttribution = { name?: string; initial?: string; tone?: string; time?: string };

export function NoticedCard({
  label,
  tone,
  time,
  attribution,
  quote,
  title,
  body,
  source,
  sourceUrl,
  working = false,
  actions = [],
  fresh = false,
  onDismiss,
  dismissLabel = 'Dismiss',
  onToggle,
  children,
}: {
  /** The kind of card when the title does not say it, such as an open question. */
  label?: string;
  tone: string;
  time?: string;
  attribution?: CardAttribution;
  quote?: string;
  title: string;
  body?: string;
  source?: string | null;
  /** Opens the source when it is tapped. */
  sourceUrl?: string | null;
  /** Verity is still on it: `label` names what it is doing and the answer lines shimmer. */
  working?: boolean;
  actions?: CardAction[];
  /** Verity's newest contribution, outlined in its signature color. */
  fresh?: boolean;
  /** Shows a close button in the header that removes the card. */
  onDismiss?: () => void;
  dismissLabel?: string;
  children?: ReactNode;
  onToggle?: () => void;
}) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const meta = attribution ?? (time ? { time } : undefined);
  const heading = <Text style={styles.cardTitle}>{title}</Text>;
  return (
    <View style={[styles.card, fresh && styles.cardFresh]} testID="meeting-card">
      <View style={styles.cardHeader}>
        <View style={styles.fill}>
          {onToggle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle meeting answer"
              onPress={onToggle}
            >
              {heading}
            </Pressable>
          ) : (
            heading
          )}
        </View>
        {meta ? (
          <View style={styles.cardMeta}>
            {meta.initial ? (
              <View style={[styles.metaAvatar, { borderColor: meta.tone ?? colors.textMuted }]}>
                <Text style={[styles.metaInitial, { color: meta.tone ?? colors.textMuted }]}>
                  {meta.initial}
                </Text>
              </View>
            ) : null}
            <Text style={styles.cardTime}>
              {[meta.name, meta.time].filter(Boolean).join(' · ')}
            </Text>
          </View>
        ) : null}
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
      {working ? (
        <View style={styles.workingLine}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          {label ? <Text style={styles.workingText}>{label}</Text> : null}
        </View>
      ) : label ? (
        <Text style={[styles.cardLabel, { color: tone }]}>{label}</Text>
      ) : null}
      {quote ? <Text style={styles.cardQuote}>{quote}</Text> : null}
      {body ? <Text style={styles.cardBody}>{body}</Text> : null}
      {onToggle && children ? (
        // The answer itself toggles too; VoiceOver uses the title's button for it.
        <Pressable accessible={false} onPress={onToggle}>
          {children}
        </Pressable>
      ) : (
        children
      )}
      {working && !children ? <WorkingLines /> : null}
      {source ? (
        sourceUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open source ${source}`}
            onPress={() => void Linking.openURL(sourceUrl)}
            style={styles.sourceLink}
          >
            <Text style={styles.cardSource}>{source}</Text>
            <Icon name="external-link" size={14} color={colors.action} />
          </Pressable>
        ) : (
          <Text style={styles.cardSourcePlain}>{source}</Text>
        )
      ) : null}
      <ActionRow actions={actions} />
    </View>
  );
}

// Placeholder lines where the answer will appear; they pulse unless Reduce Motion is on.
function WorkingLines() {
  const [pulse] = useState(() => new Animated.Value(1));
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    pulse.setValue(1);
    if (reduceMotion) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion]);
  return (
    <Animated.View
      testID="meeting-card-working"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.workingLines, { opacity: pulse }]}
    >
      <View style={[styles.workingBar, { width: '78%' }]} />
      <View style={[styles.workingBar, { width: '52%' }]} />
    </Animated.View>
  );
}

export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

// Meeting answers are short Markdown bullet lists. Lines keep their own row so bullets
// never run together, and inline bold and links render instead of showing raw markup.
export function MeetingAnswerText({ text }: { text: string }) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
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
                    style={{ color: colors.action }}
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
  const colors = theme.colors;
  return {
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontSize: theme.typography.footnote.fontSize,
      fontFamily: theme.fonts.bold,
      letterSpacing: 1.2,
    },
    sectionHint: {
      color: colors.textFaint,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.footnote.fontSize,
    },
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
    avatarText: { color: colors.text, fontFamily: theme.fonts.bold },
    avatarCaption: {
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.footnote.fontSize,
    },
    avatarCaptionActive: { color: colors.text },
    avatarDetail: {
      color: colors.textFaint,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.footnote.fontSize,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: theme.radius.card,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    cardFresh: { borderColor: colors.signature },
    fill: { flex: 1 },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
    cardMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingTop: theme.spacing.xxs,
    },
    metaAvatar: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaInitial: { ...theme.typography.caption, fontFamily: theme.fonts.bold },
    cardLabel: { ...theme.typography.label, fontFamily: theme.fonts.bold },
    cardTime: {
      ...theme.typography.footnote,
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
    },
    cardQuote: {
      ...theme.typography.bodySmall,
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
    },
    cardTitle: {
      ...theme.typography.row,
      color: colors.text,
      fontFamily: theme.fonts.semibold,
    },
    workingLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    workingText: {
      ...theme.typography.bodySmall,
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
    },
    workingLines: { gap: theme.spacing.sm, paddingVertical: theme.spacing.xs },
    workingBar: { height: 8, borderRadius: 4, backgroundColor: colors.border },
    answer: { gap: theme.spacing.xs },
    answerLine: { flexDirection: 'row', gap: theme.spacing.sm },
    answerBullet: {
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
      lineHeight: 22,
    },
    answerText: {
      flex: 1,
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.row.fontSize,
      lineHeight: 22,
    },
    answerStrong: { fontFamily: theme.fonts.bold },
    cardBody: {
      color: colors.text,
      fontFamily: theme.fonts.regular,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 20,
    },
    sourceLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      alignSelf: 'flex-start',
    },
    cardSource: {
      ...theme.typography.bodySmall,
      color: colors.action,
      fontFamily: theme.fonts.regular,
    },
    cardSourcePlain: {
      ...theme.typography.footnote,
      color: colors.textMuted,
      fontFamily: theme.fonts.regular,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing.md,
      marginTop: theme.spacing.xs,
    },
  };
});
