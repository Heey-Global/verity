import { Image, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Text } from '../../components/ui';
import { ignore, Page } from './parts';

const LOGO = require('../../assets/brand/verity-v-mark.png') as number;

/**
 * The first-run welcome: set up your own server, or join a project someone
 * shared with you.
 */
export default function WelcomeMockup() {
  return (
    <Page
      footer={
        <>
          <Button label="Set up my own server" onPress={ignore} fullWidth />
          <Button label="Join a shared project" variant="secondary" onPress={ignore} fullWidth />
          <Button label="Try demo" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <View style={styles.hero}>
        <Image source={LOGO} style={styles.logo} resizeMode="contain" accessible={false} />
        <Text variant="display" accessibilityRole="header">
          Verity
        </Text>
        <Text variant="body" tone="muted">
          Build software with the AI of your choice.
        </Text>
      </View>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xxxl * 2,
  },
  logo: { width: 96, height: 68, marginBottom: theme.spacing.sm },
}));
