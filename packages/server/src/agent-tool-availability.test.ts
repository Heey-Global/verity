import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { connectorToolAvailable } from './agent-tool-availability.js';

describe('connector discovery', () => {
  it('keeps account-only Drive document reads available without project folder links', async () => {
    let scopes = ['https://www.googleapis.com/auth/drive'];
    const store = {
      googleAccounts: {
        list: async () => [{ id: 'a', scopes }],
        folders: async () => [],
      },
    } as unknown as EventStore;
    const input = { projectId: 'p', sessionId: 's', toolName: 'verity_google_drive' as const };
    expect(await connectorToolAvailable(store, input)).toBe(true);
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
    const input = { projectId: 'p', sessionId: 'allowed', toolName: 'verity_gmail' as const };
    expect(await connectorToolAvailable(store, input)).toBe(true);
    expect(await connectorToolAvailable(store, { ...input, sessionId: 'other' })).toBe(false);
    expect(
      await connectorToolAvailable(store, { ...input, toolName: 'verity_google_calendar' }),
    ).toBe(false);
    enabled = false;
    expect(await connectorToolAvailable(store, input)).toBe(false);
    expect(effectiveAccess).toHaveBeenCalledWith('allowed', 'gmail');
  });

  it('requires an assigned file of the matching workspace kind and account scope', async () => {
    const store = {
      getSessionWorkspaceFile: async (sessionId: string) =>
        sessionId === 'document' ? { accountId: 'a', kind: 'docs' } : undefined,
      googleAccounts: {
        get: async () => ({ scopes: ['https://www.googleapis.com/auth/documents'] }),
      },
    } as unknown as EventStore;
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'document',
        toolName: 'verity_google_docs',
      }),
    ).toBe(true);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'document',
        toolName: 'verity_google_sheets',
      }),
    ).toBe(false);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'p',
        sessionId: 'unassigned',
        toolName: 'verity_google_docs',
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
      }),
    ).toBe(true);
    expect(
      await connectorToolAvailable(store, {
        projectId: 'other',
        sessionId: 's',
        toolName: 'verity_matrix',
      }),
    ).toBe(false);
  });
});
