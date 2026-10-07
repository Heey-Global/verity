import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { verifyServerImage } from './server-image-verify.js';

const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
it('verifies the exact official digest against the documented release authority', async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: '{}' });
  await verifyServerImage(image, execute);
  const security = await readFile('SECURITY.md', 'utf8');
  const command = security.match(/cosign verify \\\n([\s\S]*?)\n```/)![1]!;
  const issuer = command.match(/--certificate-oidc-issuer (\S+)/)![1]!;
  const identity = command.match(/--certificate-identity (\S+)/)![1]!;
  expect(execute).toHaveBeenCalledWith(
    '/usr/local/bin/cosign',
    ['verify', '--certificate-oidc-issuer', issuer, '--certificate-identity', identity, image],
    { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
  );
});
it.each(['latest', image.replace('@sha256:', ':sha256:'), image.replace('heey-global', 'other')])(
  'rejects a nonofficial or mutable reference: %s',
  async (reference) => {
    const execute = vi.fn();
    await expect(verifyServerImage(reference, execute)).rejects.toThrow('official digest');
    expect(execute).not.toHaveBeenCalled();
  },
);
it.each(['invalid signature', 'timeout', 'missing binary'])(
  'fails closed without forwarding process output: %s',
  async (message) => {
    await expect(
      verifyServerImage(image, vi.fn().mockRejectedValue(new Error(message))),
    ).rejects.toThrow('Server image signature verification failed');
  },
);
