import { Alert } from 'react-native';
import type { VerityClient } from '@verity/mobile';

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
    Alert.alert('Premium feature', `${feature.name} is a premium feature. ${feature.requirement}`);
    return;
  }
  open();
}

export function openPublicPreview(client: VerityClient, open: () => void): Promise<void> {
  return runPremiumFeature(
    {
      name: 'Preview sharing',
      requirement: 'Add your Uplink subscription key in Settings → Connected services to use it.',
      isConfigured: async () =>
        (await client.getVeritySettings())?.uplinkSubscriptionKeyConfigured === true,
    },
    open,
  );
}
