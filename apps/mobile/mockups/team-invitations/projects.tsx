import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { Group, Row, SectionHeader, Text, TileMark } from '../../components/ui';
import { ignore } from './parts';

function Initial({ name }: { name: string }) {
  return (
    <Text variant="row" tone="action">
      {(Array.from(name)[0] ?? '?').toUpperCase()}
    </Text>
  );
}

/**
 * The Projects tab with projects from several servers in one list: a project
 * shared from someone else's server names whose it is; your own read as today.
 */
export default function ProjectsMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Projects" />
        <Group>
          <Row
            leading={{ element: <Initial name="Kundenportal" /> }}
            title="Kundenportal"
            subtitle="1 waiting for you · 2 running"
            trailing={<TileMark tone="signature" pulsing />}
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ element: <Initial name="verity" /> }}
            title="verity"
            subtitle="from Holger · 2 new"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ element: <Initial name="Übersetzungen" /> }}
            title="Übersetzungen"
            subtitle="1 session"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ element: <Initial name="Website" /> }}
            title="Website"
            subtitle="from Holger · No sessions yet"
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <HomeTabBar tab="projects" onChange={ignore} count={0} bottomInset={0} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
