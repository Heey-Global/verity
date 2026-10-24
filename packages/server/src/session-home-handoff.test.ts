import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { materializeKnowledgeIsolation } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

const ownership = vi.hoisted(() => new Map<string, number>());
// Model a broker with CHOWN but no FOWNER, as shipped in the managed Runner.
// Rootless tests otherwise use the same identity on both sides of the handoff.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    chown: async (path: string, uid: number) => {
      ownership.set(path, uid);
    },
    chmod: async (path: string, mode: number) => {
      if ((ownership.get(path) ?? process.getuid!()) !== process.getuid!()) {
        throw Object.assign(new Error('chmod after ownership handoff'), { code: 'EPERM' });
      }
      await fs.chmod(path, mode);
    },
  };
});

it('sets persistent runtime permissions before handing directories to the agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-handoff-'));
  const agentUid = process.getuid!() + 1;
  try {
    const request = {
      command: 'claude-agent-acp' as const,
      sessionEnv: { VERITY_SESSION_ID: 'handoff-fixture' },
    };
    const isolated = await materializeKnowledgeIsolation(
      request,
      { enforceRoot: false, runtimeDir: root, agentUid, agentGid: process.getgid!() || 1 },
      'http://127.0.0.1:1',
    );
    try {
      for (const name of ['data', 'state', 'cache', 'tmp']) {
        const directory = join(isolated.home, name);
        expect(ownership.get(directory)).toBe(agentUid);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await isolated.cleanup();
    }
  } finally {
    ownership.clear();
    await rm(root, { recursive: true, force: true });
  }
});
