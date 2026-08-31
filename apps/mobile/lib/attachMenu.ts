// Row model for the composer's attach ("+") menu. Kept out of `app/` as pure
// data — no Unistyles StyleSheet, no component imports — so the row set, and in
// particular which entry points are feature-flagged in or out, can be unit
// tested without rendering the whole session screen.
import type { IconName } from '../components/Icon';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

export type AttachMenuRow =
  { divider: true } | { icon: IconName; label: string; onPress: () => void };

export interface AttachMenuHandlers {
  onCapturePhoto: () => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickMeetingAudio: () => void;
  onPickGoogleDrive: () => void;
}

/**
 * Two groups separated by a divider: transient per-turn attachments (photo /
 * file) above, and durable "write into the repo" actions (meeting transcript,
 * Google Drive import → docs/) below. The divider makes the two kinds legible
 * instead of one long undifferentiated list.
 *
 * `meetingAudioEnabled` defaults to the build-time flag; callers pass it only in
 * tests.
 */
export function attachMenuRows(
  handlers: AttachMenuHandlers,
  { meetingAudioEnabled = MEETING_AUDIO_ENABLED }: { meetingAudioEnabled?: boolean } = {},
): AttachMenuRow[] {
  return [
    { icon: 'camera', label: 'Take photo', onPress: handlers.onCapturePhoto },
    { icon: 'image', label: 'Choose photo', onPress: handlers.onPickPhotos },
    { icon: 'file', label: 'Choose file', onPress: handlers.onPickFiles },
    { divider: true },
    ...(meetingAudioEnabled
      ? [{ icon: 'mic' as IconName, label: 'Meeting audio', onPress: handlers.onPickMeetingAudio }]
      : []),
    { icon: 'cloud', label: 'Google Drive', onPress: handlers.onPickGoogleDrive },
  ];
}
