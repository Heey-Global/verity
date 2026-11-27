import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { isManagedDevServerHostPort, nextFreeDevServerHostPort } from './dev-server-ports.js';
import { normalizeSetting } from './normalize-setting.js';
import type { Database } from './schema.js';

/** One dev server (preview process) of a project. */
export interface DevServerRecord {
  id: string;
  projectId: string;
  sourceKey: string | null;
  name: string;
  command: string | null;
  url: string | null;
  workdir: string | null;
  hostPort: string | null;
  containerPort: string | null;
  /** Session whose worktree this server previews instead of the main checkout;
   *  null = serve main. Cleared automatically when the session is deleted. */
  previewSessionId: string | null;
  autoStart: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DevServerCreateInput {
  projectId: string;
  sourceKey?: string | null;
  name?: string;
  command?: string | null;
  url?: string | null;
  workdir?: string | null;
  hostPort?: string | null;
  containerPort?: string | null;
  autoStart?: boolean;
  sortOrder?: number;
}

export type DevServerPatch = {
  name?: string;
  command?: string | null;
  url?: string | null;
  workdir?: string | null;
  hostPort?: string | null;
  containerPort?: string | null;
  previewSessionId?: string | null;
  autoStart?: boolean;
  sortOrder?: number;
};

export interface DevServerDetectionStateRecord {
  projectId: string;
  fingerprint: string;
  detectedAt: Date;
  reviewedFingerprint: string | null;
  reviewedAt: Date | null;
}

export class DevServerConfigStore {
  // Serialize port mutations within this store for PGlite. PostgreSQL also
  // takes a table lock to serialize allocations across store instances.
  private devServerPortMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  private devServerRowToRecord(row: {
    id: string;
    project_id: string;
    source_key: string | null;
    name: string;
    command: string | null;
    url: string | null;
    workdir: string | null;
    host_port: string | null;
    container_port: string | null;
    preview_session_id: string | null;
    auto_start: boolean;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
  }): DevServerRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      sourceKey: row.source_key,
      name: row.name,
      command: row.command,
      url: row.url,
      workdir: row.workdir,
      hostPort: row.host_port,
      containerPort: row.container_port,
      previewSessionId: row.preview_session_id,
      autoStart: row.auto_start,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly devServerColumns = [
    'id',
    'project_id',
    'source_key',
    'name',
    'command',
    'url',
    'workdir',
    'host_port',
    'container_port',
    'preview_session_id',
    'auto_start',
    'sort_order',
    'created_at',
    'updated_at',
  ] as const;

  /** Dev servers for one project, in their configured display order. */
  async listDevServers(projectId: string): Promise<DevServerRecord[]> {
    const rows = await this.db
      .selectFrom('dev_servers')
      .select(this.devServerColumns)
      .where('project_id', '=', projectId)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => this.devServerRowToRecord(r));
  }

  async getDevServer(id: string): Promise<DevServerRecord | undefined> {
    const row = await this.db
      .selectFrom('dev_servers')
      .select(this.devServerColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.devServerRowToRecord(row) : undefined;
  }

  private devServerPortMutation<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.devServerPortMutationTail.then(operation);
    this.devServerPortMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  private async allocateDevServerHostPort(tx: Transaction<Database>): Promise<string> {
    const rows = await tx
      .selectFrom('dev_servers')
      .select('host_port')
      .where('host_port', 'is not', null)
      .execute();
    return nextFreeDevServerHostPort(
      new Set(rows.flatMap((row) => (row.host_port === null ? [] : [row.host_port]))),
    );
  }

  async createDevServer(input: DevServerCreateInput): Promise<DevServerRecord> {
    return this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        await tx
          .insertInto('project_settings')
          .values({ project_id: input.projectId })
          .onConflict((oc) => oc.column('project_id').doNothing())
          .execute();
        await tx
          .selectFrom('project_settings')
          .select('project_id')
          .where('project_id', '=', input.projectId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const row = await tx
          .insertInto('dev_servers')
          .values({
            id: randomUUID(),
            project_id: input.projectId,
            source_key: normalizeSetting(input.sourceKey),
            name: input.name ?? 'Dev server',
            command: normalizeSetting(input.command),
            url: normalizeSetting(input.url),
            workdir: normalizeSetting(input.workdir),
            host_port: await this.allocateDevServerHostPort(tx),
            container_port: normalizeSetting(input.containerPort),
            auto_start: input.autoStart ?? false,
            ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
          })
          .returning(this.devServerColumns)
          .executeTakeFirst();
        if (!row) {
          throw new Error('verity: createDevServer RETURNING yielded no row — dialect bug');
        }
        return this.devServerRowToRecord(row);
      }),
    );
  }

  async updateDevServer(id: string, patch: DevServerPatch): Promise<DevServerRecord | undefined> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.command !== undefined) set.command = normalizeSetting(patch.command);
    if (patch.url !== undefined) set.url = normalizeSetting(patch.url);
    if (patch.workdir !== undefined) set.workdir = normalizeSetting(patch.workdir);
    // host_port is a global registry lease and cannot be changed by CRUD PATCH.
    if (patch.containerPort !== undefined)
      set.container_port = normalizeSetting(patch.containerPort);
    if (patch.previewSessionId !== undefined) set.preview_session_id = patch.previewSessionId;
    if (patch.autoStart !== undefined) set.auto_start = patch.autoStart;
    if (patch.sortOrder !== undefined) set.sort_order = patch.sortOrder;
    const row = await this.db
      .updateTable('dev_servers')
      .set(set)
      .where('id', '=', id)
      .returning(this.devServerColumns)
      .executeTakeFirst();
    return row ? this.devServerRowToRecord(row) : undefined;
  }

  async recordDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord> {
    const row = await this.db
      .insertInto('dev_server_detection_state')
      .values({ project_id: projectId, fingerprint })
      .onConflict((conflict) =>
        conflict.column('project_id').doUpdateSet({
          fingerprint,
          detected_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      detectedAt: row.detected_at,
      reviewedFingerprint: row.reviewed_fingerprint,
      reviewedAt: row.reviewed_at,
    };
  }

  async getDevServerDetectionState(
    projectId: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    const row = await this.db
      .selectFrom('dev_server_detection_state')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row
      ? {
          projectId: row.project_id,
          fingerprint: row.fingerprint,
          detectedAt: row.detected_at,
          reviewedFingerprint: row.reviewed_fingerprint,
          reviewedAt: row.reviewed_at,
        }
      : undefined;
  }

  /** Mark exactly the current detector result as reviewed. A stale client cannot
   * acknowledge a newer scan that arrived after its dialog was opened. */
  async reviewDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionStateRecord | undefined> {
    const row = await this.db
      .updateTable('dev_server_detection_state')
      .set({ reviewed_fingerprint: fingerprint, reviewed_at: sql`now()` })
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .returningAll()
      .executeTakeFirst();
    return row
      ? {
          projectId: row.project_id,
          fingerprint: row.fingerprint,
          detectedAt: row.detected_at,
          reviewedFingerprint: row.reviewed_fingerprint,
          reviewedAt: row.reviewed_at,
        }
      : undefined;
  }

  /** Release a review claim when the corresponding setup mutation failed. */
  async unreviewDevServerDetection(projectId: string, fingerprint: string): Promise<void> {
    await this.db
      .updateTable('dev_server_detection_state')
      .set({ reviewed_fingerprint: null, reviewed_at: null })
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .where('reviewed_fingerprint', '=', fingerprint)
      .execute();
  }

  async deleteDevServer(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('dev_servers').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async reconcileDevServerHostPorts(projectId?: string): Promise<void> {
    await this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        const rows = await tx
          .selectFrom('dev_servers')
          .innerJoin('projects', 'projects.id', 'dev_servers.project_id')
          .select([
            'dev_servers.id',
            'dev_servers.project_id',
            'dev_servers.host_port',
            'projects.state',
            'projects.hidden_at',
          ])
          .orderBy('dev_servers.created_at', 'asc')
          .orderBy('dev_servers.id', 'asc')
          .execute();
        const used = new Set<string>();
        const needsLease: string[] = [];
        for (const row of rows) {
          const target = projectId === undefined || row.project_id === projectId;
          // Visible paused projects keep their reservation: `absent` is the only
          // safe state in which callers may add or change published ports. Only
          // a soft delete releases every lease for the project.
          const eligible = row.hidden_at === null;
          if (!eligible) {
            if (target && row.host_port !== null) {
              await tx
                .updateTable('dev_servers')
                .set({ host_port: null, updated_at: sql`now()` })
                .where('id', '=', row.id)
                .execute();
            }
            continue;
          }
          if (isManagedDevServerHostPort(row.host_port) && !used.has(row.host_port)) {
            used.add(row.host_port);
          } else if (target) {
            needsLease.push(row.id);
          }
        }
        for (const id of needsLease) {
          const port = nextFreeDevServerHostPort(used);
          used.add(port);
          await tx
            .updateTable('dev_servers')
            .set({ host_port: port, updated_at: sql`now()` })
            .where('id', '=', id)
            .execute();
        }
      }),
    );
  }

  async releaseProjectDevServerHostPorts(projectId: string): Promise<void> {
    await this.devServerPortMutation(() =>
      this.db.transaction().execute(async (tx) => {
        await sql`lock table dev_servers in share row exclusive mode`.execute(tx);
        await tx
          .updateTable('dev_servers')
          .set({ host_port: null, updated_at: sql`now()` })
          .where('project_id', '=', projectId)
          .execute();
      }),
    );
  }
}
