import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export function PremiumBadge() {
  return <Text style={styles.badge}>Premium</Text>;
}
const styles = StyleSheet.create((theme) => ({
  badge: {
    ...theme.typography.label,
    color: theme.colors.signature,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.signature,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
}));
