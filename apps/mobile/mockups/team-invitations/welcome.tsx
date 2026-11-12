import { Image, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Text } from '../../components/ui';
import { ignore, Page } from './parts';

const LOGO = require('../../assets/brand/verity-v-mark.png') as number;

/**
 * The first-run welcome with a second way in: someone who was invited does not
 * set up a server, but pastes or scans the invitation the link did not hand over.
 */
export default function WelcomeMockup() {
  return (
    <Page
      footer={
        <>
          <Button label="I have an invitation" icon="mail" onPress={ignore} fullWidth />
          <Button label="Set up my own server" variant="secondary" onPress={ignore} fullWidth />
          <Button label="Try demo" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <Image source={LOGO} style={styles.logo} resizeMode="contain" accessible={false} />
      <Text variant="label">Verity</Text>
      <Text variant="display" accessibilityRole="header">
        Secure development. Your choice of AI.
      </Text>
      <Text variant="body" tone="muted">
        Run Claude Code, Codex and OpenCode in isolated project sandboxes, on your own server or in a
        project someone shares with you.
      </Text>
      <View style={styles.gap} />
      <Group>
        <Row
          leading={{ icon: 'link', quiet: true }}
          title="Opened an invitation link?"
          subtitle="Tap it again now that the app is installed, or choose I have an invitation to paste or scan it."
          wrap
        />
      </Group>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  logo: { width: 64, height: 45, marginTop: theme.spacing.lg, marginBottom: theme.spacing.sm },
  gap: { height: theme.spacing.sm },
}));
