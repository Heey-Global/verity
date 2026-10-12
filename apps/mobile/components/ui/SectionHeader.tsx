import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * A group heading. `label` (grey, the default) is for settings and navigation
 * lists; `eyebrow` (signature pink) only for content screens with few sections
 * (docs/design-system.md § 3). It is a real heading, so VoiceOver can jump
 * between sections.
 */
export function SectionHeader({
  title,
  variant = 'label',
}: {
  title: string;
  variant?: 'label' | 'eyebrow';
}) {
  return (
    <Text style={[styles.base, styles[variant]]} accessibilityRole="header">
      {title}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: { marginTop: theme.spacing.md, marginHorizontal: theme.spacing.xxs },
  label: { ...theme.typography.label, color: theme.colors.textMuted },
  eyebrow: { ...theme.typography.eyebrow, color: theme.colors.signature },
}));
