import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { WikiStatus } from './sections';

/** The Wiki's start page scrolled past its topics, where an image of one screen ends. */
export default function HomeScrolledMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <WikiStatus />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
}));
