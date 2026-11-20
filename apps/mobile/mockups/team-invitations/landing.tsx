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
        invites you to the project{' '}
        <Text variant="display" tone="signature">
          verity
        </Text>
      </Text>
      <Group>
        <Row
          leading={{ icon: 'download', quiet: true }}
          title="1. Install Verity"
          subtitle="Free for iPhone, iPad and Mac"
          trailing={<Button label="App Store" size="small" onPress={ignore} />}
        />
        <Row
          leading={{ icon: 'check', quiet: true }}
          title="2. Accept in the app"
          subtitle="Opens the Verity app with this invitation"
          trailing={<Button label="Accept" size="small" variant="secondary" onPress={ignore} />}
        />
      </Group>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  logo: { width: 48, height: 34, marginTop: theme.spacing.md },
  from: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md,
  },
}));
