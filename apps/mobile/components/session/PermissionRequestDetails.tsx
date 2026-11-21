import { permissionInputText } from '@verity/mobile';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '../ui';

/** The generic session approval must expose fields no tool summary understands. */
export function PermissionRequestDetails({ input }: { input: unknown }) {
  return (
    <ScrollView style={styles.details} nestedScrollEnabled accessibilityLabel="Full request">
      <Text variant="code" selectable testID="permission-request-details">
        {permissionInputText(input)}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: { maxHeight: 240, flexGrow: 0, marginVertical: theme.spacing.sm },
}));
