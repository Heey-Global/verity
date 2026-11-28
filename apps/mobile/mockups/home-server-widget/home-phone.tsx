import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { HostResourcesCard } from '../../components/home/HostResources';
import { Group, Row, SectionHeader } from '../../components/ui';

const ignore = () => undefined;
const GiB = 1024 ** 3;

// Sample data: five minutes of a busy afternoon, the disk nearly full.
const CPU = [
  22, 25, 31, 28, 24, 30, 41, 55, 62, 48, 39, 35, 33, 37, 44, 52, 58, 51, 46, 40, 36, 34, 38, 45,
  49, 53, 47, 42, 44, 46,
];
const MEMORY = [
  30, 30, 31, 31, 31, 32, 32, 33, 33, 33, 32, 32, 32, 31, 31, 32, 32, 33, 33, 34, 33, 33, 32, 32,
  32, 32, 33, 32, 32, 32,
];
const RESOURCES = {
  observedAt: '2026-11-28T09:08:00.000Z',
  cpu: { percent: 46, cores: 8 },
  memory: { usedBytes: 5.0 * GiB, totalBytes: 15.5 * GiB },
  disk: { usedBytes: 420.4 * GiB, totalBytes: 464.5 * GiB },
};

/** Phone, the end of Home: the last results, Shared knowledge, then the server. */
export default function HomePhoneMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Results · 3" variant="eyebrow" flush />
        <Group>
          <Row
            title="Release Checker"
            subtitle="Verity · PR #3025 · merged"
            leading={{ icon: 'git-pull-request', quiet: true }}
            onPress={ignore}
          />
          <Row
            title="Restic-Diagnose für heey-docs"
            subtitle="K8s · Claude Opus 5.5"
            leading={{ icon: 'message-square', quiet: true }}
            onPress={ignore}
          />
          <Row
            title="QA"
            subtitle="PulseCI - Curtis · Claude Opus 5.5"
            leading={{ icon: 'message-square', quiet: true }}
            onPress={ignore}
          />
        </Group>
        <View style={styles.knowledge}>
          <Group>
            <Row
              title="Shared knowledge"
              subtitle="Reference pages every project reads"
              leading={{ icon: 'globe', quiet: true }}
              navigates
              onPress={ignore}
            />
          </Group>
        </View>
        <View style={styles.server}>
          <HostResourcesCard resources={RESOURCES} history={{ cpu: CPU, memory: MEMORY }} />
        </View>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={3} bottomInset={0} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, paddingBottom: 96, gap: theme.spacing.sm },
  knowledge: { paddingTop: theme.spacing.xl },
  server: { paddingTop: theme.spacing.lg },
}));
