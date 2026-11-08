import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FilterChips, Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { ignore } from './parts';

/** Decisions as the Wiki's start page shows them today: filter, latest two, all. */
export function Decisions() {
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
          subtitle="7 Nov"
          trailing={<StatusTag intent="ready" label="Current" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'check-circle' }}
          title="One mandate model for all agents"
          subtitle="3 Nov"
          trailing={<StatusTag intent="ready" label="Current" />}
          navigates
          onPress={ignore}
        />
        <Row title="All 34 decisions" navigates onPress={ignore} />
      </Group>
    </>
  );
}

/** The link to every file, closing the start page as today. */
export function AllFiles() {
  return (
    <View style={styles.footer}>
      <Group>
        <Row leading={{ icon: 'folder' }} title="All files" navigates onPress={ignore} />
      </Group>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { marginTop: theme.spacing.md },
}));
