import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { publishRestoreHostState, saveRestoreHostState } from './restore-host-state.js';
it('preserves original host bytes, ownership, modes and absence across interrupted publication and rollback retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-host-state-'));
  const live = join(root, 'live');
  const saved = join(root, 'saved');
  const prepared = join(root, 'prepared');
  await mkdir(live);
  await mkdir(prepared);
  const token = join(live, 'updater-token');
  await writeFile(token, 'old-private-token');
  await chmod(token, 0o640);
  await writeFile(join(live, 'custom'), 'unrelated configuration');
  const metadata = await stat(token);
  const jobId = randomUUID();
  try {
    await saveRestoreHostState(live, saved, jobId);
    expect(await readFile(join(saved, 'host-manifest'), 'utf8')).not.toContain('old-private-token');
    await writeFile(token, 'partially-promoted-token');
    await writeFile(join(live, 'installation-id'), randomUUID());
    await saveRestoreHostState(live, saved, jobId);
    expect(await readFile(join(saved, 'updater-token'), 'utf8')).toBe('old-private-token');
    await expect(publishRestoreHostState(prepared, live)).rejects.toThrow('incomplete');
    expect(await readFile(token, 'utf8')).toBe('partially-promoted-token');
    await expect(publishRestoreHostState(saved, live, randomUUID())).rejects.toThrow();
    expect(await readFile(token, 'utf8')).toBe('partially-promoted-token');
    await publishRestoreHostState(saved, live, jobId);
    await publishRestoreHostState(saved, live, jobId);
    expect(await readFile(token, 'utf8')).toBe('old-private-token');
    const restored = await stat(token);
    expect({ uid: restored.uid, gid: restored.gid, mode: restored.mode & 0o777 }).toEqual({
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode & 0o777,
    });
    await expect(stat(join(live, 'installation-id'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(live, 'custom'), 'utf8')).toBe('unrelated configuration');
    await writeFile(join(saved, 'updater-token'), 'tampered checkpoint');
    await writeFile(token, 'keep-current-state');
    await expect(publishRestoreHostState(saved, live, jobId)).rejects.toThrow('source changed');
    expect(await readFile(token, 'utf8')).toBe('keep-current-state');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
