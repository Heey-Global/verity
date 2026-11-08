import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Text } from './Text';

type Shared = {
  placeholder: string;
  /** Dictation is running: the microphone becomes a filled confirmation button. */
  listening?: boolean;
  onMic?: () => void;
};

/**
 * The one field for telling Verity something (docs/design-system.md § 5.8,
 * Capture): a `surfaceAlt` field with circular microphone and send controls
 * below the text, matching the session chat composer — `action` for everything that acts, nothing in
 * Verity's pink.
 *
 * With `onOpen` it is a doorway (Home's "Tell Verity"): the whole field opens
 * her panel. With `onChangeText` it is the panel's own composer.
 */
export function CaptureField(
  props: Shared &
    (
      | { onOpen: () => void; accessibilityLabel: string; accessibilityHint?: string }
      | {
          value: string;
          onChangeText: (value: string) => void;
          onSend: () => void;
          sendDisabled?: boolean;
          autoFocus?: boolean;
          accessibilityLabel: string;
        }
    ),
) {
  const { theme } = useUnistyles();
  const mic = props.onMic ? (
    <Pressable
      onPress={props.onMic}
      accessibilityRole="button"
      accessibilityLabel={props.listening ? 'Stop dictation' : 'Dictate'}
      accessibilityState={{ selected: props.listening === true }}
      hitSlop={2}
      style={({ pressed }) => [
        styles.control,
        props.listening ? styles.controlActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon
        name={props.listening ? 'check' : 'mic'}
        size={22}
        color={props.listening ? theme.colors.onAction : theme.colors.textMuted}
      />
    </Pressable>
  ) : null;
  if ('onOpen' in props)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        {...(props.accessibilityHint ? { accessibilityHint: props.accessibilityHint } : {})}
        onPress={props.onOpen}
        style={({ pressed }) => [styles.field, styles.doorway, pressed ? styles.pressed : null]}
      >
        <Text variant="body" tone="faint" style={styles.flex}>
          {props.placeholder}
        </Text>
        <View style={styles.control} accessible={false}>
          <Icon name="mic" size={22} color={theme.colors.textMuted} />
        </View>
      </Pressable>
    );
  return (
    <View style={styles.field}>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={theme.colors.textFaint}
        multiline
        autoFocus={props.autoFocus}
        accessibilityLabel={props.accessibilityLabel}
        style={styles.input}
      />
      <View style={styles.actions}>
        {mic}
        <Pressable
          onPress={props.onSend}
          disabled={props.sendDisabled}
          accessibilityRole="button"
          accessibilityLabel="Send to Verity"
          accessibilityState={{ disabled: props.sendDisabled === true }}
          hitSlop={2}
          style={({ pressed }) => [
            styles.control,
            !props.sendDisabled ? styles.sendActive : null,
            pressed && !props.sendDisabled ? styles.pressed : null,
          ]}
        >
          <Icon
            name="arrow-up"
            size={22}
            color={props.sendDisabled ? theme.colors.textMuted : theme.colors.onAction}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: 10,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  doorway: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  flex: { flex: 1, alignSelf: 'center' },
  input: {
    color: theme.colors.text,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.row.fontSize,
    lineHeight: 21 * theme.fontScale,
    minHeight: 24,
    maxHeight: 21 * 8,
    padding: 0,
    paddingTop: 2,
    textAlignVertical: 'top',
  },
  control: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  controlActive: { backgroundColor: theme.colors.action, borderColor: theme.colors.action },
  sendActive: { backgroundColor: theme.colors.action, borderColor: theme.colors.action },
  pressed: { opacity: 0.7 },
}));
