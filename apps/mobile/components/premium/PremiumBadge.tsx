import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export function PremiumBadge() {
  return <Text style={styles.badge}>Premium</Text>;
}
const styles = StyleSheet.create((theme) => ({
  badge: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '600',
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
}));
