import { describe, expect, it, vi } from 'vitest';
import {
  agentLoopConfigFingerprint,
  VerityApiError,
  VerityClient,
  projectRecordSchema,
  type TurnRequest,
} from './api.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

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
    expect(await client.listSessionOverview()).toEqual({ sessions: [summary], attention: [] });
  });

  // A server that predates the envelope ignores the query parameter and answers
  // with the bare array it always did. That must keep working, or upgrading the
  // app before the server would empty the session list.
  it('accepts the bare array an older server still returns', async () => {
    const { fetch } = fakeFetch(json([summary]));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listSessionOverview()).toEqual({ sessions: [summary], attention: [] });
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

describe('VerityClient.listIssues (#137)', () => {
  it('fetches and validates the open-issues list', async () => {
    const issues = [
      { number: 137, title: 'Issues on overview', body: 'do it', url: 'https://gh/137' },
      { number: 42, title: 'Another', body: '', url: 'https://gh/42' },
    ];
    const { fetch, calls } = fakeFetch(json(issues));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listIssues()).toEqual(issues);
    expect(calls[0]?.url).toBe('http://host/issues');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('maps a 503 (GitHub not configured) to an empty list, not an error', async () => {
    const { fetch } = fakeFetch(json({ error: 'GitHub issues are not configured' }, 503));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.listIssues()).toEqual([]);
  });

  it('propagates a non-503 error', async () => {
    const { fetch } = fakeFetch(json({ error: 'boom' }, 500));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listIssues()).rejects.toThrow();
  });

  it('throws on a drifted response shape', async () => {
    const { fetch } = fakeFetch(json([{ number: 1 }])); // missing title/body/url
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.listIssues()).rejects.toThrow();
  });
});

describe('VerityClient task management (ADR 0007)', () => {
  const issueItem = {
    id: 'PVTI_1',
    type: 'ISSUE',
    number: 42,
    title: 'Fix login',
    body: 'b',
    url: 'https://gh/42',
    state: 'OPEN',
    contentId: 'I_1',
    fields: [{ field: 'Priority', value: 'P1' }],
  };
  const draftItem = {
    id: 'PVTI_2',
    type: 'DRAFT_ISSUE',
    number: null,
    title: 'idea',
    body: '',
    url: '',
    state: null,
    contentId: 'DI_1',
    fields: [],
  };

  it('getTasks fetches and validates the board (incl. field defs)', async () => {
    const board = {
      projectId: 'PVT_1',
      number: 7,
      title: 'Roadmap',
      items: [issueItem, draftItem],
      fields: [{ id: 'F_prio', name: 'Priority', options: [{ id: 'O1', name: 'P1' }] }],
    };
    const { fetch, calls } = fakeFetch(json({ board }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getTasks()).toEqual(board);
    expect(calls[0]?.url).toBe('http://host/tasks');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('getTasks defaults fields to [] when a (pre-field) server omits them', async () => {
    const board = { projectId: 'PVT_1', number: 7, title: 'Roadmap', items: [] };
    const { fetch } = fakeFetch(json({ board }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.getTasks()).toEqual({ ...board, fields: [] });
  });

  it('setTaskField posts field + value to the item path', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.setTaskField('PVTI_1', 'Priority', 'P1');
    expect(calls[0]?.url).toBe('http://host/tasks/PVTI_1/field');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ field: 'Priority', value: 'P1' }));
  });

  it('getTasks maps a 503 (not configured) to null, and passes a null board through', async () => {
    const off = fakeFetch(json({ error: 'Task management is not configured' }, 503));
    expect(
      await new VerityClient({ baseUrl: 'http://host', fetch: off.fetch }).getTasks(),
    ).toBeNull();
    const empty = fakeFetch(json({ board: null }));
    expect(
      await new VerityClient({ baseUrl: 'http://host', fetch: empty.fetch }).getTasks(),
    ).toBeNull();
  });

  it('getTasks throws on a drifted item shape', async () => {
    const { fetch } = fakeFetch(
      json({ board: { projectId: 'p', number: 1, title: 't', items: [{ id: 'x' }] } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getTasks()).rejects.toThrow();
  });

  it('createTaskDraft POSTs the capture and returns the new item', async () => {
    const { fetch, calls } = fakeFetch(json({ item: draftItem }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.createTaskDraft({ title: 'idea' })).toEqual(draftItem);
    expect(calls[0]?.url).toBe('http://host/tasks/drafts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: 'idea' }));
  });

  it('createTaskIssue returns the created issue handles', async () => {
    const issue = { issueId: 'I_new', itemId: 'PVTI_new', number: 100, url: 'u100' };
    const { fetch, calls } = fakeFetch(json({ issue }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.createTaskIssue({ title: 'New' })).toEqual(issue);
    expect(calls[0]?.url).toBe('http://host/tasks/issues');
  });

  it('createTaskIssue forwards a chosen repo (the repo picker) in the body', async () => {
    const issue = { issueId: 'I_new', itemId: 'PVTI_new', number: 101, url: 'u101' };
    const { fetch, calls } = fakeFetch(json({ issue }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.createTaskIssue({ title: 'New', body: 'B', repo: 'acme/widgets' });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ title: 'New', body: 'B', repo: 'acme/widgets' }),
    );
  });

  it('convertTaskDraft targets the item path and returns the new issue ref', async () => {
    const result = { itemId: 'PVTI_2', number: 99, url: 'u99' };
    const { fetch, calls } = fakeFetch(json({ result }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.convertTaskDraft('PVTI_2', 'R_1')).toEqual(result);
    expect(calls[0]?.url).toBe('http://host/tasks/PVTI_2/convert');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ repositoryId: 'R_1' }));
  });

  it('convertTaskDraft can target a friendly repo', async () => {
    const result = { itemId: 'PVTI_2', number: 99, url: 'u99' };
    const { fetch, calls } = fakeFetch(json({ result }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.convertTaskDraft('PVTI_2', { repo: 'acme/widgets' })).toEqual(result);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ repo: 'acme/widgets' }));
  });

  it('updateTaskIssue PATCHes the issue path with the given fields', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.updateTaskIssue('I_1', { state: 'CLOSED' });
    expect(calls[0]?.url).toBe('http://host/tasks/issues/I_1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ state: 'CLOSED' }));
  });

  it('reorderTask sends itemId + afterId (null when omitted)', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.reorderTask('PVTI_2', 'PVTI_1');
    expect(calls[0]?.url).toBe('http://host/tasks/reorder');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ itemId: 'PVTI_2', afterId: 'PVTI_1' }));
    const top = fakeFetch(json({ ok: true }));
    await new VerityClient({ baseUrl: 'http://host', fetch: top.fetch }).reorderTask('PVTI_2');
    expect(top.calls[0]?.init?.body).toBe(JSON.stringify({ itemId: 'PVTI_2', afterId: null }));
  });

  it('removeTaskItem DELETEs the board item path', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await client.removeTaskItem('PVTI_2');
    expect(calls[0]?.url).toBe('http://host/tasks/PVTI_2');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('refineTask posts the transcript and returns the parsed blueprint', async () => {
    const refined = {
      title: 'Add dark mode',
      problem: 'Users want a dark theme.',
      acceptanceCriteria: ['Toggle in settings'],
      affectedAreas: [],
      openQuestions: ['Follow OS by default?'],
    };
    const { fetch, calls } = fakeFetch(json({ refined }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect(await client.refineTask('add dark mode')).toEqual(refined);
    expect(calls[0]?.url).toBe('http://host/tasks/refine');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ transcript: 'add dark mode' }));
  });

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

  it('starts, reads, stops, tails, and checks one dev server by stable id', async () => {
    const running = { projectId: 'p1', url: 'http://localhost:3000', running: true, pid: '101' };
    const stopped = { ...running, running: false, pid: null };
    const logs = { projectId: 'p1', logs: 'web ready\n' };
    const health = {
      projectId: 'p1',
      url: 'http://localhost:3000',
      reachable: true,
      status: 200,
      checkedAt: '2026-07-14T00:00:00.000Z',
      error: null,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ runtime: running }),
      json({ runtime: running }),
      json({ runtime: stopped }),
      json({ logs }),
      json({ health }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.startDevServer('web/one')).toEqual(running);
    expect(await client.getDevServerStatus('web/one')).toEqual(running);
    expect(await client.stopDevServer('web/one')).toEqual(stopped);
    expect(await client.getDevServerLogs('web/one')).toEqual(logs);
    expect(await client.getDevServerHealth('web/one')).toEqual(health);
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['POST', 'http://host/dev-servers/web%2Fone/runtime'],
      ['GET', 'http://host/dev-servers/web%2Fone/runtime'],
      ['POST', 'http://host/dev-servers/web%2Fone/runtime/stop'],
      ['GET', 'http://host/dev-servers/web%2Fone/runtime/logs'],
      ['GET', 'http://host/dev-servers/web%2Fone/runtime/health'],
    ]);
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

  it('refreshes a project token through concierge without exposing the token value', async () => {
    const refreshed = { projectId: 'p/1', refreshedAt: '2026-06-30T12:00:00.000Z' };
    const { fetch, calls } = fakeFetch(json(refreshed));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.refreshProjectToken('p/1')).toEqual(refreshed);
    expect(calls[0]?.url).toBe('http://host/concierge/projects/p%2F1/refresh-token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.stringify(refreshed)).not.toContain('ghs_');
  });

  it('recreates a project container through concierge', async () => {
    const { fetch, calls } = fakeFetch(
      json({ project: { ...project, state: 'container_starting' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.recreateProjectContainer('p/1')).toMatchObject({
      id: 'p1',
      state: 'container_starting',
    });
    expect(calls[0]?.url).toBe('http://host/concierge/projects/p%2F1/recreate-container');
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
    gitUserEmail: 'holger+github@heey.global',
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
      gitUserEmail: 'holger+github@heey.global',
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
});

describe('VerityClient.openConciergeSession', () => {
  it('POSTs to the Concierge session route and returns the session id', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 'concierge-1' }, 201));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.openConciergeSession()).resolves.toEqual({ sessionId: 'concierge-1' });
    expect(calls[0]?.url).toBe('http://host/concierge/session');
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

describe('VerityClient.setSessionSeen (#387)', () => {
  it('PATCHes the seen event count and returns the resolved mark', async () => {
    const { fetch, calls } = fakeFetch(json({ sessionId: 's1', lastSeenEventCount: 7 }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    const res = await client.setSessionSeen('s1', 7);

    expect(res).toEqual({ sessionId: 's1', lastSeenEventCount: 7 });
    expect(calls[0]?.url).toBe('http://host/sessions/s1/seen');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ eventCount: 7 }));
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
      json({ current: 'feat/notes', switchable: [], localMerge: { base: 'trunk' } }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    expect((await client.getBranches('s1')).localMerge?.base).toBe('trunk');

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
      gitUserEmail: 'holger+github@heey.global',
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

describe('VerityClient Agent Loops', () => {
  it('fingerprints the complete confirmed config, not only the script', () => {
    const base = {
      name: 'Audit',
      script: 'exit 0',
      schedule: { kind: 'daily' as const, hour: 3, minute: 0 },
      reactionPrompt: 'Investigate',
      reactionModel: null,
    };
    expect(agentLoopConfigFingerprint(base)).not.toBe(
      agentLoopConfigFingerprint({
        ...base,
        schedule: { kind: 'daily', hour: 4, minute: 0 },
      }),
    );
    expect(agentLoopConfigFingerprint(base)).not.toBe(
      agentLoopConfigFingerprint({ ...base, reactionModel: 'codex/default' }),
    );
  });
  const loop = {
    id: 'loop-1',
    projectId: 'project one',
    name: 'Dependency audit',
    status: 'draft',
    schedule: { kind: 'interval', everyMinutes: 30 },
    script: 'exit 0',
    reactionPrompt: null,
    reactionModel: null,
    sessionId: 'session-1',
    testedScriptFingerprint: null,
    consecutiveErrorCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    nextRunAt: null,
    createdAt: '2026-07-13T18:00:00.000Z',
    updatedAt: '2026-07-13T18:00:00.000Z',
  };

  it('uses the Agent Loop CRUD, test, and run-history endpoints', async () => {
    const enabled = { ...loop, status: 'enabled' };
    const { fetch, calls } = fakeFetchSequence(
      json({ loops: [loop] }),
      json({ loop }),
      json({ loop }),
      json({ loop: enabled }),
      json({ loop }),
      json({
        result: { outcome: 'ok', exitCode: 0, detail: 'clean', sessionId: 'session-1' },
        loop,
      }),
      json({
        result: { outcome: 'acted', exitCode: 10, detail: 'acted', sessionId: 'session-1' },
        run: {
          id: 'run-1',
          loopId: 'loop-1',
          startedAt: '2026-07-13T18:30:00.000Z',
          finishedAt: '2026-07-13T18:30:01.000Z',
          outcome: 'acted',
          exitCode: 10,
          detail: 'acted',
          sessionId: 'session-1',
          isTest: false,
        },
        loop: enabled,
      }),
      json({ ok: true }),
      json({ runs: [] }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listAgentLoops('project one')).toHaveLength(1);
    expect((await client.getAgentLoop('loop-1')).id).toBe('loop-1');
    await client.createAgentLoop('project one', { name: 'Dependency audit' });
    await client.updateAgentLoop('loop-1', { status: 'enabled' });
    await client.ensureAgentLoopSession('loop-1');
    expect((await client.testAgentLoop('loop-1')).result.outcome).toBe('ok');
    expect((await client.runAgentLoop('loop-1')).run.outcome).toBe('acted');
    await client.deleteAgentLoop('loop-1', { deleteSession: true });
    expect(await client.listAgentLoopRuns('loop-1')).toEqual([]);

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'http://host/projects/project%20one/agent-loops'],
      ['GET', 'http://host/agent-loops/loop-1'],
      ['POST', 'http://host/projects/project%20one/agent-loops'],
      ['PATCH', 'http://host/agent-loops/loop-1'],
      ['POST', 'http://host/agent-loops/loop-1/session'],
      ['POST', 'http://host/agent-loops/loop-1/test'],
      ['POST', 'http://host/agent-loops/loop-1/run'],
      ['DELETE', 'http://host/agent-loops/loop-1?deleteSession=true'],
      ['GET', 'http://host/agent-loops/loop-1/runs'],
    ]);
    expect(JSON.parse((calls[2]?.init?.body as string) ?? '')).toEqual({
      name: 'Dependency audit',
    });
    expect(JSON.parse((calls[3]?.init?.body as string) ?? '')).toEqual({ status: 'enabled' });
  });
});

describe('VerityClient Dev Servers', () => {
  const devServer = {
    id: 'ds-1',
    projectId: 'project one',
    name: 'Web',
    command: 'npm run dev',
    url: 'http://localhost:3000',
    workdir: null,
    hostPort: '3000',
    containerPort: null,
    sortOrder: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };

  it('fetches non-mutating dev-server suggestions', async () => {
    const suggestion = {
      key: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      workdir: null,
      containerPort: '5173',
      confidence: 'medium',
      evidence: 'Vite default from package.json script "dev"',
      status: 'new',
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    };
    const { fetch, calls } = fakeFetch(json({ fingerprint: 'abc', suggestions: [suggestion] }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.detectDevServers('project one')).toEqual([suggestion]);
    expect(calls).toEqual([
      expect.objectContaining({
        url: 'http://host/projects/project%20one/dev-server-suggestions',
        init: expect.objectContaining({ method: 'GET' }),
      }),
    ]);
  });

  it('returns the detection fingerprint with classified suggestions', async () => {
    const suggestion = {
      key: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      workdir: null,
      containerPort: '5173',
      confidence: 'medium',
      evidence: 'Vite default',
      status: 'changed',
      alreadyConfigured: true,
      existingDevServerId: 'ds-1',
      existingConfig: {
        name: 'Web',
        command: 'npm run dev:old',
        workdir: null,
        containerPort: '5173',
      },
    } as const;
    const { fetch } = fakeFetch(
      json({
        fingerprint: 'fingerprint-1',
        detectedAt: '2026-07-15T12:00:00.000Z',
        reviewedFingerprint: 'fingerprint-0',
        reviewedAt: '2026-07-15T11:00:00.000Z',
        suggestions: [suggestion],
      }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.getDevServerDetection('project one')).resolves.toEqual({
      fingerprint: 'fingerprint-1',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: 'fingerprint-0',
      reviewedAt: '2026-07-15T11:00:00.000Z',
      suggestions: [suggestion],
    });
  });

  it('marks an exact detection fingerprint as reviewed', async () => {
    const detection = {
      fingerprint: 'fingerprint-1',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: 'fingerprint-1',
      reviewedAt: '2026-07-15T12:01:00.000Z',
    };
    const { fetch, calls } = fakeFetch(json({ detection }));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.reviewDevServerDetection('project one', 'fingerprint-1')).resolves.toEqual(
      detection,
    );
    expect(calls[0]).toMatchObject({
      url: 'http://host/projects/project%20one/dev-server-suggestions/reviewed',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ fingerprint: 'fingerprint-1' }),
      }),
    });
  });

  it('uses the dev-server CRUD endpoints', async () => {
    const { fetch, calls } = fakeFetchSequence(
      json({ devServers: [devServer] }),
      json({ devServer }),
      json({ devServer }),
      json({ devServer: { ...devServer, command: 'pnpm dev' } }),
      json({ deleted: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    expect(await client.listDevServers('project one')).toHaveLength(1);
    expect((await client.getDevServer('ds-1')).id).toBe('ds-1');
    await client.createDevServer('project one', { name: 'Web', command: 'npm run dev' });
    expect((await client.updateDevServer('ds-1', { command: 'pnpm dev' })).command).toBe(
      'pnpm dev',
    );
    await client.deleteDevServer('ds-1');

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'http://host/projects/project%20one/dev-servers'],
      ['GET', 'http://host/dev-servers/ds-1'],
      ['POST', 'http://host/projects/project%20one/dev-servers'],
      ['PATCH', 'http://host/dev-servers/ds-1'],
      ['DELETE', 'http://host/dev-servers/ds-1'],
    ]);
    expect(JSON.parse((calls[2]?.init?.body as string) ?? '')).toEqual({
      name: 'Web',
      command: 'npm run dev',
    });
    expect(JSON.parse((calls[3]?.init?.body as string) ?? '')).toEqual({ command: 'pnpm dev' });
  });

  it('creates, lists, and stops public preview shares', async () => {
    const share = {
      id: 'share/one',
      projectId: 'project one',
      devServerId: 'ds/one',
      targetKind: 'dev-server',
      staticPath: null,
      state: 'active',
      publicOrigin: 'https://share.preview.example',
      expiresAt: '2026-01-01T02:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      failure: null,
    };
    const { fetch, calls } = fakeFetchSequence(
      json({ shares: [share] }),
      json({ share }),
      json({ stopped: true }),
    );
    const client = new VerityClient({ baseUrl: 'http://host', fetch });

    await expect(client.listPublicPreviewShares('project one')).resolves.toEqual([share]);
    await expect(
      client.createPublicPreviewShare('ds/one', { pin: '123456', ttlSeconds: 3600 }),
    ).resolves.toEqual(share);
    await client.stopPublicPreviewShare('share/one');

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'http://host/projects/project%20one/public-shares'],
      ['POST', 'http://host/dev-servers/ds%2Fone/public-shares'],
      ['DELETE', 'http://host/public-shares/share%2Fone'],
    ]);
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '')).toEqual({
      pin: '123456',
      ttlSeconds: 3600,
    });
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
    const token = await new VerityClient({ baseUrl: 'http://host', fetch }).prepareGithubManifest();
    expect(token).toBe('ott-xyz');
    expect(calls[0]?.url).toBe('http://host/github/app/manifest/prepare');
    expect(calls[0]?.init?.method).toBe('POST');
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
});
