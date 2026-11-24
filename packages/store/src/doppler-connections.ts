import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import { dopplerBindingGrantId, dopplerGrantUsesBinding } from './doppler-binding-identity.js';
import { LEGACY_DOPPLER_CONNECTION_ID } from './doppler-connections-migration.js';
import type { Database } from './schema.js';

export interface DopplerConnectionRecord {
  id: string;
  label: string;
  /** Whether the instance holds a token for it; the token itself is never listed. */
  hasToken: boolean;
  tokenRevision?: string;
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

export class AmbiguousDopplerConnectionError extends Error {
  constructor() {
    super('Open the Doppler connection picker in the current app to make this change.');
    this.name = 'AmbiguousDopplerConnectionError';
  }
}

export class DopplerConnectionUsageChangedError extends Error {
  constructor() {
    super('Doppler connection usage changed. Review the affected project bindings again.');
    this.name = 'DopplerConnectionUsageChangedError';
  }
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
      .select([
        'id',
        'label',
        'token',
        'token_revision',
        'workplace_slug',
        'workplace_name',
        'created_at',
      ])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      hasToken: row.token !== null,
      ...(row.token_revision === null ? {} : { tokenRevision: row.token_revision }),
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
    const token = patch.token === undefined ? undefined : this.cipher.encrypt(patch.token);
    return this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
      const existing = await tx
        .selectFrom('doppler_connections')
        .select('workplace_slug')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) return false;
      await tx
        .updateTable('doppler_connections')
        .set({
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(token === undefined ? {} : { token, token_revision: randomUUID() }),
          ...(patch.workplace === undefined && token === undefined
            ? {}
            : {
                workplace_slug: patch.workplace?.slug ?? null,
                workplace_name: patch.workplace?.name ?? null,
              }),
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();
      if (
        token !== undefined &&
        (existing.workplace_slug === null || existing.workplace_slug !== patch.workplace?.slug)
      ) {
        await tx.deleteFrom('user_doppler_connections').where('connection_id', '=', id).execute();
      }
      return true;
    });
  }

  /** The former single instance token setting writes through to this connection. */
  async setLegacyToken(token: string | null, tx?: Kysely<Database>): Promise<void> {
    const encrypted = token === null ? null : this.cipher.encrypt(token);
    const revision = randomUUID();
    const write = async (transaction: Kysely<Database>) => {
      await lockDopplerTopology(transaction);
      const [existing, other] = await transaction
        .selectFrom('doppler_connections')
        .select('id')
        .limit(2)
        .execute();
      if (
        other !== undefined ||
        (existing !== undefined && existing.id !== LEGACY_DOPPLER_CONNECTION_ID)
      )
        throw new AmbiguousDopplerConnectionError();
      if (encrypted === null && existing === undefined) return;
      const replacement = {
        token: encrypted,
        token_revision: revision,
        workplace_slug: null,
        workplace_name: null,
      };
      await transaction
        .insertInto('doppler_connections')
        .values({ id: LEGACY_DOPPLER_CONNECTION_ID, label: 'Doppler', ...replacement })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...replacement, updated_at: sql`now()` }))
        .execute();
      // Legacy token writes do not identify a workplace.
      await transaction
        .deleteFrom('user_doppler_connections')
        .where('connection_id', '=', LEGACY_DOPPLER_CONNECTION_ID)
        .execute();
    };
    if (tx !== undefined) await write(tx);
    else await this.db.transaction().execute(write);
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
  async remove(id: string, expectedBindingIds?: readonly string[]): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
      const exists = await tx
        .selectFrom('doppler_connections')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (exists === undefined) return false;
      const bindings = await tx
        .selectFrom('project_doppler_bindings')
        .select(['id', 'project_id', 'doppler_project', 'doppler_config'])
        .where('connection_id', '=', id)
        .execute();
      if (
        expectedBindingIds !== undefined &&
        (bindings.length !== expectedBindingIds.length ||
          bindings.some((binding) => !expectedBindingIds.includes(binding.id)))
      )
        throw new DopplerConnectionUsageChangedError();
      const projects = new Set(bindings.map((binding) => binding.project_id));
      for (const binding of bindings) {
        await deleteDopplerBindingGrants(tx, binding.project_id, {
          connectionId: id,
          dopplerProject: binding.doppler_project,
          dopplerConfig: binding.doppler_config,
        });
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
      for (const projectId of projects) await promoteDefaultBinding(tx, projectId);
      return true;
    });
  }
}

/**
 * Serialize connection and binding topology changes before any project lock.
 * This also closes the race between saving a personal token and removing its binding.
 */
export async function lockDopplerTopology(tx: Kysely<Database>): Promise<void> {
  await sql`lock table doppler_connections in share row exclusive mode`.execute(tx);
}

export async function deleteDopplerBindingGrants(
  tx: Kysely<Database>,
  projectId: string,
  binding: { connectionId: string; dopplerProject: string; dopplerConfig: string },
): Promise<void> {
  const bindingId = dopplerBindingGrantId(binding);
  const grants = await tx
    .selectFrom('secret_provider_permissions')
    .select(['id', 'binding_id'])
    .where('project_id', '=', projectId)
    .execute();
  const affected = grants
    .filter((grant) => dopplerGrantUsesBinding(grant.binding_id, bindingId))
    .map((grant) => grant.id);
  if (affected.length > 0) {
    await tx.deleteFrom('secret_provider_permissions').where('id', 'in', affected).execute();
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
