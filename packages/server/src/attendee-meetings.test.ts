import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { AttendeeMeetings } from './attendee-meetings.js';

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

it.each([true, false])(
  'recovers restart state before removing the share (submitted: %s)',
  async (submitted) => {
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
    const store = {
      getSession: async () => ({ id: 'session' }),
      getAttendeeState: async (id: string) => rows.get(id),
      putAttendeeState: async (id: string, state: unknown) => {
        rows.set(id, structuredClone(state));
      },
      listAttendeeState: async () => [...rows].map(([id, state]) => ({ id, state })),
    } as unknown as EventStore;
    const ingest = vi.fn();
    const remove = vi.fn(async () => {
      if (submitted)
        expect(ingest).toHaveBeenCalledWith(
          expect.objectContaining({ transcript: submitted ? 'final text' : '', state: 'ended' }),
        );
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
    const callback = new URL(body.webhooks[0]!.url);
    expect(callback.pathname).toBe('/webhooks/attendee');
    expect(callback.searchParams.get('pin')).toMatch(/^\d{9}$/);
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
