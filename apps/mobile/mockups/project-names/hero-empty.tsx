import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProjectHeroSample, ProjectPageBody } from './parts';

/** Without a description the head offers one quietly instead of a generated line. */
export default function HeroEmptyMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProjectHeroSample name="Kundenportal" />
      <ProjectPageBody />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
