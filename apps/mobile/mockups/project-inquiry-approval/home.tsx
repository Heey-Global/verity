import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { Button, Card, CardHead, SectionHeader, StatusTag, Text } from '../../components/ui';
import { InquiryApprovalCard, ignore } from './parts';

/** Home: the same pending request, beside the other items that need the user. */
export default function HomeInquiryMockup() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="For you" />
        <InquiryApprovalCard from={{ project: 'Verity', session: 'Backup-Ausschluss prüfen' }} />

        <Card stacked>
          <CardHead
            title="Plan ready for review"
            subtitle="heey-global/k8s · Synapse-Admin-Rechte"
            trailing={<StatusTag intent="optional" label="Plan" />}
            onDismiss={ignore}
          />
          <Text variant="bodySmall" tone="muted">
            Implementation waits for your approval.
          </Text>
          <View style={styles.actions}>
            <Button label="Review plan" size="small" variant="secondary" onPress={ignore} />
          </View>
        </Card>
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={3} bottomInset={0} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
