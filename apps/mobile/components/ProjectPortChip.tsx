import { Linking, Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';

export interface ProjectPortLink {
  id: string;
  label: string;
  url: string;
}

export function ProjectPortChip({ port }: { port: ProjectPortLink }) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      style={styles.chip}
      accessibilityRole="link"
      accessibilityLabel={`Open Dev Server on port ${port.label}`}
      onPress={(event) => {
        event.stopPropagation();
        void Linking.openURL(port.url).catch(() => undefined);
      }}
    >
      <Icon name="monitor" size={12} color={theme.colors.textMuted} />
      <Text style={styles.label} numberOfLines={1}>
        {port.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    maxWidth: 86,
    minHeight: 18,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    lineHeight: 16 * theme.fontScale,
  },
}));
