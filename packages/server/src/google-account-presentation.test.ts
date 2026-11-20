import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import {
  googleAccountSettingsStatus,
  googleApprovalAccount,
} from './google-account-presentation.js';

const one = {
  id: 'one',
  email: 'one@example.test',
  scopes: ['https://www.googleapis.com/auth/drive'],
};
const two = {
  id: 'two',
  email: 'two@example.test',
  scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
};
function store() {
  return {
    googleAccounts: {
      list: vi.fn(async (userId: string) => (userId === 'alice' ? [one, two] : [])),
      effectiveAccess: vi.fn(async (_sessionId: string, _service: string, userId?: string) =>
        userId === 'alice' ? { account: two, source: 'project' } : undefined,
      ),
      getOwned: vi.fn(async (id: string, userId?: string) =>
        userId === 'alice' ? [one, two].find((account) => account.id === id) : undefined,
      ),
      folders: vi.fn().mockResolvedValue([]),
    },
    getSessionWorkspaceFile: vi.fn().mockResolvedValue({ accountId: two.id }),
  } as unknown as Pick<EventStore, 'googleAccounts' | 'getSessionWorkspaceFile'>;
}

describe('Google account presentation', () => {
  it('projects account scopes without selecting an arbitrary display email', async () => {
    expect(await googleAccountSettingsStatus(store(), 'alice')).toEqual({
      googleDriveConnected: true,
      gmailAuthorized: false,
      calendarAuthorized: false,
      contactsAuthorized: true,
      googleDriveAccountEmail: null,
    });
    // Another person's accounts must not make Google look connected for Bob.
    expect(await googleAccountSettingsStatus(store(), 'bob')).toMatchObject({
      googleDriveConnected: false,
      contactsAuthorized: false,
    });
  });

  it('labels service approval with the effective grant, ignoring caller labels', async () => {
    expect(
      await googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_contacts',
        request: { googleAccount: one },
        userId: 'alice',
      }),
    ).toEqual({ id: two.id, email: two.email });
  });

  it('labels Workspace approval with its assigned account', async () => {
    expect(
      await googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_docs',
        request: {},
        userId: 'alice',
      }),
    ).toEqual({ id: two.id, email: two.email });
    // An approval card for Bob must not be labelled with Alice's assigned account.
    await expect(
      googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_docs',
        request: {},
        userId: 'bob',
      }),
    ).rejects.toThrow('no longer available');
  });

  it('labels an explicit Drive account without selecting another connected account', async () => {
    expect(
      await googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_drive',
        request: { action: 'read_document_url', accountId: one.id },
        userId: 'alice',
      }),
    ).toEqual({ id: one.id, email: one.email });
  });
});
