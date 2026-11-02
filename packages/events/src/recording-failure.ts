import { z } from 'zod';

// Fixed classifications only: exception messages may contain credentials or peer text.
export const recordingFailureReasonSchema = z.enum([
  'unknown',
  'control_offline',
  'control_closed',
  'control_timeout',
  'control_send_failed',
  'diagnostics_not_available',
  'diagnostics_version_unavailable',
  'diagnostics_selection_mismatch',
  'diagnostics_not_stopped',
  'diagnostics_not_entitled',
  'diagnostics_not_found',
  'diagnostics_conflict',
  'diagnostics_limit_reached',
  'diagnostics_invalid_cursor',
  'invalid_diagnostics_response',
  'invalid_diagnostics_export',
  'diagnostics_export_changed',
  'diagnostics_export_limit',
  'incomplete_diagnostics_export',
  'invalid_diagnostics_hash',
  'invalid_diagnostics_cursor',
  'export_too_large',
]);
export type RecordingFailureReason = z.infer<typeof recordingFailureReasonSchema>;
