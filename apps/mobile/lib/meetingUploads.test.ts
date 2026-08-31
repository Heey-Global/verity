import type { Message } from '@verity/mobile';

import {
  isMeetingRequestConfirmed,
  meetingAudioRequestText,
  meetingTranscriptionReadiness,
  pendingUploadActionAfterBackendChoice,
  shouldShowLocalMeetingUpload,
} from './meetingUploads';

function request(localId: string, fileName: string): Message {
  return {
    kind: 'user-text',
    id: `notice-${localId}`,
    localId,
    createdAt: 1,
    text: meetingAudioRequestText(fileName),
  };
}

describe('meeting upload request reconciliation', () => {
  it('matches the canonical notice by request id', () => {
    expect(isMeetingRequestConfirmed([request('upload-1', 'meeting.mp3')], 'upload-1')).toBe(true);
  });

  it('does not confuse repeated filenames or concurrent uploads', () => {
    const messages = [request('upload-1', 'meeting.mp3')];
    expect(isMeetingRequestConfirmed(messages, 'upload-2')).toBe(false);
  });

  it('removes local upload progress as soon as the canonical request bubble arrives', () => {
    expect(shouldShowLocalMeetingUpload([], 'upload-1')).toBe(true);
    expect(shouldShowLocalMeetingUpload([request('upload-1', 'meeting.mp3')], 'upload-1')).toBe(
      false,
    );
  });
});

describe('meeting transcription backend readiness', () => {
  const settings = {
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeApiKeyConfigured: false,
    transcribeBackendMode: null,
    transcribeLocalAvailable: true,
  } as Parameters<typeof meetingTranscriptionReadiness>[0];

  it('requires an explicit first-use choice', () => {
    expect(meetingTranscriptionReadiness(settings)).toEqual({
      state: 'choose',
      localAvailable: true,
      externalConfigured: false,
    });
  });

  it('allows local only when this deployment exposes the sidecar', () => {
    expect(meetingTranscriptionReadiness({ ...settings, transcribeBackendMode: 'local' })).toEqual({
      state: 'ready',
      mode: 'local',
    });
    expect(
      meetingTranscriptionReadiness({
        ...settings,
        transcribeBackendMode: 'local',
        transcribeLocalAvailable: false,
      }),
    ).toEqual({ state: 'local-unavailable' });
  });

  it('requires URL and model while allowing endpoints without authentication', () => {
    expect(
      meetingTranscriptionReadiness({ ...settings, transcribeBackendMode: 'external' }),
    ).toEqual({ state: 'external-incomplete' });
    expect(
      meetingTranscriptionReadiness({
        ...settings,
        transcribeBackendMode: 'external',
        transcribeBaseUrl: 'https://api.example.test/v1',
        transcribeModel: 'whisper-test',
      }),
    ).toEqual({ state: 'ready', mode: 'external' });
  });

  it('resumes a pending upload immediately after a usable first-use choice', () => {
    expect(pendingUploadActionAfterBackendChoice('local', false)).toBe('resume');
    expect(pendingUploadActionAfterBackendChoice('external', true)).toBe('resume');
    expect(pendingUploadActionAfterBackendChoice('external', false)).toBe('configure-external');
  });
});
