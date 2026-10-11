// The building blocks of the Verity Premium and Diagnostics screens
// (docs/premium-settings.md, docs/assets/premium/mockup.html): magenta section
// eyebrows, bordered cards, small uppercase tags and status dots. Actions stay
// blue (`primary`); magenta (`accent`) only marks the Premium signature.
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function Eyebrow({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <Text style={[styles.eyebrow, muted ? styles.eyebrowMuted : null]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export type TagTone = 'ok' | 'error' | 'neutral';

/** A small uppercase status word on a tinted ground — never a bordered pill. */
export function Tag({ label, tone = 'neutral' }: { label: string; tone?: TagTone }) {
  return (
    <Text
      style={[styles.tag, tone === 'ok' ? styles.tagOk : tone === 'error' ? styles.tagError : null]}
    >
      {label.toUpperCase()}
    </Text>
  );
}

export type DotTone = 'ok' | 'error' | 'off';

export function StatusDot({ tone }: { tone: DotTone }) {
  return (
    <View
      style={[styles.dot, tone === 'ok' ? styles.dotOk : tone === 'error' ? styles.dotError : null]}
    />
  );
}

export function IconTile({ name, accent = false }: { name: IconName; accent?: boolean }) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.iconTile, accent ? styles.iconTileAccent : null]}>
      <Icon name={name} size={20} color={accent ? theme.colors.accent : theme.colors.text} />
    </View>
  );
}

/** One bordered card. `selected` lights the border blue; `soft` mutes it. */
export function PremiumCard({
  children,
  selected = false,
  soft = false,
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  children: ReactNode;
  selected?: boolean;
  soft?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const style = [styles.card, selected ? styles.cardSelected : null, soft ? styles.soft : null];
  if (onPress === undefined) return <View style={style}>{children}</View>;
  return (
    <Pressable
      style={({ pressed }) => [...style, pressed ? styles.pressed : null]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      {children}
    </Pressable>
  );
}

/** Title and an optional one-line subtitle, filling the space between leading and trailing. */
export function CardText({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <View style={styles.body}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** A card of hairline-separated rows, as on the Diagnostics screen. */
export function RowCard({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.rowCard}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <View style={styles.separator} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export function CardRow({
  title,
  subtitle,
  trailing,
  onPress,
  accessibilityLabel,
  disabled = false,
  chevron = onPress !== undefined,
}: {
  title: string;
  subtitle?: string | undefined;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  chevron?: boolean;
}) {
  const { theme } = useUnistyles();
  const content = (
    <>
      <View style={styles.body}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.trailing}>
        {trailing}
        {chevron ? <Icon name="chevron-right" size={16} color={theme.colors.textMuted} /> : null}
      </View>
    </>
  );
  if (onPress === undefined) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.soft : null,
        pressed ? styles.pressed : null,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
    >
      {content}
    </Pressable>
  );
}

/** Muted trailing text with a status dot, e.g. `● Connected`. */
export function DotValue({ tone, label }: { tone: DotTone; label: string }) {
  return (
    <View style={styles.dotValue}>
      <StatusDot tone={tone} />
      <Text style={styles.value}>{label}</Text>
    </View>
  );
}

export function TrailingValue({ children }: { children: string }) {
  return <Text style={styles.value}>{children}</Text>;
}

/** The single-line key field: inline uppercase label, masked monospace value, optional error tag. */
export function KeyField({
  value,
  onChangeText,
  editable,
  error,
  onSubmit,
}: {
  value: string;
  onChangeText: (value: string) => void;
  editable: boolean;
  error?: string | undefined;
  onSubmit: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        styles.keyField,
        error !== undefined ? styles.keyFieldError : value ? styles.keyFieldFocus : null,
      ]}
    >
      <Text style={styles.keyLabel}>Key</Text>
      <TextInput
        style={styles.keyInput}
        value={value}
        onChangeText={onChangeText}
        placeholder="Paste your subscription key"
        placeholderTextColor={theme.colors.textFaint}
        editable={editable}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        accessibilityLabel="Uplink subscription key"
      />
      {error !== undefined ? <Tag label={error} tone="error" /> : null}
    </View>
  );
}

/** The full-width bottom action. `ghost` is the quiet variant used after activation. */
export function PremiumCta({
  label,
  onPress,
  busy = false,
  disabled = false,
  ghost = false,
  icon,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  ghost?: boolean;
  icon?: IconName;
}) {
  const { theme } = useUnistyles();
  const color = ghost ? theme.colors.text : theme.colors.onPrimary;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.cta,
        ghost ? styles.ctaGhost : null,
        busy ? styles.ctaBusy : null,
        disabled && !busy ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      {!busy && icon !== undefined ? <Icon name={icon} size={18} color={color} /> : null}
      <Text style={[styles.ctaLabel, ghost ? styles.ctaGhostLabel : null]}>{label}</Text>
    </Pressable>
  );
}

export const premiumChromeStyles = StyleSheet.create((theme) => ({
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '700',
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    marginTop: theme.spacing.md,
    marginHorizontal: 2,
  },
  eyebrowMuted: { color: theme.colors.textMuted },
  tag: {
    overflow: 'hidden',
    color: theme.colors.textMuted,
    backgroundColor: `${theme.colors.text}0f`,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    paddingHorizontal: 9,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.sm,
  },
  tagOk: { color: theme.colors.tone.done, backgroundColor: `${theme.colors.tone.done}24` },
  tagError: { color: theme.colors.tone.danger, backgroundColor: `${theme.colors.tone.danger}24` },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.textFaint,
  },
  dotOk: {
    backgroundColor: theme.colors.tone.done,
    shadowColor: theme.colors.tone.done,
    shadowOpacity: 0.9,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  dotError: {
    backgroundColor: theme.colors.tone.danger,
    shadowColor: theme.colors.tone.danger,
    shadowOpacity: 0.9,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    backgroundColor: `${theme.colors.text}0d`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTileAccent: { backgroundColor: `${theme.colors.accent}24` },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 64,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  cardSelected: {
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  soft: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
  rowTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '500' },
  subtitle: { color: theme.colors.textMuted, fontSize: 13.5, lineHeight: 18 * theme.fontScale },
  rowCard: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  separator: { height: 1, backgroundColor: theme.colors.border },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.xs,
  },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  dotValue: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { color: theme.colors.textMuted, fontSize: 15 },
  keyField: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 22,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  keyFieldFocus: { borderColor: theme.colors.primary },
  keyFieldError: { borderColor: `${theme.colors.tone.danger}99` },
  keyLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  keyInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 0.7,
    fontFamily: MONO,
  },
  cta: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  ctaBusy: { opacity: 0.75, shadowOpacity: 0 },
  ctaGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowOpacity: 0,
  },
  ctaLabel: { color: theme.colors.onPrimary, fontSize: 18, fontWeight: '700' },
  ctaGhostLabel: { color: theme.colors.text },
}));
const styles = premiumChromeStyles;
