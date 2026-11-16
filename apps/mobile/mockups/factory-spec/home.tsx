import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { InboxCard, VerityHeader } from '../../components/home/HomeInbox';
import { HomeTabBar } from '../../components/home/HomeTabBar';
import {
  Button,
  Card,
  CardHead,
  Group,
  Row,
  SectionHeader,
  StatusTag,
  Text,
} from '../../components/ui';
import { Recommendation, ScreenThumb } from './parts';

const ignore = () => undefined;

/** Home with a spec waiting for approval and a deviation Quality found. */
export default function HomeMockup() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <VerityHeader summary="1 spec to approve · 1 deviation" />
        <SectionHeader title="Needs you · 2" />
        <Card stacked>
          <CardHead
            title="Approve spec: pricing page"
            subtitle="Website · Project agent"
            trailing={<StatusTag intent="optional" label="Spec" />}
          />
          <Text variant="bodySmall" tone="muted">
            3 screens · 5 acceptance criteria · 1 decision
          </Text>
          <View style={styles.thumbs}>
            <ScreenThumb icon="layout" label="Overview" />
            <ScreenThumb icon="columns" label="Compare" />
            <ScreenThumb icon="credit-card" label="Checkout" />
          </View>
          <Recommendation>Build starts as soon as you approve.</Recommendation>
          <View style={styles.actions}>
            <Button label="Review spec" size="compact" onPress={ignore} />
            <Button
              label="Discuss with Verity"
              size="compact"
              variant="secondary"
              onPress={ignore}
            />
          </View>
        </Card>
        <InboxCard
          item={{
            key: 'mockup-deviation',
            kind: 'question',
            tag: 'Deviation',
            tone: 'attention',
            title: 'Build differs from mockup',
            context: 'Website · Quality · PR #2041',
            message: '1 of 5 criteria not met: the plan toggle moved below the plans.',
            actions: [
              { kind: 'open_session', label: 'Compare', sessionId: 'mockup' },
              { kind: 'open_session', label: 'Open session', sessionId: 'mockup' },
            ],
            at: 0,
          }}
          selected={false}
          pending={false}
          disabled={false}
          onAction={ignore}
        />
        <SectionHeader title="Updates · 1" />
        <Group>
          <Row
            title="Login fix verified"
            subtitle="App · Quality · all checks passed"
            leading={{ icon: 'check-circle', intent: 'ready' }}
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={2} bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  thumbs: { flexDirection: 'row', gap: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
