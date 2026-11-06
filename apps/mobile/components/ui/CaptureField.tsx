import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Text } from './Text';
import { tint } from './tint';

type Shared = {
  placeholder: string;
  /** Dictation is running: the microphone becomes a tonal stop. */
  listening?: boolean;
  onMic?: () => void;
};

/**
 * The one field for telling Verity something (docs/design-system.md § 5.8,
 * Capture): a `surfaceAlt` field with a tonal microphone and, where it sends
 * itself, a tonal send button — `action` for everything that acts, nothing in
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
        styles.tonal,
        props.listening ? styles.tonalActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon name={props.listening ? 'square' : 'mic'} size={18} color={theme.colors.action} />
    </Pressable>
  ) : null;
  if ('onOpen' in props)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        {...(props.accessibilityHint ? { accessibilityHint: props.accessibilityHint } : {})}
        onPress={props.onOpen}
        style={({ pressed }) => [styles.field, pressed ? styles.pressed : null]}
      >
        <Text variant="body" tone="faint" style={styles.flex}>
          {props.placeholder}
        </Text>
        <View style={styles.tonal} accessible={false}>
          <Icon name="mic" size={18} color={theme.colors.action} />
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
      {mic}
      <Pressable
        onPress={props.onSend}
        disabled={props.sendDisabled}
        accessibilityRole="button"
        accessibilityLabel="Send to Verity"
        accessibilityState={{ disabled: props.sendDisabled === true }}
        hitSlop={2}
        style={({ pressed }) => [
          styles.tonal,
          props.sendDisabled ? styles.disabled : null,
          pressed && !props.sendDisabled ? styles.pressed : null,
        ]}
      >
        <Icon name="arrow-up" size={18} color={theme.colors.action} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    minHeight: 48,
    maxHeight: 160,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  flex: { flex: 1, alignSelf: 'center' },
  input: {
    ...theme.typography.body,
    flex: 1,
    alignSelf: 'center',
    color: theme.colors.text,
    paddingVertical: theme.spacing.xs,
  },
  tonal: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
    borderWidth: 1,
    borderColor: tint(theme.colors.action, 'border'),
  },
  tonalActive: { borderColor: theme.colors.action },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
}));
