import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Sheet, Text, TextField } from '../../components/ui';
import { ignore, NetworkSharesPage } from './parts';

/**
 * Adding a share: Verity tests the sign-in and an encrypted SMB3 session
 * before saving. A failed test shows its reason on the field it concerns.
 */
export default function ConnectShareMockup() {
  return (
    <NetworkSharesPage
      overlay={
        <Sheet
          visible
          title="Add network share"
          onClose={ignore}
          footer={<Button label="Test and add" fullWidth onPress={ignore} />}
        >
          <View style={styles.fields}>
            <TextField label="Name" value="Studio NAS" onChangeText={ignore} />
            <View style={styles.field}>
              <TextField
                label="Address"
                value="smb://nas.studio.lan/team"
                onChangeText={ignore}
                keyboardType="url"
                literal
              />
              <Text variant="bodySmall" tone="muted">
                The address you would open in Finder or Explorer: the NAS, then the shared folder.
                On a Synology NAS, the shared folders are listed under Control Panel › Shared
                Folder.
              </Text>
            </View>
            <TextField label="Username" value="verity" onChangeText={ignore} literal />
            <TextField
              label="Password"
              value="mockup-placeholder"
              onChangeText={ignore}
              secret
              literal
              error={{
                title: 'Sign-in failed',
                message: 'The server rejected this username or password.',
              }}
            />
            <Text variant="body" tone="muted">
              The Verity server must reach the NAS on your network or through a VPN. Verity only
              connects with SMB3 encryption; agents never see the password.
            </Text>
          </View>
        </Sheet>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing.md },
  field: { gap: theme.spacing.xs },
}));
