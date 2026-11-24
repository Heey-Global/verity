import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { LEGACY_DOPPLER_CONNECTION_ID } from './doppler-connections-migration.js';
import { promoteDefaultBinding } from './doppler-connections.js';
import type { Database } from './schema.js';

export interface ProjectDopplerBindingRecord {
  id: string;
  projectId: string;
  connectionId: string;
  connectionLabel: string;
  dopplerProject: string;
  dopplerConfig: string;
  isDefault: boolean;
  createdAt: Date;
}

/** The same Doppler project and config is already bound to the project. */
export class DuplicateDopplerBindingError extends Error {
  constructor(dopplerProject: string, dopplerConfig: string) {
    super(`${dopplerProject}/${dopplerConfig} is already bound to this project`);
    this.name = 'DuplicateDopplerBindingError';
  }
}

/** The connection a binding names does not exist. */
export class UnknownDopplerConnectionError extends Error {
  constructor() {
    super('Doppler connection not found');
    this.name = 'UnknownDopplerConnectionError';
  }
}

/**
 * The Doppler projects and configs a Verity project reads secrets from (ADR 0031).
 * Exactly one active binding is the default whenever the project has any; it is
 * mirrored into `project_settings.doppler_project/config` for older readers.
 */
export class ProjectDopplerBindingStore {
  constructor(private readonly db: Kysely<Database>) {}

  async list(projectId: string): Promise<ProjectDopplerBindingRecord[]> {
    const rows = await this.db
      .selectFrom('project_doppler_bindings as b')
      .innerJoin('doppler_connections as c', 'c.id', 'b.connection_id')
      .select([
        'b.id',
        'b.project_id',
        'b.connection_id',
        'c.label',
        'b.doppler_project',
        'b.doppler_config',
        'b.is_default',
        'b.created_at',
      ])
      .where('b.project_id', '=', projectId)
      .orderBy('b.is_default', 'desc')
      .orderBy('b.created_at')
      .orderBy('b.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      connectionId: row.connection_id,
      connectionLabel: row.label,
      dopplerProject: row.doppler_project,
      dopplerConfig: row.doppler_config,
      isDefault: row.is_default,
      createdAt: row.created_at,
    }));
  }

  /** Adds a binding; the project's first binding becomes its default. */
  async add(
    projectId: string,
    input: { connectionId: string; dopplerProject: string; dopplerConfig: string },
  ): Promise<ProjectDopplerBindingRecord> {
    const id = randomUUID();
    await this.db.transaction().execute(async (tx) => {
      await lockProject(tx, projectId);
      await insertBinding(tx, projectId, id, input);
      await promoteDefaultBinding(tx, projectId);
    });
    const added = (await this.list(projectId)).find((binding) => binding.id === id);
    if (added === undefined) throw new Error('Doppler binding vanished after insert');
    return added;
  }

  /** False when the binding does not belong to the project. */
  async setDefault(projectId: string, bindingId: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockProject(tx, projectId);
      const target = await tx
        .selectFrom('project_doppler_bindings')
        .select('id')
        .where('project_id', '=', projectId)
        .where('id', '=', bindingId)
        .executeTakeFirst();
      if (target === undefined) return false;
      await tx
        .updateTable('project_doppler_bindings')
        .set({ is_default: false })
        .where('project_id', '=', projectId)
        .where('is_default', '=', true)
        .execute();
      await tx
        .updateTable('project_doppler_bindings')
        .set({ is_default: true })
        .where('id', '=', bindingId)
        .execute();
      await promoteDefaultBinding(tx, projectId);
      return true;
    });
  }

  /** Removing the default promotes the oldest remaining binding. */
  async remove(projectId: string, bindingId: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockProject(tx, projectId);
      const removed = await tx
        .deleteFrom('project_doppler_bindings')
        .where('project_id', '=', projectId)
        .where('id', '=', bindingId)
        .executeTakeFirst();
      if (removed.numDeletedRows === 0n) return false;
      await promoteDefaultBinding(tx, projectId);
      return true;
    });
  }
}

async function lockProject(tx: Kysely<Database>, projectId: string): Promise<void> {
  await tx.selectFrom('projects').select('id').where('id', '=', projectId).forUpdate().execute();
}

async function insertBinding(
  tx: Kysely<Database>,
  projectId: string,
  id: string,
  input: { connectionId: string; dopplerProject: string; dopplerConfig: string },
  isDefault = false,
): Promise<void> {
  const connection = await tx
    .selectFrom('doppler_connections')
    .select('id')
    .where('id', '=', input.connectionId)
    .executeTakeFirst();
  if (connection === undefined) throw new UnknownDopplerConnectionError();
  const duplicate = await tx
    .selectFrom('project_doppler_bindings')
    .select('id')
    .where('project_id', '=', projectId)
    .where('doppler_project', '=', input.dopplerProject)
    .where('doppler_config', '=', input.dopplerConfig)
    .executeTakeFirst();
  if (duplicate !== undefined)
    throw new DuplicateDopplerBindingError(input.dopplerProject, input.dopplerConfig);
  await tx
    .insertInto('project_doppler_bindings')
    .values({
      id,
      project_id: projectId,
      connection_id: input.connectionId,
      doppler_project: input.dopplerProject,
      doppler_config: input.dopplerConfig,
      is_default: isDefault,
    })
    .execute();
}

/**
 * The former `dopplerProject/dopplerConfig` settings write as "replace the default
 * binding" (ADR 0031): an existing binding of the pair becomes the default,
 * otherwise the pair replaces the default on its connection. Clearing either
 * removes the default. Runs inside the settings transaction.
 */
export async function syncDefaultDopplerBinding(
  tx: Kysely<Database>,
  projectId: string,
  dopplerProject: string | null,
  dopplerConfig: string | null,
): Promise<void> {
  const current = await tx
    .selectFrom('project_doppler_bindings')
    .select(['id', 'connection_id', 'doppler_project', 'doppler_config'])
    .where('project_id', '=', projectId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (dopplerProject === null || dopplerConfig === null) {
    if (current !== undefined)
      await tx.deleteFrom('project_doppler_bindings').where('id', '=', current.id).execute();
    await promoteDefaultBinding(tx, projectId);
    return;
  }
  if (current?.doppler_project === dopplerProject && current.doppler_config === dopplerConfig)
    return;
  const existing = await tx
    .selectFrom('project_doppler_bindings')
    .select('id')
    .where('project_id', '=', projectId)
    .where('doppler_project', '=', dopplerProject)
    .where('doppler_config', '=', dopplerConfig)
    .executeTakeFirst();
  if (existing !== undefined) {
    // Already bound: only the default moves, the former default stays bound.
    await tx
      .updateTable('project_doppler_bindings')
      .set({ is_default: false })
      .where('project_id', '=', projectId)
      .execute();
    await tx
      .updateTable('project_doppler_bindings')
      .set({ is_default: true })
      .where('id', '=', existing.id)
      .execute();
  } else {
    if (current !== undefined)
      await tx.deleteFrom('project_doppler_bindings').where('id', '=', current.id).execute();
    const connectionId = current?.connection_id ?? (await fallbackConnection(tx));
    await insertBinding(
      tx,
      projectId,
      randomUUID(),
      { connectionId, dopplerProject, dopplerConfig },
      true,
    );
  }
  await promoteDefaultBinding(tx, projectId);
}

/** Without a default to inherit from: the only or oldest connection, else the
 *  legacy connection personal tokens can use without an instance token. */
async function fallbackConnection(tx: Kysely<Database>): Promise<string> {
  const oldest = await tx
    .selectFrom('doppler_connections')
    .select('id')
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (oldest !== undefined) return oldest.id;
  await tx
    .insertInto('doppler_connections')
    .values({ id: LEGACY_DOPPLER_CONNECTION_ID, label: 'Doppler', token: null })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return LEGACY_DOPPLER_CONNECTION_ID;
}
