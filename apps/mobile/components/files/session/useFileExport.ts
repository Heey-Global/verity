import { Directory as FsDirectory, File as FsFile, Paths } from 'expo-file-system';
import { useCallback, useRef } from 'react';
import { Alert, Platform } from 'react-native';

import { printableFileHtml } from '@verity/mobile';
import { getAuthToken } from '../../../lib/authToken';
import { isDemoMode } from '../../../lib/demoMode';
import { fileNameFromPath, mimeTypeForFile } from '../../../lib/fileSelection';
import { downloadPinnedFile } from '../../../lib/pinnedTransport';
import { getServerProfile } from '../../../lib/serverProfile';
import {
  cacheDirectoryName,
  loadPrintModule,
  loadSharingModule,
  pdfFileName,
} from '../../../lib/sessionFileUi';

const PRINT_MARGINS = { top: 50, bottom: 50, left: 50, right: 50 };

/** Where an explorer's files come from, for handing one to another app. */
export interface FileExportSource {
  baseUrl: string;
  /** Separates one explorer's cached copies from another's. */
  cacheKey: string;
  downloadUrl: (path: string) => string;
  download: (path: string) => Promise<Blob>;
  readText: (path: string) => Promise<{ content: string }>;
}

/**
 * "Open with another app" and "Print or share as PDF" for any explorer: the
 * session's Files and the knowledge libraries hand a file to the system the
 * same way, over the pinned transport where the server is reached directly.
 */
export function useFileExport(source: FileExportSource) {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const directTlsPin = () =>
    getServerProfile()?.endpoints.find(({ url }) => url === sourceRef.current.baseUrl)
      ?.transport === 'direct'
      ? getServerProfile()?.endpoints.find(({ url }) => url === sourceRef.current.baseUrl)?.tlsPin
      : undefined;
  const openWith = useCallback(
    (filePath: string) => {
      void (async () => {
        const url = sourceRef.current.downloadUrl(filePath);
        try {
          if (Platform.OS === 'web') {
            const blob = await sourceRef.current.download(filePath);
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = fileNameFromPath(filePath);
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
            return;
          }
          const cacheDir = new FsDirectory(
            Paths.cache,
            cacheDirectoryName(sourceRef.current.cacheKey, filePath),
          );
          cacheDir.create({ idempotent: true, intermediates: true });
          const token = getAuthToken(sourceRef.current.baseUrl);
          const destination = new FsFile(cacheDir, fileNameFromPath(filePath));
          if (isDemoMode()) {
            const { content } = await sourceRef.current.readText(filePath);
            destination.write(content);
            const sharing = await loadSharingModule();
            if (sharing !== undefined && (await sharing.isAvailableAsync())) {
              await sharing.shareAsync(destination.uri, {
                mimeType: mimeTypeForFile(filePath),
                dialogTitle: `Open ${fileNameFromPath(filePath)}`,
              });
            }
            return;
          }
          const headers =
            token !== null && token.length > 0 ? { authorization: `Bearer ${token}` } : undefined;
          const pin = directTlsPin();
          const file = pin
            ? new FsFile(
                await downloadPinnedFile({
                  url,
                  destination: destination.uri,
                  tlsPin: pin,
                  useRemote: true,
                  ...(headers ? { headers } : {}),
                }),
              )
            : await FsFile.downloadFileAsync(url, destination, {
                idempotent: true,
                ...(headers ? { headers } : {}),
              });
          const sharing = await loadSharingModule();
          if (sharing !== undefined && (await sharing.isAvailableAsync())) {
            await sharing.shareAsync(file.uri, {
              mimeType: mimeTypeForFile(filePath),
              dialogTitle: `Open ${fileNameFromPath(filePath)}`,
            });
          } else {
            throw new Error('No app is available to open or share this file');
          }
        } catch (err) {
          Alert.alert('Could not open file', err instanceof Error ? err.message : String(err));
        }
      })();
    },
    // The source's functions are rebuilt each render; the ref keeps the latest.
    [],
  );
  // Print or export the previewed text file. Sharing the raw file never offers
  // "Print" on iOS — the system prints only content it renders itself, PDFs and
  // images — so the file goes through HTML instead: straight to the print dialog,
  // or into a PDF that the share sheet can print, mail or save.
  // Rendering a long file takes seconds with no dialog on screen yet; a second tap
  // would stack print dialogs or overwrite the PDF the first share is still reading.
  const exporting = useRef(false);
  const exportPreview = useCallback(
    (file: { path: string; content: string }, mode: 'print' | 'pdf') => {
      if (exporting.current) return;
      exporting.current = true;
      void (async () => {
        try {
          const print = await loadPrintModule();
          if (print === undefined) throw new Error('Printing is not available in this build');
          const html = printableFileHtml(file.path, file.content);
          if (mode === 'print') {
            try {
              await print.printAsync({ html, margins: PRINT_MARGINS });
            } catch (err) {
              // iOS rejects a print dialog the operator simply dismissed.
              if (err instanceof Error && /did not complete/i.test(err.message)) return;
              throw err;
            }
            return;
          }
          const rendered = await print.printToFileAsync({ html, margins: PRINT_MARGINS });
          const cacheDir = new FsDirectory(
            Paths.cache,
            cacheDirectoryName(sourceRef.current.cacheKey, `${file.path}.pdf`),
          );
          cacheDir.create({ idempotent: true, intermediates: true });
          const pdf = new FsFile(cacheDir, pdfFileName(file.path));
          await new FsFile(rendered.uri).move(pdf, { overwrite: true });
          const sharing = await loadSharingModule();
          if (sharing === undefined || !(await sharing.isAvailableAsync())) {
            throw new Error('No app is available to share this PDF');
          }
          await sharing.shareAsync(pdf.uri, {
            mimeType: 'application/pdf',
            UTI: 'com.adobe.pdf',
            dialogTitle: `Share ${pdfFileName(file.path)}`,
          });
        } catch (err) {
          Alert.alert(
            mode === 'print' ? 'Could not print file' : 'Could not create PDF',
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          exporting.current = false;
        }
      })();
    },
    [],
  );

  const chooseExport = useCallback(
    (file: { path: string; content: string }) => {
      Alert.alert(fileNameFromPath(file.path), undefined, [
        { text: 'Print', onPress: () => exportPreview(file, 'print') },
        { text: 'Share as PDF', onPress: () => exportPreview(file, 'pdf') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [exportPreview],
  );

  return { openWith, chooseExport };
}
