import type { ReactNode } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../components/Icon';
import { Text } from '../../components/ui';

/**
 * A link to another page of the project knowledge inside running text.
 * Design-system gap: the Markdown reader has no in-app link style yet; the
 * Wiki needs one that reads as tappable without looking like a web link.
 */
export function Link({ children }: { children: ReactNode }) {
  return (
    <Text variant="body" tone="action" accessibilityRole="link">
      {children}
    </Text>
  );
}

/**
 * The session's composer as the Wiki page would use it: the field on top, plus
 * on the left, microphone and send on the right, empty and so not sendable.
 * Design-system gap: the composer lives inside the session screen; the plan
 * extracts it into a shared component, which these values copy until then.
 */
export function SessionComposer({ placeholder }: { placeholder: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.card}>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        multiline
        accessibilityLabel="Message input"
      />
      <View style={styles.actionRow}>
        <Pressable style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Add">
          <Icon name="plus" size={22} color={theme.colors.textMuted} />
        </Pressable>
        <View style={styles.actionRowRight}>
          <Pressable
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Start voice dictation"
          >
            <Icon name="mic" size={22} color={theme.colors.textMuted} />
          </Pressable>
          <Pressable
            style={[styles.sendButton, styles.sendButtonDisabled]}
            disabled
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Icon name="arrow-up" size={22} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
    gap: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  input: {
    color: theme.colors.text,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.row.fontSize,
    lineHeight: 21 * theme.fontScale,
    minHeight: 24,
    padding: 0,
    paddingTop: 2,
    textAlignVertical: 'top',
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionRowRight: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sendButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.action,
  },
  sendButtonDisabled: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
