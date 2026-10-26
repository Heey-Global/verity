import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Written by `deploy/bin/verity-install` into the host runtime directory. */
const DEVCONTAINER_BUILDER_RECEIPT_FILE = 'devcontainer-builder.json';

const receiptSchema = z
  .object({
    version: z.literal(1),
    gid: z.number().int().positive().lt(65535),
  })
  .strict();

export type DevcontainerBuilderCapability =
  | { readonly state: 'available'; readonly gid: number }
  | { readonly state: 'unsupported' | 'invalid' };

/**
 * Whether the installer verified the dedicated devcontainer builder on this host.
 *
 * The receipt records an installation, not liveness: it is written only after
 * the builder unit was active and its socket existed, and it is the Updater's
 * sole reason to add the socket bind to a sealed spec. Whether the builder is
 * up when a project builds is the Server's to check, against the socket itself.
 */
export async function readDevcontainerBuilderCapability(
  directory = '/run/verity-host-runtime',
): Promise<DevcontainerBuilderCapability> {
  let handle;
  try {
    handle = await open(join(directory, DEVCONTAINER_BUILDER_RECEIPT_FILE), 'r');
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return { state: 'invalid' };
    const parsed = receiptSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    return parsed.success ? { state: 'available', gid: parsed.data.gid } : { state: 'invalid' };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'invalid',
    };
  } finally {
    await handle?.close();
  }
}
