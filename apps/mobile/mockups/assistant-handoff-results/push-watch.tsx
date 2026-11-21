import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '../../components/ui';
import { pushBody, SAMPLE, SystemNotification } from './parts';

/** The same push mirrored by iOS to the Apple Watch; no Watch app change. */
export default function PushWatchMockup() {
  return (
    <View style={styles.stage}>
      <View style={styles.face}>
        <SystemNotification
          compact
          title={`${SAMPLE.project} · ${SAMPLE.title}`}
          body={pushBody('Done', SAMPLE.doneSummary)}
        />
      </View>
      <Text variant="footnote" tone="muted">
        Apple Watch, mirrored from the iPhone
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
    gap: theme.spacing.md,
  },
  face: {
    width: 198,
    height: 242,
    borderRadius: 44,
    borderWidth: 6,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.sm,
    justifyContent: 'center',
    overflow: 'hidden',
  },
}));
