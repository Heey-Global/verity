import type { GmailSessionConnection } from '@verity/mobile';
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

export type GoogleMenuAccess = Partial<
  Record<'gmail' | 'calendar' | 'contacts', GmailSessionConnection | null>
>;
function googleDetail(connection: GmailSessionConnection | null | undefined, fallback: string) {
  if (connection?.enabled)
    return `${connection.source === 'project' ? 'Project access' : 'This chat'} · ${connection.accountEmail ?? ''}`;
  return connection?.mode === 'disabled' ? 'Disabled for this chat' : fallback;
}

/** Google shortcuts require a centrally connected account. */
export function attachMenuRows(
  handlers: AttachMenuHandlers,
  {
    meetingAudioEnabled = MEETING_AUDIO_ENABLED,
    googleConnected = false,
    googleAccess = {},
  }: {
    meetingAudioEnabled?: boolean;
    googleConnected?: boolean;
    googleAccess?: GoogleMenuAccess;
  } = {},
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
            detail: googleDetail(googleAccess.gmail, 'Read & draft'),
            onPress: handlers.onConnectGmail,
          },
          {
            icon: 'calendar' as IconName,
            label: 'Google Calendar',
            detail: googleDetail(googleAccess.calendar, 'Read & approve changes'),
            onPress: handlers.onConnectCalendar,
          },
          {
            icon: 'users' as IconName,
            label: 'Google Contacts',
            detail: googleDetail(googleAccess.contacts, 'Read names & emails'),
            onPress: handlers.onConnectContacts,
          },
        ]
      : []),
  ];
}
