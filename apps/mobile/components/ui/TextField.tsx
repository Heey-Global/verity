import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { tint } from './tint';

const MAX_LINES = 6;

/**
 * A labelled text field (docs/design-system.md § 5.3). The label sits above the
 * field; focus draws the `action` border and ring. An error keeps the entered
 * text in place and explains it in a hint box below — saving the value stays the
 * caller's job and must not happen while `error` is set.
 *
 * `secret` masks the value behind a reveal control and asks the platform not to
 * offer it to the password manager; `multiline` grows up to six lines.
 */
export function TextField({
  label,
  value,
  onChangeText,
  onBlur,
  onSubmitEditing,
  placeholder,
  error,
  secret = false,
  multiline = false,
  disabled = false,
  keyboardType,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  placeholder?: string;
  error?: { title: string; message: string } | undefined;
  secret?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  keyboardType?: 'default' | 'url' | 'email-address' | 'number-pad';
  autoFocus?: boolean;
}) {
  const { theme } = useUnistyles();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;
  const literal = secret || keyboardType === 'url' || keyboardType === 'email-address';
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.field,
          multiline ? styles.multiline : null,
          focused ? styles.focused : null,
          error !== undefined && !focused ? styles.error : null,
          disabled ? styles.disabled : null,
        ]}
      >
        <TextInput
          style={[styles.input, secret ? styles.mono : null, multiline ? styles.inputMulti : null]}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          onSubmitEditing={onSubmitEditing}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          editable={!disabled}
          multiline={multiline}
          secureTextEntry={masked}
          // A revealed key is still a key: Android keyboards must not learn it.
          keyboardType={
            secret && revealed && Platform.OS === 'android' ? 'visible-password' : keyboardType
          }
          autoFocus={autoFocus}
          // Keys, addresses and emails must arrive exactly as typed; prose keeps
          // the platform's capitalization, correction and spell check.
          {...(literal
            ? { autoCapitalize: 'none' as const, autoCorrect: false, spellCheck: false }
            : {})}
          // A key or token is not an account password: ask the platform to keep
          // it out of autofill and the save prompt. This is a hint, not a
          // guarantee — browsers ignore it on masked inputs.
          {...(secret
            ? {
                textContentType: 'none' as const,
                autoComplete: 'off' as const,
                importantForAutofill: 'no' as const,
              }
            : {})}
          accessibilityLabel={label}
          accessibilityHint={error !== undefined ? error.message : undefined}
          accessibilityState={{ disabled }}
        />
        {secret ? (
          <Pressable
            onPress={() => setRevealed((shown) => !shown)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
            hitSlop={8}
            style={styles.reveal}
          >
            <Icon name={revealed ? 'eye-off' : 'eye'} size={18} color={theme.colors.textFaint} />
          </Pressable>
        ) : null}
      </View>
      {error !== undefined ? <HintBox title={error.title} message={error.message} /> : null}
    </View>
  );
}

/**
 * The red hint box under a field or in a flow: a short bold title and one
 * sentence. Announced as an alert so the problem is heard, not just seen.
 */
export function HintBox({ title, message }: { title: string; message: string }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={styles.hint}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${message}`}
      accessibilityLiveRegion="polite"
    >
      <Icon name="alert-circle" size={18} color={theme.colors.attention} />
      <View style={styles.hintBody}>
        <Text style={styles.hintTitle}>{title}</Text>
        <Text style={styles.hintMessage}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: theme.spacing.sm - theme.spacing.xxs },
  label: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  field: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  multiline: { alignItems: 'flex-start', paddingVertical: theme.spacing.md },
  focused: {
    borderColor: theme.colors.action,
    // The 3 px ring: a spread shadow on web, an outline-colored glow natively.
    ...Platform.select({
      web: { boxShadow: `0 0 0 3px ${tint(theme.colors.action, 'ring')}` },
      default: {
        shadowColor: theme.colors.action,
        shadowOpacity: 0.2,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 0 },
      },
    }),
  },
  error: { borderColor: tint(theme.colors.attention, 'border') },
  disabled: { opacity: 0.4 },
  input: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
    fontFamily: theme.typography.body.fontFamily,
    fontSize: theme.typography.body.fontSize,
    // No lineHeight on a single line: iOS would push text and caret off center.
    // TextInput adds its own vertical padding on Android; the field owns spacing.
    paddingVertical: 0,
  },
  inputMulti: {
    lineHeight: theme.typography.body.lineHeight,
    minHeight: theme.typography.body.lineHeight * 2,
    maxHeight: theme.typography.body.lineHeight * MAX_LINES,
    textAlignVertical: 'top',
  },
  mono: { fontFamily: theme.fonts.mono, letterSpacing: 0.6 },
  reveal: { minHeight: 44, justifyContent: 'center' },
  hint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm + theme.spacing.xxs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: tint(theme.colors.attention, 'border'),
    backgroundColor: tint(theme.colors.attention, 'neutral'),
  },
  hintBody: { flex: 1, gap: theme.spacing.xxs },
  hintTitle: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.text,
  },
  hintMessage: { ...theme.typography.subtitle, color: theme.colors.textMuted },
}));
