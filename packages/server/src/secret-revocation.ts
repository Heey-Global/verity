import {
  positiveVersionSchema,
  secretContractIdSchema,
  type RunGrantClaims,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

export type SecretRevocationSubject =
  | { kind: 'project'; id: string; version: 0 }
  | { kind: 'profile' | 'alias' | 'provider_binding'; id: string; version: number };

export interface SecretRevocationStore {
  revoke(
    projectId: string,
    subject: SecretRevocationSubject,
    reason: string,
    at: string,
  ): Promise<void>;
  isClaimsActive(claims: RunGrantClaims): Promise<boolean>;
}

function validateSubject(subject: SecretRevocationSubject): SecretRevocationSubject {
  const id = secretContractIdSchema.parse(subject.id);
  if (subject.kind === 'project') {
    if (subject.version !== 0) throw new Error('project revocation version must be zero');
    return { kind: 'project', id, version: 0 };
  }
  return { kind: subject.kind, id, version: positiveVersionSchema.parse(subject.version) };
}

export function createPostgresSecretRevocationStore(db: Kysely<Database>): SecretRevocationStore {
  return {
    async revoke(projectId, unparsedSubject, reason, at) {
      const validatedProjectId = secretContractIdSchema.parse(projectId);
      const subject = validateSubject(unparsedSubject);
      if (subject.kind === 'project' && subject.id !== validatedProjectId) {
        throw new Error('project revocation subject must match project');
      }
      if (reason.length < 1 || reason.length > 256) throw new Error('invalid revocation reason');
      if (!Number.isFinite(Date.parse(at))) throw new Error('invalid revocation timestamp');
      await db
        .insertInto('secret_revocations')
        .values({
          project_id: validatedProjectId,
          subject_kind: subject.kind,
          subject_id: subject.id,
          subject_version: subject.version,
          reason,
          revoked_at: at,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['project_id', 'subject_kind', 'subject_id', 'subject_version'])
            .doNothing(),
        )
        .execute();
    },
    async isClaimsActive(claims) {
      const rows = await db
        .selectFrom('secret_revocations')
        .select(['subject_kind', 'subject_id', 'subject_version'])
        .where('project_id', '=', claims.projectId)
        .execute();
      for (const row of rows) {
        if (!['project', 'profile', 'alias', 'provider_binding'].includes(row.subject_kind)) {
          return false;
        }
        if (row.subject_kind === 'project') return false;
        if (
          row.subject_kind === 'profile' &&
          row.subject_id === claims.profile.id &&
          row.subject_version === claims.profile.version
        ) {
          return false;
        }
        if (
          row.subject_kind === 'alias' &&
          claims.aliases.some(
            (alias) => alias.id === row.subject_id && alias.version === row.subject_version,
          )
        ) {
          return false;
        }
        if (
          row.subject_kind === 'provider_binding' &&
          claims.providerBindings.some(
            (binding) => binding.id === row.subject_id && binding.version === row.subject_version,
          )
        ) {
          return false;
        }
      }
      return true;
    },
  };
}
