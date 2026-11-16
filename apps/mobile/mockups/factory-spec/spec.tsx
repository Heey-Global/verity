import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  Button,
  Card,
  CardHead,
  FilterChips,
  Group,
  Row,
  SectionHeader,
  StatusTag,
  Text,
} from '../../components/ui';
import { Recommendation } from './parts';

const ignore = () => undefined;

const CRITERIA = [
  { title: 'Monthly/annual toggle above the plans', source: 'Mockup · Overview' },
  { title: 'Recommended plan highlighted', source: 'Mockup · Overview' },
  { title: 'Comparison table readable at 320 px', source: 'Mockup · Compare' },
  { title: 'Checkout opens with the chosen plan', source: 'Test' },
] as const;

type Tab = 'spec' | 'mockups';

/** The spec itself: fixed sections, criteria Quality will check, one decision. */
export default function SpecMockup() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('spec');
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text variant="eyebrow">Spec · Website</Text>
          <View style={styles.titleRow}>
            <Text variant="title" style={styles.flex}>
              Pricing page
            </Text>
            <StatusTag intent="optional" label="v2" />
          </View>
        </View>
        <FilterChips
          options={[
            { value: 'spec', label: 'Spec' },
            { value: 'mockups', label: 'Mockups 1/3' },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel="Spec section"
        />
        <SectionHeader title="Goal" />
        <Text variant="body">Pick a plan and reach checkout in two taps.</Text>
        <SectionHeader title="Out of scope" />
        <Text variant="body" tone="muted">
          Coupons, invoices, enterprise contact form.
        </Text>
        <SectionHeader title="Acceptance criteria" />
        <Group>
          {CRITERIA.map((criterion) => (
            <Row
              key={criterion.title}
              title={criterion.title}
              subtitle={criterion.source}
              leading={{ icon: 'circle' }}
            />
          ))}
        </Group>
        <SectionHeader title="Decision" />
        <Card stacked>
          <CardHead title="Show prices incl. VAT?" subtitle="Needed before the build starts" />
          <Recommendation>I recommend incl. VAT – your audience is consumers.</Recommendation>
          <View style={styles.actions}>
            <Button label="Incl. VAT" size="compact" onPress={ignore} />
            <Button label="Excl. VAT" size="compact" variant="secondary" onPress={ignore} />
          </View>
        </Card>
      </ScrollView>
      <View
        style={[styles.bar, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}
        testID="mockup-approval-bar"
      >
        <View style={styles.actions}>
          <View style={styles.flex}>
            <Button label="Request changes" variant="secondary" fullWidth onPress={ignore} />
          </View>
          <View style={styles.flex}>
            <Button label="Approve & build" fullWidth disabled onPress={ignore} />
          </View>
        </View>
        <Text variant="footnote" style={styles.center}>
          Waiting for: 2 mockups · 1 decision
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  heading: { gap: theme.spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  bar: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  center: { textAlign: 'center' },
}));
