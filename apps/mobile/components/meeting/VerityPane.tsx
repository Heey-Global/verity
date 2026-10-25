import { useId, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { groupModelsByEngine, modelDisplayName } from '@verity/mobile';

import { Icon } from '../Icon';
import { Sheet } from '../ui';
import { tint } from '../ui/tint';

const MARK = require('../../assets/brand/verity-v-mark.png') as number;
// The mark's artwork is wider than tall.
const MARK_RATIO = 240 / 168;

/**
 * Verity's place in a live meeting (docs/design-system.md § 5.8): the one surface on the
 * screen with a signature-to-action edge and glow, so what appears inside reads as a
 * participant speaking up rather than as another list.
 */
export function VerityPane({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const gradient = useId();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const radius = theme.radius.card + 4;
  return (
    <View
      testID="verity-pane"
      style={[styles.pane, { borderRadius: radius }]}
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((current) =>
          current?.width === width && current.height === height ? current : { width, height },
        );
      }}
    >
      {size ? (
        <Svg
          pointerEvents="none"
          width={size.width}
          height={size.height}
          style={styles.edge}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Defs>
            <LinearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={colors.signature} />
              <Stop offset="1" stopColor={colors.action} />
            </LinearGradient>
          </Defs>
          <Rect
            x={1}
            y={1}
            width={Math.max(0, size.width - 2)}
            height={Math.max(0, size.height - 2)}
            rx={radius - 1}
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth={2}
          />
        </Svg>
      ) : null}
      <View style={styles.header}>
        <View style={styles.markHalo}>
          <Image
            source={MARK}
            accessibilityIgnoresInvertColors
            style={{ width: 44, height: 44 / MARK_RATIO }}
          />
        </View>
        <Text style={styles.name} accessibilityRole="header">
          Verity
        </Text>
      </View>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.cards}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

/** The question field at the foot of Verity's pane, with the model meeting answers use. */
export function AskVerityField({
  value,
  onChangeText,
  onSubmit,
  sending,
  model,
  onPickModel,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  sending: boolean;
  /** The model meeting requests run on; hidden until it is known. */
  model: string | undefined;
  onPickModel: () => void;
}) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const disabled = !value.trim() || sending;
  return (
    <View style={styles.field}>
      <Image
        source={MARK}
        accessibilityIgnoresInvertColors
        style={{ width: 22, height: 22 / MARK_RATIO }}
      />
      <TextInput
        accessibilityLabel="Ask Verity about this meeting"
        placeholder="Ask Verity…"
        placeholderTextColor={colors.textFaint}
        multiline
        submitBehavior="submit"
        returnKeyType="send"
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={disabled ? undefined : onSubmit}
        style={styles.input}
      />
      {model ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Model for meeting answers: ${modelDisplayName(model)}. Tap to switch.`}
          hitSlop={6}
          onPress={onPickModel}
          style={styles.modelChip}
        >
          <Text style={styles.modelText} numberOfLines={1}>
            {modelDisplayName(model)}
          </Text>
          <Icon name="chevron-down" size={14} color={colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Verity in meeting"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onSubmit}
        style={[styles.send, disabled && styles.sendDisabled]}
      >
        {sending ? (
          <ActivityIndicator size="small" color={colors.action} />
        ) : (
          <Icon name="arrow-up" size={18} color={colors.action} />
        )}
      </Pressable>
    </View>
  );
}

/** Picks the model for this meeting's answers; the chat keeps its own model. */
export function MeetingModelSheet({
  visible,
  models,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  models: string[];
  selected: string | undefined;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  return (
    <Sheet visible={visible} title="Model for this meeting" onClose={onClose}>
      <ScrollView style={styles.sheetList}>
        {groupModelsByEngine(models).map((group) => (
          <View key={group.engine}>
            <Text style={styles.sheetGroup}>{group.engine}</Text>
            {group.models.map((model) => {
              const current = model === selected;
              return (
                <Pressable
                  key={model}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  accessibilityLabel={`Use ${modelDisplayName(model)}${current ? ', current' : ''}`}
                  onPress={() => onPick(model)}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
                >
                  <Text style={styles.sheetRowText}>{modelDisplayName(model)}</Text>
                  {current ? <Icon name="check" size={18} color={colors.action} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => {
  const colors = theme.colors;
  return {
    pane: {
      flex: 1,
      backgroundColor: colors.surface,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      // The pane's glow is Verity's: signature, like every brand moment.
      shadowColor: colors.signature,
      ...theme.elevation.glow,
    },
    edge: { position: 'absolute', left: 0, top: 0 },
    fill: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
    markHalo: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.signature, 'neutral'),
      shadowColor: colors.signature,
      ...theme.elevation.glow,
    },
    name: { ...theme.typography.title, color: colors.text },
    cards: { gap: theme.spacing.md, paddingBottom: theme.spacing.sm },
    field: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.radius.control,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    input: {
      ...theme.typography.body,
      flex: 1,
      maxHeight: 120,
      color: colors.text,
      paddingVertical: theme.spacing.sm,
    },
    modelChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xxs,
      maxWidth: 160,
    },
    modelText: { ...theme.typography.subtitle, color: colors.textMuted },
    send: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.control,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint(colors.action, 'fill'),
      borderWidth: 1,
      borderColor: tint(colors.action, 'border'),
    },
    sendDisabled: { opacity: 0.4 },
    sheetList: { maxHeight: 420 },
    sheetGroup: {
      ...theme.typography.label,
      color: colors.textMuted,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
    },
    sheetRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.xs,
    },
    sheetRowPressed: { backgroundColor: tint(colors.text, 'neutral') },
    sheetRowText: { ...theme.typography.body, color: colors.text },
  };
});
