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
 * `attention` draws the tonal `attention` border for an item reporting a
 * problem, alongside the status word that names it — never instead of it.
 */
export function Card({
  children,
  selected = false,
  muted = false,
  flush = false,
  attention = false,
  stacked = false,
  divided = false,
}: {
  children: ReactNode;
  selected?: boolean;
  muted?: boolean;
  /** For a card that holds a single Row or ToggleRow: the row brings its own
   *  padding and fills the card, so the card adds none. */
  flush?: boolean;
  attention?: boolean;
  /** Lays the content out top to bottom (status, title, detail, action)
   *  instead of as one row. */
  stacked?: boolean;
  /** For a stacked card made of sections — a head and the blocks below it:
   *  separates them with the same 1 px divider `Group` draws between rows. */
  divided?: boolean;
}) {
  const sections = divided ? Children.toArray(children).filter(isValidElement) : null;
  return (
    <View
      style={[
        styles.card,
        stacked ? styles.cardStacked : null,
        flush ? styles.cardFlush : null,
        attention ? styles.cardAttention : null,
        selected ? styles.cardSelected : null,
        muted ? styles.muted : null,
      ]}
    >
      {sections === null
        ? children
        : sections.map((section, index) => (
            <Fragment key={section.key ?? index}>
              {index > 0 ? <View style={styles.divider} /> : null}
              {section}
            </Fragment>
          ))}
    </View>
  );
}

/**
 * The head of a stacked card: what the card is about, one line under it, and
 * its state. The same title/subtitle/trailing slots as a `Row`, without the
 * row's own padding, which the stacked card already provides.
 */
export function CardHead({
  title,
  subtitle,
  leading,
  trailing,
  onDismiss,
}: {
  title: string;
  subtitle?: string | undefined;
  /** A mark that is not a Feather glyph (a code host's logo), drawn in the
   *  same tile a `Row` uses, so the head lines up with the card's content. */
  leading?: { element: ReactNode };
  trailing?: ReactNode;
  /** Draws an X after the trailing status that dismisses the card. */
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <View style={styles.head}>
      {leading !== undefined ? <View style={styles.tile}>{leading.element}</View> : null}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing !== undefined || onDismiss !== undefined ? (
        <View style={styles.headTrailing} testID="card-head-trailing">
          {trailing}
          {onDismiss !== undefined ? (
            <IconButton icon="x" accessibilityLabel="Dismiss" onPress={onDismiss} />
          ) : null}
        </View>
      ) : null}
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
 *  the icon in the brand pink — reserved for the Premium mark (§ 2). `quiet`
 *  keeps the neutral tile in a row that can be tapped, for a tile that states a
 *  fact rather than an action. `marks` sit on the tile's right corners
 *  ({@link TileMark}): `top` for the subject's own state, `bottom` for a verdict. */
type Leading =
  | {
      icon: IconName;
      signature?: boolean;
      intent?: StatusIntent;
      quiet?: boolean;
      marks?: { top?: ReactNode; bottom?: ReactNode };
    }
  | { dot: StatusIntent }
  | { element: ReactNode };

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
  onLongPress,
  navigates = false,
  selected,
  active = false,
  disabled = false,
  settled = false,
  accessibilityLabel,
  accessibilityHint,
  expanded,
  tag,
  answers,
  wrap = false,
}: {
  title: string;
  subtitle?: string | undefined;
  leading?: Leading;
  /** Exactly one of: a value, a status, a toggle, or — only on a row without
   *  `onPress` — a compact button. Inside a pressable row a button would be
   *  unreachable for VoiceOver, which hears the row as one element. */
  trailing?: ReactNode;
  onPress?: () => void;
  /** The row's secondary actions (rename, delete) on a long press. Only with
   *  `onPress`; name the actions in `accessibilityHint`. */
  onLongPress?: (() => void) | undefined;
  navigates?: boolean;
  selected?: boolean;
  /** The navigation destination currently open beside this row. */
  active?: boolean;
  disabled?: boolean;
  /** Finished and only kept around (a session whose pull request merged): the
   *  row stays fully usable but recedes, lighter than a disabled one. */
  settled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  expanded?: boolean;
  /** A status tag ({@link StatusTag}) at the start of the subtitle line instead
   *  of on the trailing side, for a row whose title needs the full width — an
   *  inbox row, where a trailing tag beside the chevron would wrap the title. */
  tag?: ReactNode;
  /** Compact buttons that answer what the row waits on, in a strip under it and
   *  outside its pressable area, so VoiceOver reaches each one. */
  answers?: ReactNode;
  /** Shows the whole title however many lines it takes, for a row whose title
   *  is the thing to read and decide on — an answer in full. */
  wrap?: boolean;
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
      tag={tag}
      wrap={wrap}
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
  const strip =
    answers !== undefined ? (
      <View style={[styles.answers, leading !== undefined ? styles.answersIndented : null]}>
        {answers}
      </View>
    ) : null;
  if (onPress === undefined) {
    const row = (
      <View style={[styles.row, disabled ? styles.muted : settled ? styles.settled : null]}>
        {content}
      </View>
    );
    return strip ? (
      <View>
        {row}
        {strip}
      </View>
    ) : (
      row
    );
  }
  const pressable = (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole={choice ? 'radio' : 'button'}
      accessibilityLabel={
        accessibilityLabel ?? spokenLabel(title, subtitle, choice ? undefined : trailing, tag)
      }
      accessibilityHint={accessibilityHint}
      accessibilityState={
        choice ? { disabled, checked: selected } : { disabled, expanded, selected: active }
      }
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.muted : settled ? styles.settled : null,
        pressed && !disabled ? styles.pressed : null,
        active ? styles.rowActive : null,
      ]}
    >
      {content}
    </Pressable>
  );
  return strip ? (
    <View>
      {pressable}
      {strip}
    </View>
  ) : (
    pressable
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
function spokenLabel(
  title: string,
  subtitle: string | undefined,
  trailing: ReactNode,
  tag?: ReactNode,
): string {
  const text = (node: ReactNode) =>
    typeof node === 'string'
      ? node
      : isValidElement<{ label?: unknown }>(node) && typeof node.props.label === 'string'
        ? node.props.label
        : undefined;
  // The tag is read where it is drawn: before the subtitle.
  return [title, text(tag), subtitle, text(trailing)]
    .filter((part) => part !== undefined && part !== '')
    .join(', ');
}

function RowContent({
  title,
  subtitle,
  tag,
  wrap = false,
  leading,
  acts,
  trailing,
  chevron,
}: {
  title: string;
  subtitle?: string | undefined;
  tag?: ReactNode;
  wrap?: boolean;
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
              leading.intent === 'needsSetup'
                ? styles.tileAttention
                : leading.intent === 'ready'
                  ? styles.tileReady
                  : leading.intent === 'transient'
                    ? styles.tileAction
                    : leading.signature === true
                      ? styles.tileSignature
                      : acts && leading.quiet !== true
                        ? styles.tileAction
                        : null,
            ]}
          >
            <Icon
              name={leading.icon}
              size={16}
              color={
                leading.intent === 'needsSetup'
                  ? theme.colors.attention
                  : leading.intent === 'ready'
                    ? theme.colors.success
                    : leading.intent === 'transient'
                      ? theme.colors.action
                      : leading.signature === true
                        ? theme.colors.signature
                        : acts && leading.quiet !== true
                          ? theme.colors.action
                          : theme.colors.textMuted
              }
            />
            {leading.marks?.top !== undefined ? (
              <View style={styles.tileMarkTop}>{leading.marks.top}</View>
            ) : null}
            {leading.marks?.bottom !== undefined ? (
              <View style={styles.tileMarkBottom}>{leading.marks.bottom}</View>
            ) : null}
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
        <Text style={styles.title} numberOfLines={wrap ? undefined : 2}>
          {title}
        </Text>
        {tag !== undefined ? (
          <View style={styles.tagLine}>
            <View style={styles.tagSlot}>{tag}</View>
            {subtitle ? (
              <Text style={[styles.subtitle, styles.tagSubtitle]} numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : subtitle ? (
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
  cardStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingVertical: theme.spacing.lg,
  },
  cardAttention: { borderColor: tint(theme.colors.attention, 'border') },
  cardSelected: {
    borderColor: theme.colors.action,
    shadowColor: theme.colors.action,
    ...theme.elevation.glow,
  },
  muted: { opacity: 0.4 },
  settled: { opacity: 0.6 },
  group: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: theme.colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  // A card's status tag is a few words and the card's whole verdict, so it keeps
  // its width and the title beside it wraps instead ("PERMISSI…" said nothing).
  headTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexShrink: 0,
  },
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
  rowActive: { backgroundColor: tint(theme.colors.action, 'fill') },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  // Under the row's text, so the answers read as belonging to it.
  answers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
    paddingBottom: theme.spacing.md,
  },
  // The leading tile (32) and the row's gap after it.
  answersIndented: { paddingLeft: theme.spacing.md + theme.spacing.xxs + 32 + theme.spacing.md },
  tile: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  tileAction: { backgroundColor: tint(theme.colors.action, 'fill') },
  tileAttention: { backgroundColor: tint(theme.colors.attention, 'fill') },
  tileReady: { backgroundColor: tint(theme.colors.success, 'fill') },
  tileSignature: { backgroundColor: tint(theme.colors.signature, 'fill') },
  // Overhangs the tile's right corner by 3 px, so the mark sits on the corner
  // without covering the 16 px glyph. The tile does not clip its children.
  tileMarkTop: { position: 'absolute', top: -3, right: -3 },
  tileMarkBottom: { position: 'absolute', bottom: -3, right: -3 },
  dotSlot: { width: 32, alignItems: 'center' },
  body: { flex: 1, minWidth: 0, gap: theme.spacing.xxs },
  title: { ...theme.typography.row, color: theme.colors.text },
  subtitle: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  // The tag keeps its width and leads the subtitle. A subtitle that does not fit
  // beside the tag moves under it at the full width; growing beside a wide tag
  // ("MERGE READY") it would wrap into a narrow column of fragments.
  tagLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.spacing.sm,
    rowGap: theme.spacing.xxs,
  },
  tagSlot: { flexShrink: 0, maxWidth: '100%' },
  // No flex basis of 0: the subtitle's own width decides whether it stays on
  // the tag's line, so a long one starts the next line instead.
  tagSubtitle: { flexShrink: 1, minWidth: 0 },
  // The trailing side takes at most 45 % of the row; a long value or status
  // truncates there, so the title is never squeezed into a column of fragments.
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexShrink: 1,
    maxWidth: '45%',
  },
  value: { ...theme.typography.body, color: theme.colors.textMuted, flexShrink: 1 },
}));
