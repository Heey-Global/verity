import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Card, FilterChips, Group, Row, SectionHeader, StatusTag, Text } from '../../components/ui';
import { Link } from './parts';

const ignore = () => undefined;

/** The top of the Wiki's start page: the overview Verity maintains in index.md and its topics. */
export function WikiOverview() {
  return (
    <>
      <Card stacked>
        <Text variant="body">
          Verity is a self-hosted assistant that runs coding and knowledge agents per project. Start
          with the <Link>product concept</Link> and the <Link>navigation concept</Link>; current
          choices are under Decisions.
        </Text>
        <Text variant="footnote" tone="muted">
          Start page · updated today
        </Text>
      </Card>

      <SectionHeader title="Topics" />
      <Group>
        <Row
          leading={{ icon: 'layers' }}
          title="Product concept"
          subtitle="Assistant, roles, positioning · 8 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Mobile app"
          subtitle="Design system, performance, OTA updates · 14 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Meetings"
          subtitle="Live transcription, intake, analysis · 6 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Security and permissions"
          subtitle="Authorization, egress, certificates · 11 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Builds and releases"
          subtitle="Build storage, CI, release recovery · 12 pages"
          navigates
          onPress={ignore}
        />
      </Group>
    </>
  );
}

/** The sections the app fills itself: decisions, recent changes and what needs a look. */
export function WikiStatus() {
  return (
    <>
      <SectionHeader title="Decisions" />
      <FilterChips
        options={[
          { value: 'current', label: 'Current · 24' },
          { value: 'superseded', label: 'Superseded · 10' },
        ]}
        value="current"
        onChange={ignore}
        accessibilityLabel="Decisions"
        compact
      />
      <Group>
        <Row
          leading={{ icon: 'check-circle' }}
          title="Content lists Wiki and Sources directly"
          subtitle="7 Nov · replaces “Knowledge browsers move out of Settings”"
          trailing={<StatusTag intent="ready" label="Current" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'check-circle' }}
          title="One mandate model for all agents"
          subtitle="3 Nov · Project settings › Agents"
          trailing={<StatusTag intent="ready" label="Current" />}
          navigates
          onPress={ignore}
        />
        <Row title="All 34 decisions" navigates onPress={ignore} />
      </Group>

      <SectionHeader title="Recently updated" />
      <Group>
        <Row
          leading={{ icon: 'file-text' }}
          title="Navigation concept"
          subtitle="Today · from Live meeting 7 Nov"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'file-text' }}
          title="Live meeting intake"
          subtitle="Today · from Live meeting 7 Nov"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'file-text' }}
          title="Build storage rollout"
          subtitle="Yesterday · from Live meeting 6 Oct"
          navigates
          onPress={ignore}
        />
      </Group>

      <SectionHeader title="To review · 3" />
      <Group>
        <Row
          leading={{ icon: 'alert-triangle', intent: 'needsSetup' }}
          title="Meeting contradicts a page"
          subtitle="Navigation concept · Live meeting 7 Nov"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'git-merge', intent: 'needsSetup' }}
          title="Edit conflict"
          subtitle="Project egress deadline contract · changed twice at once"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'link-2', intent: 'needsSetup' }}
          title="2 broken links"
          subtitle="Weekly check · Mobile performance audit"
          navigates
          onPress={ignore}
        />
      </Group>

      <View style={styles.footer}>
        <Group>
          <Row leading={{ icon: 'folder' }} title="All files" navigates onPress={ignore} />
        </Group>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { marginTop: theme.spacing.md },
}));
