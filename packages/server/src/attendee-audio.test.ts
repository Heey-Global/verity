import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ATTENDEE_AUDIO_PATH, AttendeeAudioReceiver } from './attendee-audio.js';

const timestampMs = 1_770_000_000_000;
const pcm = Buffer.alloc(320, 1);

function frame({
  botId = 'bot_test',
  time = timestampMs,
  participantId,
  audio = pcm,
}: {
  botId?: string;
  time?: number;
  participantId?: string;
  audio?: Buffer;
} = {}): string {
  return JSON.stringify({
    bot_id: botId,
    trigger: participantId ? 'realtime_audio.per_participant' : 'realtime_audio.mixed',
    data: {
      chunk: audio.toString('base64'),
      sample_rate: 16_000,
      timestamp_ms: time,
      ...(participantId ? { participant_uuid: participantId } : {}),
    },
  });
}

describe('Attendee audio receiver', () => {
  const receivers: AttendeeAudioReceiver[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    for (const receiver of receivers.splice(0)) await receiver.close();
  });

  async function start(botId: () => string | undefined = () => 'bot_test') {
    const transcribe = vi.fn<ConstructorParameters<typeof AttendeeAudioReceiver>[0]['transcribe']>(
      async () => {},
    );
    const onGap = vi.fn();
    const receiver = new AttendeeAudioReceiver({ token: 'test-token', botId, transcribe, onGap });
    receivers.push(receiver);
    const url = `ws://127.0.0.1:${await receiver.listen()}${ATTENDEE_AUDIO_PATH}`;
    return { receiver, url, transcribe, onGap };
  }

  async function connect(url: string): Promise<WebSocket> {
    const client = new WebSocket(url + '?token=test-token');
    clients.push(client);
    await once(client, 'open');
    return client;
  }

  it('rejects a socket with an invalid channel token and ignores frames for a different bot', async () => {
    const { url, transcribe, onGap } = await start();
    const unauthorized = new WebSocket(url + '?token=wrong');
    clients.push(unauthorized);
    await expect(once(unauthorized, 'open')).rejects.toThrow('403');

    const client = await connect(url);
    client.send(frame({ botId: 'bot_other' }));
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledWith('invalid_audio'));
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('converts ordered participant audio to WAV after binding it to the bot', async () => {
    const binding: { botId?: string } = {};
    const { receiver, url, transcribe, onGap } = await start(() => binding.botId);
    const client = await connect(url);
    client.send(frame({ participantId: 'speaker' }));
    const pong = once(client, 'pong');
    client.ping();
    await pong;
    expect(transcribe).not.toHaveBeenCalled();
    binding.botId = 'bot_test';
    client.send(frame({ participantId: 'speaker' }));

    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(transcribe).toHaveBeenCalledWith({
      wav: expect.any(Buffer),
      timestampMs,
      participantId: 'speaker',
      signal: expect.any(AbortSignal),
    });
    const wav = transcribe.mock.calls[0]?.[0].wav;
    expect(wav?.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav?.readUInt32LE(24)).toBe(16_000);
    expect(wav?.subarray(44)).toEqual(Buffer.concat([pcm, pcm]));
    const disconnected = once(client, 'close');
    client.close(1000);
    await disconnected;
    await receiver.finish();
    expect(onGap).not.toHaveBeenCalled();
  });

  it('reports queued audio gaps and cancels work on shutdown', async () => {
    const { receiver, url, transcribe, onGap } = await start();
    transcribe.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    );
    const client = await connect(url);
    for (let i = 0; i < 12; i++) client.send(frame({ time: timestampMs + i * 500 }));
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledWith('overloaded'));
    expect(transcribe).toHaveBeenCalledTimes(1);
    await receiver.close();
    expect(transcribe.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('reports interruption and accepts a reconnect to the same meeting', async () => {
    const { receiver, url, transcribe, onGap } = await start();
    const first = await connect(url);
    first.terminate();
    await vi.waitFor(() => expect(onGap).toHaveBeenCalledWith('interrupted'));
    const second = await connect(url);
    second.send(frame());
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await receiver.finish();
    expect(onGap).toHaveBeenCalledTimes(1);
  });
});
