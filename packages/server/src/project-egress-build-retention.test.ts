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
    await writeFile(
      join(directory, 'c'.repeat(64) + '.json'),
      JSON.stringify({
        version: 1,
        binding: { containerId: id },
      }),
      { mode: 0o600 },
    );
    // The same atomic-write entry can be in flight or left behind after a crash.
    const temporary = join(
      directory,
      'e'.repeat(64) + '.json.12345678-1234-4234-8234-123456789abc',
    );
    await writeFile(temporary, '{incomplete', { mode: 0o600 });
    vi.mocked(readEgressHostConfiguration).mockResolvedValue({
      version: 1,
      binding: { containerId: id },
    });
    expect(
      await protectedBuildRetainedImages(async (expected) => {
        expect(expected).toBe(id);
        return JSON.stringify([{ Id: id, Config: { Image: image } }]);
      }, directory),
    ).toEqual([image]);
    const readPaths = vi.mocked(readEgressHostConfiguration).mock.calls.map(([path]) => path);
    expect(readPaths).not.toContain(temporary);
    expect(await protectedBuildRetainedImages(async () => undefined, directory)).toEqual([]);
    // With no published record, a crash leftover must not invent image authority.
    await rm(join(directory, 'c'.repeat(64) + '.json'));
    expect(
      await protectedBuildRetainedImages(async () => {
        throw new Error('Temporary files must never trigger inspection');
      }, directory),
    ).toEqual([]);
    await writeFile(join(directory, 'c'.repeat(64) + '.json'), '{}', { mode: 0o600 });
    await expect(
      protectedBuildRetainedImages(
        async () => JSON.stringify([{ Id: 'd'.repeat(64), Config: { Image: image } }]),
        directory,
      ),
    ).rejects.toThrow('identity mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
