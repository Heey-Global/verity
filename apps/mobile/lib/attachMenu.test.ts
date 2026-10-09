import { attachMenuRows, type AttachMenuRow } from './attachMenu';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

const handlers = {
  onCapturePhoto: jest.fn(),
  onPickPhotos: jest.fn(),
  onPickFiles: jest.fn(),
  onPickMeetingAudio: jest.fn(),
  onLiveMeeting: jest.fn(),
  onConnectGmail: jest.fn(),
  onConnectCalendar: jest.fn(),
  onConnectContacts: jest.fn(),
};

function labels(rows: AttachMenuRow[]): string[] {
  return rows.map((row) =>
    'section' in row ? `[${row.section}]` : 'divider' in row ? '—' : row.label,
  );
}

describe('attachMenuRows', () => {
  it('separates content imports from connected services', () => {
    expect(
      labels(attachMenuRows(handlers, { meetingAudioEnabled: true, googleConnected: true })),
    ).toEqual([
      'Take photo',
      'Choose photo',
      'Choose file',
      '—',
      'Transcribe audio file',
      'Live Meeting',
      '—',
      '[Connect]',
      'Gmail',
      'Google Calendar',
      'Google Contacts',
    ]);
    expect(
      attachMenuRows(handlers, { meetingAudioEnabled: true, googleConnected: true }).find(
        (row) => 'label' in row && row.label === 'Gmail',
      ),
    ).toMatchObject({ icon: 'mail', detail: 'Read & draft' });
  });

  it('drops the meeting row when the flag is off', () => {
    expect(
      labels(attachMenuRows(handlers, { meetingAudioEnabled: false, googleConnected: true })),
    ).toEqual([
      'Take photo',
      'Choose photo',
      'Choose file',
      '—',
      '[Connect]',
      'Gmail',
      'Google Calendar',
      'Google Contacts',
    ]);
  });

  it('routes the meeting-audio row to the upload handler', () => {
    const row = attachMenuRows(handlers, { meetingAudioEnabled: true, googleConnected: true }).find(
      (candidate): candidate is Extract<AttachMenuRow, { label: string }> =>
        'label' in candidate && candidate.label === 'Transcribe audio file',
    );
    expect(row?.icon).toBe('mic');
    row?.onPress();
    expect(handlers.onPickMeetingAudio).toHaveBeenCalledTimes(1);
  });

  it('routes Calendar separately from Gmail', () => {
    const row = attachMenuRows(handlers, { googleConnected: true }).find(
      (candidate): candidate is Extract<AttachMenuRow, { label: string }> =>
        'label' in candidate && candidate.label === 'Google Calendar',
    );
    row?.onPress();
    expect(handlers.onConnectCalendar).toHaveBeenCalledTimes(1);
    expect(handlers.onConnectGmail).not.toHaveBeenCalled();
  });

  it('is reachable in this build — meeting audio ships enabled', () => {
    expect(MEETING_AUDIO_ENABLED).toBe(true);
    expect(labels(attachMenuRows(handlers))).toContain('Transcribe audio file');
  });
});

it('hides all Google shortcuts without a central account, including while loading', () => {
  expect(labels(attachMenuRows(handlers, { meetingAudioEnabled: false }))).toEqual([
    'Take photo',
    'Choose photo',
    'Choose file',
  ]);
  expect(labels(attachMenuRows(handlers, { googleConnected: false }))).not.toContain('[Connect]');
});
