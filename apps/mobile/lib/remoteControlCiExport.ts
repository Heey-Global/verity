import { Share } from 'react-native';
import { getServerProfile, type VerityServerProfile } from './serverProfile';

export function remoteControlCiInputs(profile: VerityServerProfile | null) {
  const endpoint = profile?.endpoints.find((entry) => entry.url === profile.activeUrl);
  const remote = profile?.remoteControl;
  if (!endpoint?.tlsPin || !remote) {
    throw new Error('Connect a paired server with Remote Control enabled before exporting.');
  }
  // Explicit projection prevents pairing credentials and future profile fields
  // from leaking into a report intended for CI workflow inputs.
  return {
    uplink_origin: remote.uplinkOrigin,
    installation_handle: remote.installationHandle,
    core_url: endpoint.url,
    core_pin: endpoint.tlsPin,
  };
}

export async function shareRemoteControlCiInputs(): Promise<void> {
  await Share.share({
    title: 'Remote Control test inputs',
    message: JSON.stringify(remoteControlCiInputs(getServerProfile()), null, 2),
  });
}
