import type { GmailSessionConnection } from '@verity/mobile';
// Row model for the composer's attach ("+") menu. Kept out of `app/` as pure
// data — no Unistyles StyleSheet, no component imports — so the row set, and in
// particular which entry points are feature-flagged in or out, can be unit
// tested without rendering the whole session screen.
import type { IconName } from '../components/Icon';
import { MEETING_AUDIO_ENABLED } from './featureFlags';
import type { GoogleService } from './sessionGoogleAccess';

export type AttachAnchor = { x: number; y: number; width: number; height: number };

export type AttachMenuRow =
  | { divider: true }
  | { icon: IconName; label: string; detail?: string; navigates?: boolean; onPress: () => void };

export interface AttachMenuHandlers {
  onCapturePhoto: () => void;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onPickMeetingAudio: () => void;
  onLiveMeeting: () => void;
  onOpenConnectors: () => void;
}

export type { GoogleService };
export type GoogleMenuAccess = Partial<Record<GoogleService, GmailSessionConnection | null>>;

export const CONNECTORS: readonly { service: GoogleService; label: string; icon: IconName }[] = [
  { service: 'gmail', label: 'Gmail', icon: 'mail' },
  { service: 'calendar', label: 'Google Calendar', icon: 'calendar' },
  { service: 'contacts', label: 'Google Contacts', icon: 'users' },
];

/** How one connector stands in this chat, as its row in the Connectors list shows it. */
export function connectorState(connection: GmailSessionConnection | null | undefined): {
  on: boolean;
  /** Granted for the whole project: switched in Project settings, not here. */
  locked: boolean;
  detail: string;
} {
  if (connection?.enabled) {
    const project = connection.source === 'project';
    const scope = project ? 'Project access' : 'This chat';
    return {
      on: true,
      locked: project,
      detail: connection.accountEmail ? `${scope} · ${connection.accountEmail}` : scope,
    };
  }
  return { on: false, locked: false, detail: 'Off' };
}

/** The Connectors row's one-line summary: which connectors this chat may use. */
export function connectorsSummary(access: GoogleMenuAccess): string {
  const on = CONNECTORS.filter(({ service }) => access[service]?.enabled === true);
  if (on.length === 0) return 'None for this chat';
  if (on.length > 1) return on.map(({ label }) => label.replace(/^Google /, '')).join(' · ');
  const [only] = on;
  const project = access[only.service]?.source === 'project';
  return `${only.label} · ${project ? 'Project access' : 'This chat'}`;
}

/**
 * The rows under the recent-image strip. Where the strip shows (native), its
 * camera tile replaces "Take photo"; Connectors require a centrally connected
 * Google account.
 */
export function attachMenuRows(
  handlers: AttachMenuHandlers,
  {
    meetingAudioEnabled = MEETING_AUDIO_ENABLED,
    recentStrip = false,
    googleConnected = false,
    googleAccess = {},
  }: {
    meetingAudioEnabled?: boolean;
    recentStrip?: boolean;
    googleConnected?: boolean;
    googleAccess?: GoogleMenuAccess;
  } = {},
): AttachMenuRow[] {
  return [
    ...(recentStrip
      ? []
      : [{ icon: 'camera' as IconName, label: 'Take photo', onPress: handlers.onCapturePhoto }]),
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
          {
            icon: 'link' as IconName,
            label: 'Connectors',
            detail: connectorsSummary(googleAccess),
            navigates: true,
            onPress: handlers.onOpenConnectors,
          },
        ]
      : []),
  ];
}
