import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  finishSessionCleanup,
  pendingSessionCleanups,
  queueSessionCleanup,
} from './pending-session-cleanup.js';

it('retains ownership after the session row is gone and removes only a completed cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-pending-cleanup-'));
  try {
    const first = {
      sessionId: 'first',
      sandboxCwd: '/work/first',
      runnerProjectIds: ['project'],
      bindings: [{ backend: 'codex', backendSessionId: 'thread' }],
    };
    const second = { ...first, sessionId: 'second' };
    await queueSessionCleanup(root, first);
    await queueSessionCleanup(root, second);
    await queueSessionCleanup(root, first);
    expect(await pendingSessionCleanups(root)).toEqual(expect.arrayContaining([first, second]));
    await finishSessionCleanup(root, first.sessionId);
    expect(await pendingSessionCleanups(root)).toEqual([second]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
