import { join } from 'node:path';
import type { RestoreJob } from './restore-job.js';
import { readBounded } from './repository.js';

/** The bundled Compose database volume is scoped to the staged installation's project. */
export async function restoreComposeDatabaseVolume(
  root: string,
  job: Pick<RestoreJob, 'id'>,
): Promise<string> {
  const project = (await readBounded(join(root, job.id, 'host/compose-project'), 128))
    .toString()
    .trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project))
    throw new Error('Invalid restored Compose project');
  return `${project}_verity-db`;
}
