import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, Text } from '../../components/ui';
import ViewerMockup from '../mockup-review/viewer';
import { ignore } from './parts';

/** Existing review viewer with a proposed explicit manual completion action. */
export default function EndReview() {
  return (
    <View style={styles.root}>
      <ViewerMockup />
      <View style={styles.end}>
        <Text variant="bodySmall" tone="muted">
          Already implemented? End this review to remove it from Home and Needs you. Images and
          marks stay in the chat. This does not start implementation.
        </Text>
        <Button label="End review" size="compact" variant="secondary" onPress={ignore} />
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  end: {
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
}));
