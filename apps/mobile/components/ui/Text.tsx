import type { ReactNode } from 'react';
import { Text as NativeText, type StyleProp, type TextProps, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export type TextVariant =
  | 'display'
  | 'title'
  | 'row'
  | 'body'
  | 'button'
  | 'subtitle'
  | 'footnote'
  | 'eyebrow'
  | 'label'
  | 'code';

export type TextTone = 'default' | 'muted' | 'faint' | 'action' | 'signature' | 'attention';

/**
 * Text in one of the ten named styles (docs/design-system.md § 3), colored by a
 * role. The default tone follows the spec: subtitles and labels are muted,
 * footnotes faint, eyebrows in the signature color, everything else in `text`.
 */
export function Text({
  variant = 'body',
  tone,
  style,
  children,
  ...rest
}: Omit<TextProps, 'style'> & {
  variant?: TextVariant;
  tone?: TextTone;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}) {
  return (
    <NativeText
      {...rest}
      style={[styles[variant], tone !== undefined ? toneStyles[tone] : null, style]}
    >
      {children}
    </NativeText>
  );
}

const styles = StyleSheet.create((theme) => ({
  display: { ...theme.typography.display, color: theme.colors.text },
  title: { ...theme.typography.title, color: theme.colors.text },
  row: { ...theme.typography.row, color: theme.colors.text },
  body: { ...theme.typography.body, color: theme.colors.text },
  button: { ...theme.typography.button, color: theme.colors.text },
  subtitle: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  footnote: { ...theme.typography.footnote, color: theme.colors.textFaint },
  eyebrow: { ...theme.typography.eyebrow, color: theme.colors.signature },
  label: { ...theme.typography.label, color: theme.colors.textMuted },
  code: { ...theme.typography.code, color: theme.colors.text },
}));

const toneStyles = StyleSheet.create((theme) => ({
  default: { color: theme.colors.text },
  muted: { color: theme.colors.textMuted },
  faint: { color: theme.colors.textFaint },
  action: { color: theme.colors.action },
  signature: { color: theme.colors.signature },
  attention: { color: theme.colors.attention },
}));
