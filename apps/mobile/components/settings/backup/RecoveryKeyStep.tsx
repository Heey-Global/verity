// The recovery key, shown once: at setup and when a new key replaces the old
// one. Verity keeps no copy, so the operator gets three ways to keep it — copy
// into a password manager, save as a file through the share sheet, or print —
// and no QR code: a second device is just another place to paste or save it.
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { loadPrintModule, loadSharingModule } from '../../../lib/sessionFileUi';
import { Button, Card, SectionHeader, Text } from '../../ui';

const FILE_NAME = 'verity-recovery-key.txt';

export function RecoveryKeyStep({ recoveryKey }: { recoveryKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void Clipboard.setStringAsync(recoveryKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <View style={styles.stack}>
      <SectionHeader title="Recovery key" variant="eyebrow" />
      <Text variant="body" tone="muted">
        You need this key to restore. Verity keeps no copy, so store it somewhere safe, for example
        in your password manager.
      </Text>
      <Card>
        <Text variant="code" selectable accessibilityLabel="Recovery key">
          {recoveryKey}
        </Text>
      </Card>
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            label={copied ? 'Copied' : 'Copy'}
            icon="copy"
            variant="secondary"
            size="compact"
            fullWidth
            onPress={copy}
          />
        </View>
        <View style={styles.action}>
          <Button
            label="Save"
            icon="file"
            variant="secondary"
            size="compact"
            fullWidth
            onPress={() => void saveRecoveryKey(recoveryKey)}
          />
        </View>
        <View style={styles.action}>
          <Button
            label="Print"
            icon="printer"
            variant="secondary"
            size="compact"
            fullWidth
            onPress={() => void printRecoveryKey(recoveryKey)}
          />
        </View>
      </View>
      <Text variant="footnote" tone="faint">
        If you leave before confirming, this key is discarded and you get a new one next time.
      </Text>
    </View>
  );
}

/** Through the share sheet, so "Save to Files" and password managers both work.
 *  The temporary file is removed once the sheet closes. */
async function saveRecoveryKey(recoveryKey: string): Promise<void> {
  const sharing = await loadSharingModule();
  if (sharing === undefined || !(await sharing.isAvailableAsync())) {
    Alert.alert('Saving is not available', 'Copy the key instead.');
    return;
  }
  const file = new File(Paths.cache, FILE_NAME);
  try {
    file.write(`Verity recovery key\n\n${recoveryKey}\n`);
    await sharing.shareAsync(file.uri, {
      mimeType: 'text/plain',
      dialogTitle: 'Save recovery key',
    });
  } catch (error) {
    Alert.alert('Could not save the key', error instanceof Error ? error.message : String(error));
  } finally {
    if (file.exists) file.delete();
  }
}

async function printRecoveryKey(recoveryKey: string): Promise<void> {
  const print = await loadPrintModule();
  if (print === undefined) {
    Alert.alert('Printing is not available', 'Copy or save the key instead.');
    return;
  }
  try {
    await print.printAsync({
      html: `<h2 style="font-family:sans-serif">Verity recovery key</h2><p style="font-family:monospace;font-size:14px;word-break:break-all">${escapeHtml(recoveryKey)}</p>`,
    });
  } catch (error) {
    // iOS rejects a print dialog the operator simply dismissed.
    if (error instanceof Error && /did not complete/i.test(error.message)) return;
    Alert.alert('Could not print the key', error instanceof Error ? error.message : String(error));
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.md },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  action: { flex: 1 },
}));
