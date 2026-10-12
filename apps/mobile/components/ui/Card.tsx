import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { Dot, type StatusIntent } from './Status';
import { Toggle } from './Toggle';
import { tint } from './tint';

/**
 * A single item with its own state or control (docs/design-system.md § 5.2).
 * `selected` draws the `action` border with its glow; `muted` is for items that
 * are present but not available (Teams "Soon", a feature not included).
 */
export function Card({
  children,
  selected = false,
  muted = false,
}: {
  children: ReactNode;
  selected?: boolean;
  muted?: boolean;
}) {
  return (
    <View style={[styles.card, selected ? styles.cardSelected : null, muted ? styles.muted : null]}>
      {children}
    </View>
  );
}

/**
 * Several rows of the same kind on one surface, separated by 1 px dividers. The
 * dividers are inserted here so a screen cannot forget one or leave one behind
 * a row it hides.
 */
export function Group({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <View style={styles.divider} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

type Leading = { icon: IconName } | { dot: StatusIntent };

/**
 * One row: optional leading icon tile or status dot, a title with at most one
 * subtitle, and exactly one trailing element. The chevron appears only when the
 * row navigates (`navigates`), never just because it can be pressed.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  navigates = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading;
  /** Exactly one of: a value, a status, a toggle, a compact button. */
  trailing?: ReactNode;
  onPress?: () => void;
  navigates?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const content = (
    <RowContent
      title={title}
      subtitle={subtitle}
      leading={leading}
      trailing={trailing}
      chevron={navigates}
    />
  );
  if (onPress === undefined) {
    return <View style={[styles.row, disabled ? styles.muted : null]}>{content}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.muted : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      {content}
    </Pressable>
  );
}

/**
 * A row whose trailing element is a toggle. The whole row is the switch, so it
 * is announced and pressed as one control.
 */
export function ToggleRow({
  title,
  subtitle,
  leading,
  value,
  onValueChange,
  disabled = false,
  switching = false,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  switching?: boolean;
}) {
  const locked = disabled || switching;
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={locked}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ checked: value, disabled: locked, busy: switching }}
      style={({ pressed }) => [styles.row, pressed && !locked ? styles.pressed : null]}
    >
      <RowContent
        title={title}
        subtitle={subtitle}
        leading={leading}
        trailing={<Toggle value={value} disabled={disabled} switching={switching} />}
        chevron={false}
      />
    </Pressable>
  );
}

function RowContent({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading | undefined;
  trailing?: ReactNode;
  chevron: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      {leading !== undefined ? (
        'icon' in leading ? (
          <View style={styles.tile}>
            <Icon name={leading.icon} size={18} color={theme.colors.textMuted} />
          </View>
        ) : (
          <View style={styles.dotSlot}>
            <Dot intent={leading.dot} />
          </View>
        )
      ) : null}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing !== undefined || chevron ? (
        <View style={styles.trailing}>
          {typeof trailing === 'string' ? <Text style={styles.value}>{trailing}</Text> : trailing}
          {chevron ? <Icon name="chevron-right" size={16} color={theme.colors.textFaint} /> : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 56,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  cardSelected: {
    borderColor: theme.colors.action,
    shadowColor: theme.colors.action,
    ...theme.elevation.glow,
  },
  muted: { opacity: 0.4 },
  group: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: theme.colors.border },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 56,
    paddingVertical: theme.spacing.sm + theme.spacing.xxs,
    paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  tile: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  dotSlot: { width: 36, alignItems: 'center' },
  body: { flex: 1, minWidth: 0, gap: theme.spacing.xxs },
  title: { ...theme.typography.row, color: theme.colors.text },
  subtitle: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexShrink: 0 },
  value: { ...theme.typography.body, color: theme.colors.textMuted },
}));
