import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { Group, Row, SectionHeader, Text, TileMark } from '../../components/ui';
import { NAME, ignore } from './parts';

function Initial({ name }: { name: string }) {
  return (
    <Text variant="row" tone="action">
      {(Array.from(name)[0] ?? '?').toUpperCase()}
    </Text>
  );
}

/**
 * The Projects tab: every project by its own name; the line under it keeps
 * today's facts (what waits, what runs, what is new), never the description.
 */
export default function HomeMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Projects" />
        <Group>
          <Row
            leading={{ element: <Initial name={NAME} /> }}
            title={NAME}
            subtitle="1 waiting for you · 2 running"
            trailing={<TileMark tone="signature" pulsing />}
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ element: <Initial name="Kundenportal" /> }}
            title="Kundenportal"
            subtitle="1 session"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ element: <Initial name="Übersetzungen" /> }}
            title="Übersetzungen"
            subtitle="No sessions yet"
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
