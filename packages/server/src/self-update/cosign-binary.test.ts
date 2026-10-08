import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withCosignBinary } from './cosign-binary.js';
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cosign-test-'));
  directories.push(root);
  return root;
}
it('uses the image-provided binary without a host download', async () => {
  const download = vi.fn();
  const run = vi.fn().mockResolvedValue('verified');
  await expect(withCosignBinary(run, { installed: async () => true, download })).resolves.toBe(
    'verified',
  );
  expect(run).toHaveBeenCalledWith(
    '/usr/local/bin/cosign',
    expect.stringMatching(/verity-cosign-[^/]+\/tuf$/),
  );
  expect(download).not.toHaveBeenCalled();
});
it('rejects mismatched downloaded bytes before executing and cleans staging', async () => {
  const root = await temporaryRoot();
  const run = vi.fn();
  await expect(
    withCosignBinary(run, {
      installed: async () => false,
      architecture: 'x64',
      platform: 'linux',
      temporaryRoot: root,
      download: async (_url, path) => {
        await writeFile(path, 'untrusted');
      },
    }),
  ).rejects.toThrow('checksum verification failed');
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
it.each([false, true])(
  'executes checked bytes privately and cleans staging (execution failure: %s)',
  async (fail) => {
    const root = await temporaryRoot();
    const bytes = 'test cosign binary';
    let executed = false;
    const result = withCosignBinary(
      async (path) => {
        executed = true;
        expect((await stat(path)).mode & 0o777).toBe(0o700);
        expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
        if (fail) throw new Error('signature rejected');
        return 'verified';
      },
      {
        installed: async () => false,
        architecture: 'arm64',
        platform: 'linux',
        temporaryRoot: root,
        expectedChecksum: createHash('sha256').update(bytes).digest('hex'),
        download: async (url, path) => {
          expect(url).toMatch(
            /^https:\/\/github.com\/sigstore\/cosign\/releases\/download\/v[^/]+\/cosign-linux-arm64$/,
          );
          await writeFile(path, bytes);
        },
      },
    );
    if (fail) await expect(result).rejects.toThrow('signature rejected');
    else await expect(result).resolves.toBe('verified');
    expect(executed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  },
);
it('cleans staging after a failed download', async () => {
  const root = await temporaryRoot();
  await expect(
    withCosignBinary(vi.fn(), {
      installed: async () => false,
      architecture: 'x64',
      platform: 'linux',
      temporaryRoot: root,
      download: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
  expect(await readdir(root)).toEqual([]);
});

it('streams the HTTPS response into verified private staging', async () => {
  const root = await temporaryRoot();
  const bytes = 'downloaded fixture';
  const fetcher = vi.fn().mockResolvedValue(new Response(bytes));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    withCosignBinary(async () => 'verified', {
      installed: async () => false,
      architecture: 'x64',
      platform: 'linux',
      temporaryRoot: root,
      expectedChecksum: createHash('sha256').update(bytes).digest('hex'),
    }),
  ).resolves.toBe('verified');
  expect((fetcher.mock.calls[0]![0] as URL).protocol).toBe('https:');
  expect(fetcher.mock.calls[0]![1]).toEqual({
    signal: expect.any(AbortSignal),
    redirect: 'manual',
  });
  expect(await readdir(root)).toEqual([]);
});
it('refuses an HTTP redirect before following it and cleans staging', async () => {
  const root = await temporaryRoot();
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://example.test/cosign' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  const run = vi.fn();
  await expect(
    withCosignBinary(run, {
      installed: async () => false,
      architecture: 'x64',
      platform: 'linux',
      temporaryRoot: root,
    }),
  ).rejects.toThrow('requires HTTPS');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
