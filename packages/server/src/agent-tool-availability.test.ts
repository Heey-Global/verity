import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { connectorToolAvailable } from './agent-tool-availability.js';

describe('connector discovery', () => {
  it('keeps account-only Drive document reads available without project folder links', async () => {
    let scopes = ['https://www.googleapis.com/auth/drive'];
    const store = {
      googleAccounts: {
        list: async (userId: string) => (userId === 'alice' ? [{ id: 'a', scopes }] : []),
        folders: async () => [],
      },
    } as unknown as EventStore;
    const input = {
      projectId: 'p',
      sessionId: 's',
      toolName: 'verity_google_drive' as const,
      userId: 'alice',
    };
    expect(await connectorToolAvailable(store, input)).toBe(true);
    expect(await connectorToolAvailable(store, { ...input, userId: 'bob' })).toBe(false);
    expect(await connectorToolAvailable(store, { ...input, userId: undefined })).toBe(false);
    scopes = [];
    expect(await connectorToolAvailable(store, input)).toBe(false);
  });
  it('uses session-bound access and current scopes without loading credentials', async () => {
    const scopes = ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    );
    let enabled = true;
    const effectiveAccess = vi.fn(async (sessionId: string) =>
      enabled && sessionId === 'allowed' ? { account: { scopes } } : undefined,
    );
    const store = { googleAccounts: { effectiveAccess } } as unknown as EventStore;
    const input = {
      projectId: 'p',
      sessionId: 'allowed',
      toolName: 'verity_gmail' as const,
      userId: 'alice',
    };
    expect(await connectorToolAvailable(store, input)).toBe(true);
    expect(await connectorToolAvailable(store, { ...input, sessionId: 'other' })).toBe(false);
    expect(
      await connectorToolAvailable(store, { ...input, toolName: 'verity_google_calendar' }),
    ).toBe(false);
    enabled = false;
    expect(await connectorToolAvailable(store, input)).toBe(false);
    expect(effectiveAccess).toHaveBeenCalledWith('allowed', 'gmail', 'alice');
  });

  it('requires an assigned file of the matching workspace kind and account scope', async () => {
    const store = {
      getSessionWorkspaceFile: async (sessionId: string) =>
        sessionId === 'document' ? { accountId: 'a', kind: 'docs' } : undefined,
      googleAccounts: {
        getOwned: async (_id: string, userId: string | undefined) =>
          userId === 'alice'
            ? { scopes: ['https://www.googleapis.com/auth/documents'] }
            : undefined,
      },
    } as unknown as EventStore;
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'document',
        toolName: 'verity_google_docs',
        userId: 'alice',
      }),
    ).toBe(true);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'document',
        toolName: 'verity_google_sheets',
        userId: 'alice',
      }),
    ).toBe(false);
    // The assigned file's account belongs to Alice; Bob's turn must not reach it.
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'document',
        toolName: 'verity_google_docs',
        userId: 'bob',
      }),
    ).toBe(false);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'unassigned',
        toolName: 'verity_google_docs',
        userId: 'alice',
      }),
    ).toBe(false);
  });

  it('does not expose Matrix for another project or inactive source', async () => {
    const store = {
      integrations: {
        matrixConfigSummary: async () => ({ username: 'a', endpoint: 'https://matrix.example' }),
        listAccounts: async () => [{ id: 'a', endpoint: 'https://matrix.example' }],
        listSources: async (projectId: string) => [
          { status: projectId === 'connected' ? 'active' : 'disabled', accountId: 'a' },
        ],
      },
    } as unknown as EventStore;
    expect(
      await connectorToolAvailable(store, {
        projectId: 'connected',
        sessionId: 's',
        toolName: 'verity_matrix',
        userId: undefined,
      }),
    ).toBe(true);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'other',
        sessionId: 's',
        toolName: 'verity_matrix',
        userId: undefined,
      }),
    ).toBe(false);
  });
});

describe('connector discovery per person (ADR 0023 §3)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createIsolatedTestDb();
    await ctx.db
      .insertInto('users')
      .values([
        { id: 'alice', role: 'member', status: 'active' },
        { id: 'bob', role: 'member', status: 'active' },
      ])
      .execute();
    await ctx.store.createProject({
      id: 'shared',
      kind: 'local',
      owner: '__local__',
      repo: 'shared',
      cloneDir: 'shared',
      containerName: 'shared',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'team-chat',
      projectId: 'shared',
      worktree: '/team-chat',
      model: 'test',
    });
    const account = await ctx.store.googleAccounts.save({
      ownerUserId: 'alice',
      email: 'alice@example.test',
      clientId: 'client',
      refreshToken: 'alice-refresh',
      scopes: [
        'gmail.readonly',
        'gmail.compose',
        'gmail.settings.basic',
        'calendar.calendarlist.readonly',
        'calendar.events',
        'drive',
      ].map((scope) => `https://www.googleapis.com/auth/${scope}`),
    });
    await ctx.store.googleAccounts.setProjectAccess('shared', 'gmail', 'alice', account.id);
    await ctx.store.googleAccounts.setSessionAccess('team-chat', 'calendar', {
      mode: 'account',
      accountId: account.id,
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("does not offer Alice's Google tools to a turn run for Bob, who has no account", async () => {
    const input = (
      toolName: 'verity_gmail' | 'verity_google_calendar' | 'verity_google_drive',
    ) => ({
      projectId: 'shared',
      sessionId: 'team-chat',
      toolName,
    });
    for (const toolName of [
      'verity_gmail',
      'verity_google_calendar',
      'verity_google_drive',
    ] as const) {
      expect(await connectorToolAvailable(ctx.store, { ...input(toolName), userId: 'alice' })).toBe(
        true,
      );
      // Alice's project choice and the chat's explicit account must not leak to Bob.
      expect(await connectorToolAvailable(ctx.store, { ...input(toolName), userId: 'bob' })).toBe(
        false,
      );
      expect(
        await connectorToolAvailable(ctx.store, { ...input(toolName), userId: undefined }),
      ).toBe(false);
    }
  });
});
