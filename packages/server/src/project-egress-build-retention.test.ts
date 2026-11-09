import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { readEgressHostConfiguration } from './project-egress-host-authority.js';
vi.mock('./project-egress-host-authority.js', () => ({ readEgressHostConfiguration: vi.fn() }));
import { protectedBuildRetainedImages } from './project-egress-build-retention.js';

it('retains an owned build image without any project relay registry entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'build-retention-'));
  const id = 'a'.repeat(64);
  const image = `ghcr.io/example/relay@sha256:${'b'.repeat(64)}`;
  try {
    await writeFile(join(directory, 'c'.repeat(64) + '.json'), JSON.stringify({
      version: 1, binding: { containerId: id },
    }), { mode: 0o600 });
    vi.mocked(readEgressHostConfiguration).mockResolvedValue({
      version: 1, binding: { containerId: id },
    });
    expect(await protectedBuildRetainedImages(async (expected) => {
      expect(expected).toBe(id);
      return JSON.stringify([{ Id: id, Config: { Image: image } }]);
    }, directory)).toEqual([image]);
    expect(await protectedBuildRetainedImages(async () => undefined, directory)).toEqual([]);
    await expect(protectedBuildRetainedImages(async () => JSON.stringify([
      { Id: 'd'.repeat(64), Config: { Image: image } },
    ]), directory)).rejects.toThrow('identity mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
