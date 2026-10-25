import { Alert } from 'react-native';
import type { VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { PREMIUM_ROUTE, premiumFeatures } from './premium/premiumFeatures';

type PremiumFeature = {
  name: string;
  requirement: string;
  isConfigured: () => Promise<boolean>;
};

/** Check on each invocation so a newly configured key takes effect immediately. */
export async function runPremiumFeature(feature: PremiumFeature, open: () => void): Promise<void> {
  let configured: boolean;
  try {
    configured = await feature.isConfigured();
  } catch {
    Alert.alert('Could not check availability', 'Check your connection and try again.');
    return;
  }
  if (!configured) {
    Alert.alert(
      'Verity Premium',
      `${feature.name} is part of Verity Premium. ${feature.requirement}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Learn more', onPress: () => router.push(PREMIUM_ROUTE) },
      ],
    );
    return;
  }
  open();
}

export async function openPublicPreview(client: VerityClient, open: () => void): Promise<void> {
  try {
    const { publicSharing } = await client.getPreviewCapabilities();
    if (publicSharing === 'available') {
      open();
      return;
    }
    if (publicSharing === 'unavailable') {
      Alert.alert(
        'Online sharing unavailable',
        'Uplink is temporarily unavailable. Check Diagnostics and try again.',
      );
      return;
    }
    Alert.alert(
      'Verity Premium',
      publicSharing === 'disabled'
        ? 'Online sharing is switched off. Enable it in Verity Premium settings.'
        : `${premiumFeatures[0].name} is part of Verity Premium. Add your Uplink subscription key in Settings → Verity Premium.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Premium settings', onPress: () => router.push(PREMIUM_ROUTE) },
      ],
    );
  } catch {
    Alert.alert('Could not check availability', 'Check your connection and try again.');
  }
}
