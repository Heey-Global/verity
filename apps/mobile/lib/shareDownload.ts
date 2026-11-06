import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { getAuthToken } from './authToken';
import { getVerityBaseUrl } from './client';
import { fileNameFromPath, mimeTypeForFile } from './fileSelection';
import { downloadPinnedFile } from './pinnedTransport';
import { getServerProfile } from './serverProfile';
import { loadSharingModule } from './sessionFileUi';

/**
 * Download a server file and hand it to the share sheet ("Open in…", "Save to
 * Files").
 *
 * On iOS and Android the file goes straight from the URL to disk, with the
 * bearer and — on a direct connection — the server's TLS pin, as session files
 * do. Reading it through `fetch` first does not work there: React Native's Blob
 * has no `arrayBuffer()`, which surfaced as "undefined is not a function". The
 * web keeps the browser download of the fetched blob.
 */
export async function shareDownload({
  url,
  path,
  cacheFolder,
  webBlob,
}: {
  url: string;
  /** The file's path on the server; its last segment names the download. */
  path: string;
  /** A folder under the app cache, so downloads of the same name do not collide. */
  cacheFolder: string;
  webBlob: () => Promise<Blob>;
}): Promise<void> {
  const name = fileNameFromPath(path);
  if (Platform.OS === 'web') {
    const objectUrl = URL.createObjectURL(await webBlob());
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }
  const directory = new Directory(Paths.cache, cacheFolder);
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, name);
  const baseUrl = getVerityBaseUrl();
  const token = getAuthToken(baseUrl);
  const headers =
    token !== null && token.length > 0 ? { authorization: `Bearer ${token}` } : undefined;
  const endpoint = getServerProfile()?.endpoints.find((candidate) => candidate.url === baseUrl);
  const tlsPin = endpoint?.transport === 'direct' ? endpoint.tlsPin : undefined;
  const file = tlsPin
    ? new File(
        await downloadPinnedFile({
          url,
          destination: destination.uri,
          tlsPin,
          useRemote: true,
          ...(headers ? { headers } : {}),
        }),
      )
    : await File.downloadFileAsync(url, destination, {
        idempotent: true,
        ...(headers ? { headers } : {}),
      });
  const sharing = await loadSharingModule();
  if (sharing === undefined || !(await sharing.isAvailableAsync()))
    throw new Error('No app is available to open or share this file');
  await sharing.shareAsync(file.uri, {
    mimeType: mimeTypeForFile(path),
    dialogTitle: `Open ${name}`,
  });
}
