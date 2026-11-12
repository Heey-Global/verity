import QRCode from 'react-native-qrcode-svg';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, StatusTag, Text } from '../../components/ui';
import { ignore, Page, PROJECT } from './parts';

const LINK = 'https://verity.build/join#k=4F2C9A17&s=7Qm2c9TkV4xRbW1p';

/** The invitation exists: share it as a link or QR code, see its validity, revoke it. */
export default function InviteCreatedMockup() {
  return (
    <Page
      footer={
        <>
          <Button label="Share link" icon="share" onPress={ignore} fullWidth />
          <Button label="Revoke invitation" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <Text variant="bodySmall" tone="muted">
        Send the link by WhatsApp, Signal or email, or let Lena scan the code. It works once and opens
        only {PROJECT}, nothing else on your server.
      </Text>
      <View style={styles.qrFrame}>
        <QRCode value={LINK} size={200} backgroundColor="#ffffff" color="#000000" />
      </View>
      <Group>
        <Row
          leading={{ icon: 'link', quiet: true }}
          title="verity.build/join#…"
          subtitle="Tap to copy · routed through Uplink"
          trailing={<StatusTag intent="transient" label="Waiting" />}
          onPress={ignore}
        />
        <Row leading={{ icon: 'user-check', quiet: true }} title="Can run" subtitle={`Only the project ${PROJECT}`} />
        <Row leading={{ icon: 'clock', quiet: true }} title="Valid until 19 Nov, 14:20" subtitle="7 days · single use" />
      </Group>
      <Text variant="footnote" tone="muted">
        Anyone holding the link can join until it is used, expires or is revoked. Send it only to
        Lena. You see here when it was accepted.
      </Text>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  qrFrame: {
    alignSelf: 'center',
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
    borderRadius: theme.radius.control,
    backgroundColor: '#ffffff',
  },
}));
