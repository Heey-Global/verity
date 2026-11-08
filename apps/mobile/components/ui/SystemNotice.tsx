import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import { Dot, type StatusIntent } from './Status';
import { Text } from './Text';
import { tint } from './tint';

/** The intents a system message can carry (docs/design-system.md § 5.9). */
export type SystemNoticeIntent = Extract<StatusIntent, 'transient' | 'needsSetup' | 'unknown'>;

const INDICATOR = 20;

/**
 * One line Verity writes into a chat rather than the agent or the operator:
 * preparation, interruptions, failures, bookkeeping. A status indicator from
 * § 5.4, a short headline saying what happened, an optional muted explanation,
 * then actions and collapsed technical detail. Color only repeats what the
 * words already say, so the headline is always present.
 */
export function SystemNotice({
  intent,
  title,
  detail,
  actions,
  technical,
  link,
  onPress,
  accessibilityLabel,
}: {
  intent: SystemNoticeIntent;
  title: string;
  detail?: string | undefined;
  /** Buttons for the recovery the notice offers, indented under the headline. */
  actions?: ReactNode;
  /** Raw diagnostics, shown only after "Details" is tapped. */
  technical?: string | undefined;
  /** Trailing link word for a notice that opens something (e.g. "Tasks"). */
  link?: string | undefined;
  onPress?: (() => void) | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const prominent = detail !== undefined || actions !== undefined || technical !== undefined;
  const headline = (
    <View style={styles.headline}>
      <SystemNoticeIndicator intent={intent} />
      <Text variant="subtitle" style={[styles.title, prominent ? styles.strong : null]}>
        {title}
      </Text>
      {link ? (
        <Text variant="subtitle" style={styles.strong}>
          {link} ›
        </Text>
      ) : null}
    </View>
  );
  return (
    <View
      style={styles.root}
      accessibilityLiveRegion={intent === 'transient' ? 'polite' : undefined}
    >
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          style={({ pressed }) => (pressed ? styles.pressed : null)}
        >
          {headline}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={accessibilityLabel ?? `${title}, ${describe(intent)}`}>
          {headline}
        </View>
      )}
      {detail ? (
        <Text variant="subtitle" style={styles.indented}>
          {detail}
        </Text>
      ) : null}
      {actions !== undefined || technical !== undefined ? (
        <View style={[styles.indented, styles.actions]}>
          {actions}
          {technical !== undefined ? (
            <Button
              label={open ? 'Hide details' : 'Details'}
              variant="text"
              size="compact"
              onPress={() => setOpen((value) => !value)}
              accessibilityHint={open ? 'Hides the technical output' : 'Shows the technical output'}
            />
          ) : null}
        </View>
      ) : null}
      {technical !== undefined && open ? (
        <View style={[styles.indented, styles.technical]}>
          <CodeBlock text={technical} />
        </View>
      ) : null}
    </View>
  );
}

/** The leading status mark alone, for a status line inside another element
 *  (a message's own "Sending…"), so it matches the notices around it. */
export function SystemNoticeIndicator({ intent }: { intent: SystemNoticeIntent }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.indicator} importantForAccessibility="no" accessibilityElementsHidden>
      {intent === 'transient' ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : (
        <Dot intent={intent} />
      )}
    </View>
  );
}

function describe(intent: SystemNoticeIntent): string {
  return intent === 'transient'
    ? 'in progress'
    : intent === 'needsSetup'
      ? 'needs attention'
      : 'notice';
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.xs, paddingVertical: theme.spacing.xs },
  headline: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  indicator: { width: INDICATOR, alignItems: 'center' },
  title: { flex: 1, color: theme.colors.text },
  strong: { fontFamily: theme.fonts.semibold },
  indented: { marginLeft: INDICATOR + theme.spacing.sm },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  technical: {
    marginTop: theme.spacing.xs,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral'), borderRadius: theme.radius.md },
}));
