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
      list: vi.fn().mockResolvedValue([one, two]),
      effectiveAccess: vi.fn().mockResolvedValue({ account: two, source: 'project' }),
      get: vi.fn().mockResolvedValue(two),
      folders: vi.fn().mockResolvedValue([]),
    },
    getSessionWorkspaceFile: vi.fn().mockResolvedValue({ accountId: two.id }),
  } as unknown as Pick<EventStore, 'googleAccounts' | 'getSessionWorkspaceFile'>;
}

describe('Google account presentation', () => {
  it('projects account scopes without selecting an arbitrary display email', async () => {
    expect(await googleAccountSettingsStatus(store())).toEqual({
      googleDriveConnected: true,
      gmailAuthorized: false,
      calendarAuthorized: false,
      contactsAuthorized: true,
      googleDriveAccountEmail: null,
    });
  });

  it('labels service approval with the effective grant, ignoring caller labels', async () => {
    expect(
      await googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_contacts',
        request: { googleAccount: one },
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
      }),
    ).toEqual({ id: two.id, email: two.email });
  });

  it('labels an explicit Drive account without selecting another connected account', async () => {
    expect(
      await googleApprovalAccount(store(), {
        sessionId: 's',
        projectId: 'p',
        toolName: 'verity_google_drive',
        request: { action: 'read_document_url', accountId: one.id },
      }),
    ).toEqual({ id: one.id, email: one.email });
  });
});
