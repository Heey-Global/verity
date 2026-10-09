import { type IntegrationSource } from '@verity/mobile';
import { Text, View } from 'react-native';
import { settingsStyles as styles } from './settingsStyles';

const reasons: Record<IntegrationSource['importDiagnostics'][number]['code'], string> = {
  invalid_request: 'The import request is invalid.',
  target_message_not_found: 'The original message for this edit or deletion has not been imported.',
  knowledge_storage_unavailable: 'Knowledge storage is unavailable.',
  source_unavailable: 'The room is unavailable for import.',
  event_predates_activation: 'The event predates the room connection.',
  source_binding_changed: 'The room connection changed during import.',
  invalid_attachment_encoding: 'The attachment encoding is invalid.',
  empty_attachment: 'The attachment is empty.',
  attachment_too_large: 'The attachment exceeds the 50 MiB limit.',
  unauthorized_connector: 'The Matrix connector is not authorized.',
  import_failed: 'Import failed; no verified reason is available.',
  transport_error: 'The connector could not reach the Verity server.',
  media_download_failed: 'The Matrix attachment could not be downloaded or decrypted.',
};

export function MatrixImportErrors({ source }: { source: IntegrationSource }) {
  return (
    <>
      {source.importDiagnosticsTruncated ? (
        <Text style={styles.reproHint} accessibilityRole="alert">
          Import diagnostics incomplete; additional failures may be pending.
        </Text>
      ) : null}
      {(source.importDiagnostics ?? []).map((diagnostic) => (
        <View key={diagnostic.eventId} style={styles.pathContent}>
          <Text style={styles.reproHint} accessibilityRole="alert">
            {source.status === 'paused' ? 'Import pending (room paused)' : 'Import retrying'} ·{' '}
            {reasons[diagnostic.code]}
          </Text>
          <Text style={styles.reproSubtitle} selectable>
            Event: {diagnostic.eventId}
            {diagnostic.httpStatus !== null ? ` · HTTP ${diagnostic.httpStatus}` : ''}
            {` · Attempts: ${diagnostic.attempts}`}
          </Text>
          <Text style={styles.reproSubtitle}>Last attempt: {diagnostic.lastAttemptAt}</Text>
        </View>
      ))}
    </>
  );
}
