import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const COSIGN_VERSION = '3.1.3';
export const COSIGN_SHA256 = {
  x64: '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71',
  arm64: 'c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a',
} as const;
const builtin = '/usr/local/bin/cosign';

async function installed(): Promise<boolean> {
  try {
    await access(builtin, constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function download(url: string, destination: string): Promise<void> {
  const signal = AbortSignal.timeout(120_000);
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== 'https:') throw new Error('cosign download requires HTTPS');
    const response = await fetch(current, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('cosign download redirect is invalid');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new Error('cosign download failed');
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > 256 * 1024 * 1024) callback(new Error('cosign download exceeds size limit'));
        else callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    return;
  }
  throw new Error('cosign download has too many redirects');
}

/** Host recovery uses the same verified binary without installing host packages. */
export async function withCosignBinary<T>(
  run: (path: string, tufRoot: string) => Promise<T>,
  deps: {
    installed?: () => Promise<boolean>;
    download?: (url: string, destination: string) => Promise<void>;
    architecture?: string;
    platform?: string;
    temporaryRoot?: string;
    expectedChecksum?: string;
  } = {},
): Promise<T> {
  const directory = await mkdtemp(join(deps.temporaryRoot ?? tmpdir(), 'verity-cosign-'));
  const tufRoot = join(directory, 'tuf');
  try {
    if (await (deps.installed ?? installed)()) return await run(builtin, tufRoot);
    const architecture = deps.architecture ?? process.arch;
    if ((deps.platform ?? process.platform) !== 'linux' || !['x64', 'arm64'].includes(architecture))
      throw new Error('Automatic cosign provisioning requires Linux AMD64 or ARM64');
    const arch = architecture === 'x64' ? 'amd64' : 'arm64';
    const expected =
      deps.expectedChecksum ?? COSIGN_SHA256[architecture as keyof typeof COSIGN_SHA256];
    const path = join(directory, 'cosign');
    await (deps.download ?? download)(
      `https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${arch}`,
      path,
    );
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid cosign download bytes');
      digest.update(chunk);
    }
    if (digest.digest('hex') !== expected) throw new Error('cosign checksum verification failed');
    await chmod(path, 0o700);
    return await run(path, tufRoot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
