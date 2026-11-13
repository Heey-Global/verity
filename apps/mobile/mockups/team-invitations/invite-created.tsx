import QRCode from 'react-native-qrcode-svg';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, Group, IconButton, Row, SectionHeader, StatusTag } from '../../components/ui';
import { ignore, Page, PROJECT } from './parts';

const LINK = 'https://verity.build/join#k=4F2C9A17&s=7Qm2c9TkV4xRbW1p';

/** The invitation exists: share it as a link or QR code, see its validity, revoke it. */
export default function InviteCreatedMockup() {
  const { theme } = useUnistyles();
  return (
    <Page
      footer={
        <>
          <Button label="Send invitation" icon="share" onPress={ignore} fullWidth />
          <Button label="Revoke invitation" variant="text" onPress={ignore} fullWidth />
        </>
      }
    >
      <SectionHeader title="Send to Lena" variant="eyebrow" />
      <View style={styles.qrFrame}>
        <QRCode
          value={LINK}
          size={200}
          backgroundColor={theme.colors.surface}
          color={theme.colors.text}
        />
      </View>
      <Group>
        <Row
          leading={{ icon: 'link', quiet: true }}
          title="Invitation link"
          subtitle="verity.build/join#…"
          trailing={
            <IconButton icon="copy" accessibilityLabel="Copy invitation link" onPress={ignore} />
          }
        />
      </Group>
      <Group>
        <Row
          leading={{ icon: 'mail', quiet: true }}
          title="Invitation for Lena"
          trailing={<StatusTag intent="optional" label="Open" />}
        />
        <Row leading={{ icon: 'user-check', quiet: true }} title={`Can edit “${PROJECT}”`} />
        <Row
          leading={{ icon: 'clock', quiet: true }}
          title="Valid until 19 Nov, 14:20"
          subtitle="Can be used once"
        />
      </Group>
    </Page>
  );
}

const styles = StyleSheet.create((theme) => ({
  qrFrame: {
    alignSelf: 'center',
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface,
  },
}));
