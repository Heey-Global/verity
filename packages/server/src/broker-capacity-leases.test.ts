import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdtemp, open, rename, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capacityLeaseRequest,
  runAgentSpawnBroker,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

let root: string;
let operationId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'capacity-'));
  operationId = randomUUID();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function request(action: 'create' | 'status' | 'retire', generation = 'generation-1') {
  return capacityLeaseRequest(
    { protocolVersion: 1, kind: 'capacity-lease', action, operationId, generation },
    { capacityLeaseRoot: join(root, 'leases'), enforceRoot: false },
  );
}

describe('trusted kernel capacity leases', () => {
  it('retains a child-inherited shared lease until the last holder exits and durably fences retirement', async () => {
    const created = await request('create');
    expect(created.state).toBe('idle');
    const handle = await open(created.path, 'r');
    const lock = spawn('/usr/bin/flock', ['--shared', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    await once(lock, 'exit');
    const holder = spawn(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'pipe', handle.fd] },
    );
    await once(holder.stdout!, 'data');
    await handle.close();
    try {
      expect((await request('status')).state).toBe('held');
      expect((await request('retire')).state).toBe('held');
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }
    expect((await request('status')).state).toBe('idle');
    expect((await request('retire')).state).toBe('retired');
  });

  it('releases only after kernel proof, preserves identity across restart, and cannot recreate retired UUIDs', async () => {
    const created = await request('create');
    const handle = await open(created.path, 'r');
    const lock = spawn('/usr/bin/flock', ['--shared', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    await once(lock, 'exit');
    expect((await request('status')).state).toBe('held');
    expect((await request('retire')).state).toBe('held');
    await handle.close();
    expect((await request('status')).identity).toEqual(created.identity);
    expect((await request('retire')).state).toBe('retired');
    expect((await request('status')).state).toBe('retired');
    expect((await request('create')).state).toBe('retired');
    expect((await request('create', 'wrong-generation')).state).toBe('unknown');
    await expect(open(created.path, 'r')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never interprets missing, replaced, symlinked, or writable evidence as idle', async () => {
    const created = await request('create');
    await rename(created.path, `${created.path}.original`);
    expect((await request('status')).state).toBe('unknown');
    expect((await request('create')).state).toBe('unknown');
    await writeFile(created.path, 'replacement', { mode: 0o644 });
    expect((await request('retire')).state).toBe('unknown');
    await rm(created.path);
    await symlink(`${created.path}.original`, created.path);
    expect((await request('status')).state).toBe('unknown');
    await rm(created.path);
    await rename(`${created.path}.original`, created.path);
    await chmod(created.path, 0o666);
    expect((await request('status')).state).toBe('unknown');
  });

  it('serializes concurrent creation and fences a reader opened before retirement', async () => {
    const replies = await Promise.all([request('create'), request('create'), request('create')]);
    expect(replies.map((reply) => reply.state)).toEqual(['idle', 'idle', 'idle']);
    expect(replies[1]?.identity).toEqual(replies[0]?.identity);
    expect(replies[2]?.identity).toEqual(replies[0]?.identity);
    const stale = await open(replies[0].path, 'r');
    try {
      expect((await request('retire')).state).toBe('retired');
      const lock = spawn('/usr/bin/flock', ['--shared', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', stale.fd],
      });
      await once(lock, 'exit');
      expect((await request('create')).state).toBe('retired');
      expect((await request('status')).state).toBe('retired');
    } finally {
      await stale.close();
    }
  });

  it('does not reconstruct missing original metadata from a surviving inode', async () => {
    const created = await request('create');
    await rm(join(root, 'leases', `${operationId}.json`));
    expect((await request('status')).state).toBe('unknown');
    expect((await request('create')).state).toBe('unknown');
    await expect(open(created.path, 'r').then((handle) => handle.close())).resolves.toBeUndefined();
  });

  it('rejects unsafe roots and corrupted metadata without releasing evidence', async () => {
    const created = await request('create');
    await writeFile(join(root, 'leases', `${operationId}.json`), '{}');
    expect((await request('retire')).state).toBe('unknown');
    await expect(open(created.path, 'r').then((handle) => handle.close())).resolves.toBeUndefined();
    await chmod(join(root, 'leases'), 0o777);
    expect((await request('create')).state).toBe('unknown');
  });
});

it('routes the capacity protocol through the trusted broker socket', async () => {
  await chmod(root, 0o770);
  const broker = await runAgentSpawnBroker({
    runtimeDir: root,
    worktreeRoot: root,
    capacityLeaseRoot: join(root, 'leases'),
    enforceRoot: false,
    agentUid: process.getuid!(),
    agentGid: process.getgid!(),
    scriptIsolation: { available: true },
  });
  const socket = createConnection(broker.socketPath);
  try {
    const response = new Promise<string>((resolve, reject) => {
      let bytes = '';
      socket.on('data', (data) => {
        bytes += data.toString();
      });
      socket.once('end', () => resolve(bytes));
      socket.once('error', reject);
    });
    await once(socket, 'connect');
    socket.write(
      JSON.stringify({
        protocolVersion: 1,
        kind: 'capacity-lease',
        action: 'create',
        operationId,
        generation: 'generation-1',
      }) + '\n',
    );
    expect(JSON.parse(await response)).toMatchObject({ ok: true, state: 'idle', operationId });
  } finally {
    socket.destroy();
    await broker.close();
  }
});
