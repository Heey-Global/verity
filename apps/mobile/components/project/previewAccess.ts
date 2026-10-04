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
    'Preview not reachable on your network',
    publicSharing === 'available'
      ? 'Your device cannot reach this preview on your server’s network. Share it publicly through Uplink instead?'
      : publicSharing === 'premium-required'
        ? 'This preview is only available on your server’s network or VPN. Public sharing requires Verity Premium.'
        : 'This preview is only available on your server’s network or VPN. Uplink is temporarily unavailable.',
    // The way out comes first: publishing is the fix when the network is the
    // problem, so it leads; the local link is the fallback for a device at home.
    [
      ...(publicSharing === 'available'
        ? [{ text: 'Share publicly', onPress: sharePublicly }]
        : publicSharing === 'premium-required' && openSettings
          ? [{ text: 'Open settings', onPress: openSettings }]
          : []),
      {
        text: 'Copy local link',
        onPress: () => {
          void Clipboard.setStringAsync(share.url);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ],
  );
}
