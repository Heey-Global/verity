import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { tint } from './tint';

/** The four status intents (docs/design-system.md § 8). */
export type StatusIntent = 'ready' | 'needsSetup' | 'optional' | 'transient';

/**
 * The state of a single element as a small uppercase word on a tinted ground
 * (§ 5.4). `optional` is shown as a neutral tag here only where the spec allows
 * it (`Soon` on a feature card); elsewhere `optional` is plain muted text, which
 * `StatusText` renders. `transient` shows a spinner next to its word.
 */
export function StatusTag({ intent, label }: { intent: StatusIntent; label: string }) {
  const { theme } = useUnistyles();
  if (intent === 'transient') return <StatusText intent="transient" label={label} />;
  return (
    <View
      style={[
        styles.tag,
        intent === 'ready' ? styles.tagReady : intent === 'needsSetup' ? styles.tagAttention : null,
      ]}
      accessible
      accessibilityLabel={`${label}, ${describe(intent)}`}
    >
      <Text
        style={[
          styles.tagLabel,
          {
            color:
              intent === 'ready'
                ? theme.colors.success
                : intent === 'needsSetup'
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
    <View style={styles.dotRow} accessible accessibilityLabel={`${label}, ${describe(intent)}`}>
      <Dot intent={intent} />
      <Text style={styles.word}>{label}</Text>
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
        intent === 'ready' ? styles.dotReady : intent === 'needsSetup' ? styles.dotAttention : null,
      ]}
    />
  );
}

/** Plain muted word, with a spinner for `transient`. */
function StatusText({ intent, label }: { intent: StatusIntent; label: string }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={styles.dotRow}
      accessible
      accessibilityLabel={`${label}, ${describe(intent)}`}
      accessibilityLiveRegion="polite"
    >
      {intent === 'transient' ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : null}
      <Text style={styles.word}>{label}</Text>
    </View>
  );
}

function describe(intent: StatusIntent): string {
  return intent === 'ready'
    ? 'ready'
    : intent === 'needsSetup'
      ? 'needs attention'
      : intent === 'transient'
        ? 'in progress'
        : 'optional';
}

const styles = StyleSheet.create((theme) => ({
  tag: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.tag,
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  tagReady: { backgroundColor: tint(theme.colors.success, 'fill') },
  tagAttention: { backgroundColor: tint(theme.colors.attention, 'fill') },
  tagLabel: { ...theme.typography.label },
  dotRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.textFaint },
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
    fontSize: 14 * theme.fontScale,
    color: theme.colors.textMuted,
  },
}));
