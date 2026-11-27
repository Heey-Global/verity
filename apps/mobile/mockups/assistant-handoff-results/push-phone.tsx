import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '../../components/ui';
import { pushBody, SAMPLE, SystemNotification } from './parts';

/** The push on the iPhone lock screen: project · handoff title, then status and summary. */
export default function PushPhoneMockup() {
  return (
    <View style={styles.lock}>
      <View style={styles.clock}>
        <Text variant="subtitle" tone="muted">
          Saturday, 21 November
        </Text>
        <Text variant="display">14:32</Text>
      </View>
      <SystemNotification
        title={`${SAMPLE.project} · ${SAMPLE.title}`}
        body={pushBody('Done', SAMPLE.doneSummary)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  lock: {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.xxxl,
    gap: theme.spacing.xl,
  },
  clock: { alignItems: 'center', gap: theme.spacing.xs },
}));
