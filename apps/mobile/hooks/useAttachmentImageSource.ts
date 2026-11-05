import { File as FsFile, Paths } from 'expo-file-system';
import type { ImageSource } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';

import { getAuthToken } from '../lib/authToken';
import { getVerityBaseUrl } from '../lib/client';
import { downloadPinnedFile } from '../lib/pinnedTransport';
import { getServerProfile } from '../lib/serverProfile';

// Resolve an attachment to a renderable URI: a stored ref (id) → the server's
// content-addressed endpoint (expo-image lazy-fetches + disk-caches it); a pending
// upload or a legacy inline attachment (data) → a data URI.
function attachmentSource(a: {
  id?: string;
  data?: string;
  mediaType: string;
}): ImageSource | undefined {
  const baseUrl = getVerityBaseUrl();
  if (a.id !== undefined && baseUrl !== null) {
    const token = getAuthToken(baseUrl);
    return {
      uri: `${baseUrl}/attachments/${a.id}`,
      ...(token !== null && token.length > 0
        ? { headers: { authorization: `Bearer ${token}` } }
        : {}),
    };
  }
  if (a.data !== undefined) return { uri: `data:${a.mediaType};base64,${a.data}` };
  return undefined;
}

/** Resolve stored images through the same native public-key-pinned downloader as
 * API requests. Passing their HTTPS URL directly to expo-image would use its own
 * URLSession and therefore reject the installer's self-signed certificate. */
export function useAttachmentImageSource(a: {
  id?: string;
  data?: string;
  mediaType: string;
}): ImageSource | undefined {
  const immediate = useMemo(() => attachmentSource(a), [a.data, a.id, a.mediaType]);
  return usePinnedImageSource(immediate, a.id);
}

/** Load a server-hosted image source (`immediate`) through the pinned downloader
 * when the active endpoint is a TLS-pinned direct connection; otherwise hand it to
 * expo-image as-is. `cacheKey` names the downloaded copy; without one, `immediate`
 * is not a server URL (e.g. inline base64) and is returned unchanged. */
export function usePinnedImageSource(
  immediate: ImageSource | undefined,
  cacheKey: string | undefined,
  onError?: () => void,
): ImageSource | undefined {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [source, setSource] = useState<ImageSource | undefined>(
    cacheKey === undefined ? immediate : undefined,
  );
  useEffect(() => {
    if (cacheKey === undefined || !/^https?:\/\//.test(immediate?.uri ?? '')) {
      setSource(immediate);
      return;
    }
    const baseUrl = getVerityBaseUrl();
    const endpoint = getServerProfile()?.endpoints.find(({ url }) => url === baseUrl);
    if (
      baseUrl === null ||
      endpoint?.transport !== 'direct' ||
      endpoint.tlsPin === undefined ||
      // The bearer and pin belong to the active endpoint only; a source built for
      // another origin (e.g. before a LAN/remote switch) keeps its own loader.
      !immediate!.uri!.startsWith(`${baseUrl}/`)
    ) {
      setSource(immediate);
      return;
    }
    let active = true;
    let cachedUri: string | undefined;
    const destination = new FsFile(
      Paths.cache,
      'verity-attachments',
      `${cacheKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    // Read the bearer now rather than trusting the memoized source's header: a
    // biometric unlock or token rotation can land after the source was built.
    const token = getAuthToken(baseUrl);
    void downloadPinnedFile({
      url: immediate!.uri!,
      destination: destination.uri,
      tlsPin: endpoint.tlsPin,
      useRemote: true,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })
      .then((uri) => {
        if (active) {
          cachedUri = uri;
          setSource({ uri });
        } else {
          try {
            new FsFile(uri).delete();
          } catch {
            // Best effort cache cleanup.
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setSource(undefined);
        onErrorRef.current?.();
      });
    return () => {
      active = false;
      if (cachedUri) {
        try {
          new FsFile(cachedUri).delete();
        } catch {
          // Best effort cache cleanup.
        }
      }
    };
  }, [cacheKey, immediate]);
  return source;
}
