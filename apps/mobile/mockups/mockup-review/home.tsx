import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { VerityHeader } from '../../components/home/HomeInbox';
import { HomeTabBar } from '../../components/home/HomeTabBar';
import { Button, Card, CardHead, SectionHeader, StatusTag, Text } from '../../components/ui';
import { MockupThumbs, SAMPLE_SCREENS } from './parts';

const ignore = () => undefined;

/**
 * Home with a mockup review. The item shows the screens themselves; Review
 * opens the full-screen review directly, not the session. Implementation
 * would add a media slot to InboxCard rather than compose a card here.
 */
export default function HomeReviewMockup() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <VerityHeader summary="1 mockup review" />
        <SectionHeader title="Needs you · 1" />
        <Card stacked>
          <CardHead
            title="Review mockups: pricing page"
            subtitle="Website · Project agent · 3 screens"
            trailing={<StatusTag intent="needsSetup" label="Mockups" />}
          />
          <MockupThumbs screens={SAMPLE_SCREENS} />
          <Text variant="bodySmall" tone="muted">
            1 of 3 approved, 1 comment. Implementation waits for your review.
          </Text>
          <View style={styles.actions}>
            <Button label="Review" size="compact" onPress={ignore} />
            <Button label="Open session" size="compact" variant="secondary" onPress={ignore} />
          </View>
        </Card>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={1} bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
