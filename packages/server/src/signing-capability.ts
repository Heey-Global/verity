import { createHash, randomBytes } from 'node:crypto';

import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

interface SigningCapabilityBinding {
  projectId: string;
  containerGeneration: string;
}

export interface SigningCapabilityRegistry {
  issue(binding: SigningCapabilityBinding): Promise<string>;
  resolve(capability: string): Promise<SigningCapabilityBinding | undefined>;
  revokeProject(projectId: string): Promise<void>;
}

const CAPABILITY_BYTES = 32;

function hashCapability(capability: string): string {
  return createHash('sha256').update(`verity-git-sign-cap:${capability}`).digest('hex');
}

/** Persistent, project/container-generation-bound authority to use the git signer.
 * Only the hash is stored; issuing again rotates and immediately revokes the old value. */
export function createSigningCapabilityRegistry(db: Kysely<Database>): SigningCapabilityRegistry {
  return {
    async issue(binding): Promise<string> {
      const capability = randomBytes(CAPABILITY_BYTES).toString('base64url');
      const capHash = hashCapability(capability);
      await db
        .insertInto('signing_capabilities')
        .values({
          project_id: binding.projectId,
          cap_hash: capHash,
          container_generation: binding.containerGeneration,
        })
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({
            cap_hash: capHash,
            container_generation: binding.containerGeneration,
          }),
        )
        .execute();
      return capability;
    },
    async resolve(capability): Promise<SigningCapabilityBinding | undefined> {
      if (capability.length === 0) return undefined;
      const row = await db
        .selectFrom('signing_capabilities')
        .select(['project_id', 'container_generation'])
        .where('cap_hash', '=', hashCapability(capability))
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { projectId: row.project_id, containerGeneration: row.container_generation };
    },
    async revokeProject(projectId): Promise<void> {
      await db.deleteFrom('signing_capabilities').where('project_id', '=', projectId).execute();
    },
  };
}
