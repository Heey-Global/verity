import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
const execute = promisify(execFile);

it('durably removes only the exposed bundle, retries after publication failure and refuses retired request replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'identity-retirement-'));
  try {
    const state = join(root, 'state');
    const requests = join(root, 'requests');
    const destination = join(root, 'destination');
    const bin = join(root, 'bin');
    for (const path of [state, requests, destination, bin, join(destination, 'identity')])
      await mkdir(path);
    // Only root ownership and Docker are simulated; deletion, locks, sync and replay run the actual helper.
    const shims: Record<string, string> = {
      id: '#!/bin/sh\nprintf "0\\n"\n',
      stat: '#!/bin/sh\nif [ "$1" = "-c" ] && [ "$2" = "%u" ] || [ "$1" = "-Lc" ] && [ "$2" = "%u" ]; then printf "0\\n"; else exec /usr/bin/stat "$@"; fi\n',
      docker: '#!/bin/sh\nexit 17\n',
    };
    for (const [name, content] of Object.entries(shims)) {
      await writeFile(join(bin, name), content);
      await chmod(join(bin, name), 0o755);
    }
    const installation = randomUUID();
    const { host } = await generateBackupKeys();
    for (const [name, value] of Object.entries({
      'backup-dir': destination,
      'backup-server-image': `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      'installation-id': installation,
      'tls-ca-key.pem': 'fixture',
      'tls-ca-cert.pem': 'fixture',
    }))
      await writeFile(join(state, name), value);
    const old = join(destination, 'identity', `${installation}-ca-key-k1`);
    const unrelated = join(destination, 'identity', 'other-installation-ca-key-k1');
    await writeFile(old, 'exposed');
    await writeFile(unrelated, 'preserve');
    const request = { recipient: host.recipient, keyGeneration: 2, retireGeneration: 1 };
    await writeFile(join(requests, 'recipient.json'), JSON.stringify(request));
    const run = () =>
      execute('bash', [resolve('deploy/host/verity-backup-identity')], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH']}`,
          VERITY_STATE_DIR: state,
          VERITY_BACKUP_IDENTITY_DIR: requests,
        },
      });
    await expect(run()).rejects.toMatchObject({ code: 17 });
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('preserve');
    expect(
      await readFile(join(state, 'backup-retired-generations', `${installation}-k1`), 'utf8'),
    ).toBe(`${installation}:1\n`);
    expect(
      await readFile(join(destination, 'identity', `${installation}-ca-retired-k1`), 'utf8'),
    ).toBe(`${installation}:1\n`);
    // Simulate a crash after tombstone persistence but before deletion, followed by a stale request replay.
    await writeFile(old, 'interrupted-delete');
    await writeFile(
      join(requests, 'recipient.json'),
      JSON.stringify({ recipient: host.recipient, keyGeneration: 1 }),
    );
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining('permanently retired'),
    });
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(state, 'identity-rotation'));
    await writeFile(
      join(state, 'identity-rotation', 'checkpoint'),
      JSON.stringify({ phase: 'prepared' }),
    );
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining('rotation is pending'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
