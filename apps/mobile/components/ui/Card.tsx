import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { Dot, type StatusIntent } from './Status';
import { Button, IconButton } from './Button';
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
  flush = false,
}: {
  children: ReactNode;
  selected?: boolean;
  muted?: boolean;
  /** For a card that holds a single Row or ToggleRow: the row brings its own
   *  padding and fills the card, so the card adds none. */
  flush?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        flush ? styles.cardFlush : null,
        selected ? styles.cardSelected : null,
        muted ? styles.muted : null,
      ]}
    >
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

/** A Feather icon or a status dot; `element` is for a mark that is not a
 *  Feather glyph (an agent's logo), drawn in the same tile. `signature` draws
 *  the icon in the brand pink — reserved for the Premium mark (§ 2). */
type Leading =
  { icon: IconName; signature?: boolean } | { dot: StatusIntent } | { element: ReactNode };

// Rows already warned about a button inside a pressable row, so a list that
// re-renders often warns once per row instead of on every render.
const warnedRows = new Set<string>();

/**
 * One row: optional leading icon tile or status dot, a title with at most one
 * subtitle, and exactly one trailing element. The chevron appears only when the
 * row navigates (`navigates`), never just because it can be pressed.
 *
 * `selected` makes the row one option of a single-choice list: it is announced
 * as a radio button and shows a check mark instead of a trailing element.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  navigates = false,
  selected,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading;
  /** Exactly one of: a value, a status, a toggle, or — only on a row without
   *  `onPress` — a compact button. Inside a pressable row a button would be
   *  unreachable for VoiceOver, which hears the row as one element. */
  trailing?: ReactNode;
  onPress?: () => void;
  navigates?: boolean;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { theme } = useUnistyles();
  const choice = selected !== undefined;
  if (
    process.env.NODE_ENV !== 'production' &&
    onPress !== undefined &&
    isValidElement(trailing) &&
    (trailing.type === Button || trailing.type === IconButton) &&
    !warnedRows.has(title)
  ) {
    warnedRows.add(title);
    console.warn(
      `Row "${title}": a button inside a pressable row cannot be reached by VoiceOver; ` +
        'drop onPress or move the action out of the row.',
    );
  }
  const content = (
    <RowContent
      title={title}
      subtitle={subtitle}
      leading={leading}
      acts={onPress !== undefined}
      trailing={
        choice ? (
          selected ? (
            <Icon name="check" size={18} color={theme.colors.action} />
          ) : undefined
        ) : (
          trailing
        )
      }
      chevron={navigates && !choice}
    />
  );
  if (onPress === undefined) {
    return <View style={[styles.row, disabled ? styles.muted : null]}>{content}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={choice ? 'radio' : 'button'}
      accessibilityLabel={
        accessibilityLabel ?? spokenLabel(title, subtitle, choice ? undefined : trailing)
      }
      accessibilityHint={accessibilityHint}
      accessibilityState={choice ? { disabled, checked: selected } : { disabled }}
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
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.muted : null,
        pressed && !locked ? styles.pressed : null,
      ]}
    >
      <RowContent
        title={title}
        subtitle={subtitle}
        leading={leading}
        acts
        // The row already dims as a whole when disabled; dimming the track
        // again would leave the switch barely visible.
        trailing={<Toggle value={value} switching={switching} />}
        chevron={false}
      />
    </Pressable>
  );
}

/**
 * A pressable row is one element for VoiceOver, so its own label has to carry
 * everything the row shows: the title, the subtitle and the trailing value or
 * status — otherwise "Server update · UPDATE" is heard as just "Server update".
 */
function spokenLabel(title: string, subtitle: string | undefined, trailing: ReactNode): string {
  const trailingText =
    typeof trailing === 'string'
      ? trailing
      : isValidElement<{ label?: unknown }>(trailing) && typeof trailing.props.label === 'string'
        ? trailing.props.label
        : undefined;
  return [title, subtitle, trailingText]
    .filter((part) => part !== undefined && part !== '')
    .join(', ');
}

function RowContent({
  title,
  subtitle,
  leading,
  acts,
  trailing,
  chevron,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading | undefined;
  /** Whether the row can be tapped: its icon then takes the action color (§ 2). */
  acts: boolean;
  trailing?: ReactNode;
  chevron: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      {leading !== undefined ? (
        'icon' in leading ? (
          <View
            style={[
              styles.tile,
              leading.signature === true ? styles.tileSignature : acts ? styles.tileAction : null,
            ]}
          >
            <Icon
              name={leading.icon}
              size={16}
              color={
                leading.signature === true
                  ? theme.colors.signature
                  : acts
                    ? theme.colors.action
                    : theme.colors.textMuted
              }
            />
          </View>
        ) : 'element' in leading ? (
          <View style={styles.tile}>{leading.element}</View>
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
          {typeof trailing === 'string' ? (
            <Text style={styles.value} numberOfLines={1}>
              {trailing}
            </Text>
          ) : (
            trailing
          )}
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
  // Clips the row's pressed background to the rounded corners. Not on `card`
  // itself: that would clip the selected glow on iOS.
  cardFlush: { paddingVertical: 0, paddingHorizontal: 0, overflow: 'hidden' },
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
  // Rows fill their container, so a row inside a card spans the card's width.
  row: {
    flexGrow: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 52,
    paddingVertical: theme.spacing.sm + theme.spacing.xxs,
    paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  tile: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  tileAction: { backgroundColor: tint(theme.colors.action, 'fill') },
  tileSignature: { backgroundColor: tint(theme.colors.signature, 'fill') },
  dotSlot: { width: 32, alignItems: 'center' },
  body: { flex: 1, minWidth: 0, gap: theme.spacing.xxs },
  title: { ...theme.typography.row, color: theme.colors.text },
  subtitle: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  // A long status may shrink and truncate; the title always keeps more than
  // half the row, so it is never squeezed into a column of fragments.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexShrink: 1,
    maxWidth: '45%',
  },
  value: { ...theme.typography.body, color: theme.colors.textMuted },
}));
