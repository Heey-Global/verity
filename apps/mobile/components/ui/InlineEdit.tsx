import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Text } from './Text';
import { tint } from './tint';

/**
 * Text that is edited where it stands (docs/design-system.md § 5.3): at rest it
 * reads as the surrounding text; a tap turns it into a slim field in the same
 * typography, marked only by an underline, with a small check beside it.
 *
 * Leaving the field saves, as do Return and the check. Escape — a hardware
 * keyboard on iPad or the desktop — puts the old text back. A failed save keeps
 * the field open with the typed text and names the reason below it.
 *
 * Without `onSave` the text is not editable and simply shows `value`.
 */
export function InlineEdit({
  value,
  onSave,
  label,
  variant = 'body',
  multiline = false,
  placeholder,
  emptyText,
  required = false,
  maxLength,
  numberOfLines,
  header = false,
  testID,
}: {
  value: string;
  /** Stores the new text; a rejection keeps the field open with its message. */
  onSave?: ((next: string) => Promise<void>) | undefined;
  /** Names the field for VoiceOver and the empty-name message. */
  label: string;
  variant?: 'title' | 'subtitle' | 'body';
  multiline?: boolean;
  /** Offered at rest when `value` is empty, e.g. "Add description". */
  placeholder?: string;
  /** Shown at rest, read-only, when `value` is empty and nothing can be added. */
  emptyText?: string;
  /** Refuse an empty text instead of saving it. */
  required?: boolean;
  maxLength?: number;
  numberOfLines?: number;
  /** The text is the screen's heading. */
  header?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // Blur and the check both finish an edit; whichever comes second must not
  // save twice. Escape ends the edit too, and the blur that follows it must
  // not save what was just discarded.
  const finishing = useRef(false);
  const open = useRef(false);
  const editing = draft !== undefined;

  const start = () => {
    open.current = true;
    finishing.current = false;
    setError(undefined);
    setDraft(value);
  };
  const close = () => {
    open.current = false;
    setDraft(undefined);
    setError(undefined);
  };
  const save = async () => {
    if (draft === undefined || !open.current || finishing.current) return;
    const next = draft.trim();
    if (next === value.trim()) {
      close();
      return;
    }
    if (required && next === '') {
      setError(`${label} cannot be empty.`);
      return;
    }
    finishing.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await onSave?.(next);
      close();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : `Could not save the ${label.toLowerCase()}.`,
      );
    } finally {
      finishing.current = false;
      setSaving(false);
    }
  };

  if (!editing) {
    const empty = value.trim() === '';
    if (onSave === undefined)
      return empty && emptyText === undefined ? null : (
        <Text
          variant={variant}
          numberOfLines={numberOfLines}
          accessibilityRole={header ? 'header' : undefined}
          testID={testID}
        >
          {empty ? emptyText : value}
        </Text>
      );
    return (
      <Pressable
        onPress={start}
        accessibilityRole="button"
        accessibilityLabel={empty ? (placeholder ?? label) : `${label}: ${value}`}
        accessibilityHint={`Edits the ${label.toLowerCase()}`}
        style={({ pressed }) => [styles.rest, pressed ? styles.pressed : null]}
        testID={testID}
      >
        {empty && placeholder !== undefined ? (
          <>
            <Icon name="plus" size={14} color={theme.colors.textFaint} />
            <Text variant={variant} tone="faint">
              {placeholder}
            </Text>
          </>
        ) : (
          <Text
            variant={variant}
            numberOfLines={numberOfLines}
            accessibilityRole={header ? 'header' : undefined}
          >
            {value}
          </Text>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={[styles.field, error !== undefined ? styles.fieldError : styles.fieldFocused]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          multiline={multiline}
          // Return finishes the edit even in the multi-line description, which
          // is one paragraph under the name rather than a document.
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          onBlur={() => void save()}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === 'Escape') close();
          }}
          editable={!saving}
          maxLength={maxLength}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel={label}
          style={[styles.input, inputStyles[variant], multiline ? styles.inputMulti : null]}
          testID={testID === undefined ? undefined : `${testID}-input`}
        />
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={`Save ${label.toLowerCase()}`}
          hitSlop={8}
          style={[styles.check, multiline ? styles.checkTop : null]}
        >
          <Icon name="check" size={16} color={theme.colors.action} />
        </Pressable>
      </View>
      {error !== undefined ? (
        <View style={styles.errorLine} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={14} color={theme.colors.attention} />
          <Text variant="footnote" tone="attention" style={styles.flex}>
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  rest: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  pressed: { opacity: 0.6 },
  wrap: { gap: theme.spacing.xs },
  // No box: the text stays where it read at rest, an underline marks the field.
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.xxs,
    borderBottomWidth: 1,
  },
  fieldFocused: { borderBottomColor: theme.colors.action },
  fieldError: { borderBottomColor: theme.colors.attention },
  input: { flex: 1, minWidth: 0, color: theme.colors.text, paddingVertical: 0 },
  inputMulti: { minHeight: theme.typography.subtitle.lineHeight * 3, textAlignVertical: 'top' },
  check: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  checkTop: { alignSelf: 'flex-start' },
  errorLine: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs },
}));

const inputStyles = StyleSheet.create((theme) => ({
  title: {
    fontFamily: theme.typography.title.fontFamily,
    fontSize: theme.typography.title.fontSize,
    letterSpacing: theme.typography.title.letterSpacing,
  },
  subtitle: {
    fontFamily: theme.typography.subtitle.fontFamily,
    fontSize: theme.typography.subtitle.fontSize,
    lineHeight: theme.typography.subtitle.lineHeight,
  },
  body: {
    fontFamily: theme.typography.body.fontFamily,
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.typography.body.lineHeight,
  },
}));
