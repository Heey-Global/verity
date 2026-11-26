import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredLiveAudioTranscription } from './live-audio-transcription.js';
import type { MeetingTranscriptionSettings } from './meeting-transcription.js';

const settings: MeetingTranscriptionSettings = {
  transcribeBackendMode: 'external',
  transcribeBaseUrl: 'https://speech.example.test/private/v1/',
  transcribeApiKey: 'test-token',
  transcribeModel: 'my-whisper',
};

afterEach(() => vi.unstubAllGlobals());

describe('live audio transcription', () => {
  it('sends WAV to the configured endpoint with its model and token', async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.toString()).toBe('https://speech.example.test/private/v1/audio/transcriptions');
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer test-token' },
      });
      const form = init.body as FormData;
      expect(form.get('model')).toBe('my-whisper');
      expect(form.get('language')).toBeNull();
      const audio = form.get('file') as File;
      expect(audio.type).toBe('audio/wav');
      const bytes = Buffer.from(await audio.arrayBuffer());
      expect(bytes.length === 3 ? bytes.toString() : bytes.toString('ascii', 0, 4)).toMatch(
        /^(WAV|RIFF)$/u,
      );
      return Response.json({ text: '  Hallo and welcome  ' });
    });
    vi.stubGlobal('fetch', request);
    const transcriber = configuredLiveAudioTranscription(async () => settings);
    await transcriber.checkAudioTranscription();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      transcriber.transcribeAudio(Buffer.from('WAV'), new AbortController().signal),
    ).resolves.toBe('Hallo and welcome');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails before sending audio when the stored endpoint or model is absent', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const transcriber = configuredLiveAudioTranscription(async () => ({
      ...settings,
      transcribeModel: null,
    }));
    await expect(transcriber.checkAudioTranscription()).rejects.toThrow('not configured');
    await expect(
      transcriber.transcribeAudio(Buffer.from('WAV'), new AbortController().signal),
    ).rejects.toThrow('not configured');
    expect(request).not.toHaveBeenCalled();
  });

  it('returns silence as empty text and rejects oversized output', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ text: '' }))
      .mockResolvedValueOnce(Response.json({ text: 'x'.repeat(128 * 1024) }));
    vi.stubGlobal('fetch', request);
    const transcriber = configuredLiveAudioTranscription(async () => settings);
    const signal = new AbortController().signal;
    await expect(transcriber.transcribeAudio(Buffer.from('WAV'), signal)).resolves.toBe('');
    await expect(transcriber.transcribeAudio(Buffer.from('WAV'), signal)).rejects.toThrow(
      'meeting transcription failed',
    );
  });
});
