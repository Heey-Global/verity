import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import { dopplerBindingGrantId } from './doppler-binding-identity.js';
import { LEGACY_DOPPLER_CONNECTION_ID } from './doppler-connections-migration.js';
import type { Database } from './schema.js';

export interface DopplerConnectionRecord {
  id: string;
  label: string;
  /** Whether the instance holds a token for it; the token itself is never listed. */
  hasToken: boolean;
  workplaceSlug: string | null;
  workplaceName: string | null;
  createdAt: Date;
}

export interface DopplerConnectionUsage {
  projectId: string;
  projectName: string;
  bindings: { id: string; dopplerProject: string; dopplerConfig: string; isDefault: boolean }[];
}

export interface DopplerWorkplace {
  slug: string | null;
  name: string | null;
}

/**
 * The instance's Doppler connections (ADR 0031). Metadata stays readable while the
 * store is sealed; tokens are decrypted only by {@link tokenBytes}.
 */
export class DopplerConnectionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<DopplerConnectionRecord[]> {
    const rows = await this.db
      .selectFrom('doppler_connections')
      .select(['id', 'label', 'token', 'workplace_slug', 'workplace_name', 'created_at'])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      hasToken: row.token !== null,
      workplaceSlug: row.workplace_slug,
      workplaceName: row.workplace_name,
      createdAt: row.created_at,
    }));
  }

  async get(id: string): Promise<DopplerConnectionRecord | undefined> {
    return (await this.list()).find((connection) => connection.id === id);
  }

  /** The instance token as owned, erasable bytes. */
  async tokenBytes(id: string): Promise<Buffer | undefined> {
    const row = await this.db
      .selectFrom('doppler_connections')
      .select('token')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.token == null ? undefined : this.cipher.decryptBytes(row.token);
  }

  async add(input: { label: string; token: string; workplace: DopplerWorkplace }): Promise<string> {
    const id = randomUUID();
    await this.db
      .insertInto('doppler_connections')
      .values({
        id,
        label: input.label,
        token: this.cipher.encrypt(input.token),
        workplace_slug: input.workplace.slug,
        workplace_name: input.workplace.name,
      })
      .execute();
    return id;
  }

  /** Renames a connection or replaces its token; false when it does not exist. */
  async update(
    id: string,
    patch: { label?: string; token?: string; workplace?: DopplerWorkplace },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('doppler_connections')
      .set({
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.token === undefined
          ? {}
          : { token: this.cipher.encrypt(patch.token), token_revision: randomUUID() }),
        ...(patch.workplace === undefined
          ? {}
          : { workplace_slug: patch.workplace.slug, workplace_name: patch.workplace.name }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** The former single instance token setting writes through to this connection. */
  async setLegacyToken(token: string | null): Promise<void> {
    if (token === null) {
      await this.db
        .updateTable('doppler_connections')
        .set({ token: null, token_revision: randomUUID(), updated_at: sql`now()` })
        .where('id', '=', LEGACY_DOPPLER_CONNECTION_ID)
        .execute();
      return;
    }
    const encrypted = this.cipher.encrypt(token);
    const revision = randomUUID();
    await this.db
      .insertInto('doppler_connections')
      .values({
        id: LEGACY_DOPPLER_CONNECTION_ID,
        label: 'Doppler',
        token: encrypted,
        token_revision: revision,
      })
      .onConflict((oc) =>
        oc
          .column('id')
          .doUpdateSet({ token: encrypted, token_revision: revision, updated_at: sql`now()` }),
      )
      .execute();
  }

  /** The projects whose bindings use the connection, for the delete warning. */
  async usage(id: string): Promise<DopplerConnectionUsage[]> {
    const rows = await this.db
      .selectFrom('project_doppler_bindings as b')
      .innerJoin('projects as p', 'p.id', 'b.project_id')
      .select([
        'b.id',
        'b.project_id',
        'p.name',
        'b.doppler_project',
        'b.doppler_config',
        'b.is_default',
      ])
      .where('b.connection_id', '=', id)
      .orderBy('p.name')
      .orderBy('b.doppler_project')
      .orderBy('b.doppler_config')
      .execute();
    const projects = new Map<string, DopplerConnectionUsage>();
    for (const row of rows) {
      const project: DopplerConnectionUsage = projects.get(row.project_id) ?? {
        projectId: row.project_id,
        projectName: row.name ?? row.project_id,
        bindings: [],
      };
      project.bindings.push({
        id: row.id,
        dopplerProject: row.doppler_project,
        dopplerConfig: row.doppler_config,
        isDefault: row.is_default,
      });
      projects.set(row.project_id, project);
    }
    return [...projects.values()];
  }

  /**
   * Deletes the connection with everything that hangs on it, in one transaction:
   * its bindings in every project, the personal tokens for it and the grants of
   * those bindings. A project whose default binding goes promotes its oldest
   * remaining binding. False when the connection does not exist.
   */
  async remove(id: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const exists = await tx
        .selectFrom('doppler_connections')
        .select('token_revision')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (exists === undefined) return false;
      const bindings = await tx
        .selectFrom('project_doppler_bindings')
        .select(['project_id', 'doppler_project', 'doppler_config', 'is_default'])
        .where('connection_id', '=', id)
        .execute();
      for (const binding of bindings) {
        await tx
          .deleteFrom('secret_provider_permissions')
          .where('project_id', '=', binding.project_id)
          .where(
            'binding_id',
            '=',
            dopplerBindingGrantId({
              connectionId: id,
              tokenRevision: exists.token_revision,
              dopplerProject: binding.doppler_project,
              dopplerConfig: binding.doppler_config,
            }),
          )
          .execute();
      }
      await tx.deleteFrom('user_doppler_connections').where('connection_id', '=', id).execute();
      await tx.deleteFrom('project_doppler_bindings').where('connection_id', '=', id).execute();
      await tx.deleteFrom('doppler_connections').where('id', '=', id).execute();
      // The former single token setting is this connection's; it goes with it.
      if (id === LEGACY_DOPPLER_CONNECTION_ID)
        await tx
          .updateTable('verity_settings')
          .set({ doppler_service_token: null })
          .where('id', '=', 'global')
          .execute();
      const projects = new Set(bindings.filter((b) => b.is_default).map((b) => b.project_id));
      for (const projectId of projects) await promoteDefaultBinding(tx, projectId);
      return true;
    });
  }
}

/** Makes the oldest binding the default when none is, and mirrors the default into
 *  `project_settings` for readers of the former single binding. */
export async function promoteDefaultBinding(
  tx: Kysely<Database>,
  projectId: string,
): Promise<void> {
  let current = await tx
    .selectFrom('project_doppler_bindings')
    .select(['id', 'doppler_project', 'doppler_config'])
    .where('project_id', '=', projectId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (current === undefined) {
    current = await tx
      .selectFrom('project_doppler_bindings')
      .select(['id', 'doppler_project', 'doppler_config'])
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (current !== undefined) {
      await tx
        .updateTable('project_doppler_bindings')
        .set({ is_default: true })
        .where('id', '=', current.id)
        .execute();
    }
  }
  await tx
    .insertInto('project_settings')
    .values({
      project_id: projectId,
      doppler_project: current?.doppler_project ?? null,
      doppler_config: current?.doppler_config ?? null,
    })
    .onConflict((oc) =>
      oc.column('project_id').doUpdateSet({
        doppler_project: current?.doppler_project ?? null,
        doppler_config: current?.doppler_config ?? null,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}
