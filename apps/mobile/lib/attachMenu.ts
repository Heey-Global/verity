// Row model for the composer's attach ("+") menu. Kept out of `app/` as pure
// data — no Unistyles StyleSheet, no component imports — so the row set, and in
// particular which entry points are feature-flagged in or out, can be unit
// tested without rendering the whole session screen.
import type { IconName } from '../components/Icon';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

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

/**
 * The menu groups actions by what they do. Content sources can feed the current
 * conversation and Project Knowledge, while connected services grant the
 * current session access to an external account.
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
    { divider: true },
    { section: 'Connect' },
    {
      icon: 'mail',
      label: 'Gmail',
      detail: 'Read & draft',
      onPress: handlers.onConnectGmail,
    },
    {
      icon: 'calendar',
      label: 'Google Calendar',
      detail: 'Read & approve changes',
      onPress: handlers.onConnectCalendar,
    },
    {
      icon: 'users',
      label: 'Google Contacts',
      detail: 'Read names & emails',
      onPress: handlers.onConnectContacts,
    },
  ];
}
