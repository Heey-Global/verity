import { projectCardState, type ProjectRecord } from '@verity/mobile';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, IconButton, Row, SectionHeader, Text } from '../../components/ui';
import { ProjectStateNote, ProjectStateTile } from '../../components/project/ProjectStateTile';

const ignore = () => undefined;

type SampleProject = Pick<
  ProjectRecord,
  'state' | 'lifecycleState' | 'provisionError' | 'provisionWarning'
> & { sandboxUpdate?: ProjectRecord['sandboxUpdate'] };

/**
 * The project page's hero with the card's state, from the page's own tile and
 * note: the tile takes the card's colour, and a state on its way (Starting…,
 * Waking…) sits to the right of the name, which gives way first.
 */
function HeroSample({
  name,
  description,
  project,
}: {
  name: string;
  description: string;
  project: SampleProject;
}) {
  const state = projectCardState(project);
  return (
    <View style={styles.hero}>
      <ProjectStateTile title={name} state={state.state} size="hero" spoken />
      <View style={styles.heroBody}>
        <View style={styles.nameLine}>
          <Text variant="title" accessibilityRole="header" numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          <ProjectStateNote state={state} />
        </View>
        <Text variant="subtitle" numberOfLines={2}>
          {description}
        </Text>
      </View>
    </View>
  );
}

/** The project page in the wide layout's left column, as on the iPad. */
export function ProjectPageSample({
  name,
  description,
  project,
  needsYou,
}: {
  name: string;
  description: string;
  project: SampleProject;
  needsYou?: ReactNode;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <Button
          label="Projects"
          icon="chevron-left"
          variant="text"
          size="compact"
          onPress={ignore}
        />
        <IconButton icon="settings" accessibilityLabel="Project settings" onPress={ignore} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <HeroSample name={name} description={description} project={project} />
        {needsYou}
        <SectionHeader title="Content" />
        <Group>
          <Row
            leading={{ icon: 'book-open' }}
            title="Wiki"
            subtitle="Maintained knowledge and decisions"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'paperclip' }}
            title="Sources"
            subtitle="Documents, meeting transcripts and attachments"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'check-square' }}
            title="Tasks"
            subtitle="No open tasks"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'git-pull-request' }}
            title="Repositories"
            subtitle="2 repositories · 3 open PRs"
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  heroBody: { flex: 1, gap: theme.spacing.xxs },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  // The name gives way to the state, which stays whole.
  name: { flexShrink: 1, minWidth: 0 },
}));
