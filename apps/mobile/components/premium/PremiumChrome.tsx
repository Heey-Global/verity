// The building blocks of the Verity Premium and Diagnostics screens
// (docs/premium-settings.md), now drawn by the design system's components
// (components/ui, docs/design-system.md). These wrappers keep the screens'
// props until each screen is migrated to the components directly.
import { type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import {
  Button,
  Group,
  Row,
  SectionHeader,
  StatusDot as StatusWord,
  StatusTag,
  TextField,
  ToggleRow,
} from '../ui';
import { Dot, type StatusIntent } from '../ui/Status';
import { tint } from '../ui/tint';

/** A section heading; grey, as on every settings screen. */
export function Eyebrow({ children }: { children: string; muted?: boolean }) {
  return <SectionHeader title={children} />;
}

export type TagTone = 'ok' | 'error' | 'neutral';

const TAG_INTENT: Record<TagTone, StatusIntent> = {
  ok: 'ready',
  error: 'needsSetup',
  neutral: 'optional',
};

/** A small uppercase status word on a tinted ground — never a bordered pill. */
export function Tag({ label, tone = 'neutral' }: { label: string; tone?: TagTone }) {
  return <StatusTag intent={TAG_INTENT[tone]} label={label} />;
}

export type DotTone = 'ok' | 'error' | 'off';

const DOT_INTENT: Record<DotTone, StatusIntent> = {
  ok: 'ready',
  error: 'needsSetup',
  off: 'optional',
};

export function StatusDot({ tone }: { tone: DotTone }) {
  return <Dot intent={DOT_INTENT[tone]} />;
}

/** The leading icon tile. `accent` marks the Premium signature in pink. */
export function IconTile({ name, accent = false }: { name: IconName; accent?: boolean }) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.iconTile, accent ? styles.iconTileAccent : null]}>
      <Icon
        name={name}
        size={18}
        color={accent ? theme.colors.signature : theme.colors.textMuted}
      />
    </View>
  );
}

/** One card (§ 5.2). `selected` draws the action border with its glow; `soft` mutes it. */
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

/** Title and an optional subtitle, filling the space between leading and trailing. */
export function CardText({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <View style={styles.body}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** A card of divided rows, as on the Diagnostics screen. */
export function RowCard({ children }: { children: ReactNode }) {
  return <Group>{children}</Group>;
}

export function CardRow({
  title,
  subtitle,
  trailing,
  onPress,
  accessibilityLabel,
  disabled = false,
  switchValue,
  chevron = onPress !== undefined && switchValue === undefined,
}: {
  title: string;
  subtitle?: string | undefined;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Renders the row as a switch: a trailing toggle, and `onPress` flips it. */
  switchValue?: boolean;
  chevron?: boolean;
}) {
  if (switchValue !== undefined) {
    return (
      <ToggleRow
        title={title}
        subtitle={subtitle}
        value={switchValue}
        onValueChange={() => onPress?.()}
        disabled={disabled || onPress === undefined}
      />
    );
  }
  return (
    <Row
      title={title}
      subtitle={subtitle}
      trailing={trailing}
      {...(onPress !== undefined ? { onPress } : {})}
      navigates={chevron}
      disabled={disabled}
      {...(accessibilityLabel !== undefined ? { accessibilityLabel } : {})}
    />
  );
}

/** Muted trailing text with a status dot, e.g. `● Connected`. */
export function DotValue({ tone, label }: { tone: DotTone; label: string }) {
  return <StatusWord intent={DOT_INTENT[tone]} label={label} />;
}

export function TrailingValue({ children }: { children: string }) {
  return <Text style={styles.value}>{children}</Text>;
}

/** The subscription key field: masked, with the rejection explained below it. */
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
  error?: { title: string; message: string } | undefined;
  onSubmit: () => void;
}) {
  return (
    <TextField
      label="Uplink subscription key"
      value={value}
      onChangeText={onChangeText}
      placeholder="Paste your subscription key"
      disabled={!editable}
      secret
      error={error}
      onSubmitEditing={onSubmit}
    />
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
  return (
    <Button
      label={label}
      onPress={onPress}
      variant={ghost ? 'secondary' : 'primary'}
      loading={busy}
      disabled={disabled}
      fullWidth
      {...(icon !== undefined ? { icon } : {})}
    />
  );
}

export const premiumChromeStyles = StyleSheet.create((theme) => ({
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.tile,
    backgroundColor: tint(theme.colors.text, 'neutral'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTileAccent: { backgroundColor: tint(theme.colors.signature, 'fill') },
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
  soft: { opacity: 0.4 },
  pressed: { backgroundColor: theme.colors.surfaceAlt },
  disabled: { opacity: 0.4 },
  body: { flex: 1, minWidth: 0, gap: theme.spacing.xxs },
  title: { ...theme.typography.row, color: theme.colors.text },
  subtitle: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  value: { ...theme.typography.body, color: theme.colors.textMuted },
}));
const styles = premiumChromeStyles;
