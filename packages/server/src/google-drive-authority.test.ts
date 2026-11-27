import type { EventStore } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { authorizeGoogleDriveCall } from './google-drive-authority.js';

const USER = 'u1';

// The pre-card refusal for Drive calls: without it a read-only folder link
// would reach the approval card, or a moved session would act for its old project.
function fakeStore(accessMode: 'read-only' | 'read-write', projectId = 'p1') {
  const folders = vi.fn(async () => [
    {
      id: 'link1',
      accountId: 'a1',
      accountOwnerUserId: USER,
      revision: 'r1',
      folderId: 'root',
      name: 'Root',
      accessMode,
    },
  ]);
  const store = {
    getSession: async () => ({ projectId }),
    googleAccounts: {
      folders,
      list: async () => [
        {
          id: 'a1',
          email: 'me@example.test',
          credentialVersion: 1,
          scopes: ['https://www.googleapis.com/auth/drive'],
        },
      ],
    },
  } as unknown as EventStore;
  return { store, folders };
}

const call = (request: unknown) => ({ projectId: 'p1', sessionId: 's1', request });
const trash = {
  action: 'trash',
  folderLinkId: 'link1',
  fileId: 'file',
  name: 'Note',
  expectedVersion: 'v1',
};

describe('authorizeGoogleDriveCall', () => {
  it('refuses a session that moved to another project', async () => {
    const { store } = fakeStore('read-write', 'p2');
    await expect(
      authorizeGoogleDriveCall(store, call({ action: 'capabilities' }), async () => USER),
    ).rejects.toThrow('session project changed');
  });

  it('answers capabilities without a folder link before resolving any folder', async () => {
    const { store, folders } = fakeStore('read-only');
    await authorizeGoogleDriveCall(store, call({ action: 'capabilities' }), async () => USER);
    expect(folders).not.toHaveBeenCalled();
  });

  it('refuses changes in a read-only folder but allows them in a read-write one', async () => {
    await expect(
      authorizeGoogleDriveCall(fakeStore('read-only').store, call(trash), async () => USER),
    ).rejects.toThrow('read-only Google Drive access');
    await expect(
      authorizeGoogleDriveCall(fakeStore('read-write').store, call(trash), async () => USER),
    ).resolves.toBeUndefined();
  });
});
