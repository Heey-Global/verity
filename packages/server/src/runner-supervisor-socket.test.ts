import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { supervisorSocketReachable } from './runner-supervisor-socket.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'verity-supervisor-probe-'));
  dirs.push(dir);
  return dir;
}

describe('supervisorSocketReachable', () => {
  it('is true while a supervisor accepts on the socket', async () => {
    const path = join(await scratchDir(), 'supervisor.sock');
    const server = createServer((peer) => peer.end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    await expect(supervisorSocketReachable(path)).resolves.toBe(true);
  });

  it('is false for a socket file no one listens on', async () => {
    // The shape a retired Sandbox generation leaves behind: the inode outlives the
    // process, `existsSync` says yes, and connecting is refused. This is the case the
    // presence check got wrong, so it is the one worth pinning.
    const path = join(await scratchDir(), 'supervisor.sock');
    await writeFile(path, '');

    await expect(supervisorSocketReachable(path)).resolves.toBe(false);
  });

  it('is false when the socket is absent', async () => {
    const path = join(await scratchDir(), 'supervisor.sock');

    await expect(supervisorSocketReachable(path)).resolves.toBe(false);
  });

  it('is false once a listener stops accepting', async () => {
    const path = join(await scratchDir(), 'supervisor.sock');
    const server = createServer((peer) => peer.end());
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await expect(supervisorSocketReachable(path)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(supervisorSocketReachable(path)).resolves.toBe(false);
  });
});
