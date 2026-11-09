import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DESCRIPTION, ProjectHeroSample, ProjectPageBody } from './parts';

/** The name, tapped: the title line becomes a focused field in title type. */
export default function EditNameMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProjectHeroSample
        description={DESCRIPTION}
        editing={{ field: 'name', value: 'Verity Plattform – Mobile' }}
      />
      <ProjectPageBody />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
