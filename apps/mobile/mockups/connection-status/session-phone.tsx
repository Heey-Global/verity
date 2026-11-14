import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ConnectionStrip, SessionTranscript } from './parts';

/** iPhone session while the server updates: the compact strip above the transcript. */
export default function SessionPhoneMockup() {
  return (
    <View style={styles.root}>
      <ConnectionStrip state="updating" />
      <SessionTranscript phone />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
}));
