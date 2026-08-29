import type { MeetingTranscriptUpload, Message } from '@verity/mobile';

// Upload readiness moved into @verity/mobile so it shares one definition of "is
// a backend configured" with the Settings pill — the two disagreed, and a screen
// that reports the backend ready while the upload flow sends the operator back
// to Settings to configure it is the same lie told twice. Re-exported here
// because this module remains the app's door to the meeting-upload helpers.
export { meetingTranscriptionReadiness, type MeetingTranscriptionReadiness } from '@verity/mobile';

/** Decide whether a first-use choice can continue an already staged upload
 * immediately or still needs the external service fields from Settings. */
export function pendingUploadActionAfterBackendChoice(
  mode: 'local' | 'external',
  externalConfigured: boolean,
): 'resume' | 'configure-external' {
  return mode === 'external' && !externalConfigured ? 'configure-external' : 'resume';
}

export function meetingAudioRequestText(fileName: string): string {
  return `Please transcribe meeting audio:\n${fileName}`;
}

/** Match only the canonical notice for this upload, never an older upload that
 * happened to use the same filename. */
export function isMeetingRequestConfirmed(
  messages: readonly Message[],
  requestId: string,
): boolean {
  return messages.some((message) => message.kind === 'user-text' && message.localId === requestId);
}

/** Keep the local progress row only until its canonical request notice arrives. */
export function shouldShowLocalMeetingUpload(
  messages: readonly Message[],
  requestId: string,
): boolean {
  return !isMeetingRequestConfirmed(messages, requestId);
}

export interface PendingMeetingUpload {
  upload: MeetingTranscriptUpload;
  followUpPrompt?: string;
  transcriptUploaded?: boolean;
}

const pendingMeetingUploads = new Map<string, PendingMeetingUpload>();

export function setPendingMeetingUpload(sessionId: string, pending: PendingMeetingUpload): void {
  pendingMeetingUploads.set(sessionId, pending);
}

export function claimPendingMeetingUpload(sessionId: string): PendingMeetingUpload | undefined {
  const pending = pendingMeetingUploads.get(sessionId);
  pendingMeetingUploads.delete(sessionId);
  return pending;
}

export function restorePendingMeetingUpload(
  sessionId: string,
  pending: PendingMeetingUpload,
): void {
  pendingMeetingUploads.set(sessionId, pending);
}
