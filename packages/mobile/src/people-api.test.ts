import { describe, expect, it } from 'vitest';
import { VerityClient } from './api.js';
import { teamSharingUnavailable } from './people-api.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A client whose requests are recorded and answered from `responses` in order. */
function clientAnswering(...responses: unknown[]): { client: VerityClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (responses.length === 0) throw new Error('no answer left for ' + url);
    const body = responses.shift();
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  }) as typeof globalThis.fetch;
  return { client: new VerityClient({ baseUrl: 'http://host', fetch }), calls };
}

function body(call: Call | undefined): unknown {
  const raw = call?.init?.body;
  if (typeof raw !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(raw) as unknown;
}

const member = {
  userId: 'lena',
  displayName: 'Lena',
  canRead: true,
  canExecute: true,
  canManage: false,
  creator: false,
  joinedAt: '2026-11-01T00:00:00.000Z',
};
const invitation = {
  id: 'inv-1',
  inviteeName: 'Mia',
  canExecute: false,
  state: 'open',
  expiresAt: '2026-11-08T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
};
const login = {
  sessionId: 'login-1',
  provider: 'claude',
  status: 'waiting',
  verificationUri: 'https://example.test/verify',
  userCode: 'ABCD',
  needsCode: true,
  configured: false,
  message: null,
};

describe('project team calls', () => {
  // The calls `VerityClient` carries from people-api.ts must keep reaching the
  // project's own team routes, escaping every id they put into the path.
  it('reads the team and manages invitations and members by escaped ids', async () => {
    const { client, calls } = clientAnswering(
      { members: [member], invitations: [invitation] },
      { invitation, linkFields: null },
      { invitation, linkFields: null },
      undefined,
      { member: { ...member, canManage: true } },
      undefined,
    );

    await expect(client.getProjectTeam('p/1')).resolves.toEqual({
      members: [member],
      invitations: [invitation],
    });
    await expect(
      client.createProjectInvitation('p/1', { inviteeName: 'Mia', canExecute: false }),
    ).resolves.toEqual({ invitation, linkFields: null });
    await client.getProjectInvitation('p/1', 'inv/1');
    await client.revokeProjectInvitation('p/1', 'inv/1');
    await expect(
      client.setProjectMemberRights('p/1', 'lena', { canExecute: true, canManage: true }),
    ).resolves.toMatchObject({ userId: 'lena', canManage: true });
    await client.removeProjectMember('p/1', 'lena');

    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'GET http://host/projects/p%2F1/team',
      'POST http://host/projects/p%2F1/invitations',
      'GET http://host/projects/p%2F1/invitations/inv%2F1',
      'DELETE http://host/projects/p%2F1/invitations/inv%2F1',
      'PATCH http://host/projects/p%2F1/members/lena',
      'DELETE http://host/projects/p%2F1/members/lena',
    ]);
    expect(body(calls[1])).toEqual({ inviteeName: 'Mia', canExecute: false });
    expect(body(calls[4])).toEqual({ canExecute: true, canManage: true });
  });

  // Inviting is hidden on a definitive reason only. A newer server's unknown
  // reason must not break the team page, and must hide nothing.
  it('reads why team sharing is unavailable, and ignores a reason it does not know', async () => {
    const { client } = clientAnswering(
      { members: [member], invitations: [], teamSharing: 'not_entitled' },
      { invitation, linkFields: null, teamSharing: 'teleported' },
    );
    const team = await client.getProjectTeam('p1');
    expect(team.teamSharing).toBe('not_entitled');
    expect(teamSharingUnavailable(team.teamSharing)).toBe(true);
    const read = await client.getProjectInvitation('p1', 'inv-1');
    expect(read.teamSharing).toBeUndefined();
    for (const waits of [undefined, 'available', 'uplink_offline'] as const)
      expect(teamSharingUnavailable(waits)).toBe(false);
  });

  it('joins a team with the invitation it was handed', async () => {
    const joined = {
      completionExpiresAt: Date.now() + 600_000,
      token: 't',
      tokenId: 'tid',
      userId: 'mia',
      projectId: 'p',
    };
    const { client, calls } = clientAnswering(joined);
    const request = {
      invitationId: 'inv',
      secret: 's',
      redemptionId: 'r',
      displayName: 'Mia',
    };
    await expect(client.joinTeam(request)).resolves.toEqual(joined);
    expect(calls[0]?.url).toBe('http://host/team/join');
    expect(body(calls[0])).toEqual({ ...request, completionProtocol: 1 });
  });
});

describe("the signed-in person's own provider accounts", () => {
  it('lists, logs in, saves OpenCode and disconnects on the personal routes', async () => {
    const { client, calls } = clientAnswering(
      { connections: [], usesInstanceLogins: true },
      { login },
      { login },
      { login: { ...login, status: 'complete' } },
      { provider: 'opencode', baseUrl: 'https://llm.example/v1', models: ['m'] },
      undefined,
    );

    await expect(client.listProviderConnections()).resolves.toEqual({
      connections: [],
      usesInstanceLogins: true,
    });
    await expect(client.startProviderConnectionLogin('claude')).resolves.toEqual(login);
    await client.getProviderConnectionLogin('login/1');
    await expect(
      client.submitProviderConnectionLoginCode('login/1', 'CODE'),
    ).resolves.toMatchObject({ status: 'complete' });
    await expect(
      client.setOpenCodeConnection({ baseUrl: 'https://llm.example/v1', apiKey: 'k' }),
    ).resolves.toEqual({ provider: 'opencode', baseUrl: 'https://llm.example/v1', models: ['m'] });
    await client.disconnectProviderConnection('opencode');

    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'GET http://host/me/provider-connections',
      'POST http://host/me/provider-connections/claude/login',
      'GET http://host/me/provider-connections/logins/login%2F1',
      'POST http://host/me/provider-connections/logins/login%2F1/code',
      'PUT http://host/me/provider-connections/opencode',
      'DELETE http://host/me/provider-connections/opencode',
    ]);
    expect(body(calls[3])).toEqual({ code: 'CODE' });
    expect(body(calls[4])).toEqual({ baseUrl: 'https://llm.example/v1', apiKey: 'k' });
  });

  it("sets the person's own default model for a project", async () => {
    const { client, calls } = clientAnswering({ defaultModel: 'codex/default' });
    await expect(client.setOwnProjectDefaultModel('p/1', 'codex/default')).resolves.toEqual({
      defaultModel: 'codex/default',
    });
    expect(`${calls[0]?.init?.method} ${calls[0]?.url}`).toBe(
      'PUT http://host/projects/p%2F1/default-model',
    );
    expect(body(calls[0])).toEqual({ model: 'codex/default' });
  });
});
