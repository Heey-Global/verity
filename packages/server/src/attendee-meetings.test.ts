import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { AttendeeMeetings, uplinkStartFailure } from './attendee-meetings.js';
import { UplinkControlClient } from './uplink-control-client.js';
import { PreviewShareRemovalQueuedError } from './preview-share-manager.js';

it('releases a failed preparation so retry cannot remain blocked by a phantom bot', async () => {
  const rows = new Map<string, unknown>();
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const create = vi.fn().mockRejectedValue(new Error('unavailable'));
  const service = new AttendeeMeetings({
    store,
    edge: { create, remove: vi.fn().mockResolvedValue(undefined), isAvailable: () => true },
    ingest: vi.fn(),
  });
  await service.configure({
    apiKey: 'fixture',
    webhookSecret: Buffer.alloc(32).toString('base64'),
  });
  await service.open();
  try {
    await expect(
      service.start('session', 'https://meet.google.com/abc-defg-hij', false),
    ).rejects.toThrow('Check Uplink');
    await expect(
      service.start('session', 'https://meet.google.com/abc-defg-hij', false),
    ).rejects.toThrow('Check Uplink');
    expect(create).toHaveBeenCalledTimes(2);
    const states = [...rows].filter(([id]) => id.startsWith('meeting:')).map(([, state]) => state);
    expect(states).toHaveLength(2);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'ended', credentials: { apiKey: '', webhookSecret: '' } }),
      ]),
    );
  } finally {
    await service.close();
  }
});

it.each([
  { submitted: true, offline: false },
  { submitted: false, offline: false },
  { submitted: true, offline: true },
  { submitted: false, offline: true },
])(
  'recovers restart state before removing the share (submitted: $submitted, offline: $offline)',
  async ({ submitted, offline }) => {
    const rows = new Map<string, unknown>();
    rows.set('meeting:restored', {
      meeting: {
        id: 'restored',
        sessionId: 'session',
        engine: 'attendee',
        startedAt: 1,
        endedAt: null,
        state: 'active',
        transcript: '',
        ownerTokenHash: 'fixture',
        revision: 0,
      },
      ...(submitted ? { botId: 'bot' } : {}),
      binding: { shareId: 'share' },
      pin: 'fixture',
      credentials: { apiKey: 'fixture', webhookSecret: 'fixture' },
      identities: {},
      phase: 'running',
      stopRequested: false,
      listenForVerity: false,
      spokenThrough: -1,
    });
    const queued = new Set<string>();
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
      },
      listAttendeeState: async () =>
        [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
      addPendingUplinkShareRemoval: async (id: string) => {
        queued.add(id);
      },
    } as unknown as EventStore;
    const uplink = new UplinkControlClient({
      url: 'wss://uplink.example.test/control',
      store,
      serverVersion: 'test',
    });
    const ingest = vi.fn();
    const remove = vi.fn(async () => {
      if (submitted)
        expect(ingest).toHaveBeenCalledWith(
          expect.objectContaining({ transcript: submitted ? 'final text' : '', state: 'ended' }),
        );
      if (offline) await uplink.remove('share');
    });
    const service = new AttendeeMeetings({
      store,
      ingest,
      edge: { create: vi.fn(), remove, isAvailable: () => true },
      client: () =>
        ({
          request: async () => ({ state: 'ended' }),
          transcript: async () => [
            {
              speaker_uuid: 'alice',
              speaker_name: 'Alice',
              timestamp_ms: 1000,
              duration_ms: 500,
              transcription: { transcript: 'final text' },
            },
          ],
        }) as unknown as import('./attendee-client.js').AttendeeClient,
    });
    await service.open();
    try {
      await vi.waitFor(() =>
        expect(rows.get('meeting:restored')).toMatchObject({
          phase: 'ended',
          credentials: { apiKey: '', webhookSecret: '' },
        }),
      );
      expect(remove).toHaveBeenCalledWith('share');
      if (offline) expect(queued.has('share')).toBe(true);
      expect(rows.get('meeting:restored')).not.toHaveProperty('binding');
      await service.configure({
        apiKey: 'fixture',
        webhookSecret: Buffer.alloc(32).toString('base64'),
      });
      await expect(
        service.start('session', 'https://meet.google.com/abc-defg-hij', false),
      ).rejects.toThrow('Check Uplink');
    } finally {
      await service.close();
    }
  },
);

it('starts and stops the provider bot independently of the app', async () => {
  const { PreviewConnector } = await import('@verity/preview-tunnel');
  const { AttendeeClient } = await import('./attendee-client.js');
  const connect = vi.spyOn(PreviewConnector.prototype, 'connect').mockResolvedValue(undefined);
  const disconnected = vi
    .spyOn(PreviewConnector.prototype, 'waitForDisconnect')
    .mockImplementation(() => new Promise(() => undefined));
  const rows = new Map<string, unknown>();
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const urlString = (input: string | URL | Request) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (urlString(_url).endsWith('/leave')) return new Response(null, { status: 204 });
    if (urlString(_url).endsWith('/transcript')) return Response.json([]);
    if (init?.method === 'POST') return Response.json({ id: 'bot' });
    return Response.json({ state: 'joined_recording' });
  });
  const remove = vi.fn();
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    edge: {
      isAvailable: () => true,
      remove,
      create: vi.fn(async () => ({
        shareId: 'share',
        publicOrigin: 'https://meeting.example.test',
        edgeUrl: 'wss://meeting.example.test/__verity/connector',
        connectorToken: 'fixture',
        sessionSecret: 'fixture',
        expiresAt: new Date(Date.now() + 60000),
      })),
    },
    client: (key) => new AttendeeClient(key, fetcher),
  });
  await service.configure({
    apiKey: 'fixture',
    webhookSecret: Buffer.alloc(32).toString('base64'),
  });
  await service.open();
  try {
    const result = await service.start('session', 'https://meet.google.com/abc-defg-hij', false);
    const createCall = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    const requestBody = createCall?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Missing bot request JSON');
    const body = JSON.parse(requestBody) as {
      webhooks: Array<{ url: string }>;
      meeting_url: string;
    };
    expect(body.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
    // A second join of this call must find the bot already in it.
    expect(await service.runningFor('https://meet.google.com/abc-defg-hij')).toBe(result.meetingId);
    const callback = new URL(body.webhooks[0]!.url);
    expect(callback.pathname).toBe('/webhooks/attendee');
    const { hashPreviewPin } = await import('@verity/preview-tunnel');
    expect(() => hashPreviewPin(callback.searchParams.get('pin') ?? '')).not.toThrow();
    await service.stop('session', result.meetingId);
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => urlString(url).endsWith('/leave') && init?.method === 'POST',
      ),
    ).toBe(true);
    expect(rows.get(`meeting:${result.meetingId}`)).toMatchObject({
      stopRequested: true,
      botId: 'bot',
    });
    expect(remove).not.toHaveBeenCalled();
  } finally {
    await service.close();
    connect.mockRestore();
    disconnected.mockRestore();
  }
});

it('reconnects callbacks after restarting an ambiguous provider submission', async () => {
  const { PreviewConnector } = await import('@verity/preview-tunnel');
  const connect = vi.spyOn(PreviewConnector.prototype, 'connect').mockResolvedValue(undefined);
  const disconnected = vi
    .spyOn(PreviewConnector.prototype, 'waitForDisconnect')
    .mockImplementation(() => new Promise(() => undefined));
  const state = {
    meeting: { id: 'pending', sessionId: 'session' },
    phase: 'interrupted',
    botCreateAttempted: true,
    binding: {
      edgeUrl: 'wss://meeting.example.test/__verity/connector',
      connectorToken: 'fixture',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  const rows = new Map<string, unknown>([['meeting:pending', state]]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, value: unknown) => {
      rows.set(id, value);
    },
    listAttendeeState: async () => [...rows].map(([id, value]) => ({ id, state: value })),
  } as unknown as EventStore;
  const client = vi.fn();
  const service = new AttendeeMeetings({ store, ingest: vi.fn(), client });
  await service.open();
  try {
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(client).not.toHaveBeenCalled();
    expect(rows.get('meeting:pending')).toMatchObject({ botCreateAttempted: true });
  } finally {
    await service.close();
    connect.mockRestore();
    disconnected.mockRestore();
  }
});

it('treats repeat stop after final cleanup as an idempotent command', async () => {
  const client = vi.fn();
  const service = new AttendeeMeetings({
    store: {
      getAttendeeState: async () => ({
        phase: 'ended',
        meeting: { id: 'done', sessionId: 'session' },
        credentials: { apiKey: '', webhookSecret: '' },
      }),
    } as unknown as EventStore,
    ingest: vi.fn(),
    client,
  });
  await expect(service.stop('session', 'done')).resolves.toEqual({ accepted: true });
  expect(client).not.toHaveBeenCalled();
});

it('allows retry after a definitive Attendee rejection without waiting for a nonexistent bot', async () => {
  const { PreviewConnector } = await import('@verity/preview-tunnel');
  const { AttendeeClient } = await import('./attendee-client.js');
  const connect = vi.spyOn(PreviewConnector.prototype, 'connect').mockResolvedValue(undefined);
  const disconnected = vi
    .spyOn(PreviewConnector.prototype, 'waitForDisconnect')
    .mockImplementation(() => new Promise(() => undefined));
  const rows = new Map<string, unknown>();
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, value: unknown) => {
      rows.set(id, structuredClone(value));
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const create = vi.fn(async () => ({
    shareId: 'share',
    publicOrigin: 'https://meeting.example.test',
    edgeUrl: 'wss://meeting.example.test/__verity/connector',
    connectorToken: 'fixture',
    sessionSecret: 'fixture',
    expiresAt: new Date(Date.now() + 60000),
  }));
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    edge: { create, remove: vi.fn().mockResolvedValue(undefined), isAvailable: () => true },
    client: (key) => new AttendeeClient(key, async () => new Response('', { status: 401 })),
  });
  await service.configure({
    apiKey: 'fixture',
    webhookSecret: Buffer.alloc(32).toString('base64'),
  });
  await service.open();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        service.start('session', 'https://meet.google.com/abc-defg-hij', false),
      ).rejects.toThrow('Attendee rejected');
    }
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    await service.close();
    connect.mockRestore();
    disconnected.mockRestore();
  }
});

it('keeps an addressed utterance pending when classification or dispatch fails', async () => {
  const rows = new Map<string, unknown>([
    [
      'meeting:retry',
      {
        meeting: {
          id: 'retry',
          sessionId: 'session',
          state: 'active',
          transcript: '',
          revision: 0,
        },
        botId: 'bot',
        phase: 'running',
        credentials: { apiKey: 'fixture' },
        identities: {},
        listenForVerity: true,
        spokenThrough: -1,
      },
    ],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const spoken = vi.fn().mockRejectedValue(new Error('temporarily unavailable'));
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    spoken,
    client: () =>
      ({
        request: async () => ({ state: 'ended' }),
        transcript: async () => [
          {
            speaker_uuid: 'alice',
            timestamp_ms: 0,
            duration_ms: 500,
            transcription: { transcript: 'Verity, check this claim' },
          },
        ],
      }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  await service.open();
  try {
    await vi.waitFor(() => expect(spoken).toHaveBeenCalledOnce());
  } finally {
    await service.close();
  }
  expect(rows.get('meeting:retry')).toMatchObject({
    phase: 'ended',
    credentials: { apiKey: '', webhookSecret: '' },
  });
  const saved = rows.get('meeting:retry') as { pendingRequests: Record<string, string> };
  expect(Object.values(saved.pendingRequests)).toEqual(['Verity, check this claim']);
});

it('finds corrected, late and simultaneous addressed utterances without replaying hints', async () => {
  const rows = new Map<string, unknown>([
    [
      'meeting:corrections',
      {
        meeting: {
          id: 'corrections',
          sessionId: 'session',
          state: 'active',
          transcript: '',
          revision: 0,
        },
        botId: 'bot',
        phase: 'running',
        credentials: { apiKey: 'fixture' },
        identities: {},
        listenForVerity: true,
      },
    ],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  let snapshot = [
    {
      speaker_uuid: 'alice',
      speaker_name: 'Alice',
      timestamp_ms: 1000,
      duration_ms: 500,
      transcription: { transcript: 'ordinary statement' },
    },
  ];
  const spoken = vi.fn().mockResolvedValue(undefined);
  const ingest = vi.fn();
  const run = async (rename?: string, clear = false) => {
    ingest.mockClear();
    const service = new AttendeeMeetings({
      store,
      spoken,
      ingest,
      client: () =>
        ({
          request: async () => ({ state: 'joined_recording' }),
          transcript: async () => snapshot,
        }) as unknown as import('./attendee-client.js').AttendeeClient,
    });
    await service.open();
    try {
      await vi.waitFor(() => expect(ingest).toHaveBeenCalled());
      if (rename || clear)
        await service.edit('session', 'corrections', {
          speakerNames: rename ? { '0': rename } : {},
        });
    } finally {
      await service.close();
    }
  };
  await run();
  expect(spoken).not.toHaveBeenCalled();
  snapshot = [
    {
      ...snapshot[0]!,
      speaker_name: 'Corrected Alice',
      transcription: { transcript: 'Verity, check the corrected claim' },
    },
    {
      ...snapshot[0]!,
      speaker_name: 'Corrected Alice',
      timestamp_ms: 0,
      transcription: { transcript: 'Verity, check the late claim' },
    },
    {
      ...snapshot[0]!,
      speaker_uuid: 'bob',
      transcription: { transcript: 'Verity, check the simultaneous claim' },
    },
  ];
  await run();
  const correctedMeeting = ingest.mock.calls.at(-1)?.[0] as {
    speakerNames: Record<string, string>;
    speakerTurns: Array<{ start: number }>;
  };
  expect(correctedMeeting.speakerNames['0']).toBe('Corrected Alice');
  expect(correctedMeeting.speakerTurns.every((turn) => turn.start >= 0)).toBe(true);
  expect(spoken).toHaveBeenCalledTimes(3);
  expect(new Set(spoken.mock.calls.map((call: unknown[]) => call[2])).size).toBe(3);
  await run('My Alice');
  await run();
  expect(ingest.mock.calls.at(-1)?.[0].speakerNames['0']).toBe('My Alice');
  await run(undefined, true);
  await run();
  expect(ingest.mock.calls.at(-1)?.[0].speakerNames['0']).toBe('Corrected Alice');
  expect(spoken).toHaveBeenCalledTimes(3);
});

it('stops deleted sessions without ingesting and erases their terminal state', async () => {
  const rows = new Map<string, unknown>([
    [
      'meeting:deleted',
      {
        meeting: {
          id: 'deleted',
          sessionId: 'gone',
          transcript: 'private text',
          state: 'active',
          revision: 0,
        },
        botId: 'bot',
        phase: 'running',
        credentials: { apiKey: 'fixture' },
        identities: {},
        binding: { shareId: 'share' },
        pendingRequests: { request: 'Verity, research this' },
      },
    ],
  ]);
  const store = {
    getSession: async () => undefined,
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  let terminal = false;
  const request = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') return {};
    return { state: terminal ? 'ended' : 'joined_recording' };
  });
  const ingest = vi.fn().mockRejectedValue(new Error('session no longer exists'));
  const spoken = vi.fn();
  const remove = vi.fn();
  const run = async () => {
    const service = new AttendeeMeetings({
      store,
      ingest,
      spoken,
      edge: { remove } as unknown as NonNullable<
        ConstructorParameters<typeof AttendeeMeetings>[0]['edge']
      >,
      client: () => ({ request }) as unknown as import('./attendee-client.js').AttendeeClient,
    });
    await service.open();
    try {
      await vi.waitFor(() =>
        terminal
          ? expect(rows.has('meeting:deleted')).toBe(false)
          : expect(request).toHaveBeenCalledWith('bots/bot/leave', 'POST'),
      );
    } finally {
      await service.close();
    }
  };
  await run();
  expect(ingest).not.toHaveBeenCalled();
  expect(spoken).not.toHaveBeenCalled();
  terminal = true;
  await run();
  expect(remove).toHaveBeenCalledWith('share');
  expect(rows.size).toBe(0);
});

it('sends leave while research classification is still pending', async () => {
  const rows = new Map<string, unknown>([
    [
      'meeting:slow',
      {
        meeting: { id: 'slow', sessionId: 'session', transcript: '', state: 'active', revision: 0 },
        botId: 'bot',
        phase: 'running',
        credentials: { apiKey: 'fixture' },
        identities: {},
        listenForVerity: true,
      },
    ],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spoken = vi.fn(() => blocked);
  const request = vi.fn(async () => ({ state: 'joined_recording' }));
  const service = new AttendeeMeetings({
    store,
    spoken,
    ingest: vi.fn(),
    client: () =>
      ({
        request,
        transcript: async () => [
          {
            speaker_uuid: 'alice',
            timestamp_ms: 0,
            duration_ms: 500,
            transcription: { transcript: 'Verity, check this' },
          },
        ],
      }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  await service.open();
  try {
    await vi.waitFor(() => expect(spoken).toHaveBeenCalledOnce());
    const stop = service.stop('session', 'slow');
    // A model response may take much longer than the user's End command.
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('bots/bot/leave', 'POST'));
    await stop;
  } finally {
    release();
    await service.close();
  }
});

it('coalesces polling ticks while a provider snapshot is pending', async () => {
  const rows = new Map<string, unknown>([
    [
      'meeting:poll',
      {
        meeting: { id: 'poll', sessionId: 'session', transcript: '', state: 'active', revision: 0 },
        botId: 'bot',
        phase: 'running',
        credentials: { apiKey: 'fixture' },
        identities: {},
      },
    ],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  let release!: () => void;
  const blocked = new Promise<[]>((resolve) => {
    release = () => resolve([]);
  });
  const request = vi.fn(async () => ({ state: 'joined_recording' }));
  const transcript = vi.fn(() => blocked);
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    client: () =>
      ({ request, transcript }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  await service.open();
  try {
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    const ticks = service as unknown as { poll: () => void };
    for (let i = 0; i < 10; i++) ticks.poll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stop = service.stop('session', 'poll');
    release();
    await stop;
    // Slow snapshots must not accumulate ten more provider rounds ahead of End.
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith('bots/bot/leave', 'POST');
  } finally {
    release();
    await service.close();
  }
});

it('recovers a saved bot ID and requests leave before a failing Edge reconnect', async () => {
  const { PreviewConnector } = await import('@verity/preview-tunnel');
  const connect = vi
    .spyOn(PreviewConnector.prototype, 'connect')
    .mockRejectedValue(new Error('Edge offline'));
  const rows = new Map<string, unknown>([
    [
      'meeting:recover',
      {
        meeting: {
          id: 'recover',
          sessionId: 'session',
          transcript: '',
          state: 'interrupted',
          revision: 0,
        },
        phase: 'interrupted',
        stopRequested: true,
        botCreateAttempted: true,
        identities: {},
        credentials: { apiKey: 'fixture' },
        binding: {
          edgeUrl: 'wss://meeting.example.test/__verity/connector',
          connectorToken: 'fixture',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    ],
    ['event:bot', { bot_id: 'bot', bot_metadata: { verityMeetingId: 'recover' } }],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const request = vi.fn(async () => ({ state: 'joined_recording' }));
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    client: () =>
      ({
        request,
        transcript: async () => [],
      }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  await service.open();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('bots/bot/leave', 'POST'));
    expect(rows.get('meeting:recover')).toMatchObject({ botId: 'bot', stopRequested: true });
  } finally {
    await service.close();
    connect.mockRestore();
  }
});

it.each([false, true])(
  'removes persisted webhook bindings on sharing shutdown (queued: %s)',
  async (queued) => {
    const state = {
      meeting: { id: 'restored' },
      phase: 'running',
      botId: 'bot',
      binding: { shareId: 'share' },
    };
    let disable!: () => void;
    const saveState = vi.fn(async () => undefined);
    const store = {
      listAttendeeState: vi.fn(async () => [{ id: 'meeting:restored', state }]),
      putAttendeeState: saveState,
    } as unknown as EventStore;
    const remove = vi.fn(async () => {
      // The removal queue must receive the handle before the durable binding is erased.
      expect(state.binding?.shareId).toBe('share');
      if (queued) throw new PreviewShareRemovalQueuedError('offline');
    });
    const service = new AttendeeMeetings({
      store,
      ingest: vi.fn(),
      edge: {
        create: vi.fn(),
        remove,
        onSharingDisabled: (listener) => {
          disable = listener;
          return () => undefined;
        },
      },
    });
    disable();
    await vi.waitFor(() => expect(saveState).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledWith('share');
    expect(state.binding).toBeUndefined();
    expect(state.botId).toBe('bot');
    expect(state.phase).toBe('running');
    await service.close();
  },
);

it.each([
  { stage: 'connection', queueFails: false },
  { stage: 'save', queueFails: false },
  { stage: 'connection', queueFails: true },
  { stage: 'save', queueFails: true },
])(
  'does not create a bot when sharing is disabled during $stage (queue fails: $queueFails)',
  async ({ stage, queueFails }) => {
    const { PreviewConnector } = await import('@verity/preview-tunnel');
    const rows = new Map<string, unknown>();
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
        if (stage === 'save' && (state as { botCreateAttempted?: boolean }).botCreateAttempted) {
          available = false;
          disable();
        }
      },
      listAttendeeState: async () =>
        [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
    } as unknown as EventStore;
    let disable!: () => void;
    let available = true;
    const connect = vi.spyOn(PreviewConnector.prototype, 'connect').mockImplementation(async () => {
      if (stage === 'connection') {
        available = false;
        disable();
      }
    });
    const disconnected = vi
      .spyOn(PreviewConnector.prototype, 'waitForDisconnect')
      .mockImplementation(() => new Promise(() => undefined));
    const close = vi.spyOn(PreviewConnector.prototype, 'close');
    const request = vi.fn();
    const remove = vi.fn(async () => {
      if (queueFails) throw new Error('queue storage unavailable');
    });
    const service = new AttendeeMeetings({
      store,
      ingest: vi.fn(),
      edge: {
        isAvailable: () => available,
        onSharingDisabled: (listener) => {
          disable = listener;
          return () => undefined;
        },
        remove,
        create: async () => ({
          shareId: 'share',
          publicOrigin: 'https://meeting.example.test',
          edgeUrl: 'wss://meeting.example.test/__verity/connector',
          connectorToken: 'fixture',
          sessionSecret: 'fixture',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      client: () => ({ request }) as unknown as import('./attendee-client.js').AttendeeClient,
    });
    await service.configure({
      apiKey: 'fixture',
      webhookSecret: Buffer.alloc(32).toString('base64'),
    });
    await service.open();
    try {
      await expect(
        service.start('session', 'https://meet.google.com/abc-defg-hij', false),
      ).rejects.toThrow('Check Uplink');
      expect(request).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith('share');
      expect([...rows].find(([id]) => id.startsWith('meeting:'))?.[1]).toMatchObject({
        phase: queueFails ? 'stopping' : 'ended',
        credentials: { apiKey: '', webhookSecret: '' },
      });
      const state = [...rows].find(([id]) => id.startsWith('meeting:'))?.[1];
      if (queueFails) {
        expect(state).toHaveProperty('binding.shareId', 'share');
        remove.mockImplementation(async () => undefined);
        await service.stop('session', (state as { meeting: { id: string } }).meeting.id);
        const completed = [...rows].find(([id]) => id.startsWith('meeting:'))?.[1];
        expect(completed).toMatchObject({ phase: 'ended' });
        expect(completed).not.toHaveProperty('binding');
      } else expect(state).not.toHaveProperty('binding');
    } finally {
      await service.close();
      connect.mockRestore();
      close.mockRestore();
      disconnected.mockRestore();
    }
  },
);

it('retains the webhook share handle when shutdown revocation fails', async () => {
  const state = { meeting: { id: 'restored' }, phase: 'running', binding: { shareId: 'share' } };
  let disable!: () => void;
  const save = vi.fn();
  const remove = vi.fn(async () => {
    throw new Error('durable queue unavailable');
  });
  const service = new AttendeeMeetings({
    store: {
      listAttendeeState: async () => [{ id: 'meeting:restored', state }],
      putAttendeeState: save,
    } as unknown as EventStore,
    ingest: vi.fn(),
    edge: {
      create: vi.fn(),
      remove,
      onSharingDisabled: (listener) => {
        disable = listener;
        return () => undefined;
      },
    },
  });
  disable();
  await service.close();
  expect(remove).toHaveBeenCalledWith('share');
  expect(state.binding).toEqual({ shareId: 'share' });
  expect(save).not.toHaveBeenCalled();
});

it.each([
  [
    'capability_check',
    'webhook_not_negotiated',
    'has not confirmed webhook support',
    '(Uplink step: capability_check · webhook_not_negotiated)',
  ],
  [
    'share_create',
    'limit_reached',
    'share limit is reached',
    '(Uplink step: share_create · limit_reached)',
  ],
  ['share_create', 'pending', 'did not complete', '(Uplink step: share_create)'],
] as const)(
  'names the failed Uplink step %s/%s when an online meeting cannot start',
  async (phase, code, reason, step) => {
    const rows = new Map<string, unknown>();
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
      },
      listAttendeeState: async () => [],
    } as unknown as EventStore;
    const service = new AttendeeMeetings({
      store,
      edge: {
        create: async (_input, observe) => {
          observe?.({ phase, code, shareCreateSent: phase === 'share_create' });
          throw new Error('internal detail');
        },
        remove: vi.fn().mockResolvedValue(undefined),
        isAvailable: () => true,
      },
      ingest: vi.fn(),
    });
    await service.configure({
      apiKey: 'fixture',
      webhookSecret: Buffer.alloc(32).toString('base64'),
    });
    await service.open();
    try {
      const failure = service.start('session', 'https://meet.google.com/abc-defg-hij', false);
      await expect(failure).rejects.toThrow(reason);
      await expect(failure).rejects.toThrow(step);
      await expect(failure).rejects.not.toThrow('internal detail');
    } finally {
      await service.close();
    }
  },
);

it('keeps the generic Uplink hint for a failure before any Uplink step reported', () => {
  expect(uplinkStartFailure('ensure_sharing', 'pending')).toBe(
    'Could not enable online sharing on the Uplink. Check Uplink / Online Sharing and retry. (Uplink step: ensure_sharing)',
  );
  expect(uplinkStartFailure('share_create', 'toString')).toBe(
    'The Uplink refused the webhook share. Check Uplink / Online Sharing and retry. (Uplink step: share_create · unknown)',
  );
  expect(uplinkStartFailure('provider_setup', 'pending')).toMatch(
    /^The webhook share is ready, but preparing the meeting failed/,
  );
  expect(uplinkStartFailure('share_create', 'raw upstream <text>')).toBe(
    'The Uplink refused the webhook share. Check Uplink / Online Sharing and retry. (Uplink step: share_create · unknown)',
  );
});

it('logs the meeting data path without transcript text, PIN or credentials', async () => {
  const { AttendeeRequestRejected } = await import('./attendee-client.js');
  const running = {
    meeting: {
      id: 'meeting',
      sessionId: 'session',
      engine: 'attendee',
      title: null,
      startedAt: 0,
      endedAt: null,
      state: 'active',
      transcript: '',
      captureStatus: 'preparing',
      ownerTokenHash: 'hash',
      revision: 1,
    },
    botId: 'bot',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    pin: '123456',
    credentials: { apiKey: 'secret-key', webhookSecret: Buffer.alloc(32).toString('base64') },
    identities: {},
    phase: 'running',
    stopRequested: false,
    listenForVerity: false,
  };
  const rows = new Map<string, unknown>([['meeting:meeting', running]]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  let failing = false;
  const request = vi.fn(async () => {
    if (failing) throw new AttendeeRequestRejected(502);
    return { state: 'joined_recording' };
  });
  const transcript = vi.fn(async () => [
    {
      speaker_uuid: 'alice',
      speaker_name: 'Alice',
      timestamp_ms: 4000,
      duration_ms: 500,
      transcription: { transcript: 'confidential words' },
    },
  ]);
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    log,
    client: () =>
      ({ request, transcript }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  await service.open();
  try {
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        {
          meetingId: 'meeting',
          botState: 'joined_recording',
          utterances: 1,
          lastTimestampMs: 4000,
        },
        'Online meeting transcript snapshot',
      ),
    );
    expect(log.info).toHaveBeenCalledWith(
      {
        meetingId: 'meeting',
        botId: 'bot',
        platform: 'google_meet',
        botState: 'joined_recording',
        previousBotState: null,
        joinStatus: 'joined',
        reason: null,
        eventType: null,
        eventSubType: null,
      },
      'Online meeting bot state changed',
    );
    const origin = (service as unknown as { targetOrigin: string }).targetOrigin;
    const post = (path: string, body: unknown) =>
      fetch(new URL(path, origin), { method: 'POST', body: JSON.stringify(body) });
    expect((await post('/elsewhere', {})).status).toBe(404);
    const event = {
      idempotency_key: '00000000-0000-4000-8000-000000000000',
      bot_id: 'bot',
      trigger: 'transcript.update',
      data: { transcript: 'confidential words' },
    };
    expect((await post('/webhooks/attendee', event)).status).toBe(401);
    expect((await post('/webhooks/attendee', { ...event, bot_id: 'other' })).status).toBe(401);
    expect((await post('/webhooks/attendee', 'not an event')).status).toBe(400);
    expect(log.info).toHaveBeenCalledWith(
      { status: 404, outcome: 'unknown_path' },
      'Attendee webhook answered',
    );
    expect(log.info).toHaveBeenCalledWith(
      {
        status: 401,
        outcome: 'signature_missing',
        trigger: 'transcript.update',
        meetingId: 'meeting',
      },
      'Attendee webhook answered',
    );
    expect(log.info).toHaveBeenCalledWith(
      { status: 401, outcome: 'unknown_meeting', trigger: 'transcript.update' },
      'Attendee webhook answered',
    );
    expect(log.info).toHaveBeenCalledWith(
      { status: 400, outcome: 'invalid', error: 'ZodError' },
      'Attendee webhook answered',
    );
    failing = true;
    (service as unknown as { poll(): void }).poll();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        {
          meetingId: 'meeting',
          phase: expect.any(String),
          error: 'Error',
          status: 502,
        },
        'Online meeting reconciliation failed',
      ),
    );
    // A meeting that stays broken warns once per failure kind, not on every poll.
    (service as unknown as { poll(): void }).poll();
    await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      log.warn.mock.calls.filter(
        ([, message]) => message === 'Online meeting reconciliation failed',
      ),
    ).toHaveLength(1);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toMatch(/confidential|123456|secret-key|abc-defg-hij/u);
  } finally {
    await service.close();
  }
});

it.each([false, true])(
  'records safe connector failures without changing startup cleanup (logger throws: %s)',
  async (throws) => {
    const { PreviewConnector } = await import('@verity/preview-tunnel');
    const rows = new Map<string, unknown>();
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
      },
      listAttendeeState: async () => [],
    } as unknown as EventStore;
    const warn = vi.fn(() => {
      if (throws) throw new Error('logger unavailable');
    });
    const request = vi.fn();
    const remove = vi.fn();
    const connect = vi
      .spyOn(PreviewConnector.prototype, 'connect')
      .mockImplementation(async function (this: import('@verity/preview-tunnel').PreviewConnector) {
        const { options } = this as unknown as {
          options: import('@verity/preview-tunnel').PreviewConnectorOptions;
        };
        options.onDiagnostic?.({
          event: 'connect.failed',
          cause: 'upgrade_rejected',
          statusCode: 403,
          elapsedMs: 12,
        });
        throw new Error('raw upstream error with secret-token');
      });
    const service = new AttendeeMeetings({
      store,
      ingest: vi.fn(),
      log: { info: vi.fn(), warn },
      client: () => ({ request }) as unknown as import('./attendee-client.js').AttendeeClient,
      edge: {
        isAvailable: () => true,
        remove,
        create: async () => ({
          shareId: 'share',
          publicOrigin: 'https://meeting.example.test',
          edgeUrl: 'wss://meeting.example.test/__verity/connector',
          connectorToken: 'secret-token',
          sessionSecret: 'secret-session',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
    });
    await service.configure({
      apiKey: 'secret-api',
      webhookSecret: Buffer.alloc(32).toString('base64'),
    });
    await service.open();
    try {
      await expect(
        service.start('session', 'https://meet.google.com/abc-defg-hij', false),
      ).rejects.toThrow('its connector could not connect');
      expect(warn).toHaveBeenCalledWith(
        {
          meetingId: expect.any(String),
          shareId: 'share',
          event: 'connect.failed',
          cause: 'upgrade_rejected',
          statusCode: 403,
          elapsedMs: 12,
        },
        'Online meeting connector transport',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: expect.any(String),
          phase: 'connector_connect',
          event: 'failed',
          bindingPresent: true,
          botCreateAttempted: false,
        }),
        'Online meeting start failed',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-|meeting\.example|raw upstream/);
      expect(request).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith('share');
    } finally {
      await service.close();
      connect.mockRestore();
    }
  },
);

/** A running online meeting with a provider bot, as the reconciliation loop finds it. */
function joiningMeeting(bot: () => unknown) {
  const rows = new Map<string, unknown>([
    [
      'meeting:meeting',
      {
        meeting: {
          id: 'meeting',
          sessionId: 'session',
          engine: 'attendee',
          title: null,
          startedAt: 0,
          endedAt: null,
          state: 'active',
          transcript: '',
          captureStatus: 'preparing',
          ownerTokenHash: 'hash',
          revision: 1,
        },
        botId: 'bot',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        pin: '123456',
        credentials: { apiKey: 'secret-key', webhookSecret: Buffer.alloc(32).toString('base64') },
        identities: {},
        phase: 'running',
        stopRequested: false,
        listenForVerity: false,
      },
    ],
  ]);
  const store = {
    getSession: async () => ({ id: 'session' }),
    getAttendeeState: async (id: string) => rows.get(id),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  const request = vi.fn(async (path: string) => (path.endsWith('/leave') ? null : bot()));
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = new AttendeeMeetings({
    store,
    ingest: vi.fn(),
    log,
    client: () =>
      ({
        request,
        transcript: async () => [],
      }) as unknown as import('./attendee-client.js').AttendeeClient,
  });
  return { rows, request, log, service };
}

// Before this, the bot's provider reason was dropped: a meeting that could not be joined
// looked like one still joining until someone pressed End.
it('reports why the bot could not join, without logging the meeting link', async () => {
  const { service, log } = joiningMeeting(() => ({
    state: 'fatal_error',
    events: [
      { type: 'join_requested', created_at: '2026-11-13T07:56:50Z' },
      {
        type: 'could_not_join_meeting',
        sub_type: 'login_required',
        created_at: '2026-11-13T07:57:30Z',
      },
    ],
  }));
  await service.open();
  try {
    await vi.waitFor(async () =>
      expect(await service.status('session', 'meeting')).toEqual({
        status: 'failed',
        reason: 'login_required',
        platform: 'google_meet',
      }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: 'meeting',
        botId: 'bot',
        platform: 'google_meet',
        botState: 'fatal_error',
        joinStatus: 'failed',
        reason: 'login_required',
        eventType: 'could_not_join_meeting',
        eventSubType: 'login_required',
      }),
      'Online meeting bot could not join',
    );
    // Another session's caller learns nothing about this meeting.
    expect(await service.status('other', 'meeting')).toBeUndefined();
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toMatch(/abc-defg-hij|123456|secret-key/u);
  } finally {
    await service.close();
  }
});

it('shows the waiting room only when the provider reports it', async () => {
  let state = 'joining';
  const { service } = joiningMeeting(() => ({ state, events: [] }));
  await service.open();
  try {
    await vi.waitFor(async () =>
      expect(await service.status('session', 'meeting')).toMatchObject({ status: 'joining' }),
    );
    state = 'waiting_room';
    (service as unknown as { poll(): void }).poll();
    await vi.waitFor(async () =>
      expect(await service.status('session', 'meeting')).toMatchObject({ status: 'waiting' }),
    );
    expect(await service.joinStatuses()).toEqual(new Map([['meeting', 'waiting']]));
  } finally {
    await service.close();
  }
});

// The app sent End up to nine times while a bot hung in joining; each one asked the provider
// to leave again.
it('asks the provider to leave once however often End is pressed', async () => {
  const { service, request } = joiningMeeting(() => ({ state: 'joining' }));
  await Promise.all([service.stop('session', 'meeting'), service.stop('session', 'meeting')]);
  await service.stop('session', 'meeting');
  expect(request.mock.calls.filter(([path]) => String(path).endsWith('/leave'))).toHaveLength(1);
});

it('logs the enum fields of a signed state change and nothing else', async () => {
  const { createHmac } = await import('node:crypto');
  const { service, log } = joiningMeeting(() => ({ state: 'joining' }));
  await service.open();
  try {
    const event = {
      idempotency_key: '00000000-0000-4000-8000-000000000001',
      bot_id: 'bot',
      trigger: 'bot.state_change',
      data: {
        new_state: 'waiting_room',
        old_state: 'joining',
        event_type: 'put_in_waiting_room',
        event_sub_type: null,
        note: 'Ask Alice for the budget',
      },
    };
    const canonical = (value: unknown): string =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object'
          ? `{${Object.keys(value)
              .sort()
              .map(
                (key) =>
                  `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
              )
              .join(',')}}`
          : JSON.stringify(value);
    const signature = createHmac('sha256', Buffer.alloc(32))
      .update(canonical(event), 'utf8')
      .digest('base64');
    const origin = (service as unknown as { targetOrigin: string }).targetOrigin;
    const response = await fetch(new URL('/webhooks/attendee', origin), {
      method: 'POST',
      headers: { 'x-webhook-signature': signature },
      body: JSON.stringify(event),
    });
    expect(response.status).toBe(202);
    expect(log.info).toHaveBeenCalledWith(
      {
        status: 202,
        outcome: 'accepted',
        trigger: 'bot.state_change',
        meetingId: 'meeting',
        botId: 'bot',
        newState: 'waiting_room',
        oldState: 'joining',
        eventType: 'put_in_waiting_room',
        eventSubType: null,
      },
      'Attendee webhook answered',
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/budget/u);
  } finally {
    await service.close();
  }
});
