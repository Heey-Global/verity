import type { Ref } from 'react';
import { Pressable, type View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';

/** Measurable drag target with equivalent screen-reader move actions. */
export function ReorderHandle({
  ref,
  label,
  canMoveUp,
  canMoveDown,
  disabled,
  onMove,
}: {
  ref?: Ref<View>;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      ref={ref}
      collapsable={false}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityHint="Hold and drag, or use the move actions."
      accessibilityState={{ disabled }}
      accessibilityActions={[
        ...(canMoveUp ? [{ name: 'increment', label: 'Move up' }] : []),
        ...(canMoveDown ? [{ name: 'decrement', label: 'Move down' }] : []),
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (disabled) return;
        if (nativeEvent.actionName === 'increment' && canMoveUp) onMove(-1);
        if (nativeEvent.actionName === 'decrement' && canMoveDown) onMove(1);
      }}
      style={styles.handle}
    >
      <Icon name="menu" size={20} color={theme.colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  handle: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
