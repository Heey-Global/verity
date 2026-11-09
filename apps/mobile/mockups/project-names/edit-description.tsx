import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProjectHeroSample, ProjectPageBody } from './parts';

/**
 * The description, tapped: a field growing over several lines. Shown with a
 * failed save: the text stays as typed and the reason sits below it.
 */
export default function EditDescriptionMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProjectHeroSample
        editing={{
          field: 'description',
          value:
            'Self-hosted AI agent workspace with mobile app. Coordinates agents across repositories, knowledge and meetings.',
          error: {
            title: 'Not saved',
            message: 'The server did not answer; your text is kept.',
          },
        }}
      />
      <ProjectPageBody />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
