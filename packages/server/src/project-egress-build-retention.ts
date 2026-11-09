import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readEgressHostConfiguration } from './project-egress-host-authority.js';

const objectId = z.string().regex(/^[a-f0-9]{64}$/u);
/** A provisional snapshot only: the stopped host also reconciles private partial
 * checkpoints before installing policy, including anchors created after this read.
 * Installed image authority is checked by managedEgressConfiguration.
 */
export async function protectedBuildRetainedImages(
  inspect: (id: string) => Promise<string | undefined>,
  directory = '/var/lib/verity-egress/build-anchors',
): Promise<string[]> {
  const files = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  if (files.length > 10000) throw new Error('Protected build inventory is too large');
  const images: string[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file))
      throw new Error('Invalid protected build inventory entry');
    const raw = await readEgressHostConfiguration(join(directory, file));
    if (raw === undefined) continue; // The live controller may have retired it.
    const record = z.object({
      version: z.literal(1),
      binding: z.object({ containerId: objectId }),
    }).parse(raw);
    const inspection = await inspect(record.binding.containerId);
    if (inspection === undefined) continue;
    const value = z.array(z.object({
      Id: objectId,
      Config: z.object({ Image: z.string() }),
    })).length(1).parse(JSON.parse(inspection))[0]!;
    if (value.Id !== record.binding.containerId)
      throw new Error('Protected build retention identity mismatch');
    images.push(value.Config.Image);
  }
  return images;
}
