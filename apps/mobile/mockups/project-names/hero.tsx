import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DESCRIPTION, ProjectHeroSample, ProjectPageBody } from './parts';

/** At rest: name and description read as text; a tap on either edits it in place. */
export default function HeroMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProjectHeroSample description={DESCRIPTION} />
      <ProjectPageBody />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
