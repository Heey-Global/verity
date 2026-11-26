import type { EventStore } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { AttendeeMeetings } from './attendee-meetings.js';

it('routes hosted bot audio through its own Uplink share and finalizes the resulting transcript', async () => {
  const { PreviewEdge, hashPreviewSecret } = await import('@verity/preview-tunnel');
  const { WebSocket } = await import('ws');
  const { AttendeeClient } = await import('./attendee-client.js');
  const rows = new Map<string, unknown>();
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const edges = new Map<string, { close(): Promise<void>; port: number }>();
  const remove = vi.fn(async (id: string) => {
    await edges.get(id)?.close();
    edges.delete(id);
  });
  let createBody: unknown;
  let ended = false;
  const urlString = (input: string | URL | Request) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (urlString(url).endsWith('/leave')) return new Response(null, { status: 204 });
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Missing bot request body');
      createBody = JSON.parse(init.body);
      return Response.json({ id: 'bot_live' });
    }
    return Response.json({ state: ended ? 'ended' : 'joined_not_recording' });
  });
  const transcribeAudio = vi.fn(async () => 'Guten Morgen, let’s look this up.');
  const ingest = vi.fn();
  const service = new AttendeeMeetings({
    store,
    ingest,
    transcribeAudio,
    checkAudioTranscription: async () => undefined,
    client: (key) => new AttendeeClient(key, fetcher),
    edge: {
      remove,
      create: async ({ webhook, pinHash }) => {
        const shareId = webhook ? 'webhook' : 'audio';
        const publicOrigin = `https://${shareId}.example.test`;
        const connectorToken = 'connector';
        const sessionSecret = 'session-secret';
        const edge = new PreviewEdge({
          shareId,
          publicOrigin,
          pinHash,
          connectorTokenHash: hashPreviewSecret(connectorToken),
          sessionSecretHash: hashPreviewSecret(sessionSecret),
          ...(webhook ? { webhookPath: webhook.path } : {}),
        });
        const port = await edge.listen();
        edges.set(shareId, { close: () => edge.close(), port });
        return {
          shareId,
          publicOrigin,
          edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
          connectorToken,
          sessionSecret,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    },
  });
  await service.configure({
    apiKey: 'fixture',
    webhookSecret: Buffer.alloc(32).toString('base64'),
  });
  await service.open();
  let socket: InstanceType<typeof WebSocket> | undefined;
  try {
    const { meetingId } = await service.start(
      'session',
      'https://meet.google.com/abc-defg-hij',
      false,
    );
    expect(createBody).toMatchObject({
      transcription_settings: { enabled: false },
      recording_settings: { format: 'none' },
      websocket_settings: { per_participant_audio: { sample_rate: 16000 } },
    });
    const request = createBody as {
      websocket_settings: { per_participant_audio: { url: string } };
    };
    const url = new URL(request.websocket_settings.per_participant_audio.url);
    expect(url.host).toBe('audio.example.test');
    const port = edges.get('audio')?.port;
    socket = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`);
    await new Promise<void>((resolve, reject) => {
      socket?.once('open', resolve);
      socket?.once('error', reject);
    });
    const pcm = Buffer.alloc(3200);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(1000, offset);
    socket.send(
      JSON.stringify({
        bot_id: 'bot_live',
        trigger: 'realtime_audio.per_participant',
        data: {
          chunk: pcm.toString('base64'),
          sample_rate: 16000,
          timestamp_ms: Date.now(),
          participant_uuid: 'alice',
        },
      }),
    );
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledOnce(), { timeout: 2500 });
    await vi.waitFor(
      () =>
        expect(ingest).toHaveBeenLastCalledWith(
          expect.objectContaining({
            state: 'active',
            transcript: 'Guten Morgen, let’s look this up.',
          }),
        ),
      { timeout: 12_000 },
    );
    ended = true;
    await service.stop('session', meetingId);
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'ended',
        transcript: 'Guten Morgen, let’s look this up.',
        speakerTurns: [expect.objectContaining({ speaker: 0 })],
      }),
    );
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['audio', 'webhook']);
    expect(fetcher.mock.calls.some(([url]) => urlString(url).endsWith('/transcript'))).toBe(false);
  } finally {
    socket?.terminate();
    await service.close();
    await Promise.all([...edges.values()].map((edge) => edge.close()));
  }
}, 20_000);
