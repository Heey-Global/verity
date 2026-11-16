import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { Fragment } from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, Row, SectionHeader, Text } from '../../../components/ui';
import { isDemoMode } from '../../../lib/demoMode';
import { findMockup, MOCKUP_SPECS } from '../../../mockups/registry';

/**
 * A spec's mockup screen, composed of the app's real components with sample
 * data (apps/mobile/mockups). `scripts/render-mockups.mjs` renders these to PNG
 * from the browser export. Only the demo transport may show them: outside demo
 * mode the route sends the operator home, so a mockup can never be mistaken for
 * live data.
 *
 * The screen parameter is named `mockup`, not `screen`: React Navigation reads
 * a `screen` param as the target of a nested navigator, finds none, and falls
 * back to Home before this route renders.
 */
export default function MockupRoute() {
  const params = useLocalSearchParams<{ spec?: string; mockup?: string }>();
  if (!isDemoMode()) return <Redirect href="/" />;
  const found = findMockup(params.spec, params.mockup);
  if (found) {
    const { Component, title } = found.screen;
    return (
      <>
        <Stack.Screen options={{ title }} />
        <Component />
      </>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: 'Mockup not found' }} />
      <ScrollView contentContainerStyle={styles.content} testID="mockup-not-found">
        <Text variant="body" tone="muted">
          No mockup at {params.spec ?? '?'}/{params.mockup ?? '?'}. Available:
        </Text>
        {MOCKUP_SPECS.map((spec) => (
          <Fragment key={spec.id}>
            <SectionHeader title={spec.title} />
            <Group>
              {Object.keys(spec.screens).map((screen) => (
                <Row key={screen} title={`${spec.id}/${screen}`} />
              ))}
            </Group>
          </Fragment>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
