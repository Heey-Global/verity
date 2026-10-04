import { Alert, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { localPreviewReachable, type LocalPreviewShare } from '@verity/mobile';

export async function openLocalPreview(
  share: LocalPreviewShare,
  publicSharing: 'available' | 'premium-required' | 'unavailable',
  sharePublicly: () => void,
  openSettings?: () => void,
): Promise<void> {
  if (await localPreviewReachable(share)) {
    await Linking.openURL(share.url);
    return;
  }
  Alert.alert(
    'Local preview is unreachable',
    publicSharing === 'available'
      ? 'Your device cannot reach this preview on your server’s network. Share it publicly through Uplink instead?'
      : publicSharing === 'premium-required'
        ? 'This preview is only available on your server’s network or VPN. Public sharing requires Verity Premium.'
        : 'This preview is only available on your server’s network or VPN. Uplink is temporarily unavailable.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Copy local link',
        onPress: () => {
          void Clipboard.setStringAsync(share.url);
        },
      },
      ...(publicSharing === 'available'
        ? [{ text: 'Share publicly', onPress: sharePublicly }]
        : publicSharing === 'premium-required' && openSettings
          ? [{ text: 'Open settings', onPress: openSettings }]
          : []),
    ],
  );
}
