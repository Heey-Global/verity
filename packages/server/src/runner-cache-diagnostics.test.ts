import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { requestRunnerSupervisor } from '@verity/session';
import { runSupervisor } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { runAgentSpawnBroker } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { RunnerCacheStorage } from './runner-cache-storage.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('carries full reports and ownership refusal over the actual supervisor and broker sockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cache-wire-'));
  roots.push(root);
  await chmod(root, 0o770);
  const broker = await runAgentSpawnBroker({
    runtimeDir: root,
    worktreeRoot: root,
    enforceRoot: false,
    agentUid: process.getuid!(),
    agentGid: process.getgid!(),
    scriptIsolation: { available: true },
  });
  vi.stubEnv('VERITY_AGENT_SPAWN_BROKER_SOCKET', broker.socketPath);
  let supervisor;
  try {
    supervisor = await runSupervisor({ runtimeDir: root, scriptIsolation: { available: true } });
    const socket = supervisor.socketPath;
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'project', sessionIds: [] }],
      request: async (_projectId, sessionIds, maxBytes) =>
        requestRunnerSupervisor(socket, { kind: 'reclaim-package-caches', sessionIds, maxBytes }),
    });
    await storage.runOnce();
    expect(storage.lastReport).toMatchObject({
      usageComplete: true,
      removedBytes: 0,
      blockers: [],
    });
    await mkdir(join(root, 'turns', 'orphan'), { recursive: true });
    await storage.runOnce();
    expect(storage.lastReport).toMatchObject({
      usageComplete: false,
      removedBytes: 0,
      sharedBytes: null,
    });
    expect(storage.lastReport?.blockers.join(' ')).toContain(
      '[turn-ownership-unknown] missingState=1, invalidState=0, unsettledWithoutSession=0',
    );
    expect(JSON.stringify(storage.lastReport)).not.toContain(root);
    // A settled but invalid historical shape remains protected, never relabeled idle.
    await writeFile(
      join(root, 'turns', 'orphan', 'state.json'),
      JSON.stringify({ status: 'settled' }),
    );
    await storage.runOnce();
    expect(storage.lastReport?.blockers.join(' ')).toContain('missingState=0, invalidState=1');
  } finally {
    await supervisor?.close();
    await broker.close();
  }
});
