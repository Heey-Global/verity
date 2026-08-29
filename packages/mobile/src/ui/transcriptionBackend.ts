import type { VeritySettings, MeetingTranscriptionBackendStatus } from '../api.js';

/**
 * How the Settings screen's meeting-transcription section reports the stored
 * backend choice.
 *
 * The decision lives here rather than in the screen because "which backend
 * counts as set up" is a contract with the server, not a rendering detail, and
 * it takes TWO facts to answer:
 *
 * - The chosen mode. Verity bundles no local speech-to-text backend any more, so
 *   `local` names a backend no deployment can run. Store migration
 *   `0083_drop_local_transcribe_backend_mode` clears that preference and the
 *   server refuses to store it again, but an app can still be talking to a
 *   server that has not restarted into the new schema.
 * - Whether that backend is actually reachable. `external` on its own promises
 *   nothing: without something to send the audio to, the server rejects the
 *   upload as unconfigured.
 *
 * A mode nobody can satisfy must never read as ready, in either direction. That
 * is why readiness takes `transcribeExternalConfigured` — the server's own
 * verdict, from the same facts the upload path enforces — rather than the URL
 * and model fields. Those are null both on a deployment that configures the
 * endpoint through its environment and on one that supplies its own transcriber
 * command, and both of those transcribe perfectly well.
 */
export type TranscriptionBackendMode = VeritySettings['transcribeBackendMode'];

export interface TranscriptionBackendStatus {
  /** `ready` only for a backend this deployment can actually reach. */
  readonly intent: 'ready' | 'needsSetup';
  /** Pill text: what the operator is looking at, or what is missing. */
  readonly label: string;
}

export function transcriptionBackendStatus(
  mode: TranscriptionBackendMode,
  externalConfigured: boolean,
): TranscriptionBackendStatus {
  if (mode === 'external') {
    // Chosen but unreachable is its own state, and naming what is missing is the
    // whole point: the operator is looking at the two empty fields that fix it.
    return externalConfigured
      ? { intent: 'ready', label: 'External' }
      : { intent: 'needsSetup', label: 'Add URL and model' };
  }
  // A leftover `local` is NOT "no choice yet" — saying so would hide that the
  // stored preference is why transcription refuses to run. Name it, and keep the
  // section in its needs-setup state until a reachable backend is picked.
  if (mode === 'local') return { intent: 'needsSetup', label: 'Local unavailable' };
  return { intent: 'needsSetup', label: 'Choose backend' };
}

/** The only states an upload may start from, or what stands in the way. */
export type MeetingTranscriptionReadiness =
  | { state: 'choose'; localAvailable: boolean; externalConfigured: boolean }
  | { state: 'ready'; mode: 'local' | 'external' }
  | { state: 'local-unavailable' }
  | { state: 'external-incomplete' };

/**
 * Translate the transcription status into whether a recording may be uploaded.
 * Shares `externalTranscriptionConfigured` with the Settings pill on purpose: a
 * screen that calls the backend ready while the upload flow sends the operator
 * back to Settings to configure it is the same lie told twice. Null mode is
 * intentionally never treated as the legacy fallback in the app: it triggers the
 * one-time explicit chooser.
 */
export function meetingTranscriptionReadiness(
  settings: MeetingTranscriptionBackendStatus,
): MeetingTranscriptionReadiness {
  const externalConfigured = externalTranscriptionConfigured(settings);
  if (settings?.transcribeBackendMode === 'local') {
    return settings.transcribeLocalAvailable
      ? { state: 'ready', mode: 'local' }
      : { state: 'local-unavailable' };
  }
  if (settings?.transcribeBackendMode === 'external') {
    return externalConfigured
      ? { state: 'ready', mode: 'external' }
      : { state: 'external-incomplete' };
  }
  return {
    state: 'choose',
    localAvailable: settings?.transcribeLocalAvailable === true,
    externalConfigured,
  };
}

/**
 * Whether meeting audio has anywhere to go, according to the server. The URL and
 * model fallback covers a server that predates `transcribeExternalConfigured`
 * (which then defaults to false): those two are what such a server would have
 * required anyway, so behaviour against it is unchanged.
 */
export function externalTranscriptionConfigured(
  settings: MeetingTranscriptionBackendStatus,
): boolean {
  if (settings?.transcribeExternalConfigured === true) return true;
  return Boolean(settings?.transcribeBaseUrl?.trim() && settings.transcribeModel?.trim());
}
