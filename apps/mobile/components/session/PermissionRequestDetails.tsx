import { permissionInputText } from '@verity/mobile';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '../ui';

/**
 * The generic session approval must expose fields no tool summary understands.
 * `inline` is for a card that already scrolls its whole body (a pinned approval):
 * a bounded box of its own there would catch the swipe meant to reach the buttons.
 */
export function PermissionRequestDetails({
  input,
  inline = false,
}: {
  input: unknown;
  inline?: boolean;
}) {
  const text = (
    <Text variant="code" selectable testID="permission-request-details">
      {permissionInputText(input)}
    </Text>
  );
  return inline ? (
    <View style={styles.inline} accessibilityLabel="Full request">
      {text}
    </View>
  ) : (
    <ScrollView style={styles.details} nestedScrollEnabled accessibilityLabel="Full request">
      {text}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: { maxHeight: 240, flexGrow: 0, marginVertical: theme.spacing.sm },
  inline: { marginVertical: theme.spacing.sm },
}));
