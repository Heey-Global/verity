import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexCredentialSpill } from './codex-credential-spill.js';

const roots: string[] = [];
const KEY = '7a'.repeat(32);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex gateway encrypted spill', () => {
  it('recovers auth only with the unseal key and never persists plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-codex-gateway-spill-'));
    roots.push(root);
    const path = join(root, 'state', 'codex.enc');
    const spill = new CodexCredentialSpill(path);
    const authJson = '{"tokens":{"access_token":"access","refresh_token":"refresh"}}';

    const sourceRevision = '1'.repeat(64);
    await spill.write(KEY, sourceRevision, authJson);
    const stored = await readFile(path, 'utf8');
    expect(stored).toMatch(/^enc:v1:/u);
    expect(stored).not.toContain('access');
    expect(stored).not.toContain('refresh');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'state'))).mode & 0o777).toBe(0o700);
    await expect(spill.read(KEY)).resolves.toEqual({ version: 2, sourceRevision, authJson });
    await expect(spill.read('6b'.repeat(32))).rejects.toThrow();
    await spill.clear();
    await expect(spill.read(KEY)).resolves.toBeUndefined();
  });
});
