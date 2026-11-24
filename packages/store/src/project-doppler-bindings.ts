import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { LEGACY_DOPPLER_CONNECTION_ID } from './doppler-connections-migration.js';
import {
  AmbiguousDopplerConnectionError,
  DopplerConnectionTokenChangedError,
  deleteDopplerBindingGrants,
  lockDopplerTopology,
  promoteDefaultBinding,
} from './doppler-connections.js';
import type { Database } from './schema.js';

export interface ProjectDopplerBindingRecord {
  id: string;
  projectId: string;
  connectionId: string;
  connectionLabel: string;
  workplaceSlug?: string;
  tokenRevision?: string;
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

export class DopplerBindingDefaultChangedError extends Error {
  constructor() {
    super('The default Doppler binding changed. Review the binding before removing it.');
    this.name = 'DopplerBindingDefaultChangedError';
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
        'c.workplace_slug',
        'c.token_revision',
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
      ...(row.workplace_slug === null ? {} : { workplaceSlug: row.workplace_slug }),
      ...(row.token_revision === null ? {} : { tokenRevision: row.token_revision }),
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
    expectedTokenRevision?: string | null,
  ): Promise<ProjectDopplerBindingRecord> {
    const id = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
      await lockProject(tx, projectId);
      await insertBinding(tx, projectId, id, input, false, expectedTokenRevision);
      await promoteDefaultBinding(tx, projectId);
      const added = (await new ProjectDopplerBindingStore(tx).list(projectId)).find(
        (binding) => binding.id === id,
      );
      if (added === undefined) throw new Error('Doppler binding vanished after insert');
      return added;
    });
  }

  /** False when the binding does not belong to the project. */
  async setDefault(projectId: string, bindingId: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
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
  async remove(projectId: string, bindingId: string, expectedDefault?: boolean): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await lockDopplerTopology(tx);
      await lockProject(tx, projectId);
      if (expectedDefault !== undefined) {
        const current = await tx
          .selectFrom('project_doppler_bindings')
          .select('is_default')
          .where('project_id', '=', projectId)
          .where('id', '=', bindingId)
          .executeTakeFirst();
        if (current === undefined) return false;
        if (current.is_default !== expectedDefault) throw new DopplerBindingDefaultChangedError();
      }
      if (!(await removeBinding(tx, projectId, bindingId))) return false;
      await promoteDefaultBinding(tx, projectId);
      return true;
    });
  }
}

async function removeBinding(
  tx: Kysely<Database>,
  projectId: string,
  bindingId: string,
  retainedConnectionId?: string,
): Promise<boolean> {
  const removed = await tx
    .deleteFrom('project_doppler_bindings')
    .where('project_id', '=', projectId)
    .where('id', '=', bindingId)
    .returning(['connection_id', 'doppler_project', 'doppler_config'])
    .executeTakeFirst();
  if (removed === undefined) return false;
  await deleteDopplerBindingGrants(tx, projectId, {
    connectionId: removed.connection_id,
    dopplerProject: removed.doppler_project,
    dopplerConfig: removed.doppler_config,
  });
  if (removed.connection_id === retainedConnectionId) return true;
  const remaining = await tx
    .selectFrom('project_doppler_bindings')
    .select('id')
    .where('project_id', '=', projectId)
    .where('connection_id', '=', removed.connection_id)
    .executeTakeFirst();
  if (remaining === undefined) {
    await tx
      .deleteFrom('user_doppler_connections')
      .where('project_id', '=', projectId)
      .where('connection_id', '=', removed.connection_id)
      .execute();
  }
  return true;
}

async function lockProject(tx: Kysely<Database>, projectId: string): Promise<void> {
  await tx
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .forNoKeyUpdate()
    .execute();
}

async function insertBinding(
  tx: Kysely<Database>,
  projectId: string,
  id: string,
  input: { connectionId: string; dopplerProject: string; dopplerConfig: string },
  isDefault = false,
  expectedTokenRevision?: string | null,
): Promise<void> {
  const connection = await tx
    .selectFrom('doppler_connections')
    .select('token_revision')
    .where('id', '=', input.connectionId)
    .executeTakeFirst();
  if (connection === undefined) throw new UnknownDopplerConnectionError();
  if (expectedTokenRevision !== undefined && connection.token_revision !== expectedTokenRevision)
    throw new DopplerConnectionTokenChangedError();
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

/** Applies a legacy settings write only when it identifies a single binding and connection. */
export async function syncDefaultDopplerBinding(
  tx: Kysely<Database>,
  projectId: string,
  dopplerProject: string | null,
  dopplerConfig: string | null,
): Promise<void> {
  const [current, other] = await tx
    .selectFrom('project_doppler_bindings')
    .select(['id', 'connection_id', 'doppler_project', 'doppler_config'])
    .where('project_id', '=', projectId)
    .orderBy('is_default', 'desc')
    .limit(2)
    .execute();
  if (current?.doppler_project === dopplerProject && current.doppler_config === dopplerConfig)
    return;

  const [connection, anotherConnection] = await tx
    .selectFrom('doppler_connections')
    .select('id')
    .limit(2)
    .execute();
  if (other !== undefined || anotherConnection !== undefined)
    throw new AmbiguousDopplerConnectionError();

  const complete = dopplerProject !== null && dopplerConfig !== null;
  if (current !== undefined)
    await removeBinding(tx, projectId, current.id, complete ? connection?.id : undefined);
  if (complete) {
    if (connection === undefined)
      await tx
        .insertInto('doppler_connections')
        .values({ id: LEGACY_DOPPLER_CONNECTION_ID, label: 'Doppler', token: null })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    await insertBinding(
      tx,
      projectId,
      randomUUID(),
      {
        connectionId: connection?.id ?? LEGACY_DOPPLER_CONNECTION_ID,
        dopplerProject,
        dopplerConfig,
      },
      true,
    );
  }
  // Preserve a partial pair for older clients that write the two fields separately.
}
