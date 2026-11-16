import { createHash, randomBytes } from 'node:crypto';

import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

interface SigningCapabilityBinding {
  projectId: string;
  /** The person whose sandbox holds the capability (ADR 0023 §4). */
  userId: string;
  containerGeneration: string;
}

export interface SigningCapabilityRegistry {
  issue(binding: SigningCapabilityBinding): Promise<string>;
  resolve(capability: string): Promise<SigningCapabilityBinding | undefined>;
  /** Drop one sandbox's capability (sleep, relay stop). */
  revokeSandbox(projectId: string, userId: string): Promise<void>;
  /** Drop every sandbox's capability in a project (deprovision). */
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
          user_id: binding.userId,
          cap_hash: capHash,
          container_generation: binding.containerGeneration,
        })
        .onConflict((oc) =>
          oc.columns(['project_id', 'user_id']).doUpdateSet({
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
        .select(['project_id', 'user_id', 'container_generation'])
        .where('cap_hash', '=', hashCapability(capability))
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            projectId: row.project_id,
            userId: row.user_id,
            containerGeneration: row.container_generation,
          };
    },
    async revokeSandbox(projectId, userId): Promise<void> {
      await db
        .deleteFrom('signing_capabilities')
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .execute();
    },
    async revokeProject(projectId): Promise<void> {
      await db.deleteFrom('signing_capabilities').where('project_id', '=', projectId).execute();
    },
  };
}
