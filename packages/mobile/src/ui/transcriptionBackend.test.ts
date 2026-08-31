import { describe, expect, it } from 'vitest';
import type { MeetingTranscriptionBackendStatus } from '../api.js';
import {
  externalTranscriptionConfigured,
  meetingTranscriptionReadiness,
  transcriptionBackendStatus,
} from './transcriptionBackend.js';

describe('transcriptionBackendStatus', () => {
  it('marks a reachable external backend ready', () => {
    expect(transcriptionBackendStatus('external', true)).toEqual({
      intent: 'ready',
      label: 'External',
    });
  });

  it('never reports an external backend without URL and model as ready', () => {
    // Choosing external does not configure it: with no URL/model — neither in
    // the app's settings nor from the deployment environment — the server
    // rejects every upload, so a ready pill would be the same lie the removed
    // local backend used to tell.
    expect(transcriptionBackendStatus('external', false)).toEqual({
      intent: 'needsSetup',
      label: 'Add URL and model',
    });
  });

  it('never reports the removed local backend as ready', () => {
    // An installation upgraded from the bundled sidecar: the stored preference
    // survives until the migration runs, and a screen that treats "some mode is
    // stored" as "set up" shows Local as ready while uploads are rejected.
    expect(transcriptionBackendStatus('local', false)).toEqual({
      intent: 'needsSetup',
      label: 'Local unavailable',
    });
    // Not even a deployment that DOES have a remote backend configured makes the
    // dead choice ready — that backend is not the one the operator picked.
    expect(transcriptionBackendStatus('local', true)).toEqual({
      intent: 'needsSetup',
      label: 'Local unavailable',
    });
  });

  it('asks for a choice when none is stored', () => {
    expect(transcriptionBackendStatus(null, false)).toEqual({
      intent: 'needsSetup',
      label: 'Choose backend',
    });
    // A configured deployment backend still needs the explicit one-time choice
    // the app asks for before it uploads anything.
    expect(transcriptionBackendStatus(null, true)).toEqual({
      intent: 'needsSetup',
      label: 'Choose backend',
    });
  });
});

describe('meeting transcription backend readiness', () => {
  const status = (
    overrides: Partial<MeetingTranscriptionBackendStatus> = {},
  ): MeetingTranscriptionBackendStatus => ({
    transcribeBackendMode: null,
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeApiKeyConfigured: false,
    transcribeLocalAvailable: false,
    transcribeExternalConfigured: false,
    ...overrides,
  });

  it('lets a deployment-supplied transcriber command upload without a URL or model', () => {
    // A custom transcriber command reports no endpoint and still works. The
    // server says so through `transcribeExternalConfigured`; taking the URL and
    // model as proof instead sent this deployment back to Settings forever.
    const custom = status({
      transcribeBackendMode: 'external',
      transcribeExternalConfigured: true,
    });
    expect(externalTranscriptionConfigured(custom)).toBe(true);
    expect(meetingTranscriptionReadiness(custom)).toEqual({ state: 'ready', mode: 'external' });
    // And before the one-time choice, the chooser must offer to continue rather
    // than divert to a setup screen with nothing left to fill in.
    expect(meetingTranscriptionReadiness(status({ transcribeExternalConfigured: true }))).toEqual({
      state: 'choose',
      localAvailable: false,
      externalConfigured: true,
    });
  });

  it('still refuses external mode when nothing can run the recording', () => {
    expect(meetingTranscriptionReadiness(status({ transcribeBackendMode: 'external' }))).toEqual({
      state: 'external-incomplete',
    });
  });

  it('falls back to URL and model against a server without the flag', () => {
    // Version skew: the flag defaults to false there, and those two fields are
    // exactly what such a server required.
    const older = status({
      transcribeBackendMode: 'external',
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeModel: 'whisper-test',
    });
    expect(externalTranscriptionConfigured(older)).toBe(true);
    expect(meetingTranscriptionReadiness(older)).toEqual({ state: 'ready', mode: 'external' });
    expect(
      externalTranscriptionConfigured(status({ transcribeBaseUrl: 'https://api.example.test/v1' })),
    ).toBe(false);
  });

  it('keeps the removed local backend unusable however the deployment is configured', () => {
    expect(
      meetingTranscriptionReadiness(
        status({ transcribeBackendMode: 'local', transcribeExternalConfigured: true }),
      ),
    ).toEqual({ state: 'local-unavailable' });
  });
});
