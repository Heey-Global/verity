import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { identityHelperRequestSchema, openCaIdentityReceipt } from './identity-receipt.js';
import { readBounded, writeDurable } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';
import type { BackupDestination } from './destination.js';

/** Publish only a public recipient. The installer-owned watcher supplies a CA-authenticated reply. */
export async function requestBackupIdentity(options: {
  requestRoot: string;
  destination: BackupDestination;
  installationId: string;
  keyGeneration: number;
  recipient: string;
  certificate: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const request = identityHelperRequestSchema.parse({
    recipient: options.recipient,
    installationId: options.installationId,
    keyGeneration: options.keyGeneration,
  });
  return withRepositoryLock(join(options.requestRoot, 'request.lock'), async () => {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120000)]);
    signal.throwIfAborted();
    await options.destination.assertPresent();
    const path = options.destination.pinnedPath(
      'identity',
      `${request.installationId}-ca-key-k${request.keyGeneration}`,
    );
    const read = async (): Promise<boolean> => {
      await options.destination.assertPresent();
      try {
        openCaIdentityReceipt(
          await readBounded(path, 384 * 1024),
          options.certificate,
          request.installationId,
          request.keyGeneration,
          request.recipient,
        );
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        // A previous attempt may have used another recipient. Never return its receipt;
        // wait for the trusted watcher to replace it after this request is published.
        return false;
      }
    };
    if (await read()) return path;
    await writeDurable(
      join(options.requestRoot, 'recipient.json'),
      Buffer.from(
        JSON.stringify({ recipient: request.recipient, keyGeneration: request.keyGeneration }),
      ),
      false,
    );
    while (true) {
      signal.throwIfAborted();
      if (await read()) return path;
      await delay(250, undefined, { signal });
    }
  });
}
