import { beginSessionSwitch, exportSessionSwitchTimings } from './sessionSwitchTiming.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  VerityApiError,
  VerityClient,
  projectRecordSchema,
  sessionSummarySchema,
  branchListSchema,
  sessionDetailSchema,
  type TurnRequest,
} from './api.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

it('retains the same full PR snapshot in overview and branch responses', () => {
  const pullRequest = {
    number: 42,
    title: 'Known PR',
    url: 'https://github.com/example/repo/pull/42',
    phase: 'open',
    pipeline: 'running',
    mergeable: null,
    checks: { completed: 1, total: 2, successful: 1, failed: 0, pending: 1 },
  };
  const summary = sessionSummarySchema.parse({
    sessionId: 's',
    worktree: '/wt/s',
    model: 'm',
    name: null,
    status: 'idle',
    usage: ZERO_USAGE,
    pullRequest,
  });
  const branches = branchListSchema.parse({ current: 'fix/status', switchable: [], pullRequest });
  expect(summary.pullRequest).toEqual(branches.pullRequest);
});

it('normalizes the additive agent-text counter version without breaking legacy readers', () => {
  const wire = {
    sessionId: 's1',
    worktree: '/wt/s1',
    model: 'm',
    name: null,
    status: 'idle',
    usage: ZERO_USAGE,
    eventCount: 2,
    agentTextCounterVersion: 'agent-text-v2',
    lastSeenEventCount: 1,
  };
  // Installed clients restrict the older field to a literal; a replacement value
  // there would reject the entire session list rather than just the read marker.
  const legacy = z.object({ eventCountVersion: z.literal('dev-servers-excluded-v1').optional() });
  expect(() => legacy.parse(wire)).not.toThrow();
  expect(sessionSummarySchema.parse(wire).eventCountVersion).toBe('agent-text-v2');
  expect(sessionDetailSchema.parse(wire).eventCountVersion).toBe('agent-text-v2');
});

it.each([undefined, 'dev-servers-excluded-v1', 'agent-text-v2'])(
  'accepts summaries with counter version %s',
  (eventCountVersion) => {
    const parsed = sessionSummarySchema.parse({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: null,
      status: 'awaiting_input',
      usage: ZERO_USAGE,
      resumable: true,
      eventCount: 2,
      lastSeenEventCount: 1,
      eventCountVersion,
      backgroundWorking: true,
    });
    expect(parsed.eventCountVersion).toBe(eventCountVersion);
    expect(parsed.backgroundWorking).toBe(true);
  },
);

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake `fetch` that records calls and returns a canned response. */
function fakeFetch(response: Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function fakeFetchSequence(...responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('fakeFetchSequence exhausted');
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonBody(call: Call | undefined): unknown {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as unknown;
}

describe('VerityClient live meetings', () => {
  it('loads server-generated insights for the selected meeting', async () => {
    const insight = {
      id: 'insight-1',
      meetingId: 'meeting/one',
      kind: 'contradiction',
      summary: 'Two dates were mentioned.',
      evidenceA: 'Tuesday',
      evidenceB: 'Friday',
      createdAt: 5,
    };
    const { fetch, calls } = fakeFetch(json({ insights: [insight] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getLiveMeetingInsights('session/one', insight.meetingId)).toEqual([
      { ...insight, sourcePath: null },
    ]);
    expect(calls[0]?.url).toBe(
      'http://host/sessions/session%2Fone/live-meetings/meeting%2Fone/insights',
    );
  });

  it('sends a meeting, finalized note, and recorder commands to their scoped routes', async () => {
    const meeting = {
      id: 'meeting/one',
      sessionId: 'session/one',
      engine: 'fluid-nemotron' as const,
      startedAt: 1,
      endedAt: null,
      state: 'active' as const,
      transcript: 'Hello',
      captureStatus: 'listening' as const,
      ownerToken: 'recorder-secret',
      revision: 2,
    };
    const note = {
      id: 'note/one',
      meetingId: meeting.id,
      atSeconds: 3,
      text: 'Decision',
      revision: 1,
    };
    const command = {
      id: 'command/one',
      meetingId: meeting.id,
      action: 'pause',
      state: 'pending',
      error: null,
      requestedAt: 4,
      acknowledgedAt: null,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ cursor: 7, meetings: [meeting], notes: [note] }),
      json({ ok: true }),
      json({ ok: true }),
      json({ commands: [command], recorderOnline: true }),
      json({ commandId: command.id }),
      json({ ok: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getLiveMeetingChanges(meeting.sessionId, 6)).toEqual({
      cursor: 7,
      meetings: [
        {
          id: meeting.id,
          sessionId: meeting.sessionId,
          engine: meeting.engine,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt,
          state: meeting.state,
          transcript: meeting.transcript,
          captureStatus: meeting.captureStatus,
          revision: meeting.revision,
        },
      ],
      notes: [note],
    });
    await client.putLiveMeeting(meeting);
    await client.putLiveMeetingNote(meeting.sessionId, note);
    expect(
      await client.getLiveMeetingCommands(meeting.sessionId, meeting.id, meeting.ownerToken),
    ).toEqual({
      commands: [command],
      recorderOnline: true,
    });
    expect(await client.requestLiveMeetingCommand(meeting.sessionId, meeting.id, 'pause')).toBe(
      command.id,
    );
    await client.acknowledgeLiveMeetingCommand(
      meeting.sessionId,
      meeting.id,
      command.id,
      meeting.ownerToken,
      'completed',
      null,
    );
    const root = 'http://host/sessions/session%2Fone/live-meetings';
    expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
      [`${root}?after=6`, 'GET'],
      [`${root}/meeting%2Fone`, 'PUT'],
      [`${root}/meeting%2Fone/notes/note%2Fone`, 'PUT'],
      [`${root}/meeting%2Fone/commands`, 'GET'],
      [`${root}/meeting%2Fone/commands`, 'POST'],
      [`${root}/meeting%2Fone/commands/command%2Fone`, 'PUT'],
    ]);
    expect(jsonBody(calls[1])).toEqual(meeting);
    expect(jsonBody(calls[2])).toEqual(note);
    expect(calls[3]?.init?.headers).toMatchObject({ 'x-meeting-owner-token': meeting.ownerToken });
    expect(jsonBody(calls[4])).toEqual({ action: 'pause' });
    expect(calls[5]?.init?.headers).toMatchObject({ 'x-meeting-owner-token': meeting.ownerToken });
    expect(jsonBody(calls[5])).toEqual({ state: 'completed', error: null });
  });
});

describe('VerityClient Matrix integrations', () => {
  const projectId = 'project/one';
  const source = {
    accountId: '@verity:example.test',
    sourceId: '!room:example.test',
    displayName: 'Project chat',
    inviter: null,
    projectId,
    status: 'active',
    activatedAt: '2026-09-24T12:00:00.000Z',
    lastIngestedAt: null,
    lastError: null,
  };

  it('reads a redacted Matrix configuration and sends credentials to the global route', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({
        config: {
          endpoint: 'https://matrix.example.test',
          username: '@verity:example.test',
          passwordConfigured: true,
        },
      }),
      json({ ok: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getMatrixConfig()).toEqual({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      passwordConfigured: true,
    });
    await client.saveMatrixConfig({
      endpoint: 'https://matrix.example.test',
      username: '@verity:example.test',
      password: 'private-password',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://host/integrations/matrix/config',
      'http://host/integrations/matrix/config',
    ]);
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(calls[1]?.init?.body).toBe(
      JSON.stringify({
        endpoint: 'https://matrix.example.test',
        username: '@verity:example.test',
        password: 'private-password',
      }),
    );
  });

  it('lists, binds, pauses, and disconnects a room through integration routes', async () => {
    const account = {
      id: '@verity:example.test',
      provider: 'matrix',
      endpoint: 'https://matrix.example.test',
      displayName: 'Matrix',
      status: 'online',
      lastError: null,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ accounts: [account], sources: [source] }),
      json({ sources: [source] }),
      json({ source }),
      json({ ok: true }),
      json({ ok: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const parsedSource = { ...source, importDiagnostics: [], importDiagnosticsTruncated: false };
    expect(await client.listIntegrations()).toEqual({
      accounts: [account],
      sources: [parsedSource],
    });
    expect(await client.listProjectIntegrations(projectId)).toEqual([parsedSource]);
    expect(
      await client.bindIntegrationSource(source.accountId, source.sourceId, projectId),
    ).toEqual(parsedSource);
    await client.pauseIntegrationSource(source.accountId, source.sourceId, true);
    await client.disconnectIntegrationSource(source.accountId, source.sourceId);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ['http://host/integrations', 'GET'],
      ['http://host/projects/project%2Fone/integrations', 'GET'],
      ['http://host/integrations/sources/bind', 'POST'],
      ['http://host/integrations/sources/pause', 'POST'],
      ['http://host/integrations/sources/disconnect', 'POST'],
    ]);
    expect(calls[2]?.init?.body).toBe(
      JSON.stringify({
        accountId: source.accountId,
        sourceId: source.sourceId,
        projectId,
      }),
    );
    expect(calls[3]?.init?.body).toBe(
      JSON.stringify({
        accountId: source.accountId,
        sourceId: source.sourceId,
        paused: true,
      }),
    );
    expect(calls[4]?.init?.body).toBe(
      JSON.stringify({
        accountId: source.accountId,
        sourceId: source.sourceId,
      }),
    );
  });
});

describe('VerityClient Google Drive browser', () => {
  it('encodes a Drive search query and pagination token', async () => {
    const { fetch, calls } = fakeFetch(json({ files: [], nextPageToken: 'next' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(
      client.listGoogleDriveFiles({
        query: 'project plan',
        sharedWithMe: true,
        pageToken: 'page/2',
      }),
    ).resolves.toEqual({ files: [], nextPageToken: 'next' });
    expect(calls[0]?.url).toBe(
      'http://host/google-drive/files?query=project+plan&sharedWithMe=true&pageToken=page%2F2',
    );
  });

  it('lists shared drives with pagination', async () => {
    const { fetch, calls } = fakeFetch(
      json({ drives: [{ id: 'drive-1', name: 'Finance' }], nextPageToken: 'next' }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listGoogleSharedDrives('page/2')).resolves.toEqual({
      drives: [{ id: 'drive-1', name: 'Finance' }],
      nextPageToken: 'next',
    });
    expect(calls[0]?.url).toBe('http://host/google-drive/drives?pageToken=page%2F2');
  });

  it('requests the Workspace picker and assigns its native selection', async () => {
    const file = {
      assignmentId: 'assignment-1',
      kind: 'docs',
      fileId: 'deck-1',
      name: 'Q3 review',
      webViewLink: 'https://docs.google.com/document/d/deck-1/edit',
      revisionId: 'rev-1',
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ files: [] }),
      json({ file: null }),
      json({ file }),
      json({}),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.listGoogleDriveFiles({ purpose: 'workspace' });
    await expect(client.getSessionGoogleWorkspaceFile('s1')).resolves.toBeNull();
    await expect(client.assignSessionGoogleWorkspaceFile('s1', 'deck-1')).resolves.toMatchObject({
      kind: 'docs',
      fileId: 'deck-1',
      name: 'Q3 review',
    });
    await client.clearSessionGoogleWorkspaceFile('s1');
    expect(calls[0]?.url).toBe('http://host/google-drive/files?purpose=workspace');
    expect(calls[1]?.url).toBe('http://host/sessions/s1/google-workspace/file');
    expect(calls[1]?.init?.method).toBe('GET');
    expect(calls[2]?.url).toBe('http://host/sessions/s1/google-workspace/file');
    expect(calls[2]?.init?.method).toBe('PUT');
    expect(JSON.parse(calls[2]?.init?.body as string)).toEqual({ fileId: 'deck-1' });
    expect(calls[3]?.url).toBe('http://host/sessions/s1/google-workspace/file');
    expect(calls[3]?.init?.method).toBe('DELETE');
  });
});

describe('VerityClient Gmail session access', () => {
  it('connects the account and toggles access for one encoded session', async () => {
    const connection = {
      enabled: true,
      accountEmail: 'person@example.com',
      clientId: 'google-client-id',
      connected: true,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ ...connection, enabled: false, connected: false }),
      json({ connected: true, accountEmail: 'person@example.com' }),
      json(connection),
      json({}),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.getSessionGmailConnection('session/1')).resolves.toMatchObject({
      enabled: false,
      connected: false,
    });
    await client.connectGmail({ code: 'code', codeVerifier: 'verifier', redirectUri: 'verity:/' });
    await expect(client.enableSessionGmail('session/1')).resolves.toEqual(connection);
    await client.disableSessionGmail('session/1');

    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/session%2F1/gmail',
      'http://host/gmail/connect',
      'http://host/sessions/session%2F1/gmail',
      'http://host/sessions/session%2F1/gmail',
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'verity:/',
    });
  });
});

describe('VerityClient Calendar session access', () => {
  it('connects the account and toggles access for one encoded session', async () => {
    const connection = {
      enabled: true,
      accountEmail: 'person@example.com',
      clientId: 'google-client-id',
      connected: true,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ ...connection, enabled: false, connected: false }),
      json({ connected: true, accountEmail: 'person@example.com' }),
      json(connection),
      json({}),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.getSessionCalendarConnection('session/1')).resolves.toMatchObject({
      enabled: false,
      connected: false,
    });
    await client.connectCalendar({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'verity:/',
    });
    await expect(client.enableSessionCalendar('session/1')).resolves.toEqual(connection);
    await client.disableSessionCalendar('session/1');

    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/session%2F1/calendar',
      'http://host/calendar/connect',
      'http://host/sessions/session%2F1/calendar',
      'http://host/sessions/session%2F1/calendar',
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'verity:/',
    });
  });
});

describe('VerityClient Contacts session access', () => {
  it('connects the account and toggles access for one encoded session', async () => {
    const connection = {
      enabled: true,
      accountEmail: 'person@example.com',
      clientId: 'google-client-id',
      connected: true,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ ...connection, enabled: false, connected: false }),
      json({ connected: true, accountEmail: 'person@example.com' }),
      json(connection),
      json({}),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.getSessionContactsConnection('session/1')).resolves.toMatchObject({
      enabled: false,
      connected: false,
    });
    await client.connectContacts({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'verity:/',
    });
    await expect(client.enableSessionContacts('session/1')).resolves.toEqual(connection);
    await client.disableSessionContacts('session/1');

    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/session%2F1/contacts',
      'http://host/contacts/connect',
      'http://host/sessions/session%2F1/contacts',
      'http://host/sessions/session%2F1/contacts',
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'verity:/',
    });
  });
});

describe('VerityClient health capabilities', () => {
  it('surfaces pushEnabled and remains compatible with older servers', async () => {
    const current = new VerityClient({
      baseUrl: 'http://host',
      fetch: fakeFetch(json({ status: 'ok', version: '1.2.3', pushEnabled: true })).fetch,
    });
    await expect(current.getHealth()).resolves.toEqual({
      status: 'ok',
      version: '1.2.3',
      pushEnabled: true,
    });

    const legacy = new VerityClient({
      baseUrl: 'http://host',
      fetch: fakeFetch(json({ status: 'ok' })).fetch,
    });
    await expect(legacy.getHealth()).resolves.toEqual({ status: 'ok' });
  });
});

describe('VerityClient.registerPushToken', () => {
  it('POSTs the expo token to the device-scoped route with the bearer', async () => {
    const { fetch, calls } = fakeFetch(json({ registered: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch, getToken: () => 'tok' });
    await expect(
      client.registerPushToken('dev id/1', {
        expoToken: 'ExponentPushToken[abc]',
        platform: 'ios',
      }),
    ).resolves.toEqual({ registered: true });
    expect(calls[0]?.url).toBe('http://host/devices/dev%20id%2F1/push-token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      expoToken: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('surfaces a 503 (push disabled server-side) as a VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'Push notifications are not configured' }, 503));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(
      client.registerPushToken('d1', { expoToken: 'ExponentPushToken[x]', platform: 'ios' }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('VerityClient auth (bearer token)', () => {
  function authHeader(call: Call | undefined): string | undefined {
    const headers = call?.init?.headers as Record<string, string> | undefined;
    return headers?.authorization;
  }

  it('omits Authorization when no token provider is set', async () => {
    const { fetch, calls } = fakeFetch(json([]));
    await new VerityClient({ baseUrl: 'http://host', fetch }).listSessions();
    expect(authHeader(calls[0])).toBeUndefined();
  });

  it('attaches Authorization: Bearer <token> when a token is available', async () => {
    const { fetch, calls } = fakeFetch(json([]));
    await new VerityClient({
      baseUrl: 'http://host',
      fetch,
      getToken: () => 'tok-abc',
    }).listSessions();
    expect(authHeader(calls[0])).toBe('Bearer tok-abc');
  });

  it('omits Authorization when the provider returns null (no token yet)', async () => {
    const { fetch, calls } = fakeFetch(json([]));
    await new VerityClient({ baseUrl: 'http://host', fetch, getToken: () => null }).listSessions();
    expect(authHeader(calls[0])).toBeUndefined();
  });

  it('reads the token per request, so a rotated token is picked up', async () => {
    const { fetch, calls } = fakeFetchSequence(json([]), json([]));
    let token = 'first';
    const client = new VerityClient({ baseUrl: 'http://host', fetch, getToken: () => token });
    await client.listSessions();
    token = 'second';
    await client.listSessions();
    expect(authHeader(calls[0])).toBe('Bearer first');
    expect(authHeader(calls[1])).toBe('Bearer second');
  });

  it('mints a live ticket over authenticated HTTP', async () => {
    const expiresAt = '2026-08-30T18:00:00.000Z';
    const ticket = 'A'.repeat(43);
    const { fetch, calls } = fakeFetch(json({ ticket, expiresAt }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch, getToken: () => 'device' });
    await expect(client.createLiveTicket()).resolves.toEqual({ ticket, expiresAt });
    expect(calls[0]?.url).toBe('http://host/live/ticket');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(authHeader(calls[0])).toBe('Bearer device');
  });

  it('unlockSecret returns the minted token and sends the device label', async () => {
    const { fetch, calls } = fakeFetch(json({ status: 'unlocked', token: 'T', tokenId: 'id1' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.unlockSecret('correct-horse-battery', 'iPhone');
    expect(result).toEqual({ status: 'unlocked', token: 'T', tokenId: 'id1' });
    expect(calls[0]?.url).toBe('http://host/secret/unlock');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '')).toEqual({
      password: 'correct-horse-battery',
      deviceLabel: 'iPhone',
    });
  });

  it('initSecretPassword returns the minted token (gate active)', async () => {
    const { fetch } = fakeFetch(json({ status: 'unlocked', token: 'T2', tokenId: 'id2' }));
    const result = await new VerityClient({ baseUrl: 'http://host', fetch }).initSecretPassword(
      'correct-horse-battery',
    );
    expect(result.token).toBe('T2');
  });

  it('performs pairing and presents the one-use bootstrap only to the password on-ramp', async () => {
    const responses = [
      json({
        serverId: 'srv_0123456789abcdef',
        identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        signature: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
      json({
        bootstrapToken: 'abcdefghijklmnopqrstuvwxyz_0123456789',
        expiresAt: '2026-08-29T12:05:00.000Z',
      }),
      json({ status: 'unlocked', token: 'device-token' }),
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        ...(init === undefined ? {} : { init }),
      });
      return responses.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const client = new VerityClient({ baseUrl: 'https://host', fetch });
    await client.fetchPairingIdentity('abcdefghijklmnopqrstuvwxyz_012345');
    const redeemed = await client.redeemPairingCode('abcdefghijklmnopqrstuvwxyz_0123456789');
    await client.initSecretPassword(
      'correct horse battery staple',
      'iPhone',
      redeemed.bootstrapToken,
    );
    expect(calls[2]?.init?.headers).toMatchObject({
      'x-verity-pairing': redeemed.bootstrapToken,
    });
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[1]?.init?.headers).not.toHaveProperty('x-verity-pairing');
  });

  it('tolerates a gate-off deployment (no token in the unlock response)', async () => {
    const { fetch } = fakeFetch(json({ status: 'unlocked' }));
    const result = await new VerityClient({ baseUrl: 'http://host', fetch }).unlockSecret(
      'pw-pw-pw-pw',
    );
    expect(result).toEqual({ status: 'unlocked' });
    expect(result.token).toBeUndefined();
  });

  it('fires onUnauthorized when a gated route 401s AND a token was sent', async () => {
    const { fetch } = fakeFetch(json({ error: 'unauthorized' }, 401));
    let called = 0;
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch,
      getToken: () => 'stale-token',
      onUnauthorized: () => (called += 1),
    });
    await expect(client.listSessions()).rejects.toBeInstanceOf(VerityApiError);
    expect(called).toBe(1);
  });

  it('does NOT fire onUnauthorized on a 401 when no token was sent', async () => {
    // Guards the biometric-cancel case: with no token loaded, a 401 must not
    // wipe the still-valid stored credential — it just means "not unlocked yet".
    const { fetch } = fakeFetch(json({ error: 'unauthorized' }, 401));
    let called = 0;
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch,
      getToken: () => null,
      onUnauthorized: () => (called += 1),
    });
    await expect(client.listSessions()).rejects.toBeInstanceOf(VerityApiError);
    expect(called).toBe(0);
  });

  it('does NOT fire onUnauthorized for a 401 on the /secret/* on-ramp', async () => {
    const { fetch } = fakeFetch(json({ error: 'incorrect master password' }, 401));
    let called = 0;
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch,
      onUnauthorized: () => (called += 1),
    });
    await expect(client.unlockSecret('wrong-password')).rejects.toBeInstanceOf(VerityApiError);
    expect(called).toBe(0);
  });
});

describe('VerityClient.listSessions', () => {
  it('fetches and validates the session list', async () => {
    const summary = {
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: 'Fix login',
      status: 'running',
      usage: ZERO_USAGE,
      rateLimit: {
        status: 'rejected',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        providerLabel: 'Codex',
      },
      rateLimits: [
        {
          status: 'allowed',
          resetsAt: 1_700_000_000,
          window: 'weekly',
          usedPercent: 76,
          providerLabel: 'Codex',
        },
      ],
    };
    const { fetch, calls } = fakeFetch(json([summary]));
    const client = new VerityClient({ baseUrl: 'http://host:3000/', fetch });

    const sessions = await client.listSessions();

    expect(sessions).toEqual([summary]);
    expect(calls[0]?.url).toBe('http://host:3000/sessions'); // trailing slash trimmed
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('throws on a drifted response shape (validation fails loudly)', async () => {
    const { fetch } = fakeFetch(json([{ sessionId: 's1' }])); // missing fields
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listSessions()).rejects.toThrow();
  });

  // The per-session signal rides the DEFAULT list rather than the envelope. That
  // is only safe because `z.object` STRIPS keys the schema does not name — which
  // is also why the schema has to name it: an unlisted field is dropped silently,
  // not loudly.
  it('keeps a per-session attention signal sent on the bare list', async () => {
    const attention = [{ code: 'sandbox_disconnected', message: 'Sandbox replaced' }];
    const { fetch } = fakeFetch(
      json([
        {
          sessionId: 's1',
          worktree: '/wt/s1',
          model: 'm',
          name: null,
          status: 'running',
          usage: ZERO_USAGE,
          attention,
        },
      ]),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect((await client.listSessions())[0]?.attention).toEqual(attention);
  });
});

describe('VerityClient.listSessionOverview', () => {
  const summary = {
    sessionId: 's1',
    worktree: '/wt/s1',
    model: 'm',
    name: null,
    status: 'running' as const,
    usage: ZERO_USAGE,
  };

  it('asks for the envelope and returns the attention signals with the list', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        sessions: [summary],
        attention: [{ code: 'secret_sealed', message: 'Server is sealed' }],
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host:3000/', fetch });

    const overview = await client.listSessionOverview();

    expect(calls[0]?.url).toBe('http://host:3000/sessions?envelope=1');
    expect(overview.sessions).toEqual([summary]);
    expect(overview.attention).toEqual([{ code: 'secret_sealed', message: 'Server is sealed' }]);
  });

  // `action` is what the banner turns into a tap, and it crosses this parse before
  // anything renders it. Asserted here because zod strips what the schema does not
  // declare: dropping the field, or tightening the object around the two keys that
  // predate it, would leave a banner that still reads correctly and no longer opens
  // the one screen that fixes the condition — with every other test still green.
  it('keeps the remedy an attention signal names', async () => {
    const { fetch } = fakeFetch(
      json({
        sessions: [],
        attention: [
          {
            code: 'usage_probe_unhealthy',
            message: 'Codex sign-in was refused',
            action: 'codex-login',
          },
        ],
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const overview = await client.listSessionOverview();
    expect(overview.attention[0]?.action).toBe('codex-login');
  });

  // A server that grows the field into a shape this build cannot read must cost the
  // button and nothing else. Failing the parse here would drop the SENTENCE too,
  // which is the half that always stands on its own.
  it('drops a remedy it cannot read without losing the signal', async () => {
    const { fetch } = fakeFetch(
      json({
        sessions: [],
        attention: [
          {
            code: 'usage_probe_unhealthy',
            message: 'Codex sign-in was refused',
            action: { kind: 'codex-login' },
          },
        ],
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const overview = await client.listSessionOverview();
    expect(overview.attention[0]?.message).toBe('Codex sign-in was refused');
    expect(overview.attention[0]?.action).toBeUndefined();
  });

  it('reads a healthy envelope (no attention key) as no signals', async () => {
    const { fetch } = fakeFetch(json({ sessions: [summary] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listSessionOverview()).toEqual({
      sessions: [summary],
      attention: [],
      sessionReordering: false,
    });
  });

  // A server that predates the envelope ignores the query parameter and answers
  // with the bare array it always did. That must keep working, or upgrading the
  // app before the server would empty the session list.
  it('accepts the bare array an older server still returns', async () => {
    const { fetch } = fakeFetch(json([summary]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listSessionOverview()).toEqual({
      sessions: [summary],
      attention: [],
      sessionReordering: false,
    });
  });

  // Symmetrically: a server NEWER than this app may add a code it never heard of.
  it('accepts an attention code this build does not know', async () => {
    const { fetch } = fakeFetch(
      json({ sessions: [], attention: [{ code: 'from_the_future', message: 'Look at me' }] }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const overview = await client.listSessionOverview();
    expect(overview.attention).toEqual([{ code: 'from_the_future', message: 'Look at me' }]);
  });
});

describe('VerityClient.searchMessages', () => {
  it('encodes contextual search filters and validates results', async () => {
    const item = {
      id: 7,
      sessionId: 's1',
      sessionName: 'Search work',
      projectId: 'p1',
      projectName: 'heey-global/verity',
      role: 'agent',
      kind: 'text',
      text: 'A matching message',
      firstEventSeq: 12,
      createdAt: 1234,
    };
    const { fetch, calls } = fakeFetch(json({ items: [item], nextCursor: 'next' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(
      client.searchMessages({ query: 'matching message', sessionId: 's1', limit: 20 }),
    ).resolves.toEqual({ items: [item], nextCursor: 'next' });
    expect(calls[0]?.url).toBe(
      'http://host/search/messages?q=matching+message&sessionId=s1&limit=20',
    );
  });
});

describe('VerityClient.listProviderLimits', () => {
  it('fetches and validates provider limit rows', async () => {
    const limits = [
      {
        status: 'allowed',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        usedPercent: 33,
        providerLabel: 'Claude',
      },
      {
        status: 'rejected',
        resetsAt: 1_700_000_100,
        window: 'weekly',
        usedPercent: 100,
        providerLabel: 'Claude',
      },
    ];
    const { fetch, calls } = fakeFetch(json(limits));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listProviderLimits()).resolves.toEqual(limits);
    expect(calls[0]?.url).toBe('http://host/provider-limits');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('degrades to [] when an older server lacks the route', async () => {
    const { fetch } = fakeFetch(json({ error: 'not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listProviderLimits()).resolves.toEqual([]);
  });
});

describe('VerityClient meeting transcripts', () => {
  it('uploadMeetingAudio posts audio for session transcription', async () => {
    const created = {
      path: 'docs/meetings/2026-07-06-planning-abcdef12.md',
      title: 'Planning',
      segments: 2,
    };
    const { fetch, calls } = fakeFetch(json(created));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(
      client.uploadMeetingAudio('s/1', {
        fileName: 'planning.m4a',
        mediaType: 'audio/mp4',
        data: 'YXVkaW8=',
        title: 'Planning',
      }),
    ).resolves.toEqual(created);
    expect(calls[0]?.url).toBe('http://host/sessions/s%2F1/meetings/transcripts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        fileName: 'planning.m4a',
        mediaType: 'audio/mp4',
        data: 'YXVkaW8=',
        title: 'Planning',
      }),
    );
  });

  it('streams file-backed meeting audio and accepts background transcription', async () => {
    const { fetch, calls } = fakeFetch(json({ accepted: true }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch, uploadFetch: fetch });
    const data = new Blob(['audio'], { type: 'audio/mp4' });
    await expect(
      client.uploadMeetingAudio('s/1', {
        fileName: 'long planning.m4a',
        mediaType: 'audio/mp4',
        data,
        title: 'Long Planning',
        clientRequestId: 'upload ä',
      }),
    ).resolves.toEqual({ accepted: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s%2F1/meetings/transcripts/stream');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-verity-meeting-file-name': 'long%20planning.m4a',
        'x-verity-meeting-media-type': 'audio%2Fmp4',
        'x-verity-meeting-title': 'Long%20Planning',
        'x-verity-meeting-client-request-id': 'upload%20%C3%A4',
      },
      body: data,
    });
  });

  it('uses an iOS background session when the native file supports it', async () => {
    const upload = vi.fn().mockResolvedValue({
      status: 202,
      body: JSON.stringify({ accepted: true }),
      headers: {},
    });
    const data = Object.assign(new Blob(['audio'], { type: 'audio/mp4' }), { upload });
    const client = new VerityClient({
      baseUrl: 'http://host',
      getToken: () => 'device-token',
    });
    await expect(
      client.uploadMeetingAudio('s1', {
        fileName: 'two-hours.m4a',
        mediaType: 'audio/mp4',
        data,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(upload).toHaveBeenCalledWith('http://host/sessions/s1/meetings/transcripts/stream', {
      httpMethod: 'POST',
      headers: {
        authorization: 'Bearer device-token',
        'content-type': 'application/octet-stream',
        'x-verity-meeting-file-name': 'two-hours.m4a',
        'x-verity-meeting-media-type': 'audio%2Fmp4',
      },
      sessionType: 'background',
    });
  });

  it('invalidates a rejected token after a native background upload', async () => {
    const upload = vi.fn().mockResolvedValue({
      status: 401,
      body: JSON.stringify({ error: 'unauthorized' }),
      headers: {},
    });
    const onUnauthorized = vi.fn();
    const client = new VerityClient({
      baseUrl: 'http://host',
      getToken: () => 'revoked-token',
      onUnauthorized,
    });
    await expect(
      client.uploadMeetingAudio('s1', {
        fileName: 'meeting.m4a',
        mediaType: 'audio/mp4',
        data: Object.assign(new Blob(['audio']), { upload }),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('live read observations', () => {
  it('records eligible reads, replays them to a later subscriber and detaches', async () => {
    const { fetch } = fakeFetchSequence(json([]), json([]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.listProjects();
    const observed = vi.fn();
    const detach = client.observeReads(observed);
    expect(observed).toHaveBeenCalledWith({ path: '/projects' });
    detach();
    await client.listProjects();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('retains a resource subscription after an initial read fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listProjects()).rejects.toThrow('offline');
    const observed = vi.fn();
    client.observeReads(observed);
    expect(observed).toHaveBeenCalledWith({ path: '/projects' });
  });

  it('watches a meeting feed independently of its incremental read cursor', async () => {
    const { fetch } = fakeFetch(json({ cursor: 1, meetings: [], notes: [] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const observed = vi.fn();
    client.observeReads(observed);
    await client.getLiveMeetingChanges('s', 123);
    expect(observed).toHaveBeenCalledWith({ path: '/sessions/s/live-meetings' });
  });
});

describe('VerityClient.listProjects (#174)', () => {
  const project = {
    id: 'p1',
    kind: 'github',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global-verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  };
  const settings = {
    projectId: 'p1',
    dopplerProject: null,
    dopplerConfig: null,
    defaultBranch: 'main',
    defaultModel: 'claude-sonnet-4-6',
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  };

  it('fetches and validates the project list', async () => {
    const { fetch, calls } = fakeFetch(json([project]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listProjects()).toEqual([project]);
    expect(calls[0]?.url).toBe('http://host/projects');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('persists project order', async () => {
    const { fetch, calls } = fakeFetch(json([project]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.reorderProjects(['p2', 'p1'])).toEqual([project]);
    expect(calls[0]?.url).toBe('http://host/projects/order');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ ids: ['p2', 'p1'] }));
  });

  it('persists a project collapse state', async () => {
    const { fetch, calls } = fakeFetch(json({ ...project, collapsed: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.setProjectCollapsed('p1', true)).toEqual({ ...project, collapsed: true });
    expect(calls[0]?.url).toBe('http://host/projects/p1/collapsed');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ collapsed: true }));
  });

  it('maps a 503 (fleet registry not configured) to an empty list', async () => {
    const { fetch } = fakeFetch(json({ error: 'not configured' }, 503));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listProjects()).toEqual([]);
  });

  it('fetches repository issues with validated connection metadata', async () => {
    const result = {
      connected: true,
      viewerLogin: null,
      issues: [
        {
          number: 42,
          title: 'Fix layout',
          url: 'https://github.com/acme/app/issues/42',
          labels: ['bug'],
          assignees: ['alice'],
        },
      ],
    };
    const { fetch, calls } = fakeFetch(json(result));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listProjectGitHubIssues('p/1')).toEqual(result);
    expect(calls[0]?.url).toBe('http://host/projects/p%2F1/github/issues');
  });

  it('fetches available GitHub repositories separately from created projects', async () => {
    const { fetch, calls } = fakeFetch(json([project]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listAvailableRepositories()).toEqual([project]);
    expect(calls[0]?.url).toBe('http://host/github/repositories');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('fetches project detail with bound sessions', async () => {
    const detail = {
      project,
      settings,
      sessions: [
        {
          sessionId: 's1',
          worktree: '/wt/s1',
          model: 'm',
          name: null,
          projectId: 'p1',
          status: 'idle',
          usage: ZERO_USAGE,
          resumable: true,
        },
      ],
    };
    const { fetch, calls } = fakeFetch(json(detail));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getProject('p/1')).toEqual(detail);
    expect(calls[0]?.url).toBe('http://host/projects/p%2F1');
  });

  it('updates project settings', async () => {
    const { fetch, calls } = fakeFetch(json({ settings }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(
      await client.updateProjectSettings('p/1', {
        defaultBranch: 'main',
      }),
    ).toEqual(settings);
    expect(calls[0]?.url).toBe('http://host/projects/p%2F1/settings');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        defaultBranch: 'main',
      }),
    );
  });

  it('creates a project', async () => {
    const { fetch, calls } = fakeFetch(json({ project }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.createProject({ repo: 'heey-global/verity' })).toEqual(project);
    expect(calls[0]?.url).toBe('http://host/projects');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ repo: 'heey-global/verity' }));
  });

  it('deprovisions a project and forwards purge=true in the query string', async () => {
    const { fetch, calls } = fakeFetch(json({ project: { ...project, state: 'absent' } }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.deprovisionProject('p1', { purge: true })).toMatchObject({
      id: 'p1',
      state: 'absent',
    });
    expect(calls[0]?.url).toBe('http://host/projects/p1/deprovision?purge=true');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('sleeps and wakes a project', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ project: { ...project, lifecycleState: 'sleeping' } }),
      json({ project }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.sleepProject('p/1')).toMatchObject({ lifecycleState: 'sleeping' });
    expect(await client.wakeProject('p/1')).toMatchObject({ id: 'p1', state: 'active' });
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['POST', 'http://host/projects/p%2F1/sleep'],
      ['POST', 'http://host/projects/p%2F1/wake'],
    ]);
  });

  it('deletes a project', async () => {
    const { fetch, calls } = fakeFetch(json({ projectId: 'p/1' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.deleteProject('p/1')).toEqual({ projectId: 'p/1' });
    expect(calls[0]?.url).toBe('http://host/projects/p%2F1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('repairs a project', async () => {
    const { fetch, calls } = fakeFetch(json({ project: { ...project, state: 'cloning' } }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.repairProject('p/1')).toMatchObject({
      id: 'p1',
      state: 'cloning',
    });
    expect(calls[0]?.url).toBe('http://host/projects/p%2F1/repair');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('confirms project repair warnings when requested', async () => {
    const { fetch, calls } = fakeFetch(json({ project: { ...project, state: 'cloning' } }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.repairProject('p/1', { confirmWarnings: true });

    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ confirmWarnings: true }));
  });

  it('refreshes a project token through Verity Control without exposing the token value', async () => {
    const refreshed = { projectId: 'p/1', refreshedAt: '2026-06-30T12:00:00.000Z' };
    const { fetch, calls } = fakeFetch(json(refreshed));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.refreshProjectToken('p/1')).toEqual(refreshed);
    expect(calls[0]?.url).toBe('http://host/verity-control/projects/p%2F1/refresh-token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.stringify(refreshed)).not.toContain('ghs_');
  });

  it('recreates a project container through Verity Control', async () => {
    const { fetch, calls } = fakeFetch(
      json({ project: { ...project, state: 'container_starting' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.recreateProjectContainer('p/1')).toMatchObject({
      id: 'p1',
      state: 'container_starting',
    });
    expect(calls[0]?.url).toBe('http://host/verity-control/projects/p%2F1/recreate-container');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('confirms project recreate warnings when requested', async () => {
    const { fetch, calls } = fakeFetch(
      json({ project: { ...project, state: 'container_starting' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.recreateProjectContainer('p/1', { confirmWarnings: true });

    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ confirmWarnings: true }));
  });

  it('asks for a forced image rebuild only when the caller sets it', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ project: { ...project, state: 'container_starting' } }),
      json({ project: { ...project, state: 'container_starting' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.recreateProjectContainer('p/1', { confirmWarnings: true, forceRebuild: true });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ confirmWarnings: true, forceRebuild: true }),
    );

    // The ordinary update must keep its cached image: an unset flag is absent
    // from the body, not sent as `false`.
    await client.recreateProjectContainer('p/1', { confirmWarnings: true });
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ confirmWarnings: true }));
  });
});

describe('VerityClient.settings', () => {
  const settings = {
    advancedModeEnabled: false,
    gitUserName: 'h-teske',
    gitUserEmail: 'developer@example.com',
    gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
    gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
    gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
    gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
    gitSshPrivateKeyConfigured: true,
    gitSshPublicKeyConfigured: true,
    gitKnownHostsConfigured: true,
    gitAllowedSignersConfigured: true,
    githubAppId: '3836338',
    githubAppInstallationId: '135112757',
    githubAppPrivateKeyConfigured: true,
    dopplerServiceTokenConfigured: false,
    transcribeBaseUrl: 'https://api.example.test/v1',
    transcribeModel: 'whisper-test',
    transcribeBackendMode: 'external',
    transcribeApiKeyConfigured: true,
    transcribeLocalAvailable: true,
    transcribeExternalConfigured: true,
    claudeCodeOauthCredentialsConfigured: false,
    codexAuthJsonConfigured: false,
    uplinkSubscriptionKeyConfigured: false,
    uplinkInstallationId: null,
    googleDriveClientId: null,
    googleDriveAccountEmail: null,
    googleDriveConnected: false,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };

  it('fetches central Verity settings', async () => {
    const { fetch, calls } = fakeFetch(json({ settings }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getVeritySettings()).toEqual(settings);
    expect(calls[0]?.url).toBe('http://host/settings');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('treats a server that predates the external-configured flag as not configured', async () => {
    // Version skew must not break the settings screen, and the safe end of the
    // guess is "not configured": under-claiming asks the operator to fill in a
    // backend, while over-claiming would show a ready pill for uploads the
    // server then rejects.
    const older: Record<string, unknown> = { ...settings };
    delete older.transcribeExternalConfigured;
    const { fetch } = fakeFetch(json({ settings: older }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect((await client.getVeritySettings())?.transcribeExternalConfigured).toBe(false);
  });

  it('fetches transcription setup capability without exposing a token', async () => {
    const status = {
      transcribeBackendMode: null,
      transcribeBaseUrl: null,
      transcribeModel: null,
      transcribeApiKeyConfigured: false,
      transcribeLocalAvailable: true,
      // A deployment-supplied transcriber command has no endpoint to report
      // here, so this flag is the only thing that can tell the app it is set up.
      transcribeExternalConfigured: true,
    };
    const { fetch, calls } = fakeFetch(json(status));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getMeetingTranscriptionBackendStatus()).toEqual(status);
    expect(calls[0]?.url).toBe('http://host/settings/transcription');
    expect(JSON.stringify(status)).not.toContain('apiKey');
  });

  it('reads a transcription status without the configured flag as not configured', async () => {
    const older = {
      transcribeBackendMode: 'external',
      transcribeBaseUrl: null,
      transcribeModel: null,
      transcribeApiKeyConfigured: false,
      transcribeLocalAvailable: false,
    };
    const { fetch } = fakeFetch(json(older));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect((await client.getMeetingTranscriptionBackendStatus()).transcribeExternalConfigured).toBe(
      false,
    );
  });

  it('persists the first-use transcription backend through the dedicated endpoint', async () => {
    const { fetch, calls } = fakeFetch(json({ mode: 'local' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.updateMeetingTranscriptionBackendMode('local');
    expect(calls[0]?.url).toBe('http://host/settings/transcription/backend');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ mode: 'local' }));
  });

  it('allows an unconfigured settings response', async () => {
    const { fetch } = fakeFetch(json({ settings: null }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.getVeritySettings()).resolves.toBeNull();
  });

  it('updates central Verity settings without sending key material', async () => {
    const patch = {
      gitUserName: 'h-teske',
      gitUserEmail: 'developer@example.com',
      gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
    };
    const { fetch, calls } = fakeFetch(json({ settings }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.updateVeritySettings(patch)).toEqual(settings);
    expect(calls[0]?.url).toBe('http://host/settings');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(patch));
    expect(calls[0]?.init?.body).not.toContain('not-a-real-private-key-fixture');
  });
});

describe('VerityClient.fetchOnboardingStatus (#320)', () => {
  const complete = {
    sealed: false,
    masterPasswordSet: true,
    githubAppConfigured: true,
    signingKeyConfigured: true,
    hasProject: true,
    dopplerConfigured: false,
    claudeConfigured: false,
    codexConfigured: false,
    complete: true,
    nextStep: null,
  };

  it('fetches and validates the onboarding status', async () => {
    const { fetch, calls } = fakeFetch(json(complete));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.fetchOnboardingStatus()).toEqual(complete);
    expect(calls[0]?.url).toBe('http://host/onboarding/status');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('recognizes an older server with an OpenCode-only setup', async () => {
    const { fetch } = fakeFetch(
      json({
        ...complete,
        githubAppConfigured: false,
        signingKeyConfigured: false,
        complete: false,
        nextStep: 'github',
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    vi.spyOn(client, 'getVeritySettings').mockResolvedValue({
      opencodeApiKeyConfigured: true,
      opencodeBaseUrl: 'https://models.example.test',
      opencodeModels: '["test-model"]',
    } as NonNullable<Awaited<ReturnType<VerityClient['getVeritySettings']>>>);
    expect((await client.fetchOnboardingStatus()).opencodeConfigured).toBe(true);
  });

  it.each([
    { catalog: 'one,two', disabled: 'one\ntwo', ready: false },
    { catalog: 'one,two', disabled: 'one', ready: true },
    { catalog: ' , \n ', disabled: null, ready: false },
  ])(
    'checks enabled OpenCode models on an older server ($ready)',
    async ({ catalog, disabled, ready }) => {
      const { fetch } = fakeFetch(json({ ...complete, complete: false, nextStep: 'github' }));
      const client = new VerityClient({ baseUrl: 'http://host', fetch });
      vi.spyOn(client, 'getVeritySettings').mockResolvedValue({
        opencodeApiKeyConfigured: true,
        opencodeBaseUrl: 'https://models.example.test',
        opencodeModels: catalog,
        opencodeDisabledModels: disabled,
      } as NonNullable<Awaited<ReturnType<VerityClient['getVeritySettings']>>>);
      expect((await client.fetchOnboardingStatus()).opencodeConfigured).toBe(ready);
    },
  );

  it('parses an incomplete status with a nextStep', async () => {
    const incomplete = {
      ...complete,
      masterPasswordSet: false,
      complete: false,
      sealed: true,
      nextStep: 'master-password',
    };
    const { fetch } = fakeFetch(json(incomplete));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.fetchOnboardingStatus()).resolves.toEqual(incomplete);
  });

  it('throws on a drifted response shape (validation fails loudly)', async () => {
    const { fetch } = fakeFetch(json({ sealed: true })); // missing fields
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.fetchOnboardingStatus()).rejects.toThrow();
  });
});

describe('VerityClient.getSession', () => {
  it('returns the validated detail', async () => {
    const detail = {
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: null,
      status: 'idle',
      usage: ZERO_USAGE,
      eventCount: 3,
    };
    const { fetch } = fakeFetch(json(detail));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getSession('s1')).toEqual(detail);
  });

  it('maps a 404 to a VerityApiError carrying the status and server message', async () => {
    const { fetch } = fakeFetch(json({ error: 'session s9 not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getSession('s9')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 404,
      message: 'session s9 not found',
    });
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getSession('a/b')).rejects.toBeInstanceOf(VerityApiError);
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb');
  });
});

describe('VerityClient.getActivity', () => {
  it('parses the activity shape with id-carrying queued items (#80)', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        busy: true,
        queued: [
          {
            id: 'q1',
            text: 'a',
            attachments: [{ kind: 'image', mediaType: 'image/png', id: 'image-id' }],
          },
          { id: 'q2', text: 'b' },
        ],
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getActivity('s1')).toEqual({
      busy: true,
      queued: [
        {
          id: 'q1',
          text: 'a',
          attachments: [{ kind: 'image', mediaType: 'image/png', id: 'image-id' }],
        },
        { id: 'q2', text: 'b' },
      ],
    });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/activity');
  });

  it('coerces a bare-string queued item from an older server to an id-less item', async () => {
    // Back-compat: a pre-#80 server sends `queued: string[]`. It still renders as a
    // waiting bubble, just without a retract handle (empty id).
    const { fetch } = fakeFetch(json({ busy: true, queued: ['a', 'b'] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getActivity('s1')).toEqual({
      busy: true,
      queued: [
        { id: '', text: 'a' },
        { id: '', text: 'b' },
      ],
    });
  });

  it('parses the optional live branch (#110), present or absent', async () => {
    const { fetch: f1 } = fakeFetch(json({ busy: false, queued: [], branch: 'feat/122-x' }));
    expect(await new VerityClient({ baseUrl: 'http://host', fetch: f1 }).getActivity('s1')).toEqual(
      {
        busy: false,
        queued: [],
        branch: 'feat/122-x',
      },
    );
    // Absent (unconfigured / older server) parses fine → branch undefined.
    const { fetch: f2 } = fakeFetch(json({ busy: false, queued: [] }));
    expect(
      (await new VerityClient({ baseUrl: 'http://host', fetch: f2 }).getActivity('s1')).branch,
    ).toBeUndefined();
  });

  it('throws on a malformed activity response', async () => {
    const { fetch } = fakeFetch(json({ busy: 'yes' })); // wrong type + missing queued
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getActivity('s1')).rejects.toThrow();
  });
});

describe('VerityClient.getHistory', () => {
  it('attributes history response phases to the request gesture, never a later return', async () => {
    const first = beginSessionSwitch('timed-session');
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const request = client.getHistory('timed-session');
    beginSessionSwitch('other');
    const returned = beginSessionSwitch('timed-session');
    resolve(new Response(JSON.stringify({ events: [], hasMore: false })));
    await request;
    expect(first.phases.map((p) => p.phase)).toEqual(['events-request-start']);
    expect(returned.phases).toEqual([]);
  });
  it('separates fetch, body read, JSON parse and schema processing', async () => {
    const timing = beginSessionSwitch('phase-session');
    const { fetch } = fakeFetch(json({ events: [], hasMore: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.getHistory('phase-session');
    expect(timing.phases.map((p) => p.phase)).toEqual([
      'events-request-start',
      'events-fetch-return',
      'events-body-read-start',
      'events-body-read-end',
      'events-json-parse-end',
      'events-schema-end',
    ]);
  });

  it('assembles the query string and parses the page', async () => {
    const page = {
      events: [{ seq: 7, event: { t: 'text', delta: 'hi' } }],
      hasMore: true,
    };
    const { fetch, calls } = fakeFetch(json(page));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getHistory('s1', { beforeSeq: 10, limit: 40 })).toEqual(page);
    expect(calls[0]?.url).toBe('http://host/sessions/s1/events?beforeSeq=10&limit=40');
  });

  it('omits the query string when no options are given', async () => {
    const { fetch, calls } = fakeFetch(json({ events: [], hasMore: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.getHistory('s1');
    expect(calls[0]?.url).toBe('http://host/sessions/s1/events');
  });

  it('throws on a malformed history response', async () => {
    const { fetch } = fakeFetch(
      json({ events: [{ seq: -1, event: { t: 'nope' } }], hasMore: false }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getHistory('s1')).rejects.toThrow();
  });
});

describe('VerityClient.reportScrollDiagnostic', () => {
  it('posts mobile scroll diagnostics for a session', async () => {
    const diagnostic = {
      event: 'programmatic-scroll-delta',
      seq: 3,
      at: 1_700_000_000,
      data: { dy: -240, followStream: false },
    };
    const { fetch, calls } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.reportScrollDiagnostic('s1', diagnostic);

    expect(calls[0]?.url).toBe('http://host/sessions/s1/debug/scroll');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(diagnostic));
  });
});

describe('VerityClient.sendTurn', () => {
  const body: TurnRequest = { prompt: 'go', permissionMode: 'plan', allowedTools: ['Read'] };

  it('posts the turn body and returns the acceptance', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', accepted: true }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.sendTurn('s1', body);

    expect(res).toEqual({ sessionId: 's1', accepted: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/turns');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body));
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('rejects a malformed acceptance body (accepted must be literally true)', async () => {
    const { fetch } = fakeFetch(json({ sessionId: 's1', accepted: false }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.sendTurn('s1', body)).rejects.toThrow();
  });

  it('maps a 409 (busy) to a VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: "session 's1' is busy with another turn" }, 409));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.sendTurn('s1', body)).rejects.toMatchObject({ status: 409 });
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    const { fetch } = fakeFetch(new Response('upstream boom', { status: 502 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.sendTurn('s1', body)).rejects.toMatchObject({ status: 502 });
  });

  it('carries the rejected attachment detail of a 400 through to the caller', async () => {
    // The screen renders this message verbatim as "Send failed: …". Collapsing
    // it to a status-derived string is the failure this pins: the operator would
    // be back to re-picking every file to find the one the server refused.
    const error = '"quarterly.pdf" is empty; attachment 3 is empty';
    const { fetch } = fakeFetch(json({ error, code: 'invalidAttachments' }, 400));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.sendTurn('s1', body)).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 400,
      message: error,
      code: 'invalidAttachments',
    });
  });

  it('falls back to a status message when the JSON error body has no string error', async () => {
    // JSON body present but no usable `error` key → status-derived fallback.
    const { fetch } = fakeFetch(json({ detail: 42 }, 500));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.sendTurn('s1', body)).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 500,
    });
  });
});

describe('VerityClient.cancelTurn (#79)', () => {
  it('posts to the cancel route and returns the cancelled flag', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', cancelled: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.cancelTurn('s1');

    expect(res).toEqual({
      sessionId: 's1',
      cancelled: true,
      forceReleased: false,
      droppedQueued: [],
    });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/cancel');
    expect(calls[0]?.init?.method).toBe('POST');
    // The default must be the safe one on the wire, not just in the caller.
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ force: false }));
  });

  it('returns cancelled: false for an idle no-op', async () => {
    const { fetch } = fakeFetch(json({ sessionId: 's1', cancelled: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.cancelTurn('s1')).resolves.toEqual({
      sessionId: 's1',
      cancelled: false,
      forceReleased: false,
      droppedQueued: [],
    });
  });

  it('sends force and surfaces whether a fence was actually lifted', async () => {
    const { fetch, calls } = fakeFetch(
      json({ sessionId: 's1', cancelled: false, forceReleased: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.cancelTurn('s1', { force: true });

    expect(calls[0]?.init?.body).toBe(JSON.stringify({ force: true }));
    expect(res.forceReleased).toBe(true);
  });

  it('defaults forceReleased to false against a server that predates the flag', async () => {
    // An old server answers without the field. Defaulting it to true — or leaving it
    // undefined for a truthiness check — would report an override that never happened.
    const { fetch } = fakeFetch(json({ sessionId: 's1', cancelled: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.cancelTurn('s1', { force: true })).resolves.toMatchObject({
      forceReleased: false,
    });
  });

  it('maps a 404 (unknown session) to a VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'session s9 not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.cancelTurn('s9')).rejects.toMatchObject({ status: 404 });
  });
});

describe('VerityClient.cancelQueued (retract, #80)', () => {
  it('posts to the retract route and returns the prompt to edit', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', itemId: 'q1', prompt: 'fix me' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.cancelQueued('s1', 'q1');

    expect(res).toEqual({ sessionId: 's1', itemId: 'q1', prompt: 'fix me' });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/queue/q1/cancel');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('maps a 404 (already drained / retracted) to a VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'queued turn q1 not found for session s1' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.cancelQueued('s1', 'q1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('VerityClient.createSession', () => {
  it('posts the spawn body and returns the new session id', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 'spawned-1' }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.createSession({ prompt: 'build settings', name: 'settings' });

    expect(res).toEqual({ sessionId: 'spawned-1' });
    expect(calls[0]?.url).toBe('http://host/sessions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ prompt: 'build settings', name: 'settings' }),
    );
  });

  it('maps a non-2xx spawn to a VerityApiError with the server message', async () => {
    const { fetch } = fakeFetch(json({ error: 'worktree is busy' }, 409));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.createSession({ prompt: 'go' })).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 409,
    });
  });

  it('maps confirmation warnings to a VerityApiError that callers can continue from', async () => {
    const warning = 'Devcontainer requests remoteUser=root.';
    const { fetch } = fakeFetch(json({ requiresConfirmation: true, warnings: [warning] }, 409));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.createSession({ prompt: 'go' })).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 409,
      message: warning,
      requiresConfirmation: true,
      warnings: [warning],
    });
  });

  it('rejects a malformed created body (no sessionId)', async () => {
    const { fetch } = fakeFetch(json({ accepted: true }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.createSession({ prompt: 'go' })).rejects.toThrow();
  });

  // The chat screen opens before this call answers, so its rejection IS what the
  // operator reads in the session banner — there is no session to fall back to.
  // A ZodError's message is a pretty-printed JSON array of its issues, which the
  // banner renders verbatim: a schema dump where a sentence belongs.
  it('rejects a body it cannot parse with a readable reason, not a schema dump', async () => {
    const { fetch } = fakeFetch(json({ awaitingProvisioning: true, project: { id: 'p1' } }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const caught: unknown = await client
      .createSession({ prompt: 'go', project: 'heey-global/verity' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(Error);
    const { message, cause } = caught as Error;
    expect(message).not.toContain('\n');
    expect(message).not.toContain('"code"');
    expect(message.length).toBeLessThan(120);
    // Kept off the operator's screen, not thrown away: whoever debugs this needs
    // the issue list the sentence above replaced.
    expect(cause).toBeInstanceOf(z.ZodError);
  });

  it('parses the awaiting-provisioning response for project spawns', async () => {
    const project = {
      id: 'p1',
      kind: 'github',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'cloning',
      provisionError: null,
      createdAt: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const { fetch, calls } = fakeFetch(json({ awaitingProvisioning: true, project }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.createSession({ prompt: 'go', project: 'heey-global/verity' })).toEqual({
      awaitingProvisioning: true,
      project,
    });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ prompt: 'go', project: 'heey-global/verity' }),
    );
  });

  // The 202 carries the server's `publicProject` projection, not the raw project
  // row: `kind` is omitted for a GitHub project, and `sandboxUpdate` / `toolkitDrift`
  // / the release fields ride along. A client that rejects any of that turns a
  // "still provisioning, try again" into a failed create — the exact shape mismatch
  // that used to put a schema dump in the session banner. `cloning` because only a
  // project with no usable Sandbox reaches this answer at all; a sleeping one now
  // spawns straight away.
  it('parses an awaiting-provisioning project in the server projection shape', async () => {
    const project = {
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'cloning',
      provisionError: null,
      provisionWarning: null,
      stateChangedAt: '2026-06-26T00:00:00.000Z',
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
      sandboxUpdate: {
        state: 'unknown',
        kind: null,
        category: null,
        reason: 'sandbox update checker is not configured',
        current: null,
        currentVersion: null,
        currentRevision: null,
        target: null,
        targetVersion: null,
        targetRevision: null,
        selfRepair: 'converging',
        turnBlocked: false,
      },
      toolkitDrift: null,
      createdAt: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const { fetch } = fakeFetch(json({ awaitingProvisioning: true, project }, 202));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const result = await client.createSession({ prompt: 'go', project: 'heey-global/verity' });

    expect(result).toMatchObject({ awaitingProvisioning: true });
    expect('project' in result ? result.project : undefined).toMatchObject({
      id: 'p1',
      // Defaulted by the schema, because the server omits it for a GitHub project.
      kind: 'github',
      state: 'cloning',
    });
  });
});

describe('VerityClient.openVerityControlSession', () => {
  it('POSTs to the Verity Control session route and returns the session id', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 'verity-control-1' }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.openVerityControlSession()).resolves.toEqual({
      sessionId: 'verity-control-1',
    });
    expect(calls[0]?.url).toBe('http://host/verity-control/session');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

describe('VerityClient.renameSession', () => {
  it('PATCHes the new name and returns the echoed name', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', name: 'Fix login' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.renameSession('s1', 'Fix login');

    expect(res).toEqual({ sessionId: 's1', name: 'Fix login' });
    expect(calls[0]?.url).toBe('http://host/sessions/s1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'Fix login' }));
  });

  it('sends null to clear the name', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', name: null }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.renameSession('s1', null);

    expect(res).toEqual({ sessionId: 's1', name: null });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: null }));
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.renameSession('a/b', 'x')).rejects.toBeInstanceOf(VerityApiError);
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb');
  });

  it('maps a 404 to a VerityApiError carrying the server message', async () => {
    const { fetch } = fakeFetch(json({ error: 'session s9 not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.renameSession('s9', 'x')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 404,
    });
  });
});

describe('VerityClient.setSessionFavorite', () => {
  it('PATCHes only the favorite flag and returns the echoed value', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', favorite: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.setSessionFavorite('s1', true);

    expect(res).toEqual({ sessionId: 's1', favorite: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    // A stray `name` key would rename (or clear the name of) the session.
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ favorite: true }));
  });

  it('maps a 404 to a VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'session s9 not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.setSessionFavorite('s9', false)).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 404,
    });
  });
});

describe('VerityClient.setSessionSeen (#387)', () => {
  it('PATCHes the seen event count and returns the resolved mark', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', lastSeenEventCount: 7 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.setSessionSeen('s1', 7, 'agent-text-v2');

    expect(res).toEqual({ sessionId: 's1', lastSeenEventCount: 7 });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/seen');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ eventCount: 7, counterVersion: 'agent-text-v2' }),
    );
  });

  it('does not label a legacy server count with a newer version', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', lastSeenEventCount: 2 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.setSessionSeen('s1', 2);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ eventCount: 2 }));
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.setSessionSeen('a/b', 1)).rejects.toBeInstanceOf(VerityApiError);
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb/seen');
  });
});

describe('VerityClient.setSessionModel (switch engine)', () => {
  it('PATCHes the model and returns the echoed model', async () => {
    const { fetch, calls } = fakeFetch(
      json({ sessionId: 's1', model: 'codex/default', deferred: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.setSessionModel('s1', 'codex/default');

    expect(res).toEqual({ sessionId: 's1', model: 'codex/default', deferred: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ model: 'codex/default' }));
  });

  it('treats an older successful response without deferred as immediate', async () => {
    const { fetch } = fakeFetch(json({ sessionId: 's1', model: 'codex/default' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.setSessionModel('s1', 'codex/default')).resolves.toEqual({
      sessionId: 's1',
      model: 'codex/default',
      deferred: false,
    });
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.setSessionModel('a/b', 'codex/default')).rejects.toBeInstanceOf(
      VerityApiError,
    );
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb');
  });

  it('maps a 400 (non-Claude/Codex model on a project session) to a VerityApiError', async () => {
    const { fetch } = fakeFetch(
      json({ error: 'project sessions currently support Claude and Codex models only' }, 400),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.setSessionModel('s1', 'deepinfra/zai-org/GLM-5')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 400,
    });
  });
});

describe('VerityClient.deleteSession', () => {
  it('DELETEs the session and returns the echoed id', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.deleteSession('s1');

    expect(res).toEqual({ sessionId: 's1' });
    expect(calls[0]?.url).toBe('http://host/sessions/s1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.deleteSession('a/b')).rejects.toBeInstanceOf(VerityApiError);
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb');
  });

  it('sends force=true when requested', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.deleteSession('s1', { force: true })).resolves.toEqual({
      sessionId: 's1',
    });
    expect(calls[0]?.url).toBe('http://host/sessions/s1?force=true');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('maps a 409 (busy) to a VerityApiError carrying the status and message', async () => {
    const { fetch } = fakeFetch(json({ error: 'session s1 is busy' }, 409));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.deleteSession('s1')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 409,
    });
  });

  it('rejects a malformed deleted body (no sessionId)', async () => {
    const { fetch } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.deleteSession('s1')).rejects.toThrow();
  });
});

describe('VerityClient.getBranches', () => {
  it('fetches and validates the current + switchable branches', async () => {
    const payload = { current: 'agent/foo', switchable: ['main', 'agent/bar'] };
    const { fetch, calls } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getBranches('s1')).toEqual(payload);
    expect(calls[0]?.url).toBe('http://host/sessions/s1/branches');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('accepts archived sessions whose workspace is missing', async () => {
    const payload = {
      current: '',
      switchable: [],
      previewable: [],
      workspaceMissing: true,
      currentPr: null,
      pullRequest: null,
    };
    const { fetch } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getBranches('s1')).toEqual(payload);
  });

  it('encodes the session id in the path', async () => {
    const { fetch, calls } = fakeFetch(json({ error: 'x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getBranches('a/b')).rejects.toBeInstanceOf(VerityApiError);
    expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb/branches');
  });

  it('maps a 503 (unconfigured) to a VerityApiError with the server message', async () => {
    const { fetch } = fakeFetch(json({ error: 'branch switching is not configured' }, 503));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getBranches('s1')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 503,
      message: 'branch switching is not configured',
    });
  });

  it('rejects a drifted branches body (switchable must be an array)', async () => {
    const { fetch } = fakeFetch(json({ current: 'main', switchable: 'nope' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getBranches('s1')).rejects.toThrow();
  });

  it('parses the optional previewable list (#122)', async () => {
    const payload = { current: 'main', switchable: ['main'], previewable: ['feat/streaming'] };
    const { fetch } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getBranches('s1')).toEqual(payload);
  });

  it('accepts a branches body with no previewable (older server)', async () => {
    const { fetch } = fakeFetch(json({ current: 'main', switchable: ['agent/x'] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const res = await client.getBranches('s1');
    expect(res.previewable).toBeUndefined();
  });

  it('parses the optional currentPr (#125) as a number, null, or absent', async () => {
    const get = async (payload: unknown) => {
      const { fetch } = fakeFetch(json(payload));
      return new VerityClient({ baseUrl: 'http://host', fetch }).getBranches('s1');
    };
    expect(await get({ current: 'feat/122-x', switchable: [], currentPr: 119 })).toMatchObject({
      currentPr: 119,
    });
    expect(
      (await get({ current: 'feat/122-x', switchable: [], currentPr: null })).currentPr,
    ).toBeNull();
    // Absent (older server / GitHub not configured) parses fine → undefined.
    expect((await get({ current: 'main', switchable: [] })).currentPr).toBeUndefined();
  });

  it('parses the optional compact pullRequest status', async () => {
    const pullRequest = {
      number: 119,
      title: 'Footer PR strip',
      url: 'https://github.com/heey-global/verity/pull/119',
      phase: 'open',
      updatedAt: '2026-07-06T12:00:00Z',
      headSha: 'abc123',
      pipeline: 'running',
      checks: { completed: 2, total: 3, successful: 2, failed: 0, pending: 1 },
      mergeable: false,
    };
    const { fetch } = fakeFetch(json({ current: 'feat/119-x', switchable: [], pullRequest }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getBranches('s1')).toMatchObject({ pullRequest });
  });

  it('parses the conflict fields on a pullRequest that GitHub ran no checks for', async () => {
    const pullRequest = {
      number: 1325,
      title: 'fix(broker): hold exec',
      url: 'https://github.com/heey-global/verity/pull/1325',
      phase: 'open',
      headSha: 'abc123',
      pipeline: 'unknown',
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
      mergeable: false,
      mergeState: 'dirty',
      baseRef: 'main',
    };
    const { fetch } = fakeFetch(json({ current: 'fix/broker', switchable: [], pullRequest }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getBranches('s1')).toMatchObject({ pullRequest });
  });

  it('degrades an unknown mergeState to undefined instead of failing the parse', async () => {
    // Forward-compat: a merge state GitHub adds later must not blank the whole PR bar.
    const { fetch } = fakeFetch(
      json({
        current: 'fix/broker',
        switchable: [],
        pullRequest: {
          number: 1325,
          title: 'fix(broker): hold exec',
          url: 'https://github.com/heey-global/verity/pull/1325',
          phase: 'open',
          pipeline: 'unknown',
          checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
          mergeable: null,
          mergeState: 'something-new',
        },
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.getBranches('s1');
    expect(res.pullRequest?.number).toBe(1325);
    expect(res.pullRequest?.mergeState).toBeUndefined();
  });

  it('parses the optional owner/repo (#161) when present', async () => {
    const payload = {
      current: 'feat/161-x',
      switchable: [],
      owner: 'Heey-Global',
      repo: 'Verity',
    };
    const { fetch } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getBranches('s1')).toMatchObject({ owner: 'Heey-Global', repo: 'Verity' });
  });

  it('accepts a branches body with no owner/repo (older server / no GitHub remote, #161)', async () => {
    const { fetch } = fakeFetch(json({ current: 'main', switchable: [] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const res = await client.getBranches('s1');
    expect(res.owner).toBeUndefined();
    expect(res.repo).toBeUndefined();
  });
});

describe('VerityClient.mergePullRequest', () => {
  it('posts the PR number and validates the merged response', async () => {
    const { fetch, calls } = fakeFetch(json({ merged: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.mergePullRequest('s1', 119)).toEqual({ merged: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/pull-request/merge');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ number: 119 }));
  });
});

describe('VerityClient.mergeSessionBranch', () => {
  it('starts the local save workflow', async () => {
    const { fetch, calls } = fakeFetch(json({ accepted: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.saveSessionToProject('s1')).toEqual({ accepted: true });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/save-to-project');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('posts the local merge and validates the merged response', async () => {
    const { fetch, calls } = fakeFetch(json({ merged: true, base: 'main', branch: 'feat/notes' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.mergeSessionBranch('s1')).toEqual({
      merged: true,
      base: 'main',
      branch: 'feat/notes',
    });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/merge');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('reads the local merge base off a branch list, and tolerates its absence', async () => {
    const { fetch } = fakeFetch(
      json({
        current: 'feat/notes',
        switchable: [],
        localMerge: { base: 'trunk', hasChanges: false },
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect((await client.getBranches('s1')).localMerge).toEqual({
      base: 'trunk',
      hasChanges: false,
    });

    const older = fakeFetch(json({ current: 'main', switchable: [] }));
    const olderClient = new VerityClient({ baseUrl: 'http://host', fetch: older.fetch });
    expect((await olderClient.getBranches('s1')).localMerge).toBeUndefined();
  });
});

describe('VerityClient session files', () => {
  it('lists a session worktree directory', async () => {
    const payload = {
      path: 'dist',
      truncated: false,
      entries: [
        {
          name: 'contract.docx',
          path: 'dist/contract.docx',
          kind: 'file',
          size: 3,
          modifiedAt: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    const { fetch, calls } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listSessionFiles('s1', 'dist')).toEqual(payload);
    expect(calls[0]?.url).toBe('http://host/sessions/s1/files?path=dist');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('omits the path query for the worktree root', async () => {
    const { fetch, calls } = fakeFetch(json({ path: '', entries: [], truncated: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.listSessionFiles('s1');

    expect(calls[0]?.url).toBe('http://host/sessions/s1/files');
  });

  it('addresses explorer roots for browse, delete, and move', async () => {
    const responses = [
      json({ root: 'knowledge', path: 'imports', entries: [], truncated: false }),
      json({ deleted: true, path: 'imports/offer.pdf' }),
      json({ deleted: true, path: 'notes.txt' }),
      json({ root: 'shared', path: 'offer.pdf' }),
    ];
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch: async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, ...(init ? { init } : {}) });
        return responses.shift()!;
      },
    });

    await client.listSessionFiles('s1', 'imports', 'knowledge');
    await client.deleteSessionFile('s1', 'knowledge', 'imports/offer.pdf');
    await client.deleteSessionFile('s1', 'worktree', 'notes.txt');
    await client.moveSessionFile('s1', {
      root: 'knowledge',
      path: 'imports/offer.pdf',
      toRoot: 'shared',
    });

    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/s1/files?root=knowledge&path=imports',
      'http://host/sessions/s1/files?root=knowledge&path=imports%2Foffer.pdf',
      'http://host/sessions/s1/files?root=worktree&path=notes.txt',
      'http://host/sessions/s1/files/move',
    ]);
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(calls[2]?.init?.method).toBe('DELETE');
    expect(calls[3]?.init).toMatchObject({ method: 'POST' });
  });

  it('renames a file in place, keeping its folder and root', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ path: 'notes/b.md', root: 'worktree' }),
      json({ path: 'renamed.md', root: 'shared' }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.renameSessionFile('s1', 'worktree', 'notes/a.md', 'b.md');
    await client.renameSessionFile('s1', 'shared', 'top.md', 'renamed.md');

    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/s1/files/move',
      'http://host/sessions/s1/files/move',
    ]);
    // A rename that dropped the folder would move the file to the root instead.
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      root: 'worktree',
      path: 'notes/a.md',
      toRoot: 'worktree',
      toPath: 'notes',
      toFileName: 'b.md',
    });
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      root: 'shared',
      path: 'top.md',
      toRoot: 'shared',
      toPath: '',
      toFileName: 'renamed.md',
    });
  });

  it('rejects an older server that returns the worktree for a knowledge root', async () => {
    const { fetch } = fakeFetch(json({ path: '', entries: [], truncated: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listSessionFiles('s1', '', 'knowledge')).rejects.toThrow(
      'Update the Verity server to browse Knowledge files',
    );
  });

  it('loads text file content for preview', async () => {
    const payload = { path: 'README.md', content: '# Hello\n', size: 8 };
    const { fetch, calls } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getSessionFileContent('s1', 'README.md')).toEqual(payload);
    expect(calls[0]?.url).toBe('http://host/sessions/s1/files/content?path=README.md');
  });

  it('builds and fetches download URLs for binary files', async () => {
    const response = new Response(new Blob([new Uint8Array([1, 2, 3])]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const { fetch, calls } = fakeFetch(response);
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(client.sessionFileDownloadUrl('s1', 'dist/contract.docx')).toBe(
      'http://host/sessions/s1/files/download?path=dist%2Fcontract.docx',
    );
    await expect(client.downloadSessionFile('s1', 'dist/contract.docx')).resolves.toBeInstanceOf(
      Blob,
    );
    expect(calls[0]?.url).toBe('http://host/sessions/s1/files/download?path=dist%2Fcontract.docx');
  });

  it('uploads a file into a session worktree directory', async () => {
    const { fetch, calls } = fakeFetch(json({ path: 'docs/note.txt', size: 3 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const data = new Blob(['abc']);

    await expect(
      client.uploadSessionFile('s1', { path: 'docs', fileName: 'note.txt', data }),
    ).resolves.toEqual({ path: 'docs/note.txt', size: 3 });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/files?path=docs&fileName=note.txt');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    });
  });

  it('percent-encodes a non-ASCII upload file name', async () => {
    const name = 'Grundriß_Höhen.pdf';
    const { fetch, calls } = fakeFetch(json({ path: `docs/${name}`, size: 3 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.uploadSessionFile('s1', { path: 'docs', fileName: name, data: new Blob(['abc']) });

    // Raw UTF-8 in a request line is decoded as Latin-1 by the server's HTTP parser,
    // which is how an umlaut turns into mojibake on disk.
    expect(calls[0]?.url).toBe(
      'http://host/sessions/s1/files?path=docs&fileName=Grundri%C3%9F_H%C3%B6hen.pdf',
    );
  });

  it('uses the dedicated upload fetch without affecting ordinary requests', async () => {
    const ordinary = fakeFetch(json([]));
    const upload = fakeFetch(json({ path: 'docs/note.txt', size: 3 }));
    const client = new VerityClient({
      baseUrl: 'http://host',
      fetch: ordinary.fetch,
      uploadFetch: upload.fetch,
    });
    const data = new Blob(['abc']);

    await client.listSessions();
    await client.uploadSessionFile('s1', { path: 'docs', fileName: 'note.txt', data });

    expect(ordinary.calls).toHaveLength(1);
    expect(upload.calls).toHaveLength(1);
    expect(upload.calls[0]?.init).toMatchObject({ body: data });
  });

  it('supplies a binary MIME type when a native file reports null', async () => {
    const { fetch, calls } = fakeFetch(json({ path: 'images/export.bin', size: 3 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(3));
    const text = vi.fn(async () => 'abc');
    const nativeFile = { arrayBuffer, size: 3, text, type: null } as unknown as Blob;

    await client.uploadSessionFile('s1', {
      path: 'images',
      fileName: 'export.bin',
      data: nativeFile,
    });

    const body = calls[0]?.init?.body as Blob;
    expect(body).not.toBe(nativeFile);
    expect(body.type).toBe('application/octet-stream');
    expect(body.size).toBe(3);
    await expect(body.arrayBuffer()).resolves.toMatchObject({ byteLength: 3 });
    await expect(body.text()).resolves.toBe('abc');
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(text).toHaveBeenCalledOnce();
  });

  it('overrides the picked file own MIME type with the binary one', async () => {
    const { fetch, calls } = fakeFetch(json({ path: 'docs/contract.pdf', size: 3 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(3));
    // expo/fetch copies this into its native Content-Type header, so a PDF sent
    // as-is would reach the upload route as `application/pdf` and be refused.
    const pickedPdf = { arrayBuffer, size: 3, type: 'application/pdf' } as unknown as Blob;

    await client.uploadSessionFile('s1', {
      path: 'docs',
      fileName: 'contract.pdf',
      data: pickedPdf,
    });

    const body = calls[0]?.init?.body as Blob;
    expect(body).not.toBe(pickedPdf);
    expect(body.type).toBe('application/octet-stream');
    expect(body.size).toBe(3);
    await expect(body.arrayBuffer()).resolves.toMatchObject({ byteLength: 3 });
  });

  it('maps file route errors to VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'invalid path' }, 400));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listSessionFiles('s1', '../')).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 400,
      message: 'invalid path',
    });
  });
});

describe('VerityClient.switchBranch', () => {
  it('posts the switch body and returns the checked-out branch', async () => {
    const { fetch, calls } = fakeFetch(json({ branch: 'agent/bar' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.switchBranch('s1', { branch: 'agent/bar' });

    expect(res).toEqual({ branch: 'agent/bar' });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/branch');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ branch: 'agent/bar' }));
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('serializes newBranch + onDirty in the body', async () => {
    const { fetch, calls } = fakeFetch(json({ branch: 'agent/new' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.switchBranch('s1', { newBranch: 'agent/new', onDirty: 'commit' });

    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ newBranch: 'agent/new', onDirty: 'commit' }),
    );
  });

  it('serializes a preview switch in the body (#122)', async () => {
    const { fetch, calls } = fakeFetch(json({ branch: 'feat/streaming' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.switchBranch('s1', { preview: 'feat/streaming' });

    expect(res).toEqual({ branch: 'feat/streaming' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ preview: 'feat/streaming' }));
  });

  it('maps a 409 (dirty worktree) to a VerityApiError with the server message', async () => {
    const { fetch } = fakeFetch(
      json({ error: 'the worktree has uncommitted changes — commit or stash them first' }, 409),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.switchBranch('s1', { branch: 'main' })).rejects.toMatchObject({
      name: 'VerityApiError',
      status: 409,
      message: 'the worktree has uncommitted changes — commit or stash them first',
    });
  });

  it('rejects a malformed switched body (no branch)', async () => {
    const { fetch } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.switchBranch('s1', { branch: 'main' })).rejects.toThrow();
  });
});

describe('VerityClient.listModels (#143)', () => {
  it('fetches and validates the model list', async () => {
    const body = {
      models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'deepinfra/zai-org/GLM-5.2'],
      default: 'claude-opus-4-8',
    };
    const { fetch, calls } = fakeFetch(json(body));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.listModels();

    expect(res).toEqual(body);
    expect(calls[0]?.url).toBe('http://host/models');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('accepts a model list without a default', async () => {
    const body = { models: ['claude-opus-4-8'] };
    const { fetch } = fakeFetch(json(body));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listModels()).resolves.toEqual(body);
  });

  it('accepts the optional generic more-models disclosure', async () => {
    const body = {
      models: ['codex/gpt-5.6-sol', 'codex/gpt-5.5'],
      modelOrder: ['codex/gpt-5.6-sol', 'codex/gpt-5.5'],
      moreModels: ['codex/gpt-5.5'],
      default: 'codex/gpt-5.6-sol',
    };
    const { fetch } = fakeFetch(json(body));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listModels()).resolves.toEqual(body);
  });

  it('rejects a body with an empty model id', async () => {
    const { fetch } = fakeFetch(json({ models: [''], default: 'claude-opus-4-8' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listModels()).rejects.toThrow();
  });
});

describe('VerityClient.decidePermission', () => {
  it('POSTs an allow decision to the toolUseId path and parses the response', async () => {
    const body = { sessionId: 's1', toolUseId: 'tu_1', decided: true };
    const { fetch, calls } = fakeFetch(json(body));
    const client = new VerityClient({ baseUrl: 'http://host:3000/', fetch });

    const res = await client.decidePermission('s1', 'tu_1', { behavior: 'allow' });

    expect(res).toEqual(body);
    expect(calls[0]?.url).toBe('http://host:3000/sessions/s1/permissions/tu_1');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ behavior: 'allow' }));
  });

  it('POSTs a deny decision (with a message) as the JSON body', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', toolUseId: 'tu_2', decided: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.decidePermission('s1', 'tu_2', { behavior: 'deny', message: 'no thanks' });

    expect(calls[0]?.url).toBe('http://host/sessions/s1/permissions/tu_2');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ behavior: 'deny', message: 'no thanks' }));
  });

  it('forwards a scoped allow (ADR 0011 D2) as the JSON body', async () => {
    const response = {
      sessionId: 's1',
      toolUseId: 'tu_5',
      decided: true,
      scopeSaved: false,
    };
    const { fetch, calls } = fakeFetch(json(response));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(
      client.decidePermission('s1', 'tu_5', { behavior: 'allow', scope: 'project' }),
    ).resolves.toEqual(response);

    expect(calls[0]?.init?.body).toBe(JSON.stringify({ behavior: 'allow', scope: 'project' }));
  });

  it('forwards an allow decision with edited updatedInput', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', toolUseId: 'tu_3', decided: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.decidePermission('s1', 'tu_3', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ behavior: 'allow', updatedInput: { command: 'ls -la' } }),
    );
  });

  it('encodes the session id and tool_use_id into the path', async () => {
    const { fetch, calls } = fakeFetch(
      json({ sessionId: 's/1', toolUseId: 'tu 1', decided: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await client.decidePermission('s/1', 'tu 1', { behavior: 'allow' });

    expect(calls[0]?.url).toBe('http://host/sessions/s%2F1/permissions/tu%201');
  });

  it('throws a VerityApiError on a 404 (the prompt already went stale)', async () => {
    const { fetch } = fakeFetch(json({ error: 'no pending permission tu_x' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(
      client.decidePermission('s1', 'tu_x', { behavior: 'allow' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a drifted response shape (decided must be true)', async () => {
    const { fetch } = fakeFetch(json({ sessionId: 's1', toolUseId: 'tu_1', decided: false }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.decidePermission('s1', 'tu_1', { behavior: 'allow' })).rejects.toThrow();
  });
});

describe('VerityClient.secret store', () => {
  it('reads the secret-store status', async () => {
    const { fetch, calls } = fakeFetch(json({ status: 'uninitialized' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getSecretStatus()).toBe('uninitialized');
    expect(calls[0]?.url).toBe('http://host/secret/status');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('posts the init password', async () => {
    const { fetch, calls } = fakeFetch(json({ status: 'unlocked' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.initSecretPassword('master-password');
    expect(calls[0]?.url).toBe('http://host/secret/init');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: 'master-password' }));
  });

  it('posts the unlock password', async () => {
    const { fetch, calls } = fakeFetch(json({ status: 'unlocked' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.unlockSecret('master-password');
    expect(calls[0]?.url).toBe('http://host/secret/unlock');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: 'master-password' }));
  });

  it('surfaces an incorrect password as a 401 VerityApiError', async () => {
    const { fetch } = fakeFetch(json({ error: 'incorrect master password' }, 401));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.unlockSecret('wrong')).rejects.toBeInstanceOf(VerityApiError);
  });
});

describe('VerityClient.validateGithubApp (#320)', () => {
  it('POSTs to /github/app/validate and parses a success result', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true, accountLogin: 'acme-org' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.validateGithubApp();
    expect(result).toEqual({ ok: true, accountLogin: 'acme-org' });
    expect(calls[0]?.url).toBe('http://host/github/app/validate');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('parses a redacted failure result', async () => {
    const { fetch } = fakeFetch(json({ ok: false, error: 'locked' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.validateGithubApp()).toEqual({ ok: false, error: 'locked' });
  });
});

describe('VerityClient.generateSigningKey (#320)', () => {
  it('POSTs to /settings/signing-key/generate and parses the public result', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        ok: true,
        publicKey: 'ssh-ed25519 AAAA test',
        allowedSigners: 'e namespaces="git" k',
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.generateSigningKey();
    expect(result).toEqual({
      ok: true,
      publicKey: 'ssh-ed25519 AAAA test',
      allowedSigners: 'e namespaces="git" k',
    });
    expect(calls[0]?.url).toBe('http://host/settings/signing-key/generate');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('parses a locked failure result', async () => {
    const { fetch } = fakeFetch(json({ ok: false, error: 'locked' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.generateSigningKey()).toEqual({ ok: false, error: 'locked' });
  });
});

describe('VerityClient agent login flows', () => {
  it('starts a provider login session', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        login: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          provider: 'codex',
          status: 'ready',
          verificationUri: 'https://auth.openai.com/codex/device',
          userCode: 'UXAB-12345',
          needsCode: false,
          configured: false,
          message: null,
        },
      }),
    );
    const result = await new VerityClient({ baseUrl: 'http://host', fetch }).startAgentLogin(
      'codex',
    );
    expect(result.userCode).toBe('UXAB-12345');
    expect(calls[0]?.url).toBe('http://host/settings/agent-logins/codex/start');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('disconnects a stored provider login', async () => {
    const settings = {
      advancedModeEnabled: false,
      gitUserName: 'h-teske',
      gitUserEmail: 'developer@example.com',
      gitSshPrivateKeyPath: '/data/dev/.shared/github/id_ed25519',
      gitSshPublicKeyPath: '/data/dev/.shared/github/id_ed25519.pub',
      gitKnownHostsPath: '/data/dev/.shared/github/known_hosts',
      gitAllowedSignersPath: '/data/dev/.shared/github/allowed_signers',
      gitSshPrivateKeyConfigured: true,
      gitSshPublicKeyConfigured: true,
      gitKnownHostsConfigured: true,
      gitAllowedSignersConfigured: true,
      githubAppId: '3836338',
      githubAppInstallationId: '135112757',
      githubAppPrivateKeyConfigured: true,
      dopplerServiceTokenConfigured: false,
      transcribeBaseUrl: null,
      transcribeModel: null,
      transcribeBackendMode: null,
      transcribeApiKeyConfigured: false,
      transcribeLocalAvailable: true,
      transcribeExternalConfigured: false,
      claudeCodeOauthCredentialsConfigured: false,
      codexAuthJsonConfigured: false,
      uplinkSubscriptionKeyConfigured: false,
      uplinkInstallationId: null,
      googleDriveClientId: null,
      googleDriveAccountEmail: null,
      googleDriveConnected: false,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
    };
    const { fetch, calls } = fakeFetch(json({ settings }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.disconnectAgentLogin('claude')).toEqual(settings);
    expect(calls[0]?.url).toBe('http://host/settings/agent-logins/claude');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('polls and submits a Claude returned code', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({
        login: {
          sessionId: '22222222-2222-4222-8222-222222222222',
          provider: 'claude',
          status: 'waiting',
          verificationUri: 'https://claude.com/cai/oauth/authorize?code=true',
          userCode: null,
          needsCode: true,
          configured: false,
          message: null,
        },
      }),
      json({
        login: {
          sessionId: '22222222-2222-4222-8222-222222222222',
          provider: 'claude',
          status: 'complete',
          verificationUri: 'https://claude.com/cai/oauth/authorize?code=true',
          userCode: null,
          needsCode: true,
          configured: true,
          message: null,
        },
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getAgentLogin('22222222-2222-4222-8222-222222222222')).toMatchObject({
      status: 'waiting',
    });
    expect(
      await client.submitAgentLoginCode('22222222-2222-4222-8222-222222222222', 'abc'),
    ).toMatchObject({ status: 'complete', configured: true });
    expect(calls[0]?.url).toBe(
      'http://host/settings/agent-logins/22222222-2222-4222-8222-222222222222',
    );
    expect(calls[1]?.url).toBe(
      'http://host/settings/agent-logins/22222222-2222-4222-8222-222222222222/submit-code',
    );
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '')).toEqual({ code: 'abc' });
  });
});

describe('VerityClient session automations', () => {
  const automation = {
    id: 'a1',
    sessionId: 's 1',
    name: 'Morning review',
    status: 'enabled',
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    prompt: 'Summarize the open pull requests.',
    script: null,
    model: null,
    consecutiveErrorCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastDetail: null,
    nextRunAt: '2026-10-05T09:00:00.000Z',
    createdAt: '2026-10-04T18:00:00.000Z',
    updatedAt: '2026-10-04T18:00:00.000Z',
  };

  it('reads, saves, pauses, and deletes the automation of one session', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ automation: null }),
      json({ automation }),
      json({ automation: { ...automation, status: 'paused', nextRunAt: null } }),
      json({ ok: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.getSessionAutomation('s 1')).toBeNull();
    const request = {
      name: 'Morning review',
      schedule: { kind: 'daily' as const, hour: 9, minute: 0 },
      prompt: 'Summarize the open pull requests.',
    };
    expect((await client.saveSessionAutomation('s 1', request)).status).toBe('enabled');
    expect((await client.setSessionAutomationStatus('s 1', 'paused')).status).toBe('paused');
    await client.deleteSessionAutomation('s 1');

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'http://host/sessions/s%201/automation'],
      ['PUT', 'http://host/sessions/s%201/automation'],
      ['PATCH', 'http://host/sessions/s%201/automation'],
      ['DELETE', 'http://host/sessions/s%201/automation'],
    ]);
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '')).toEqual({
      ...request,
      schedule: { ...request.schedule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    expect(JSON.parse((calls[2]?.init?.body as string) ?? '')).toEqual({ status: 'paused' });
  });
});

it.each([
  { kind: 'daily' as const, hour: 22, minute: 33, timeZone: 'Europe/Berlin' },
  { kind: 'weekly' as const, weekday: 1, hour: 9, minute: 0 },
  { kind: 'interval' as const, everyMinutes: 30 },
])('saves explicit zones and defaults only calendar schedules: %j', async (schedule) => {
  const automation = {
    id: 'a1',
    sessionId: 's1',
    name: 'Hello',
    status: 'enabled',
    schedule,
    prompt: 'Say hello',
    script: null,
    model: null,
    consecutiveErrorCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastDetail: null,
    nextRunAt: null,
    createdAt: '',
    updatedAt: '',
  };
  const { fetch, calls } = fakeFetchSequence(json({ automation }));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  const result = await client.saveSessionAutomation('s1', {
    name: automation.name,
    prompt: automation.prompt,
    schedule,
  });
  expect(result.schedule).toEqual(schedule);
  expect(JSON.parse(calls[0]?.init?.body as string).schedule).toEqual(
    schedule.kind === 'interval'
      ? schedule
      : {
          ...schedule,
          timeZone:
            'timeZone' in schedule
              ? schedule.timeZone
              : Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
  );
});

describe('VerityClient preview shares', () => {
  it('retains PIN lock status from Core and accepts older Core responses', async () => {
    const share = {
      id: 'locked-share',
      projectId: 'p1',
      devServerId: null,
      targetKind: 'static-folder',
      staticPath: '.',
      state: 'active',
      publicOrigin: 'https://share.preview.example',
      pin: '123456',
      expiresAt: '2030-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      failure: null,
    };
    const { fetch } = fakeFetchSequence(
      json({ shares: [{ ...share, pinLocked: true }] }),
      json({ shares: [share] }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listPublicPreviewShares('p1')).resolves.toEqual([
      { ...share, pinLocked: true },
    ]);
    await expect(client.listPublicPreviewShares('p1')).resolves.toEqual([share]);
  });

  it('browses a session worktree before creating a static public preview', async () => {
    const share = {
      id: 'static-one',
      projectId: 'project one',
      devServerId: null,
      targetKind: 'static-folder',
      staticPath: 'web/dist',
      state: 'active',
      publicOrigin: 'https://static.preview.example',
      pin: '123456',
      expiresAt: '2026-01-01T02:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      failure: null,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ share }),
      json({ directories: ['dist'], files: ['index.html'] }),
      json({ directories: ['dist'], files: ['index.html'] }),
      json({ share: { ...share, sessionId: 's1' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(
      client.createStaticPublicPreviewShare('project one', {
        staticPath: 'web/dist',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).resolves.toEqual(share);
    await expect(client.listSessionStaticPreviewDirectories('s1', 'web')).resolves.toEqual([
      'dist',
    ]);
    await expect(client.listSessionStaticPreviewEntries('s1', 'web')).resolves.toEqual({
      directories: ['dist'],
      files: ['index.html'],
    });
    await expect(
      client.createSessionStaticPreviewShare('s1', {
        staticPath: 'web/dist',
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).resolves.toEqual({ ...share, sessionId: 's1' });
    expect(calls.map((call) => call.url)).toEqual([
      'http://host/projects/project%20one/public-static-shares',
      'http://host/sessions/s1/public-static-directories?path=web',
      'http://host/sessions/s1/public-static-directories?path=web',
      'http://host/sessions/s1/public-static-shares',
    ]);
  });
});

describe('VerityClient session dev server previews', () => {
  it('lists what a session serves and shares one of its ports', async () => {
    const devServers = [
      { port: 5173, reachable: true, pid: 40, name: 'Vite', command: 'vite', workdir: 'web' },
    ];
    const share = {
      id: 'port-one',
      projectId: 'p1',
      devServerId: null,
      targetKind: 'dev-server',
      targetPort: 5173,
      staticPath: null,
      sessionId: 's 1',
      state: 'active',
      publicOrigin: 'https://port.preview.example',
      pin: '123456',
      expiresAt: '2026-01-01T02:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      failure: null,
    };
    const { fetch, calls } = fakeFetchSequence(json({ devServers }), json({ share }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listSessionDevServers('s 1')).resolves.toEqual(devServers);
    await expect(
      client.createSessionPortPreviewShare('s 1', {
        targetPort: 5173,
        pin: '123456',
        ttlSeconds: 3600,
      }),
    ).resolves.toEqual(share);
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'http://host/sessions/s%201/dev-servers'],
      ['POST', 'http://host/sessions/s%201/public-port-shares'],
    ]);
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '')).toEqual({
      targetPort: 5173,
      pin: '123456',
      ttlSeconds: 3600,
    });
  });

  // The app hides the Dev server tab on null. A missing session answers 404 too,
  // and treating that as an old Core would switch the feature off for good.
  it('reports an older Core as unsupported but keeps a missing session an error', async () => {
    const { fetch } = fakeFetchSequence(
      json(
        {
          message: 'Route GET:/sessions/s1/dev-servers not found',
          error: 'Not Found',
          statusCode: 404,
        },
        404,
      ),
      json({ error: 'project session not found' }, 404),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listSessionDevServers('s1')).resolves.toBeNull();
    await expect(client.listSessionDevServers('s1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('VerityClient Doppler binding picker (#320)', () => {
  it('GETs /doppler/projects and parses the project list', async () => {
    const { fetch, calls } = fakeFetch(
      json({ projects: [{ slug: 'acme-app', name: 'Acme App' }] }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.listDopplerProjects();
    expect(result).toEqual({ projects: [{ slug: 'acme-app', name: 'Acme App' }] });
    expect(calls[0]?.url).toBe('http://host/doppler/projects');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('parses a redacted {error} envelope for /doppler/projects', async () => {
    const { fetch } = fakeFetch(json({ error: 'not configured' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listDopplerProjects()).toEqual({ error: 'not configured' });
  });

  it('GETs /doppler/configs with the project query and parses the config list', async () => {
    const { fetch, calls } = fakeFetch(
      json({ configs: [{ name: 'dev', environment: 'dev', root: true }] }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = await client.listDopplerConfigs('acme app');
    expect(result).toEqual({ configs: [{ name: 'dev', environment: 'dev', root: true }] });
    expect(calls[0]?.url).toBe('http://host/doppler/configs?project=acme%20app');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('parses a redacted {error} envelope for /doppler/configs', async () => {
    const { fetch } = fakeFetch(json({ error: 'locked' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listDopplerConfigs('acme-app')).toEqual({ error: 'locked' });
  });
});

describe('VerityClient GitHub onboarding hardening', () => {
  it('prepareGithubManifest posts and returns the start token', async () => {
    const { fetch, calls } = fakeFetch(json({ startToken: 'ott-xyz' }));
    const controller = new AbortController();
    const prepared = await new VerityClient({
      baseUrl: 'http://host',
      fetch,
    }).prepareGithubManifest(
      'https://verity.example',
      undefined,
      '/github-connect',
      false,
      controller.signal,
    );
    expect(prepared).toEqual({ startToken: 'ott-xyz' });
    expect(calls[0]?.url).toBe('http://host/github/app/manifest/prepare');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        baseUrl: 'https://verity.example',
        returnTo: '/github-connect',
        native: false,
        restartPartial: true,
      }),
    );
  });

  it('completes both native GitHub manifest callbacks through API posts', async () => {
    const { fetch, calls } = fakeFetch(
      json({ installUrl: 'https://github.com/apps/verity/installations/new?state=s2' }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.completeGithubManifest('code-1', 'state-1')).resolves.toContain(
      'github.com',
    );
    expect(calls[0]?.url).toBe('http://host/github/app/manifest/complete');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ code: 'code-1', state: 'state-1' }));

    await client.completeGithubManifestInstallation('installation-1', 'state-2');
    expect(calls[1]?.url).toBe('http://host/github/app/manifest/installed/complete');
    expect(calls[1]?.init?.body).toBe(
      JSON.stringify({ installationId: 'installation-1', state: 'state-2' }),
    );
  });

  it('disconnectGithub posts to the disconnect endpoint', async () => {
    const { fetch, calls } = fakeFetch(json({ disconnected: true }));
    await new VerityClient({ baseUrl: 'http://host', fetch }).disconnectGithub();
    expect(calls[0]?.url).toBe('http://host/settings/github/disconnect');
    expect(calls[0]?.init?.method).toBe('POST');
  });
});

describe('VerityClient standing brokered-secret grants (ADR 0011 D2)', () => {
  const grant = {
    id: 'grant-1',
    secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY',
    toolName: 'verity_secret_run',
    target: `/usr/local/bin/fastlane#${'a'.repeat(64)}`,
    scope: 'forever',
    sessionId: null,
    appliesNow: true,
    expiresAt: null,
    createdAt: '2026-08-02T00:00:00.000Z',
  };

  it('lists a project’s standing grants', async () => {
    const { fetch, calls } = fakeFetch(json({ grants: [grant] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listSecretGrants('p 1')).resolves.toEqual([grant]);
    expect(calls[0]?.url).toBe('http://host/projects/p%201/secret-grants');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('revokes one grant by id', async () => {
    const { fetch, calls } = fakeFetch(new Response(null, { status: 204 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.revokeSecretGrant('p1', 'grant/1')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('http://host/projects/p1/secret-grants/grant%2F1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('rejects a grant list it cannot trust rather than showing a partial one', async () => {
    // A scope outside the three this client knows means the server and app disagree about
    // what a grant covers. Silently dropping the row would under-report the operator's
    // exposure in the one screen meant to show all of it.
    const { fetch } = fakeFetch(json({ grants: [{ ...grant, scope: 'once' }] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listSecretGrants('p1')).rejects.toBeTruthy();
  });

  it('surfaces a revoke that matched nothing as an error, not a success', async () => {
    const { fetch } = fakeFetch(json({ error: 'grant not found' }, 404));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.revokeSecretGrant('p1', 'gone')).rejects.toBeInstanceOf(VerityApiError);
  });

  it('surfaces a deployment without grants configured as an error', async () => {
    const { fetch } = fakeFetch(
      json({ error: 'brokered secret grants are not configured', grants: [] }, 501),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listSecretGrants('p1')).rejects.toMatchObject({ status: 501 });
  });
});

describe('projectRecordSchema sandbox update', () => {
  const project = {
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global--verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
  const sandboxUpdate = {
    state: 'available',
    kind: 'normal',
    category: 'software',
    reason: null,
    current: 'old',
    target: 'new',
    currentVersion: null,
    currentRevision: null,
    targetVersion: null,
    targetRevision: null,
  };

  it('reads a Server that predates selfRepair as converging, not stalled', () => {
    // The N-1 window this app is normally in: an older Server reconciles its
    // sandboxes exactly the same way, it just cannot report the verdict. Failing
    // the parse would blank the whole overview; defaulting to `stalled` would put
    // an alert glyph on every project it serves.
    const parsed = projectRecordSchema.parse({ ...project, sandboxUpdate });
    expect(parsed.sandboxUpdate?.selfRepair).toBe('converging');
  });

  it('keeps a stalled verdict a newer Server does send', () => {
    const parsed = projectRecordSchema.parse({
      ...project,
      sandboxUpdate: { ...sandboxUpdate, selfRepair: 'stalled' },
    });
    expect(parsed.sandboxUpdate?.selfRepair).toBe('stalled');
  });

  it('reads a Server that predates turnBlocked as not blocked', () => {
    // Same N-1 window, and the reason `turnBlocked` is a boolean rather than a
    // third `selfRepair` member: this schema uses a closed enum and `.parse()`,
    // so an installed app meeting an unknown member would throw and lose the
    // entire project list — not the one badge, the list.
    expect(
      projectRecordSchema.parse({ ...project, sandboxUpdate }).sandboxUpdate?.turnBlocked,
    ).toBe(false);
  });

  it('keeps the blocked report a newer Server does send', () => {
    const parsed = projectRecordSchema.parse({
      ...project,
      sandboxUpdate: { ...sandboxUpdate, selfRepair: 'stalled', turnBlocked: true },
    });
    expect(parsed.sandboxUpdate?.turnBlocked).toBe(true);
  });
});

describe('projectRecordSchema lifecycle states', () => {
  const project = {
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global--verity',
    imageRef: null,
    provisionError: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  it.each(['sleeping_starting', 'sleeping', 'waking'] as const)(
    'accepts the %s lifecycle state while retaining the legacy state',
    (lifecycleState) => {
      expect(
        projectRecordSchema.parse({ ...project, state: 'active', lifecycleState }),
      ).toMatchObject({
        state: 'active',
        lifecycleState,
      });
    },
  );
});

it('moves a session with a stable retry key and parses the retained-workspace result', async () => {
  const moved = {
    projectId: 'b',
    worktree: '/b/move',
    branch: 'move',
    contextMode: 'history-handoff',
    transferred: ['file'],
    alreadyPresent: [],
    skipped: ['private'],
    retainedWorktree: '/a/old',
    retainedBranch: 'old',
  };
  const { fetch, calls } = fakeFetch(new Response(JSON.stringify(moved), { status: 200 }));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  const body = { project: 'b', operationId: 'retry-key' };
  expect(await client.moveSession('a/b', body)).toEqual(moved);
  expect(calls[0]?.url).toBe('http://host/sessions/a%2Fb/project');
  expect(calls[0]?.init?.method).toBe('POST');
  expect(JSON.parse(calls[0]?.init?.body as string)).toEqual(body);
});

it('labels Attendee JSON writes so the server parses configuration and meeting commands', async () => {
  const { fetch, calls } = fakeFetchSequence(
    json({ configured: true }),
    json({ configured: false }),
    json({ meetingId: 'meeting' }),
    json({ accepted: true }),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await client.saveAttendeeSettings({ apiKey: 'fixture', webhookSecret: 'fixture' });
  await client.saveAttendeeSettings(null);
  await client.startOnlineMeeting('session', 'https://meet.google.com/abc-defg-hij');
  await client.editOnlineMeetingSpeakers('session', 'meeting', {
    speakerNames: {},
    speakerCorrections: [],
    speakerMerges: {},
  });
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    expect(typeof call.init?.body).toBe('string');
  }
  expect(jsonBody(calls[1])).toBeNull();
  expect(jsonBody(calls[2])).toMatchObject({ meetingUrl: 'https://meet.google.com/abc-defg-hij' });
});

describe('Uplink diagnostics schema', () => {
  it('keeps the status fields when a Core stream record is out of shape', async () => {
    const { uplinkDiagnosticsSchema } = await import('./api.js');
    // Core's stream records evolve separately; a drifted one must not take the
    // control, sharing and remote-control status down with it.
    const parsed = uplinkDiagnosticsSchema.parse({
      control: 'connected',
      sharing: 'ready',
      remoteControl: 'ready',
      remoteStreams: [{ sessionId: 'session_one', streamId: 'abcdef01', state: 'open' }],
    });
    expect(parsed).toEqual({ control: 'connected', sharing: 'ready', remoteControl: 'ready' });
  });
});

describe('connection catalog and project Google access contracts', () => {
  it('loads account scopes and project usage without dropping account metadata', async () => {
    const account = {
      connected: true,
      accountEmail: 'me@example.test',
      scopes: ['scope'],
      projects: [{ id: 'project/one', name: 'One' }],
    };
    const usage = {
      github: 1,
      claude: 0,
      codex: 0,
      opencode: 0,
      google: 1,
      matrix: 0,
      doppler: 0,
      mcp: 0,
    };
    const { fetch, calls } = fakeFetchSequence(json(account), json(usage));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getGoogleConnection()).toEqual(account);
    expect(await client.getConnectionUsage()).toEqual(usage);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/google/connection',
      '/connections/usage',
    ]);
  });
  it.each(['gmail', 'calendar', 'contacts'] as const)(
    'scopes %s grants to the selected project and preserves legacy access counts',
    async (service) => {
      const connection = {
        enabled: false,
        connected: true,
        accountEmail: 'me@example.test',
        clientId: 'client',
      };
      const { fetch, calls } = fakeFetchSequence(
        json({ ...connection, legacySessionCount: 2 }),
        json({ ...connection, enabled: true }),
        new Response(null, { status: 204 }),
      );
      const client = new VerityClient({ baseUrl: 'http://host', fetch });
      expect(await client.getProjectGoogleConnection('project/one', service)).toEqual({
        ...connection,
        legacySessionCount: 2,
      });
      expect(await client.enableProjectGoogleConnection('project/one', service)).toEqual({
        ...connection,
        enabled: true,
      });
      await client.disableProjectGoogleConnection('project/one', service);
      expect(calls.map((call) => [new URL(call.url).pathname, call.init?.method])).toEqual(
        ['GET', 'PUT', 'DELETE'].map((method) => [
          `/projects/project%2Fone/google/${service}`,
          method,
        ]),
      );
    },
  );
  it('rejects invalid access counts rather than displaying unsafe account state', async () => {
    const { fetch } = fakeFetch(
      json({
        enabled: false,
        connected: true,
        accountEmail: null,
        clientId: null,
        legacySessionCount: -1,
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getProjectGoogleConnection('one', 'gmail')).rejects.toThrow();
  });
});

describe('text-file saving', () => {
  it('sends conditional edits and create-only requests to the content route', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ path: 'notes/a.md', content: 'edited', size: 6, version: 'saved', editable: true }),
      json({ path: 'notes/new.md', content: '', size: 0, version: 'created', editable: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const saved = await client.saveSessionFileContent(
      's/1',
      'knowledge',
      'notes/a.md',
      'edited',
      'original',
    );
    expect(saved).toMatchObject({ content: 'edited', version: 'saved', editable: true });
    await client.saveSessionFileContent('s/1', 'knowledge', 'notes/new.md', '', null);
    expect(calls[0]?.url).toBe('http://host/sessions/s%2F1/files/content');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      root: 'knowledge',
      path: 'notes/a.md',
      content: 'edited',
      expectedVersion: 'original',
    });
    expect(JSON.parse(calls[1]?.init?.body as string)).toMatchObject({ expectedVersion: null });
  });
  it('lists and reads file versions with encoded paths and version identifiers', async () => {
    const versions = [
      { id: 'save-abc/snapshot', createdAt: '2026-10-03T10:00:00Z', kind: 'snapshot' },
    ];
    const { fetch, calls } = fakeFetchSequence(json({ versions }), json({ content: 'older text' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listSessionFileVersions('s1', 'shared', 'notes/a b.md')).toEqual(versions);
    expect(
      await client.readSessionFileVersion('s1', 'shared', 'notes/a b.md', versions[0]!.id),
    ).toBe('older text');
    expect(calls.map(({ url }) => url)).toEqual([
      'http://host/sessions/s1/files/history?root=shared&path=notes%2Fa%20b.md',
      'http://host/sessions/s1/files/history?root=shared&path=notes%2Fa%20b.md&version=save-abc%2Fsnapshot',
    ]);
    expect(calls.every(({ init }) => init?.method === 'GET')).toBe(true);
  });
  it('preserves the committed-save warning for the editor', async () => {
    const payload = {
      path: 'note.md',
      content: 'saved',
      size: 5,
      version: 'saved-version',
      editable: true,
      warning: 'Knowledge refresh failed',
    };
    const { fetch } = fakeFetch(json(payload));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(
      await client.saveSessionFileContent('s1', 'knowledge', 'note.md', 'saved', null),
    ).toEqual(payload);
  });
});

it('links new Drive folders read-only and preserves explicit read/write choice', async () => {
  const { fetch, calls } = fakeFetchSequence(
    json({ folder: { id: 'root', name: 'Root' } }),
    json({ folder: { id: 'root', name: 'Root' } }),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await client.connectProjectGoogleDriveFolder('p/1', 'root');
  await client.connectProjectGoogleDriveFolder('p/1', 'root', 'read-write');
  expect(jsonBody(calls[0])).toEqual({ fileId: 'root', accessMode: 'read-only' });
  expect(jsonBody(calls[1])).toEqual({ fileId: 'root', accessMode: 'read-write' });
});

describe('local preview shares', () => {
  it('uses the direct server hostname for local links while API calls use Uplink', async () => {
    const share = {
      id: 'share/one',
      url: 'http://localhost:8100/',
      projectId: 'project-one',
      sessionId: 'session/one',
      targetPort: 5173,
      staticPath: null,
      expiresAt: '2026-10-04T12:00:00Z',
    };
    const transport = fakeFetchSequence(
      Response.json({ publicSharing: 'premium-required' }),
      Response.json({ share }),
      Response.json({ shares: [share, { ...share, url: 'http://192.168.1.20:8101/' }] }),
      new Response(null, { status: 204 }),
    );
    const client = new VerityClient({
      baseUrl: 'https://remote.example',
      localPreviewBaseUrl: 'http://192.168.1.10:8082',
      fetch: transport.fetch,
    });
    expect(await client.getPreviewCapabilities()).toEqual({ publicSharing: 'premium-required' });
    const created = await client.createSessionLocalPreviewShare('session/one', {
      targetPort: 5173,
    });
    expect(created.url).toBe('http://192.168.1.10:8100/');
    expect(created.expiresAt).toEqual(new Date(share.expiresAt));
    expect(
      (await client.listSessionLocalPreviewShares('session/one')).map((item) => item.url),
    ).toEqual([created.url, 'http://192.168.1.20:8101/']);
    await client.stopLocalPreviewShare(share.id);
    expect(transport.calls.map(({ url, init }) => [url, init?.method])).toEqual([
      ['https://remote.example/preview-capabilities', 'GET'],
      ['https://remote.example/sessions/session%2Fone/local-shares', 'POST'],
      ['https://remote.example/sessions/session%2Fone/local-shares', 'GET'],
      ['https://remote.example/local-shares/share%2Fone', 'DELETE'],
    ]);
    const body = transport.calls[1]?.init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(typeof body === 'string' ? body : '')).toEqual({ targetPort: 5173 });
  });
});

describe('managed dev server client', () => {
  const server = {
    id: 'entry-1',
    name: 'Web',
    command: 'npm run dev',
    workdir: '.',
    approved: true,
    instance: {
      id: 'instance-1',
      localShareId: 'local-share-1',
      sessionId: 's1',
      state: 'running',
      desired: 'running',
      detail: null,
      url: 'http://localhost:8100/',
      sandboxPort: 41000,
      awaitingApproval: false,
      restartToApply: false,
      startedAt: null,
    },
    elsewhere: [],
  };

  // Browser probing uses the local share id, independently minted from the instance.
  it('preserves the local share identity while resolving its network host', async () => {
    const { fetch } = fakeFetch(json({ servers: [server] }));
    const client = new VerityClient({ baseUrl: 'http://verity.local:3000', fetch });
    const entries = await client.listManagedDevServers('s1');
    expect(entries?.[0]?.instance).toMatchObject({
      id: 'instance-1',
      localShareId: 'local-share-1',
      url: 'http://verity.local:8100/',
    });
  });

  it('falls back for an older Core but preserves an actual missing-session error', async () => {
    const { fetch } = fakeFetchSequence(
      json({ error: 'Not Found' }, 404),
      json({ error: 'session not found' }, 404),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listManagedDevServers('s1')).toBeNull();
    await expect(client.listManagedDevServers('missing')).rejects.toMatchObject({
      status: 404,
      message: 'session not found',
    });
  });
});

describe('managed dev server actions', () => {
  it.each(['start', 'stop', 'restart'] as const)(
    'sends %s to the selected entry',
    async (action) => {
      const server = {
        id: 'entry/1',
        name: 'Web',
        command: 'npm run dev',
        workdir: '.',
        approved: true,
        instance: null,
        elsewhere: [],
      };
      const { fetch, calls } = fakeFetch(json({ server }));
      const client = new VerityClient({ baseUrl: 'http://host', fetch });
      expect(await client.controlManagedDevServer('s/1', server.id, action)).toEqual(server);
      expect(calls[0]?.url).toBe(
        `http://host/sessions/s%2F1/managed-dev-servers/entry%2F1/${action}`,
      );
      expect(calls[0]?.init?.method).toBe('POST');
    },
  );

  // Starting from Shared online must tell Core to leave Local off.
  it('sends the Local switch with a start and on its own route', async () => {
    const server = {
      id: 'entry/1',
      name: 'Web',
      command: 'npm run dev',
      workdir: '.',
      approved: true,
      instance: null,
      elsewhere: [],
    };
    const { fetch, calls } = fakeFetchSequence(json({ server }), json({ server }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.controlManagedDevServer('s/1', server.id, 'start', { local: false });
    expect(jsonBody(calls[0])).toEqual({ local: false });
    await client.setManagedDevServerLocal('s/1', server.id, true);
    expect(calls[1]?.url).toBe('http://host/sessions/s%2F1/managed-dev-servers/entry%2F1/local');
    expect(jsonBody(calls[1])).toEqual({ on: true });
  });

  it('approves the displayed command, reads logs, stops another instance, and deletes the entry', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ servers: [] }),
      json({ logs: 'ready\n' }),
      json({ servers: [] }),
      new Response(null, { status: 204 }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const seen = { command: 'npm run dev', workdir: 'web' };
    expect(await client.approveManagedDevServer('s/1', 'entry/1', seen)).toEqual([]);
    expect(jsonBody(calls[0])).toEqual(seen);
    expect(await client.managedDevServerLogs('s/1', 'entry/1')).toBe('ready\n');
    expect(await client.stopManagedDevServerInstance('s/1', 'instance/2')).toEqual([]);
    await client.deleteManagedDevServer('s/1', 'entry/1');
    expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
      ['http://host/sessions/s%2F1/managed-dev-servers/entry%2F1/approve', 'POST'],
      ['http://host/sessions/s%2F1/managed-dev-servers/entry%2F1/logs', 'GET'],
      ['http://host/sessions/s%2F1/managed-dev-server-instances/instance%2F2/stop', 'POST'],
      ['http://host/sessions/s%2F1/managed-dev-servers/entry%2F1', 'DELETE'],
    ]);
  });
});

describe('VerityClient tasks', () => {
  const task = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    sessionId: null,
    sourceSessionId: null,
    origin: 'user',
    title: 'Captured',
    detail: null,
    attachments: [],
    status: 'open',
    result: null,
    sort: 0,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
  };
  it('uses the same client id and retains uploads on capture retries', async () => {
    const { fetch, calls } = fakeFetchSequence(json({ task }), json({ task }));
    const client = new VerityClient({ baseUrl: 'https://example.test', fetch });
    const body = {
      title: task.title,
      projectId: null,
      uploads: [
        { kind: 'file' as const, fileName: 'context.txt', mediaType: 'text/plain', data: 'aGk=' },
      ],
    };
    await client.saveTask(task.id, body);
    await client.saveTask(task.id, body);
    expect(calls.map((call) => call.url)).toEqual([
      `https://example.test/tasks/${task.id}`,
      `https://example.test/tasks/${task.id}`,
    ]);
    expect(jsonBody(calls[0])).toEqual(body);
    expect(jsonBody(calls[1])).toEqual(body);
  });
  it('validates responses and sends optimistic edit revisions', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ task }),
      json({ tasks: [{ ...task, title: 4 }] }),
    );
    const client = new VerityClient({ baseUrl: 'https://example.test', fetch });
    await client.updateTask(task.id, { title: 'Edited', expectedRevision: 1 });
    expect(jsonBody(calls[0])).toEqual({ title: 'Edited', expectedRevision: 1 });
    await expect(client.listTasks()).rejects.toThrow();
  });
});

describe('session reorder API', () => {
  it('reads the advertised capability and ranked summaries', async () => {
    const wire = {
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: null,
      status: 'idle',
      usage: ZERO_USAGE,
      sortOrder: 2,
      backgroundWorking: true,
      agentTextCounterVersion: 'agent-text-v2',
    };
    const { fetch } = fakeFetch(json({ sessions: [wire], sessionReordering: true }));
    const overview = await new VerityClient({
      baseUrl: 'http://host',
      fetch,
    }).listSessionOverview();
    expect(overview.sessionReordering).toBe(true);
    // Counter normalization must not strip the independently persisted order.
    expect(overview.sessions[0]).toMatchObject({
      sortOrder: wire.sortOrder,
      backgroundWorking: wire.backgroundWorking,
      eventCountVersion: wire.agentTextCounterVersion,
    });
  });
  it('persists a project-bound order and reads canonical IDs', async () => {
    const { fetch, calls } = fakeFetch(json({ ids: ['b', 'a'] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.reorderSessions('p', ['b', 'a'])).toEqual(['b', 'a']);
    expect(calls[0]?.url).toBe('http://host/sessions/order');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ projectId: 'p', ids: ['b', 'a'] }));
  });
});

it.each([true, false])(
  'measures Allow request with explicit context=%s without payload content',
  async (explicit) => {
    const trace = beginSessionSwitch('secret-session', 'permission');
    const { fetch } = fakeFetch(
      json({ sessionId: 'secret-session', toolUseId: 'private-tool-use', decided: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.decidePermission(
      'secret-session',
      'private-tool-use',
      { behavior: 'allow' },
      ...(explicit ? ([{ trace }] as const) : []),
    );
    expect(trace.phases.map((p) => p.phase)).toEqual([
      'allow-request-start',
      'allow-fetch-return',
      'allow-response-processed',
    ]);
    expect(JSON.stringify(trace.phases)).not.toContain('private-tool-use');
  },
);

it('does not attach continued old-model pagination to a returning gesture', async () => {
  const original = beginSessionSwitch('paginate');
  beginSessionSwitch('other-page');
  const returned = beginSessionSwitch('paginate');
  const fetch = vi.fn(async () => json({ events: [], hasMore: false }));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await client.getHistory('paginate', { beforeSeq: 10, timing: original });
  await client.getHistory('paginate', { beforeSeq: 5, timing: undefined });
  expect(returned.phases).toEqual([]);
  expect(original.phases).toEqual([]);
});

it('sends correlation headers only for an explicit timed session request', async () => {
  const { fetch, calls } = fakeFetchSequence(
    json({ events: [], hasMore: false }),
    json({ events: [], hasMore: false }),
  );
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  await client.getHistory('untimed');
  expect(
    (calls[0]?.init?.headers as Record<string, string> | undefined)?.['x-verity-switch-request'],
  ).toBeUndefined();
  const trace = beginSessionSwitch('private-correlated-target');
  await client.getHistory('private-correlated-target');
  const headers = calls[1]?.init?.headers as Record<string, string>;
  expect(headers['x-verity-switch-request']).toBe(`${trace.id}-r1`);
  expect(headers['x-verity-switch-kind']).toBe('events');
  expect(
    exportSessionSwitchTimings()
      .at(-1)
      ?.transportRequests[0]?.phases.map((p) => p.phase),
  ).toEqual(['fetch-dispatch', 'fetch-return']);
  expect(headers['x-verity-switch-request']).not.toContain('private');
});

describe('premium feature contracts', () => {
  it('retains separate entitlement, preference and effective states', async () => {
    const { uplinkDiagnosticsSchema } = await import('./api.js');
    const features = {
      sharing: { granted: true, enabled: false, effective: false },
      remoteAccess: { granted: false, enabled: true, effective: false },
    };
    expect(
      uplinkDiagnosticsSchema.parse({
        control: 'connected',
        sharing: 'unavailable',
        remoteControl: 'unavailable',
        features,
      }).features,
    ).toEqual(features);
    expect(
      uplinkDiagnosticsSchema.parse({
        control: 'connected',
        sharing: 'ready',
        remoteControl: 'unavailable',
      }).features,
    ).toBeUndefined();
  });
  it('accepts a locally disabled sharing capability', async () => {
    const { fetch } = fakeFetchSequence(json({ publicSharing: 'disabled' }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getPreviewCapabilities()).toEqual({ publicSharing: 'disabled' });
  });
});
