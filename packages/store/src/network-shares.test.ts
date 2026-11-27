import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import {
  InvalidNetworkSharePathError,
  NetworkShareStore,
  networkSharePathWithin,
  normalizeNetworkSharePath,
} from './network-shares.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['p1', 'p2'])
    await ctx.store.upsertProject({
      id,
      owner: 'acme',
      repo: id,
      containerName: `dev-acme-${id}`,
      state: 'active',
    });
});

const studio = {
  label: 'Studio NAS',
  host: 'nas.studio.lan',
  port: null,
  share: 'team',
  username: 'verity',
  password: 'pw-1',
};

describe('normalizeNetworkSharePath', () => {
  it('accepts both separators and drops empty segments', () => {
    expect(normalizeNetworkSharePath('/Projects\\Briefs//')).toBe('Projects/Briefs');
    expect(normalizeNetworkSharePath('')).toBe('');
  });

  // A path that resolved `..` instead of rejecting it could still be checked
  // against the grant after resolution, but the SMB server would see the raw
  // form; rejecting keeps the checked path and the requested path identical.
  it.each(['..', 'a/../b', 'a\\..\\b', './a', 'a/file.txt:secret', 'a/b\u0000', 'a/ b', 'a/b.'])(
    'rejects %j',
    (input) => {
      expect(() => normalizeNetworkSharePath(input)).toThrow(InvalidNetworkSharePathError);
    },
  );

  it('compares folder boundaries by whole segments and without case', () => {
    expect(networkSharePathWithin('Projects/Briefs', 'projects/briefs/a.md')).toBe(true);
    expect(networkSharePathWithin('Projects/Briefs', 'Projects/Briefs')).toBe(true);
    expect(networkSharePathWithin('Projects/Briefs', 'Projects/Briefs-old/a.md')).toBe(false);
    expect(networkSharePathWithin('Projects/Briefs', 'Projects')).toBe(false);
    expect(networkSharePathWithin('', 'anything/at/all')).toBe(true);
  });
});

describe('NetworkShareStore', () => {
  it('never lists the password and stores it encrypted', async () => {
    const shares = new NetworkShareStore(ctx.db, createSecretCipher('cd'.repeat(32)));
    const id = await shares.createConnection(studio);
    const [listed] = await shares.listConnections();
    expect(listed).toMatchObject({
      id,
      label: 'Studio NAS',
      host: 'nas.studio.lan',
      projectCount: 0,
    });
    expect(JSON.stringify(listed)).not.toContain('pw-1');
    const raw = await ctx.db
      .selectFrom('network_share_connections')
      .select('password')
      .executeTakeFirstOrThrow();
    expect(raw.password).not.toContain('pw-1');
    const credentials = await shares.credentials(id);
    expect(credentials?.password.toString()).toBe('pw-1');
  });

  it('keeps grants per project and counts projects per connection', async () => {
    const shares = ctx.store.networkShares;
    const id = await shares.createConnection(studio);
    const folder = await shares.grantFolder({
      projectId: 'p1',
      connectionId: id,
      path: '/Projects/Briefs/',
      name: 'Briefs',
      accessMode: 'read-only',
    });
    expect(await shares.projectFolders('p2')).toEqual([]);
    expect(await shares.projectFolder('p2', folder!)).toBeUndefined();
    const [granted] = await shares.projectFolders('p1');
    expect(granted).toMatchObject({
      path: 'Projects/Briefs',
      accessMode: 'read-only',
      stale: false,
    });
    expect((await shares.getConnection(id))?.projectCount).toBe(1);
    expect(await shares.projectsUsingShares()).toBe(1);
  });

  it('changes the grant revision with every access change', async () => {
    const shares = ctx.store.networkShares;
    const id = await shares.createConnection(studio);
    const folder = (await shares.grantFolder({
      projectId: 'p1',
      connectionId: id,
      path: 'Projects',
      name: 'Projects',
      accessMode: 'read-only',
    }))!;
    const before = (await shares.projectFolder('p1', folder))!.revision;
    expect(await shares.setFolderAccess('p2', folder, 'read-write')).toBe(false);
    expect(await shares.setFolderAccess('p1', folder, 'read-write')).toBe(true);
    const after = (await shares.projectFolder('p1', folder))!;
    expect(after.accessMode).toBe('read-write');
    expect(after.revision).not.toBe(before);
  });

  // Without the target revision a grant made for one NAS would keep working
  // after an administrator pointed the connection at another server.
  it('ends grants when the connection moves to another server or share', async () => {
    const shares = ctx.store.networkShares;
    const id = await shares.createConnection(studio);
    const folder = (await shares.grantFolder({
      projectId: 'p1',
      connectionId: id,
      path: 'Projects',
      name: 'Projects',
      accessMode: 'read-write',
    }))!;
    await shares.updateConnection(id, { label: 'Renamed', password: 'pw-2' });
    expect((await shares.projectFolder('p1', folder))?.stale).toBe(false);
    await shares.updateConnection(id, { share: 'archive' });
    expect((await shares.projectFolder('p1', folder))?.stale).toBe(true);
    expect(await shares.projectsUsingShares()).toBe(0);
  });

  it('removes project folders with the connection', async () => {
    const shares = ctx.store.networkShares;
    const id = await shares.createConnection(studio);
    await shares.grantFolder({
      projectId: 'p1',
      connectionId: id,
      path: 'Projects',
      name: 'Projects',
      accessMode: 'read-only',
    });
    expect(await shares.deleteConnection(id)).toBe(true);
    expect(await shares.projectFolders('p1')).toEqual([]);
  });
});
