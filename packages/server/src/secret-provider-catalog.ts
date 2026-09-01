import { randomUUID } from 'node:crypto';

import {
  providerBindingRecordSchema,
  secretAliasRecordSchema,
  type ProviderBindingRecord,
  type ProviderBindingRef,
  type RunGrantClaims,
  type SecretAliasRecord,
  type SecretAliasRef,
} from '@verity/secret-contracts';
import { SealedError, type Database } from '@verity/store';
import type { Kysely } from 'kysely';

import type { DopplerSecretCatalog } from './doppler-secret-resolver.js';

export class SecretProviderCatalogError extends Error {}

type SecretPermissionScope = 'once' | 'session' | 'timed' | 'project';
interface SecretProviderPermission {
  id: string;
  projectId: string;
  bindingId: string;
  bindingVersion: number;
  secretName: string;
  toolId: string;
  scope: SecretPermissionScope;
  sessionId?: string;
  expiresAt?: string;
  remainingUses?: number;
  grantedBy: string;
  state: 'active' | 'revoked';
  createdAt: string;
}

export interface SecretProviderCatalog extends DopplerSecretCatalog {
  provisionBinding(record: ProviderBindingRecord): Promise<void>;
  createAlias(record: SecretAliasRecord): Promise<void>;
  listBindings(projectId: string): Promise<Array<Omit<ProviderBindingRecord, 'credentialRef'>>>;
  listAliases(
    projectId: string,
  ): Promise<
    Array<Omit<SecretAliasRecord, 'providerKey' | 'binding'> & { binding: ProviderBindingRef }>
  >;
  resolveAliasesForProfile(
    profile: SecretAliasRecord['profile'],
    projectId: string,
  ): Promise<SecretAliasRecord[]>;
  grantPermission(input: {
    projectId: string;
    bindingId: string;
    bindingVersion: number;
    secretName: string;
    toolId: string;
    scope: SecretPermissionScope;
    sessionId?: string;
    expiresAt?: string;
    grantedBy: string;
  }): Promise<SecretProviderPermission>;
  grantDynamicPermission(
    alias: SecretAliasRecord,
    input: {
      projectId: string;
      bindingId: string;
      bindingVersion: number;
      secretName: string;
      toolId: string;
      scope: SecretPermissionScope;
      sessionId?: string;
      expiresAt?: string;
      grantedBy: string;
    },
  ): Promise<SecretProviderPermission>;
  listPermissions(projectId: string): Promise<SecretProviderPermission[]>;
  revokePermission(id: string, projectId: string): Promise<boolean>;
  consumePermission: (input: {
    projectId: string;
    bindingId: string;
    bindingVersion: number;
    secretName: string;
    toolId: string;
    sessionId?: string;
    now: Date;
  }) => Promise<boolean>;
  consumePermissions: (
    inputs: {
      projectId: string;
      bindingId: string;
      bindingVersion: number;
      secretName: string;
      aliasId?: string;
      aliasVersion?: number;
      toolId: string;
      sessionId?: string;
      now: Date;
    }[],
  ) => Promise<boolean>;
  checkClaimsPermissions(claims: RunGrantClaims, now?: Date): Promise<boolean>;
  authorizeClaimsPermissions(claims: RunGrantClaims, now?: Date): Promise<boolean>;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
class PermissionUnavailable extends Error {}

function permissionFromRow(row: {
  id: string;
  project_id: string;
  binding_id: string;
  binding_version: number;
  secret_name: string;
  tool_id: string;
  scope: string;
  session_id: string | null;
  expires_at: Date | null;
  remaining_uses: number | null;
  granted_by: string;
  state: string;
  created_at: Date;
}): SecretProviderPermission {
  return {
    id: row.id,
    projectId: row.project_id,
    bindingId: row.binding_id,
    bindingVersion: row.binding_version,
    secretName: row.secret_name,
    toolId: row.tool_id,
    scope: row.scope as SecretPermissionScope,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
    ...(row.remaining_uses === null ? {} : { remainingUses: row.remaining_uses }),
    grantedBy: row.granted_by,
    state: row.state as 'active' | 'revoked',
    createdAt: row.created_at.toISOString(),
  };
}

function expectedCredentialRef(): string {
  return 'secretref:broker/doppler';
}

/** Durable, versioned catalog plus encrypted Doppler credential storage. */
export function createPostgresSecretProviderCatalog(db: Kysely<Database>): SecretProviderCatalog {
  const resolveBinding = async (
    ref: ProviderBindingRef,
    projectId: string,
  ): Promise<ProviderBindingRecord | undefined> => {
    let query = db
      .selectFrom('secret_provider_bindings')
      .selectAll()
      .where('id', '=', ref.id)
      .where('version', '=', ref.version)
      .where('provider', '=', ref.provider);
    query = query.where('project_id', '=', projectId);
    const row = await query.executeTakeFirst();
    if (row === undefined) return undefined;
    const laterRevocation = await db
      .selectFrom('secret_provider_bindings')
      .select('version')
      .where('project_id', '=', projectId)
      .where('id', '=', ref.id)
      .where('provider', '=', ref.provider)
      .where('version', '>', ref.version)
      .where('state', '!=', 'active')
      .executeTakeFirst();
    if (row.state !== 'active' || laterRevocation !== undefined) return undefined;
    return providerBindingRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      provider: row.provider,
      credentialRef: row.credential_ref,
      dopplerProject: row.doppler_project,
      dopplerConfig: row.doppler_config,
      state: row.state,
    });
  };

  const resolveStoredAlias = async (
    ref: SecretAliasRef,
    projectId: string,
  ): Promise<SecretAliasRecord | undefined> => {
    const row = await db
      .selectFrom('secret_aliases')
      .selectAll()
      .where('id', '=', ref.id)
      .where('version', '=', ref.version)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return secretAliasRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      name: row.name,
      description: row.description,
      binding: JSON.parse(row.binding_json) as unknown,
      providerKey: row.provider_key,
      injection: JSON.parse(row.injection_json) as unknown,
      profile: JSON.parse(row.profile_json) as unknown,
      state: row.state,
    });
  };

  const resolveAlias = async (
    ref: SecretAliasRef,
    projectId: string,
  ): Promise<SecretAliasRecord | undefined> => {
    const stored = await resolveStoredAlias(ref, projectId);
    if (stored === undefined) return undefined;
    const laterRevocation = await db
      .selectFrom('secret_aliases')
      .select('version')
      .where('project_id', '=', projectId)
      .where('id', '=', ref.id)
      .where('version', '>', ref.version)
      .where('state', '!=', 'active')
      .executeTakeFirst();
    if (stored.state !== 'active' || laterRevocation !== undefined) return undefined;
    return stored;
  };

  const consumePermissions: SecretProviderCatalog['consumePermissions'] = async (inputs) => {
    if (inputs.length === 0) return true;
    try {
      return await db.transaction().execute(async (tx) => {
        for (const projectId of [...new Set(inputs.map((input) => input.projectId))].sort()) {
          await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', projectId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        }
        for (const input of inputs) {
          const binding = await tx
            .selectFrom('secret_provider_bindings')
            .select('state')
            .where('project_id', '=', input.projectId)
            .where('id', '=', input.bindingId)
            .where('version', '=', input.bindingVersion)
            .where('provider', '=', 'doppler')
            .executeTakeFirst();
          const laterRevocation = await tx
            .selectFrom('secret_provider_bindings')
            .select('version')
            .where('project_id', '=', input.projectId)
            .where('id', '=', input.bindingId)
            .where('version', '>', input.bindingVersion)
            .where('provider', '=', 'doppler')
            .where('state', '!=', 'active')
            .executeTakeFirst();
          if (binding?.state !== 'active' || laterRevocation !== undefined) {
            throw new PermissionUnavailable();
          }
          if (input.aliasId !== undefined && input.aliasVersion !== undefined) {
            const alias = await tx
              .selectFrom('secret_aliases')
              .select('state')
              .where('project_id', '=', input.projectId)
              .where('id', '=', input.aliasId)
              .where('version', '=', input.aliasVersion)
              .executeTakeFirst();
            const laterAliasRevocation = await tx
              .selectFrom('secret_aliases')
              .select('version')
              .where('project_id', '=', input.projectId)
              .where('id', '=', input.aliasId)
              .where('version', '>', input.aliasVersion)
              .where('state', '!=', 'active')
              .executeTakeFirst();
            if (alias?.state !== 'active' || laterAliasRevocation !== undefined) {
              throw new PermissionUnavailable();
            }
          }
          const rows = await tx
            .selectFrom('secret_provider_permissions')
            .selectAll()
            .where('project_id', '=', input.projectId)
            .where('binding_id', '=', input.bindingId)
            .where('binding_version', '=', input.bindingVersion)
            .where('secret_name', '=', input.secretName)
            .where('tool_id', '=', input.toolId)
            .where('state', '=', 'active')
            .orderBy('created_at', 'desc')
            .forUpdate()
            .execute();
          let authorized = false;
          for (const row of rows) {
            if (
              (row.expires_at !== null && row.expires_at <= input.now) ||
              (row.scope === 'session' && row.session_id !== input.sessionId) ||
              (row.scope === 'once' && row.remaining_uses !== 1)
            ) {
              continue;
            }
            if (row.scope !== 'once') {
              authorized = true;
              break;
            }
            const consumed = await tx
              .updateTable('secret_provider_permissions')
              .set({ remaining_uses: 0, state: 'revoked', updated_at: input.now.toISOString() })
              .where('id', '=', row.id)
              .where('state', '=', 'active')
              .where('remaining_uses', '=', 1)
              .returning('id')
              .executeTakeFirst();
            if (consumed !== undefined) {
              authorized = true;
              break;
            }
          }
          if (!authorized) throw new PermissionUnavailable();
        }
        return true;
      });
    } catch (error) {
      if (error instanceof PermissionUnavailable) return false;
      throw error;
    }
  };

  return {
    resolveBinding,
    resolveAlias,

    async provisionBinding(input) {
      try {
        const record = providerBindingRecordSchema.parse(input);
        if (record.credentialRef !== expectedCredentialRef()) {
          throw new SecretProviderCatalogError('credential reference does not match binding');
        }
        const existingRow = await db
          .selectFrom('secret_provider_bindings')
          .selectAll()
          .where('project_id', '=', record.projectId)
          .where('id', '=', record.id)
          .where('version', '=', record.version)
          .where('provider', '=', record.provider)
          .executeTakeFirst();
        const existing =
          existingRow === undefined
            ? undefined
            : providerBindingRecordSchema.parse({
                id: existingRow.id,
                projectId: existingRow.project_id,
                version: existingRow.version,
                provider: existingRow.provider,
                credentialRef: existingRow.credential_ref,
                dopplerProject: existingRow.doppler_project,
                dopplerConfig: existingRow.doppler_config,
                state: existingRow.state,
              });
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new SecretProviderCatalogError('provider binding version is immutable');
        }
        await db.transaction().execute(async (tx) => {
          await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', record.projectId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (existing === undefined) {
            await tx
              .insertInto('secret_provider_bindings')
              .values({
                id: record.id,
                project_id: record.projectId,
                version: record.version,
                provider: record.provider,
                credential_ref: record.credentialRef,
                doppler_project: record.dopplerProject,
                doppler_config: record.dopplerConfig,
                state: record.state,
              })
              .onConflict((conflict) =>
                conflict.columns(['project_id', 'id', 'version']).doNothing(),
              )
              .execute();
            const stored = await tx
              .selectFrom('secret_provider_bindings')
              .selectAll()
              .where('project_id', '=', record.projectId)
              .where('id', '=', record.id)
              .where('version', '=', record.version)
              .executeTakeFirstOrThrow();
            const storedRecord = providerBindingRecordSchema.parse({
              id: stored.id,
              projectId: stored.project_id,
              version: stored.version,
              provider: stored.provider,
              credentialRef: stored.credential_ref,
              dopplerProject: stored.doppler_project,
              dopplerConfig: stored.doppler_config,
              state: stored.state,
            });
            if (JSON.stringify(storedRecord) !== JSON.stringify(record)) {
              throw new SecretProviderCatalogError('provider binding version is immutable');
            }
          }
        });
      } catch (error) {
        if (error instanceof SealedError) throw error;
        if (error instanceof SecretProviderCatalogError) throw error;
        throw new SecretProviderCatalogError('provider binding could not be provisioned');
      }
    },

    async createAlias(input) {
      const record = secretAliasRecordSchema.parse(input);
      const binding = await resolveBinding(record.binding, record.projectId);
      if (
        binding === undefined ||
        binding.projectId !== record.projectId ||
        binding.state !== 'active'
      ) {
        throw new SecretProviderCatalogError('alias binding is unavailable');
      }
      try {
        await db.transaction().execute(async (tx) => {
          await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', record.projectId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const currentBinding = await tx
            .selectFrom('secret_provider_bindings')
            .select('state')
            .where('project_id', '=', record.projectId)
            .where('id', '=', record.binding.id)
            .where('version', '=', record.binding.version)
            .where('provider', '=', record.binding.provider)
            .executeTakeFirst();
          const laterBindingRevocation = await tx
            .selectFrom('secret_provider_bindings')
            .select('version')
            .where('project_id', '=', record.projectId)
            .where('id', '=', record.binding.id)
            .where('version', '>', record.binding.version)
            .where('provider', '=', record.binding.provider)
            .where('state', '!=', 'active')
            .executeTakeFirst();
          if (currentBinding?.state !== 'active' || laterBindingRevocation !== undefined) {
            throw new SecretProviderCatalogError('alias binding is unavailable');
          }
          await tx
            .insertInto('secret_aliases')
            .values({
              id: record.id,
              project_id: record.projectId,
              version: record.version,
              name: record.name,
              description: record.description,
              binding_json: JSON.stringify(record.binding),
              provider_key: record.providerKey,
              injection_json: JSON.stringify(record.injection),
              profile_json: JSON.stringify(record.profile),
              state: record.state,
            })
            .onConflict((conflict) => conflict.columns(['project_id', 'id', 'version']).doNothing())
            .execute();
          const stored = await tx
            .selectFrom('secret_aliases')
            .selectAll()
            .where('project_id', '=', record.projectId)
            .where('id', '=', record.id)
            .where('version', '=', record.version)
            .executeTakeFirstOrThrow();
          const storedRecord = secretAliasRecordSchema.parse({
            id: stored.id,
            projectId: stored.project_id,
            version: stored.version,
            name: stored.name,
            description: stored.description,
            binding: JSON.parse(stored.binding_json) as unknown,
            providerKey: stored.provider_key,
            injection: JSON.parse(stored.injection_json) as unknown,
            profile: JSON.parse(stored.profile_json) as unknown,
            state: stored.state,
          });
          if (JSON.stringify(storedRecord) !== JSON.stringify(record)) {
            throw new SecretProviderCatalogError('secret alias could not be created');
          }
        });
      } catch {
        throw new SecretProviderCatalogError('secret alias could not be created');
      }
    },

    async listBindings(projectId) {
      const rows = await db
        .selectFrom('secret_provider_bindings')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('id')
        .orderBy('version')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        provider: 'doppler' as const,
        dopplerProject: row.doppler_project,
        dopplerConfig: row.doppler_config,
        state: providerBindingRecordSchema.shape.state.parse(row.state),
      }));
    },

    async listAliases(projectId) {
      const rows = await db
        .selectFrom('secret_aliases')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('id')
        .orderBy('version')
        .execute();
      return rows.map((row) => {
        const record = secretAliasRecordSchema.parse({
          id: row.id,
          projectId: row.project_id,
          version: row.version,
          name: row.name,
          description: row.description,
          binding: JSON.parse(row.binding_json) as unknown,
          providerKey: row.provider_key,
          injection: JSON.parse(row.injection_json) as unknown,
          profile: JSON.parse(row.profile_json) as unknown,
          state: row.state,
        });
        return {
          id: record.id,
          projectId: record.projectId,
          version: record.version,
          name: record.name,
          description: record.description,
          binding: record.binding,
          injection: record.injection,
          profile: record.profile,
          state: record.state,
        };
      });
    },

    async resolveAliasesForProfile(profile, projectId) {
      const rows = await db
        .selectFrom('secret_aliases')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('state', '=', 'active')
        .orderBy('id')
        .orderBy('version')
        .execute();
      const matching: SecretAliasRecord[] = [];
      for (const row of rows) {
        const stored = secretAliasRecordSchema.safeParse({
          id: row.id,
          projectId: row.project_id,
          version: row.version,
          name: row.name,
          description: row.description,
          binding: JSON.parse(row.binding_json) as unknown,
          providerKey: row.provider_key,
          injection: JSON.parse(row.injection_json) as unknown,
          profile: JSON.parse(row.profile_json) as unknown,
          state: row.state,
        });
        if (
          !stored.success ||
          stored.data.profile.id !== profile.id ||
          stored.data.profile.version !== profile.version ||
          stored.data.profile.policyHash !== profile.policyHash
        ) {
          continue;
        }
        const active = await resolveAlias(stored.data, projectId);
        if (active !== undefined) matching.push(active);
      }
      return matching;
    },

    async grantPermission(input) {
      if (
        !SECRET_NAME.test(input.secretName) ||
        input.toolId.length < 1 ||
        input.toolId.length > 256
      ) {
        throw new SecretProviderCatalogError('invalid secret permission');
      }
      if (
        (input.scope === 'session') !== (input.sessionId !== undefined) ||
        (input.scope === 'timed') !== (input.expiresAt !== undefined)
      ) {
        throw new SecretProviderCatalogError('invalid secret permission scope');
      }
      const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
      if (
        expiresAt !== null &&
        (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
      ) {
        throw new SecretProviderCatalogError('invalid secret permission expiry');
      }
      const binding = await resolveBinding(
        { id: input.bindingId, version: input.bindingVersion, provider: 'doppler' },
        input.projectId,
      );
      if (binding === undefined || binding.state !== 'active') {
        throw new SecretProviderCatalogError('permission binding is unavailable');
      }
      const id = randomUUID();
      return db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', input.projectId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const currentBinding = await tx
          .selectFrom('secret_provider_bindings')
          .select('state')
          .where('project_id', '=', input.projectId)
          .where('id', '=', input.bindingId)
          .where('version', '=', input.bindingVersion)
          .where('provider', '=', 'doppler')
          .executeTakeFirst();
        const laterRevocation = await tx
          .selectFrom('secret_provider_bindings')
          .select('version')
          .where('project_id', '=', input.projectId)
          .where('id', '=', input.bindingId)
          .where('version', '>', input.bindingVersion)
          .where('provider', '=', 'doppler')
          .where('state', '!=', 'active')
          .executeTakeFirst();
        if (currentBinding?.state !== 'active' || laterRevocation !== undefined) {
          throw new SecretProviderCatalogError('permission binding is unavailable');
        }
        const row = await tx
          .insertInto('secret_provider_permissions')
          .values({
            id,
            project_id: input.projectId,
            binding_id: input.bindingId,
            binding_version: input.bindingVersion,
            secret_name: input.secretName,
            tool_id: input.toolId,
            scope: input.scope,
            session_id: input.sessionId ?? null,
            expires_at: expiresAt?.toISOString() ?? null,
            remaining_uses: input.scope === 'once' ? 1 : null,
            granted_by: input.grantedBy,
            state: 'active',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return permissionFromRow(row);
      });
    },

    async grantDynamicPermission(aliasInput, input) {
      const alias = secretAliasRecordSchema.parse(aliasInput);
      if (
        alias.projectId !== input.projectId ||
        alias.binding.id !== input.bindingId ||
        alias.binding.version !== input.bindingVersion ||
        alias.providerKey !== input.secretName ||
        `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}` !==
          input.toolId
      ) {
        throw new SecretProviderCatalogError('dynamic alias does not match permission');
      }
      const existing = await resolveStoredAlias(alias, alias.projectId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(alias)) {
        throw new SecretProviderCatalogError('secret alias could not be created');
      }
      if (existing !== undefined && (await resolveAlias(alias, alias.projectId)) === undefined) {
        throw new SecretProviderCatalogError('secret alias is revoked');
      }
      const laterRevocation = await db
        .selectFrom('secret_aliases')
        .select('version')
        .where('project_id', '=', alias.projectId)
        .where('id', '=', alias.id)
        .where('version', '>', alias.version)
        .where('state', '!=', 'active')
        .executeTakeFirst();
      if (laterRevocation !== undefined) {
        throw new SecretProviderCatalogError('secret alias is revoked');
      }
      const binding = await resolveBinding(alias.binding, alias.projectId);
      if (binding === undefined || binding.state !== 'active') {
        throw new SecretProviderCatalogError('permission binding is unavailable');
      }
      const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
      if (
        !SECRET_NAME.test(input.secretName) ||
        input.toolId.length < 1 ||
        input.toolId.length > 256 ||
        (input.scope === 'session') !== (input.sessionId !== undefined) ||
        (input.scope === 'timed') !== (input.expiresAt !== undefined) ||
        (expiresAt !== null && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()))
      ) {
        throw new SecretProviderCatalogError('invalid secret permission');
      }
      return db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', alias.projectId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const transactionalRevocation = await tx
          .selectFrom('secret_aliases')
          .select('version')
          .where('project_id', '=', alias.projectId)
          .where('id', '=', alias.id)
          .where('version', '>', alias.version)
          .where('state', '!=', 'active')
          .executeTakeFirst();
        if (transactionalRevocation !== undefined) {
          throw new SecretProviderCatalogError('secret alias is revoked');
        }
        const currentBinding = await tx
          .selectFrom('secret_provider_bindings')
          .select('state')
          .where('project_id', '=', alias.projectId)
          .where('id', '=', alias.binding.id)
          .where('version', '=', alias.binding.version)
          .where('provider', '=', alias.binding.provider)
          .executeTakeFirst();
        const laterBindingRevocation = await tx
          .selectFrom('secret_provider_bindings')
          .select('version')
          .where('project_id', '=', alias.projectId)
          .where('id', '=', alias.binding.id)
          .where('version', '>', alias.binding.version)
          .where('provider', '=', alias.binding.provider)
          .where('state', '!=', 'active')
          .executeTakeFirst();
        if (currentBinding?.state !== 'active' || laterBindingRevocation !== undefined) {
          throw new SecretProviderCatalogError('permission binding is unavailable');
        }
        if (existing === undefined) {
          await tx
            .insertInto('secret_aliases')
            .values({
              id: alias.id,
              project_id: alias.projectId,
              version: alias.version,
              name: alias.name,
              description: alias.description,
              binding_json: JSON.stringify(alias.binding),
              provider_key: alias.providerKey,
              injection_json: JSON.stringify(alias.injection),
              profile_json: JSON.stringify(alias.profile),
              state: alias.state,
            })
            .onConflict((conflict) => conflict.columns(['project_id', 'id', 'version']).doNothing())
            .execute();
          const stored = await tx
            .selectFrom('secret_aliases')
            .selectAll()
            .where('project_id', '=', alias.projectId)
            .where('id', '=', alias.id)
            .where('version', '=', alias.version)
            .executeTakeFirstOrThrow();
          const storedAlias = secretAliasRecordSchema.parse({
            id: stored.id,
            projectId: stored.project_id,
            version: stored.version,
            name: stored.name,
            description: stored.description,
            binding: JSON.parse(stored.binding_json) as unknown,
            providerKey: stored.provider_key,
            injection: JSON.parse(stored.injection_json) as unknown,
            profile: JSON.parse(stored.profile_json) as unknown,
            state: stored.state,
          });
          if (JSON.stringify(storedAlias) !== JSON.stringify(alias)) {
            throw new SecretProviderCatalogError('secret alias could not be created');
          }
        }
        const row = await tx
          .insertInto('secret_provider_permissions')
          .values({
            id: randomUUID(),
            project_id: input.projectId,
            binding_id: input.bindingId,
            binding_version: input.bindingVersion,
            secret_name: input.secretName,
            tool_id: input.toolId,
            scope: input.scope,
            session_id: input.sessionId ?? null,
            expires_at: expiresAt?.toISOString() ?? null,
            remaining_uses: input.scope === 'once' ? 1 : null,
            granted_by: input.grantedBy,
            state: 'active',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return permissionFromRow(row);
      });
    },

    async listPermissions(projectId) {
      const rows = await db
        .selectFrom('secret_provider_permissions')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(permissionFromRow);
    },

    async revokePermission(id, projectId) {
      const result = await db
        .updateTable('secret_provider_permissions')
        .set({ state: 'revoked', updated_at: new Date().toISOString() })
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .where('state', '=', 'active')
        .returning('id')
        .executeTakeFirst();
      return result !== undefined;
    },

    async consumePermission(input) {
      return consumePermissions([input]);
    },

    consumePermissions,

    async authorizeClaimsPermissions(claims, now = new Date()) {
      const aliases = await Promise.all(
        claims.aliases.map((ref) => resolveAlias(ref, claims.projectId)),
      );
      if (aliases.some((alias) => alias === undefined)) return false;
      if (
        aliases.some(
          (alias) =>
            alias!.profile.id !== claims.profile.id ||
            alias!.profile.version !== claims.profile.version ||
            alias!.profile.policyHash !== claims.profile.policyHash,
        )
      )
        return false;
      const claimedBindings = new Set(
        claims.providerBindings.map(
          (binding) => `${binding.provider}\0${binding.id}\0${String(binding.version)}`,
        ),
      );
      const aliasBindings = new Set(
        aliases.map(
          (alias) =>
            `${alias!.binding.provider}\0${alias!.binding.id}\0${String(alias!.binding.version)}`,
        ),
      );
      if (
        claimedBindings.size !== aliasBindings.size ||
        [...claimedBindings].some((binding) => !aliasBindings.has(binding))
      )
        return false;
      const bindings = await Promise.all(
        aliases.map((alias) => resolveBinding(alias!.binding, claims.projectId)),
      );
      if (bindings.some((binding) => binding === undefined)) return false;
      const toolId = `${claims.profile.id}@${String(claims.profile.version)}:${claims.profile.policyHash}`;
      const unique = new Map<
        string,
        {
          projectId: string;
          bindingId: string;
          bindingVersion: number;
          secretName: string;
          toolId: string;
          sessionId: string;
          now: Date;
        }
      >();
      for (const alias of aliases) {
        const permission = {
          projectId: claims.projectId,
          bindingId: alias!.binding.id,
          bindingVersion: alias!.binding.version,
          secretName: alias!.providerKey,
          aliasId: alias!.id,
          aliasVersion: alias!.version,
          toolId,
          sessionId: claims.sessionId,
          now,
        };
        unique.set(
          `${permission.bindingId}\0${String(permission.bindingVersion)}\0${permission.secretName}`,
          permission,
        );
      }
      return consumePermissions([...unique.values()]);
    },

    async checkClaimsPermissions(claims, now = new Date()) {
      const aliases = await Promise.all(
        claims.aliases.map((ref) => resolveAlias(ref, claims.projectId)),
      );
      if (aliases.some((alias) => alias === undefined)) return false;
      if (
        aliases.some(
          (alias) =>
            alias!.profile.id !== claims.profile.id ||
            alias!.profile.version !== claims.profile.version ||
            alias!.profile.policyHash !== claims.profile.policyHash,
        )
      )
        return false;
      const claimedBindings = new Set(
        claims.providerBindings.map(
          (binding) => `${binding.provider}\0${binding.id}\0${String(binding.version)}`,
        ),
      );
      const aliasBindings = new Set(
        aliases.map(
          (alias) =>
            `${alias!.binding.provider}\0${alias!.binding.id}\0${String(alias!.binding.version)}`,
        ),
      );
      if (
        claimedBindings.size !== aliasBindings.size ||
        [...claimedBindings].some((binding) => !aliasBindings.has(binding))
      )
        return false;
      const bindings = await Promise.all(
        aliases.map((alias) => resolveBinding(alias!.binding, claims.projectId)),
      );
      if (bindings.some((binding) => binding === undefined)) return false;
      const toolId = `${claims.profile.id}@${String(claims.profile.version)}:${claims.profile.policyHash}`;
      for (const alias of aliases) {
        const rows = await db
          .selectFrom('secret_provider_permissions')
          .selectAll()
          .where('project_id', '=', claims.projectId)
          .where('binding_id', '=', alias!.binding.id)
          .where('binding_version', '=', alias!.binding.version)
          .where('secret_name', '=', alias!.providerKey)
          .where('tool_id', '=', toolId)
          .where('state', '=', 'active')
          .execute();
        if (
          !rows.some(
            (row) =>
              (row.expires_at === null || row.expires_at > now) &&
              (row.scope !== 'session' || row.session_id === claims.sessionId) &&
              (row.scope !== 'once' || row.remaining_uses === 1),
          )
        ) {
          return false;
        }
      }
      return true;
    },
  };
}
