import { requireOptionalNativeModule } from 'expo-modules-core';
import { nativeTunnelUnsupported } from './nativeTunnelSupport';
import { VerityClient } from '@verity/mobile';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { getAuthToken } from './authToken';
import { createPinnedFetch } from './pinnedTransport';
import { getServerProfile } from './serverProfile';

/**
 * Confirms no native DATA tunnel is running on this device. It needs no paired
 * direct connection. Starting a test fails closed on every error; discarding
 * an unfinished test additionally accepts `isNativeTunnelUnsupported`, raised
 * only when the module reports itself unsupported: such a device
 * has no tunnel that could be capturing. Any other failure still fails closed.
 */
export async function assertNativeTunnelInactive() {
  // Expo returns null both for absence and some initialization errors. That
  // ambiguity cannot establish inactivity, so discard must fail closed too.
  const native = requireOptionalNativeModule<{
    isActive(): Promise<boolean>;
    isSupported(): Promise<boolean>;
  }>('VerityRemoteControlTunnel');
  if (!native) throw new Error('Native status unavailable.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!(await native.isSupported())) throw nativeTunnelUnsupported();
        if (await native.isActive())
          throw new Error('An existing DATA tunnel must be stopped before testing.');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native status unavailable.')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Never use the normal client's remote fallback for diagnostic administration. */
export function selectedRecordingContext() {
  const profile = getServerProfile();
  const remote = profile?.remoteControl;
  const endpoint = profile?.endpoints?.find(
    (entry) => entry.transport === 'direct' && entry.url === profile.activeUrl && entry.tlsPin,
  );
  if (!remote || !endpoint?.tlsPin)
    throw new Error('Select a paired direct HTTPS connection before testing.');
  const getToken = () => getAuthToken(endpoint.url);
  if (!getToken()) throw new Error('Unlock the paired direct connection before testing.');
  const direct = createPinnedFetch(endpoint.tlsPin, false);
  const bounded: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    init?.signal?.addEventListener('abort', abort, { once: true });
    if (init?.signal?.aborted) abort();
    const timer = setTimeout(abort, 5000);
    try {
      return await direct(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', abort);
    }
  };
  const client = new VerityClient({
    baseUrl: endpoint.url,
    fetch: bounded,
    getToken,
    recordingDigest: (value) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
  });
  return {
    client,
    profile,
    options: {
      coreUrl: endpoint.url,
      corePin: endpoint.tlsPin,
      getToken,
      uplinkOrigin: remote.uplinkOrigin,
      installationHandle: remote.installationHandle,
    },
    assertInactive: assertNativeTunnelInactive,
    async verify() {
      const descriptor = await client.getRemoteControlDescriptor();
      if (
        getServerProfile() !== profile ||
        !descriptor.enabled ||
        descriptor.installationId !== remote.installationId ||
        descriptor.installationHandle !== remote.installationHandle ||
        descriptor.uplinkOrigin !== remote.uplinkOrigin
      )
        throw new Error('The direct Core does not match the paired remote installation.');
      return (await digestStringAsync(CryptoDigestAlgorithm.SHA256, remote.installationId)).slice(
        0,
        16,
      );
    },
  };
}
