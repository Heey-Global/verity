import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/** Asks for a file name. `Alert.prompt` exists only on iOS, so the dialog is
 * drawn over the sheet. The stem is preselected, leaving the extension in place
 * for the common case of changing only the name. `validate` answers before any
 * request; `onSubmit` may still reject (the agent can take the name in between),
 * and its message then stays in the dialog with the name still editable. */
export function FileNameDialog({
  title,
  subtitle,
  initialName,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
}: {
  title: string;
  subtitle?: string;
  initialName: string;
  confirmLabel: string;
  validate: (name: string) => string | null;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  const [name, setName] = useState(initialName);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const preselected = useRef(false);
  const problem = validate(name);
  const unchanged = name === initialName;
  const stem = initialName.lastIndexOf('.') > 0 ? initialName.lastIndexOf('.') : initialName.length;

  const submit = () => {
    if (problem !== null || unchanged || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    onSubmit(name)
      .catch((err: unknown) => setSubmitError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSubmitting(false));
  };

  const message = submitError ?? (unchanged ? null : problem);
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={submitting ? () => {} : onCancel}
    >
      <KeyboardAvoidingView behavior="padding" style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={submitting ? undefined : onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <TextInput
            value={name}
            onChangeText={(next) => {
              setName(next);
              setSubmitError(null);
            }}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            selection={selection}
            onSelectionChange={() => setSelection(undefined)}
            // Preselect the stem once; after that the caret is the operator's.
            onFocus={() => {
              if (preselected.current) return;
              preselected.current = true;
              setSelection({ start: 0, end: stem });
            }}
            returnKeyType="done"
            onSubmitEditing={submit}
            editable={!submitting}
            accessibilityLabel="File name"
            style={[styles.input, message ? styles.inputInvalid : null]}
            placeholderTextColor={theme.colors.textFaint}
          />
          {message ? (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {message}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={problem !== null || unchanged || submitting}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityState={{ disabled: problem !== null || unchanged || submitting }}
              style={({ pressed }) => [
                styles.action,
                styles.confirm,
                problem !== null || unchanged ? styles.confirmDisabled : null,
                pressed ? styles.pressed : null,
              ]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={theme.colors.onPrimary} />
              ) : (
                <Text style={styles.confirmLabel}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
    zIndex: 11,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.lg,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
  },
  input: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  inputInvalid: { borderColor: theme.colors.tone.danger },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  action: {
    minHeight: 36,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
  },
  pressed: { opacity: 0.7 },
  cancelLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  confirm: { backgroundColor: theme.colors.primary },
  confirmDisabled: { opacity: 0.45 },
  confirmLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
}));
