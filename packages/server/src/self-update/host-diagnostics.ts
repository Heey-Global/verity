import { open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { hostDiagnosticSnapshotSchema } from '../runtime-diagnostics.js';

const capabilitySchema = z.object({
  version: z.literal(1),
  hostPath: z.string().refine(
    (path) =>
      path.startsWith('/') &&
      path !== '/' &&
      posix.normalize(path) === path &&
      !path.includes(':') &&
      !Array.from(path).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
  ),
  snapshot: hostDiagnosticSnapshotSchema.omit({ records: true }),
});

export type HostDiagnosticsCapability =
  | { state: 'available'; hostPath: string; snapshot: z.infer<typeof capabilitySchema>['snapshot'] }
  | { state: 'unsupported' | 'invalid' | 'stale' };

/** Read only the installer-owned exporter's bounded receipt, never raw host journals. */
export async function readHostDiagnosticsCapability(
  directory = '/run/verity-host-runtime',
  now = Date.now(),
): Promise<HostDiagnosticsCapability> {
  let handle;
  try {
    handle = await open(join(directory, 'diagnostics.json'), 'r');
    if ((await handle.stat()).size > 16_384) return { state: 'invalid' };
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) return { state: 'invalid' };
    const parsed = capabilitySchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    if (!parsed.success) return { state: 'invalid' };
    const age = now - Date.parse(parsed.data.snapshot.observedAt);
    if (age > 5 * 60_000 || age < -60_000) return { state: 'stale' };
    return { state: 'available', hostPath: parsed.data.hostPath, snapshot: parsed.data.snapshot };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'invalid',
    };
  } finally {
    await handle?.close();
  }
}
