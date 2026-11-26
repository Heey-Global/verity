import { createHash } from 'node:crypto';
import {
  MeetingTranscriberUnavailableError,
  MeetingTranscriptionCancelledError,
  MeetingTranscriptionFailedError,
  type MeetingTranscriptionSettings,
} from './meeting-transcription.js';
import { effectiveExternalTranscription } from './server-support.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export function configuredLiveAudioTranscription(
  readSettings: () => Promise<MeetingTranscriptionSettings | undefined>,
) {
  async function configuration() {
    const settings = await readSettings();
    const { baseUrl, model } = effectiveExternalTranscription(settings);
    if (settings?.transcribeBackendMode === 'local' || !baseUrl || !model) {
      throw new MeetingTranscriberUnavailableError();
    }
    let endpoint: URL;
    try {
      endpoint = new URL(baseUrl);
    } catch {
      throw new MeetingTranscriberUnavailableError();
    }
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new MeetingTranscriberUnavailableError();
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/audio/transcriptions';
    const target = createHash('sha256').update(endpoint.href).digest('hex');
    return { endpoint, model, token: settings?.transcribeApiKey?.trim(), target };
  }

  return {
    async checkAudioTranscription(): Promise<string> {
      return (await configuration()).target;
    },
    async transcribeAudio(
      wav: Buffer,
      signal: AbortSignal,
      expectedTarget?: string,
    ): Promise<string> {
      const { endpoint, model, token, target } = await configuration();
      if (expectedTarget !== undefined && target !== expectedTarget)
        throw new MeetingTranscriberUnavailableError();
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'meeting.wav');
      form.set('model', model);
      form.set('response_format', 'json');
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          body: form,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new MeetingTranscriptionFailedError();
        }
        const text = await readResponse(response);
        const result: unknown = JSON.parse(text);
        if (
          typeof result !== 'object' ||
          result === null ||
          !('text' in result) ||
          typeof result.text !== 'string'
        ) {
          throw new MeetingTranscriptionFailedError();
        }
        return result.text.trim();
      } catch {
        if (signal.aborted) throw new MeetingTranscriptionCancelledError();
        throw new MeetingTranscriptionFailedError();
      }
    },
  };
}

async function readResponse(response: Response): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new MeetingTranscriptionFailedError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new MeetingTranscriptionFailedError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
