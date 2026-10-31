import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import type { AttendeeClient } from './attendee-client.js';
import { AttendeeMeetings } from './attendee-meetings.js';

function memoryStore(seed: Array<[string, unknown]>) {
  const rows = new Map<string, unknown>(seed);
  const store = {
    getSession: async (id: string) => (id === 'session' ? { id } : undefined),
    getAttendeeState: async (id: string) => structuredClone(rows.get(id)),
    putAttendeeState: async (id: string, state: unknown) => {
      rows.set(id, structuredClone(state));
    },
    deleteAttendeeState: async (id: string) => {
      rows.delete(id);
    },
    listAttendeeState: async () =>
      [...rows].filter(([id]) => id !== 'config').map(([id, state]) => ({ id, state })),
  } as unknown as EventStore;
  return { rows, store };
}

function running(id: string, sessionId: string | null, extra: Record<string, unknown> = {}) {
  return {
    meeting: {
      id,
      sessionId,
      engine: 'attendee',
      title: 'Design review',
      startedAt: 1_000,
      endedAt: null,
      state: 'active',
      transcript: '',
      captureStatus: 'listening',
      ownerTokenHash: 'hash',
      revision: 1,
    },
    botId: `bot-${id}`,
    pin: '123456',
    credentials: { apiKey: 'fixture', webhookSecret: 'fixture' },
    identities: {},
    phase: 'running',
    stopRequested: false,
    listenForVerity: true,
    ...extra,
  };
}

const utterance = {
  speaker_name: 'Anna',
  speaker_uuid: 'anna',
  timestamp_ms: 5_000,
  duration_ms: 1_500,
  transcription: { transcript: 'Verity, check the travel budget' },
};

it('keeps an unassigned meeting out of every session until it is assigned', async () => {
  const { rows, store } = memoryStore([['meeting:m', running('m', null)]]);
  const transcript = vi.fn(async () => [utterance]);
  const request = vi.fn(async () => ({ state: 'joined_recording' }));
  const ingest = vi.fn();
  const spoken = vi.fn();
  const service = new AttendeeMeetings({
    store,
    ingest,
    spoken,
    client: () => ({ request, transcript }) as unknown as AttendeeClient,
  });
  await service.open();
  try {
    // The provider keeps transcribing while nobody has chosen a project.
    await vi.waitFor(() => {
      const state = rows.get('meeting:m') as {
        meeting: { transcript: string };
        pendingRequests?: Record<string, string>;
      };
      expect(state.meeting.transcript).toContain('travel budget');
      expect(Object.values(state.pendingRequests ?? {})).toEqual([
        utterance.transcription.transcript,
      ]);
    });
    // Publishing would create a live meeting row in some session; requests have no session
    // to be answered in. Both have to wait for the assignment.
    expect(ingest).not.toHaveBeenCalled();
    expect(spoken).not.toHaveBeenCalled();
    expect(await service.unassigned()).toEqual([
      expect.objectContaining({ id: 'm', title: 'Design review', endedAt: null, people: 1 }),
    ]);

    await service.assign('m', 'session');
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm',
        sessionId: 'session',
        transcript: expect.stringContaining('travel budget'),
      }),
    );
    await vi.waitFor(() =>
      expect(spoken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm', sessionId: 'session' }),
        utterance.transcription.transcript,
        expect.any(String),
      ),
    );
    expect(await service.unassigned()).toEqual([]);
    await expect(service.assign('m', 'session')).rejects.toThrow('no longer waiting');
  } finally {
    await service.close();
  }
});

it('refuses to assign into a session that already has an online meeting running', async () => {
  const { store } = memoryStore([
    ['meeting:busy', running('busy', 'session')],
    ['meeting:m', running('m', null)],
  ]);
  const ingest = vi.fn();
  const service = new AttendeeMeetings({ store, ingest });
  await expect(service.assign('m', 'session')).rejects.toThrow('already active');
  await expect(service.assign('m', 'missing')).rejects.toThrow('Session not found');
  expect(ingest).not.toHaveBeenCalled();
});

it('discards an unassigned meeting without touching an assigned one', async () => {
  const { rows, store } = memoryStore([
    [
      'meeting:m',
      running('m', null, { meeting: { ...running('m', null).meeting, transcript: 'secret' } }),
    ],
    ['meeting:a', running('a', 'session')],
  ]);
  let ended = false;
  const request = vi.fn(async (path: string, method?: string) => {
    if (method === 'POST') {
      ended = true;
      return {};
    }
    return { state: path.endsWith('bot-m') && ended ? 'ended' : 'joined_recording' };
  });
  const ingest = vi.fn();
  const service = new AttendeeMeetings({
    store,
    ingest,
    client: () => ({ request }) as unknown as AttendeeClient,
  });

  expect(await service.discard('m')).toBe(true);
  expect(request).toHaveBeenCalledWith('bots/bot-m/leave', 'POST');
  // The bot has not left yet: the state stays, flagged, with nothing it heard.
  expect(rows.get('meeting:m')).toMatchObject({
    discarded: true,
    stopRequested: true,
    meeting: { transcript: '' },
  });
  expect(await service.unassigned()).toEqual([]);
  expect(await service.discard('m')).toBe(true);
  expect(rows.has('meeting:m')).toBe(false);

  // An assigned meeting was published to its session; discarding it here would leave that
  // copy behind, so the owner refuses.
  expect(await service.discard('a')).toBe(false);
  expect(rows.get('meeting:a')).toMatchObject({ phase: 'running' });
  expect(await service.discard('unknown')).toBe(false);
  expect(ingest).not.toHaveBeenCalled();
});
