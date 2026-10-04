// Row model for the composer's attach ("+") menu. Kept out of `app/` as pure
// data — no Unistyles StyleSheet, no component imports — so the row set, and in
// particular which entry points are feature-flagged in or out, can be unit
// tested without rendering the whole session screen.
import type { IconName } from '../components/Icon';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

export type AttachAnchor = { x: number; y: number; width: number; height: number };

export type AttachMenuRow =
  | { section: string }
  | { divider: true }
  | { icon: IconName; label: string; detail?: string; onPress: () => void };

export interface AttachMenuHandlers {
  onCapturePhoto: () => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickMeetingAudio: () => void;
  onLiveMeeting: () => void;
  onConnectGmail: () => void;
  onConnectCalendar: () => void;
  onConnectContacts: () => void;
}

/** Google shortcuts require a centrally connected account. */
export function attachMenuRows(
  handlers: AttachMenuHandlers,
  {
    meetingAudioEnabled = MEETING_AUDIO_ENABLED,
    googleConnected = false,
  }: { meetingAudioEnabled?: boolean; googleConnected?: boolean } = {},
): AttachMenuRow[] {
  return [
    { icon: 'camera', label: 'Take photo', onPress: handlers.onCapturePhoto },
    { icon: 'image', label: 'Choose photo', onPress: handlers.onPickPhotos },
    { icon: 'file', label: 'Choose file', onPress: handlers.onPickFiles },
    ...(meetingAudioEnabled
      ? [
          { divider: true } as const,
          {
            icon: 'mic' as IconName,
            label: 'Transcribe audio file',
            onPress: handlers.onPickMeetingAudio,
          },
          { icon: 'mic' as IconName, label: 'Live Meeting', onPress: handlers.onLiveMeeting },
        ]
      : []),
    ...(googleConnected
      ? [
          { divider: true } as const,
          { section: 'Connect' },
          {
            icon: 'mail' as IconName,
            label: 'Gmail',
            detail: 'Read & draft',
            onPress: handlers.onConnectGmail,
          },
          {
            icon: 'calendar' as IconName,
            label: 'Google Calendar',
            detail: 'Read & approve changes',
            onPress: handlers.onConnectCalendar,
          },
          {
            icon: 'users' as IconName,
            label: 'Google Contacts',
            detail: 'Read names & emails',
            onPress: handlers.onConnectContacts,
          },
        ]
      : []),
  ];
}
