import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCosignBinary } from './cosign-binary.js';

const exec = promisify(execFile);
export const SERVER_IMAGE_SIGNING_IDENTITY =
  'https://github.com/Heey-Global/verity/.github/workflows/release.yml@refs/heads/main';
export const SERVER_IMAGE_SIGNING_ISSUER = 'https://token.actions.githubusercontent.com';

/** Networked admission checks the image before the isolated Updater executes it. */
export async function verifyServerImage(
  image: string,
  execute: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<unknown> = (_file, args, options) =>
    withCosignBinary((file, tufRoot) =>
      exec(file, args, {
        ...options,
        env: { ...process.env, TUF_ROOT: tufRoot },
      }),
    ),
): Promise<void> {
  if (!/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Server image verification requires an official digest');
  try {
    await execute(
      '/usr/local/bin/cosign',
      [
        'verify',
        '--certificate-oidc-issuer',
        SERVER_IMAGE_SIGNING_ISSUER,
        '--certificate-identity',
        SERVER_IMAGE_SIGNING_IDENTITY,
        image,
      ],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    throw new Error('Server image signature verification failed');
  }
}
