import { useRef, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HeaderTextButton } from './FileSheetHeader';

/** Asks for a file name. `Alert.prompt` exists only on iOS, so the dialog is
 * drawn over the sheet. The stem is preselected, leaving the extension in place
 * for the common case of changing only the name. `validate` answers before any
 * request; `onSubmit` may still reject (the agent can take the name in between),
 * and its message then stays in the dialog with the name still editable. */
export function FileNameDialog({
  title,
  subtitle,
  initialName,
  allowUnchanged = false,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
}: {
  title: string;
  subtitle?: string;
  initialName: string;
  allowUnchanged?: boolean;
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
  const unchanged = !allowUnchanged && name === initialName;
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
            <HeaderTextButton label="Cancel" disabled={submitting} onPress={onCancel} />
            <HeaderTextButton
              label={confirmLabel}
              emphasis="strong"
              busy={submitting}
              disabled={problem !== null || unchanged}
              onPress={submit}
            />
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
}));
