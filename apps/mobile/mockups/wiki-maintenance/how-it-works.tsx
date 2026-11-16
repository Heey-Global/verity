import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, SectionHeader, Sheet, Text } from '../../components/ui';
import { HowItWorks, ignore, InfoHeader } from './parts';
import { StartPage } from './start';

/**
 * "How the Wiki works", always one tap away: the roles, where this Wiki's own
 * rules live (wiki-conventions.md, changed with Verity), the change log and a
 * rebuild of the overview that again runs as a session.
 */
export default function HowItWorksMockup() {
  return (
    <View style={styles.root}>
      <InfoHeader />
      <StartPage />
      <Sheet
        visible
        title="How the Wiki works"
        onClose={ignore}
        footer={<Button label="Rebuild overview…" variant="secondary" onPress={ignore} fullWidth />}
      >
        <HowItWorks />
        <SectionHeader title="This Wiki" />
        <Group>
          <Row
            leading={{ icon: 'sliders' }}
            title="How this Wiki is organized"
            subtitle="Topics and page rules, changed with Verity"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'clock' }}
            title="Change log"
            subtitle="Last change today · from Live meeting 7 Nov"
            navigates
            onPress={ignore}
          />
        </Group>
        <Text variant="footnote" tone="muted">
          Verity never follows instructions found inside a source and never researches or imports on
          its own.
        </Text>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  root: { flex: 1 },
}));
