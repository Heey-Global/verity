import { Image, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Text } from '../../components/ui';
import { Avatar, ignore, Page } from './parts';

const LOGO = require('../../assets/brand/verity-v-mark.png') as number;

/**
 * verity.build/join in a browser without the app: who invites to what, and the
 * way into the app. The page never redeems the invitation itself.
 */
export default function LandingMockup() {
  return (
    <Page>
      <Image source={LOGO} style={styles.logo} resizeMode="contain" accessible={false} />
      <View style={styles.from}>
        <Avatar initials="HT" />
        <Text variant="label">Holger Teske</Text>
      </View>
      <Text variant="display" accessibilityRole="header">
        invites you to the project <Text variant="display" tone="signature">verity</Text>
      </Text>
      <Text variant="body" tone="muted">
        Projects are shared through the Verity app, which connects securely to Holger's server.
      </Text>
      <Group>
        <Row leading={{ icon: 'download', quiet: true }} title="1. Install Verity" subtitle="Free for iPhone, iPad, Mac and Android" />
        <Row leading={{ icon: 'link', quiet: true }} title="2. Open this link again" subtitle="It then opens in the app, or paste it there" />
        <Row leading={{ icon: 'cpu', quiet: true }} title="3. Connect your own AI" subtitle="Claude, Codex or OpenCode" />
      </Group>
      <Button label="Download on the App Store" icon="smartphone" onPress={ignore} fullWidth />
      <Button label="Get it on Google Play" variant="secondary" onPress={ignore} fullWidth />
      <Button label="Open in Verity" variant="text" onPress={ignore} fullWidth />
      <Text variant="footnote" tone="muted">
        This page does not open the project in the browser. The invitation works once and expires on
        19 Nov.
      </Text>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  logo: { width: 48, height: 34, marginTop: theme.spacing.md },
  from: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginTop: theme.spacing.md },
}));
