import { describe, expect, it, vi } from 'vitest';

import {
  GoogleDriveFolderAuthorityError,
  assertDriveFileInLinkedFolder,
} from './google-drive-project-routes.js';
import type { DriveFile } from './google-drive.js';

describe('linked Google Drive folder authority', () => {
  it('accepts a nested file only after walking to the linked root', async () => {
    const files = new Map<string, DriveFile>([
      ['file', { id: 'file', name: 'Plan', mimeType: 'text/plain', parents: ['nested'] }],
      [
        'nested',
        {
          id: 'nested',
          name: 'Nested',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root'],
        },
      ],
      ['root', { id: 'root', name: 'Linked', mimeType: 'application/vnd.google-apps.folder' }],
    ]);
    const getFile = vi.fn(async (_token: string, id: string) => files.get(id)!);

    await expect(
      assertDriveFileInLinkedFolder('token', 'root', 'file', new Set(), getFile),
    ).resolves.toMatchObject({ id: 'file' });
    expect(getFile.mock.calls.map((call) => call[1])).toEqual(['file', 'nested', 'root']);
  });

  it('rejects a file whose parent chain does not reach the linked root', async () => {
    const files = new Map<string, DriveFile>([
      ['file', { id: 'file', name: 'Secret', mimeType: 'text/plain', parents: ['elsewhere'] }],
      [
        'elsewhere',
        { id: 'elsewhere', name: 'Other', mimeType: 'application/vnd.google-apps.folder' },
      ],
    ]);
    const getFile = async (_token: string, id: string) => files.get(id)!;

    await expect(
      assertDriveFileInLinkedFolder('token', 'root', 'file', new Set(), getFile),
    ).rejects.toBeInstanceOf(GoogleDriveFolderAuthorityError);
  });

  it('rejects cyclic parent metadata', async () => {
    const files = new Map<string, DriveFile>([
      ['a', { id: 'a', name: 'A', mimeType: 'text/plain', parents: ['b'] }],
      ['b', { id: 'b', name: 'B', mimeType: 'text/plain', parents: ['a'] }],
    ]);
    const getFile = async (_token: string, id: string) => files.get(id)!;

    await expect(
      assertDriveFileInLinkedFolder('token', 'root', 'a', new Set(), getFile),
    ).rejects.toThrow('outside the linked folder');
  });
});
