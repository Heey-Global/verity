import { attachMenuRows, type AttachMenuRow } from './attachMenu';
import { MEETING_AUDIO_ENABLED } from './featureFlags';

const handlers = {
  onCapturePhoto: jest.fn(),
  onPickPhotos: jest.fn(),
  onPickFiles: jest.fn(),
  onPickMeetingAudio: jest.fn(),
  onPickGoogleDrive: jest.fn(),
};

function labels(rows: AttachMenuRow[]): string[] {
  return rows.map((row) => ('divider' in row ? '—' : row.label));
}

describe('attachMenuRows', () => {
  it('offers meeting audio in the durable group when the flag is on', () => {
    expect(labels(attachMenuRows(handlers, { meetingAudioEnabled: true }))).toEqual([
      'Take photo',
      'Choose photo',
      'Choose file',
      '—',
      'Meeting audio',
      'Google Drive',
    ]);
  });

  it('drops the row but keeps the divider group when the flag is off', () => {
    expect(labels(attachMenuRows(handlers, { meetingAudioEnabled: false }))).toEqual([
      'Take photo',
      'Choose photo',
      'Choose file',
      '—',
      'Google Drive',
    ]);
  });

  it('routes the meeting-audio row to the upload handler', () => {
    const row = attachMenuRows(handlers, { meetingAudioEnabled: true }).find(
      (candidate): candidate is Extract<AttachMenuRow, { label: string }> =>
        'label' in candidate && candidate.label === 'Meeting audio',
    );
    expect(row?.icon).toBe('mic');
    row?.onPress();
    expect(handlers.onPickMeetingAudio).toHaveBeenCalledTimes(1);
  });

  it('is reachable in this build — meeting audio ships enabled', () => {
    expect(MEETING_AUDIO_ENABLED).toBe(true);
    expect(labels(attachMenuRows(handlers))).toContain('Meeting audio');
  });
});
