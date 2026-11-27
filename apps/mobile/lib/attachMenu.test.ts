import type { GmailSessionConnection } from '@verity/mobile';
import {
  attachMenuRows,
  type AttachMenuRow,
  CONNECTORS,
  connectorState,
  connectorsSummary,
} from './attachMenu';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

const handlers = {
  onCapturePhoto: jest.fn(),
  onPickPhotos: jest.fn(),
  onPickFiles: jest.fn(),
  onPickMeetingAudio: jest.fn(),
  onLiveMeeting: jest.fn(),
  onOpenConnectors: jest.fn(),
};

function labels(rows: AttachMenuRow[]): string[] {
  return rows.map((row) => ('divider' in row ? '—' : row.label));
}

const connection = (patch: Partial<GmailSessionConnection>): GmailSessionConnection => ({
  enabled: true,
  accountEmail: 'alex@example.com',
  clientId: null,
  connected: true,
  source: 'session',
  mode: 'account',
  ...patch,
});

beforeEach(() => jest.clearAllMocks());

describe('attachMenuRows', () => {
  it('folds the Google services into one Connectors row', () => {
    const rows = attachMenuRows(handlers, {
      meetingAudioEnabled: true,
      recentStrip: true,
      showConnectors: true,
    });
    expect(labels(rows)).toEqual([
      'Choose photo',
      'Choose file',
      '—',
      'Transcribe audio file',
      'Live Meeting',
      '—',
      'Connectors',
    ]);
    // Every connector lives behind that row, none beside it.
    for (const { label } of CONNECTORS) expect(labels(rows)).not.toContain(label);
    const connectors = rows.find((row) => 'label' in row && row.label === 'Connectors');
    expect(connectors).toMatchObject({ icon: 'link', navigates: true });
    if (connectors && 'onPress' in connectors) connectors.onPress();
    expect(handlers.onOpenConnectors).toHaveBeenCalledTimes(1);
  });

  // The strip's camera tile takes photos where the strip exists; a platform
  // without it (web) would otherwise lose the camera entirely.
  it('keeps Take photo only where there is no recent strip', () => {
    expect(labels(attachMenuRows(handlers, { meetingAudioEnabled: false }))).toEqual([
      'Take photo',
      'Choose photo',
      'Choose file',
    ]);
    expect(
      labels(attachMenuRows(handlers, { meetingAudioEnabled: false, recentStrip: true })),
    ).not.toContain('Take photo');
  });

  it('routes the meeting-audio row to the upload handler', () => {
    const row = attachMenuRows(handlers, { meetingAudioEnabled: true }).find(
      (candidate): candidate is Extract<AttachMenuRow, { label: string }> =>
        'label' in candidate && candidate.label === 'Transcribe audio file',
    );
    expect(row?.icon).toBe('mic');
    row?.onPress();
    expect(handlers.onPickMeetingAudio).toHaveBeenCalledTimes(1);
  });

  it('is reachable in this build — meeting audio ships enabled', () => {
    expect(MEETING_AUDIO_ENABLED).toBe(true);
    expect(labels(attachMenuRows(handlers))).toContain('Transcribe audio file');
  });

  it('hides Connectors without a central Google account', () => {
    expect(labels(attachMenuRows(handlers, { showConnectors: false }))).not.toContain('Connectors');
  });
});

describe('connectorsSummary', () => {
  it('names the one connector on and where its access comes from', () => {
    expect(connectorsSummary({ gmail: connection({}) })).toBe('Gmail · This chat');
    expect(connectorsSummary({ calendar: connection({ source: 'project' }) })).toBe(
      'Google Calendar · Project access',
    );
  });

  it('lists several connectors by their short names', () => {
    expect(
      connectorsSummary({
        gmail: connection({}),
        calendar: connection({ source: 'project' }),
        contacts: connection({ enabled: false }),
      }),
    ).toBe('Gmail · Calendar');
  });

  it('says so when none is on', () => {
    expect(connectorsSummary({})).toBe('None for this chat');
    expect(connectorsSummary({ gmail: connection({ enabled: false }) })).toBe('None for this chat');
  });
});

describe('connectorState', () => {
  it('locks a project grant, since this chat cannot switch it off', () => {
    expect(connectorState(connection({ source: 'project' }))).toEqual({
      on: true,
      locked: true,
      detail: 'Project access · alex@example.com',
    });
  });

  it('lets this chat switch its own access', () => {
    expect(connectorState(connection({}))).toEqual({
      on: true,
      locked: false,
      detail: 'This chat · alex@example.com',
    });
    expect(connectorState(null)).toEqual({ on: false, locked: false, detail: 'Off' });
    expect(connectorState(connection({ enabled: false, mode: 'disabled' })).on).toBe(false);
  });
});
