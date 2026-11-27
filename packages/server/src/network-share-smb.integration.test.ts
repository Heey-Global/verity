// Runs the SMB adapter against a real Samba server. It needs a running smbd and
// is skipped unless VERITY_SMB_TEST describes one, as JSON:
//   { "binary": "/usr/bin/smbclient", "ldLibraryPath": "…", "host": "127.0.0.1",
//     "port": 4450, "share": "team", "username": "verity", "password": "…",
//     "root": "/path/the/share/serves", "unencryptedPort": 4451 }
// `unencryptedPort`, when given, is a second smbd on the same share with
// `server smb encrypt = off`; the adapter must refuse it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NetworkShareError, SmbClient, type SmbTarget } from './network-share-smb.js';

interface SmbTestServer {
  binary: string;
  ldLibraryPath?: string;
  host: string;
  port: number;
  share: string;
  username: string;
  password: string;
  root: string;
  unencryptedPort?: number;
}

const config = process.env.VERITY_SMB_TEST
  ? (JSON.parse(process.env.VERITY_SMB_TEST) as SmbTestServer)
  : undefined;

describe.skipIf(!config)('SmbClient against Samba', () => {
  const server = config!;
  const client = new SmbClient({
    binary: server.binary,
    env: server.ldLibraryPath ? { LD_LIBRARY_PATH: server.ldLibraryPath } : {},
    timeoutMs: 20_000,
  });
  const target = (patch: Partial<SmbTarget> = {}): SmbTarget => ({
    host: server.host,
    port: server.port,
    share: server.share,
    username: server.username,
    password: Buffer.from(server.password),
    ...patch,
  });
  const base = `verity-test-${process.pid}`;
  const local = (...parts: string[]) => join(server.root, base, ...parts);
  const failure = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NetworkShareError);
    return (error as NetworkShareError).code;
  };

  beforeAll(() => {
    mkdirSync(local('Briefs'), { recursive: true });
    mkdirSync(local('Other'), { recursive: true });
    writeFileSync(local('Briefs', 'kickoff.md'), 'hello');
  });
  afterAll(() => {
    rmSync(local(), { recursive: true, force: true });
  });

  it('connects with encryption and reports sign-in and share errors', async () => {
    await client.test(target());
    expect(await failure(client.test(target({ password: Buffer.from('wrong') })))).toBe(
      'sign_in_failed',
    );
    expect(await failure(client.test(target({ share: 'no-such-share' })))).toBe('share_not_found');
    expect(await failure(client.test(target({ port: 1 })))).toBe('unreachable');
  });

  // The adapter's promise is that file content never crosses the network in
  // the clear; a server that will not encrypt must be refused, not used.
  it.skipIf(!config?.unencryptedPort)('refuses a server without SMB3 encryption', async () => {
    // A specific code, not just any failure: an unreachable test server must
    // not let this pass.
    expect(await failure(client.test(target({ port: server.unencryptedPort! })))).toBe(
      'encryption_unavailable',
    );
    await expect(client.list(target({ port: server.unencryptedPort! }), base)).rejects.toThrow(
      NetworkShareError,
    );
  });

  it('lists folders and reads files', async () => {
    expect(await client.list(target(), base)).toEqual([
      { name: 'Briefs', kind: 'folder', size: 0 },
      { name: 'Other', kind: 'folder', size: 0 },
    ]);
    const read = await client.read(target(), `${base}/Briefs/kickoff.md`);
    expect(read.content.toString()).toBe('hello');
    expect(await failure(client.read(target(), `${base}/Briefs/missing.md`))).toBe('not_found');
    expect(await failure(client.read(target(), `${base}/Briefs`))).toBe('not_a_file');
  });

  it('creates files without ever replacing one', async () => {
    await client.create(target(), `${base}/Briefs/new notes.md`, Buffer.from('fresh'));
    expect(readFileSync(local('Briefs', 'new notes.md'), 'utf8')).toBe('fresh');
    expect(
      await failure(client.create(target(), `${base}/Briefs/kickoff.md`, Buffer.from('x'))),
    ).toBe('already_exists');
    expect(readFileSync(local('Briefs', 'kickoff.md'), 'utf8')).toBe('hello');
  });

  // A same-size change within the same second as the read must still count as
  // a conflict, leave the file untouched and leave no
  // temporary upload behind.
  it('updates only the version it read', async () => {
    const { version } = await client.read(target(), `${base}/Briefs/kickoff.md`);
    writeFileSync(local('Briefs', 'kickoff.md'), 'HELLO');
    expect(
      await failure(
        client.update(target(), `${base}/Briefs/kickoff.md`, Buffer.from('mine'), version),
      ),
    ).toBe('conflict');
    expect(readFileSync(local('Briefs', 'kickoff.md'), 'utf8')).toBe('HELLO');
    const current = await client.read(target(), `${base}/Briefs/kickoff.md`);
    await client.update(
      target(),
      `${base}/Briefs/kickoff.md`,
      Buffer.from('mine'),
      current.version,
    );
    expect(readFileSync(local('Briefs', 'kickoff.md'), 'utf8')).toBe('mine');
    expect((await client.list(target(), `${base}/Briefs`)).map((entry) => entry.name)).toEqual([
      'kickoff.md',
      'new notes.md',
    ]);
  });
});
