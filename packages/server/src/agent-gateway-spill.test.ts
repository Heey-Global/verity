import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentGatewaySpill } from './agent-gateway-spill.js';

const roots: string[] = [];
const KEY = '7a'.repeat(32);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent gateway encrypted spill', () => {
  it('recovers a token only with the unseal key and never persists plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-spill-'));
    roots.push(root);
    const path = join(root, 'state', 'claude.enc');
    const spill = new AgentGatewaySpill(path);

    await expect(spill.unseal(KEY, 'shadow-access-token')).resolves.toBe('shadow-access-token');
    const stored = await readFile(path, 'utf8');
    expect(stored).toMatch(/^enc:v1:/u);
    expect(stored).not.toContain('shadow-access-token');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'state'))).mode & 0o777).toBe(0o700);
    await expect(new AgentGatewaySpill(path).unseal(KEY)).resolves.toBe('shadow-access-token');
    await expect(new AgentGatewaySpill(path).unseal('6b'.repeat(32))).rejects.toThrow();
    await spill.clear();
    await expect(spill.unseal(KEY)).resolves.toBeUndefined();
  });
});
