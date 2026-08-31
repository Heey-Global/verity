import {
  executionProfileRefSchema,
  executionProfileRecordSchema,
  type ExecutionProfileRecord,
  type ExecutionProfileRef,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

export class SecretExecutionProfileRegistryError extends Error {}

export interface SecretExecutionProfileRegistry {
  provision(profile: ExecutionProfileRecord): Promise<void>;
  resolve(ref: ExecutionProfileRef, projectId: string): Promise<ExecutionProfileRecord | undefined>;
  list(projectId: string): Promise<ExecutionProfileRecord[]>;
}

function parseStored(value: string): ExecutionProfileRecord | undefined {
  try {
    const parsed = executionProfileRecordSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Durable server-owned registry for immutable, versioned Secret Job execution policy. */
export function createPostgresSecretExecutionProfileRegistry(
  db: Kysely<Database>,
): SecretExecutionProfileRegistry {
  return {
    async provision(input) {
      const profile = executionProfileRecordSchema.parse(input);
      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('secret_execution_profiles')
          .values({
            id: profile.id,
            project_id: profile.projectId,
            version: profile.version,
            profile_json: JSON.stringify(profile),
            state: profile.state,
          })
          .onConflict((conflict) => conflict.columns(['project_id', 'id', 'version']).doNothing())
          .execute();
        const stored = await tx
          .selectFrom('secret_execution_profiles')
          .select(['project_id', 'id', 'version', 'profile_json', 'state'])
          .where('project_id', '=', profile.projectId)
          .where('id', '=', profile.id)
          .where('version', '=', profile.version)
          .executeTakeFirstOrThrow();
        const parsedStored = parseStored(stored.profile_json);
        if (
          parsedStored === undefined ||
          parsedStored.projectId !== stored.project_id ||
          parsedStored.id !== stored.id ||
          parsedStored.version !== stored.version ||
          parsedStored.state !== stored.state ||
          JSON.stringify(parsedStored) !== JSON.stringify(profile)
        ) {
          throw new SecretExecutionProfileRegistryError('execution profile version is immutable');
        }
      });
    },

    async resolve(ref, projectId) {
      const parsedRef = executionProfileRefSchema.safeParse(ref);
      if (!parsedRef.success) return undefined;
      try {
        return await db
          .transaction()
          .setIsolationLevel('serializable')
          .execute(async (tx) => {
            const row = await tx
              .selectFrom('secret_execution_profiles')
              .select(['project_id', 'id', 'version', 'profile_json', 'state'])
              .where('project_id', '=', projectId)
              .where('id', '=', parsedRef.data.id)
              .where('version', '=', parsedRef.data.version)
              .executeTakeFirst();
            if (row === undefined || row.state !== 'active') return undefined;
            const profile = parseStored(row.profile_json);
            if (
              profile === undefined ||
              profile.projectId !== row.project_id ||
              profile.id !== row.id ||
              profile.version !== row.version ||
              profile.state !== row.state ||
              profile.policyHash !== parsedRef.data.policyHash
            ) {
              return undefined;
            }
            const laterRevocation = await tx
              .selectFrom('secret_execution_profiles')
              .select('version')
              .where('project_id', '=', projectId)
              .where('id', '=', parsedRef.data.id)
              .where('version', '>', parsedRef.data.version)
              .where('state', '=', 'disabled')
              .executeTakeFirst();
            return laterRevocation === undefined ? profile : undefined;
          });
      } catch {
        return undefined;
      }
    },

    async list(projectId) {
      const rows = await db
        .selectFrom('secret_execution_profiles')
        .select(['project_id', 'id', 'version', 'profile_json', 'state'])
        .where('project_id', '=', projectId)
        .orderBy('id')
        .orderBy('version')
        .execute();
      const profiles: ExecutionProfileRecord[] = [];
      for (const row of rows) {
        const profile = parseStored(row.profile_json);
        if (
          profile === undefined ||
          profile.projectId !== row.project_id ||
          profile.id !== row.id ||
          profile.version !== row.version ||
          profile.state !== row.state
        ) {
          throw new SecretExecutionProfileRegistryError('stored execution profile is invalid');
        }
        profiles.push(profile);
      }
      return profiles;
    },
  };
}
