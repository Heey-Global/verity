import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { tint } from './tint';

/** The status intents (docs/design-system.md § 8). */
export type StatusIntent = 'action' | 'ready' | 'needsSetup' | 'optional' | 'transient' | 'unknown';

/**
 * The state of a single element as a small uppercase word on a tinted ground
 * (§ 5.4). `optional` is shown as a neutral tag here only where the spec allows
 * it (`Soon` on a feature card); elsewhere `optional` is plain muted text, which
 * `StatusText` renders. `transient` shows a spinner next to its word.
 */
export function StatusTag({
  intent,
  label,
  muted = false,
}: {
  intent: StatusIntent;
  label: string;
  /**
   * Draws the tag in the neutral tone while keeping the intent's spoken meaning,
   * for a row whose icon and subtitle already carry the color.
   */
  muted?: boolean;
}) {
  const { theme } = useUnistyles();
  if (intent === 'transient') return <StatusText intent="transient" label={label} />;
  const tone: StatusIntent | 'neutral' = muted ? 'neutral' : intent;
  return (
    <View
      style={[
        styles.tag,
        styles.shrink,
        tone === 'action'
          ? styles.tagAction
          : tone === 'ready'
            ? styles.tagReady
            : tone === 'needsSetup'
              ? styles.tagAttention
              : null,
      ]}
      accessible
      accessibilityLabel={`${label}, ${describe(intent)}`}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.tagLabel,
          {
            color:
              tone === 'action'
                ? theme.colors.action
                : tone === 'ready'
                  ? theme.colors.success
                  : tone === 'needsSetup'
                    ? theme.colors.attention
                    : theme.colors.textMuted,
          },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * A row's state in a pure status list: an 8 px dot in the intent's tone
 * followed by a muted word. The word is always there, so the state never
 * depends on color alone.
 */
export function StatusDot({ intent, label }: { intent: StatusIntent; label: string }) {
  if (intent === 'transient') return <StatusText intent="transient" label={label} />;
  return (
    <View
      style={[styles.dotRow, styles.shrink]}
      accessible
      accessibilityLabel={`${label}, ${describe(intent)}`}
    >
      <Dot intent={intent} />
      <Text style={[styles.word, styles.shrink]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A screen's own state under its title, such as a running meeting's `Live · 04:28`: a pill
 * with a dot (or an icon for a plain fact like the meeting platform) and a short word.
 * `ready` and `needsSetup` carry their tone; `neutral` is a quiet fact.
 */
export function StatusPill({
  intent,
  label,
  icon,
}: {
  intent: 'ready' | 'needsSetup' | 'neutral';
  label: string;
  icon?: IconName;
}) {
  const { theme } = useUnistyles();
  const tone =
    intent === 'ready'
      ? theme.colors.success
      : intent === 'needsSetup'
        ? theme.colors.attention
        : theme.colors.textMuted;
  return (
    <View
      style={[
        styles.pill,
        intent === 'neutral'
          ? null
          : { borderColor: tint(tone, 'border'), backgroundColor: tint(tone, 'fill') },
      ]}
      accessible
      accessibilityLabel={
        intent === 'neutral'
          ? label
          : `${label}, ${describe(intent === 'ready' ? 'ready' : 'needsSetup')}`
      }
    >
      {icon ? (
        <Icon name={icon} size={14} color={tone} />
      ) : (
        <View style={[styles.pillDot, { backgroundColor: tone }]} />
      )}
      <Text numberOfLines={1} style={[styles.pillLabel, { color: tone }]}>
        {label}
      </Text>
    </View>
  );
}

/** The bare 8 px dot, for a row's leading slot where the row itself names the state. */
export function Dot({ intent }: { intent: StatusIntent }) {
  return (
    <View
      testID="status-dot"
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={[
        styles.dot,
        intent === 'action'
          ? styles.dotAction
          : intent === 'ready'
            ? styles.dotReady
            : intent === 'needsSetup'
              ? styles.dotAttention
              : null,
      ]}
    />
  );
}

/** Plain muted word, with a spinner for `transient`. */
function StatusText({ intent, label }: { intent: StatusIntent; label: string }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[styles.dotRow, styles.shrink]}
      accessible
      accessibilityLabel={`${label}, ${describe(intent)}`}
      accessibilityLiveRegion="polite"
    >
      {intent === 'transient' ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : null}
      <Text style={[styles.word, styles.shrink]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function describe(intent: StatusIntent): string {
  return intent === 'action'
    ? 'waiting for you'
    : intent === 'ready'
      ? 'ready'
      : intent === 'needsSetup'
        ? 'needs attention'
        : intent === 'transient'
          ? 'in progress'
          : intent === 'unknown'
            ? 'outcome unknown'
            : 'optional';
}

const styles = StyleSheet.create((theme) => ({
  tag: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.tag,
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  tagAction: { backgroundColor: tint(theme.colors.action, 'fill') },
  tagReady: { backgroundColor: tint(theme.colors.success, 'fill') },
  tagAttention: { backgroundColor: tint(theme.colors.attention, 'fill') },
  tagLabel: { ...theme.typography.label },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
    minHeight: 32,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    flexShrink: 1,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillLabel: { ...theme.typography.footnote, fontFamily: theme.fonts.bold, flexShrink: 1 },
  dotRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  // A status word truncates instead of pushing the row's title aside.
  shrink: { flexShrink: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.textFaint },
  dotAction: { backgroundColor: theme.colors.action },
  dotReady: {
    backgroundColor: theme.colors.success,
    shadowColor: theme.colors.success,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  dotAttention: {
    backgroundColor: theme.colors.attention,
    shadowColor: theme.colors.attention,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  word: {
    ...theme.typography.subtitle,
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.textMuted,
  },
}));
