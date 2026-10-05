import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, ManagedDevServerInstancesTable, ManagedDevServersTable } from './schema.js';

/** A dev server the agent set up for a project (concept 2.6). */
export interface ManagedDevServerRecord {
  id: string;
  projectId: string;
  name: string;
  /** Upper-case letters, digits and underscores; names the sibling URL variable. */
  nameKey: string;
  /** Command template; may contain `{port}`. */
  command: string;
  /** Relative to the session worktree; `.` for its root. */
  workdir: string;
  /** True when the operator approved exactly this command and subdirectory. */
  approved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ManagedDevServerDesired = 'running' | 'stopped';
export type ManagedDevServerState = 'stopped' | 'starting' | 'running' | 'crashed';

/** One entry bound to one session's worktree. */
export interface ManagedDevServerInstanceRecord {
  id: string;
  serverId: string;
  projectId: string;
  sessionId: string;
  sandboxPort: number;
  networkPort: number | null;
  desired: ManagedDevServerDesired;
  state: ManagedDevServerState;
  detail: string | null;
  lastRunCommand: string | null;
  lastRunWorkdir: string | null;
  startedAt: Date | null;
  lastRanAt: Date | null;
  /** The operator's Local switch. */
  localAccess: boolean;
}

export class ManagedDevServerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedDevServerConflictError';
  }
}

export class ManagedDevServerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedDevServerInputError';
  }
}

/** Every network port is held by a running server or a live public link. */
export class ManagedDevServerPortsFullError extends Error {
  constructor() {
    super('All network ports are in use');
    this.name = 'ManagedDevServerPortsFullError';
  }
}

const MANAGED_DEV_SERVER_NAME_MAX = 60;
const MANAGED_DEV_SERVER_COMMAND_MAX = 2000;

/** `my-api` and `My API` both become `MY_API`; two names with the same key collide. */
export function managedDevServerNameKey(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MANAGED_DEV_SERVER_NAME_MAX)
    throw new ManagedDevServerInputError(
      `name must be 1-${String(MANAGED_DEV_SERVER_NAME_MAX)} characters`,
    );
  const key = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (!key) throw new ManagedDevServerInputError('name needs at least one letter or digit');
  return key;
}

/** Relative, inside the worktree, no `..`. Symlinks are checked again at every start. */
export function normalizeManagedDevServerWorkdir(value: string | undefined): string {
  const raw = (value ?? '.').trim() || '.';
  if (raw.startsWith('/') || raw.includes('\0'))
    throw new ManagedDevServerInputError('subdirectory must be relative to the worktree');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..'))
    throw new ManagedDevServerInputError('subdirectory must stay inside the worktree');
  return parts.length === 0 ? '.' : parts.join('/');
}

function validateCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MANAGED_DEV_SERVER_COMMAND_MAX || trimmed.includes('\0'))
    throw new ManagedDevServerInputError(
      `command must be 1-${String(MANAGED_DEV_SERVER_COMMAND_MAX)} characters`,
    );
  return trimmed;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === '23505' ||
      /unique|duplicate key/iu.test(String((error as { message?: unknown }).message)))
  );
}

/** A deadlock or serialization failure: the transaction can simply be retried. */
function isSerializationFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001';
}

function serverRecord(row: Selectable<ManagedDevServersTable>): ManagedDevServerRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    nameKey: row.name_key,
    command: row.command,
    workdir: row.workdir,
    approved: row.approved_command === row.command && row.approved_workdir === row.workdir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function instanceRecord(
  row: Selectable<ManagedDevServerInstancesTable>,
): ManagedDevServerInstanceRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sandboxPort: row.sandbox_port,
    networkPort: row.network_port,
    desired: row.desired as ManagedDevServerDesired,
    state: row.state as ManagedDevServerState,
    detail: row.detail,
    lastRunCommand: row.last_run_command,
    lastRunWorkdir: row.last_run_workdir,
    startedAt: row.started_at,
    lastRanAt: row.last_ran_at,
    localAccess: row.local_access,
  };
}

export interface ManagedDevServerInstancePatch {
  desired?: ManagedDevServerDesired;
  state?: ManagedDevServerState;
  detail?: string | null;
  lastRunCommand?: string | null;
  lastRunWorkdir?: string | null;
  startedAt?: Date | null;
  lastRanAt?: Date | null;
  localAccess?: boolean;
}

export class ManagedDevServerStore {
  constructor(private readonly db: Kysely<Database>) {}

  async list(projectId: string): Promise<ManagedDevServerRecord[]> {
    const rows = await this.db
      .selectFrom('managed_dev_servers')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(serverRecord);
  }

  async get(id: string): Promise<ManagedDevServerRecord | undefined> {
    const row = await this.db
      .selectFrom('managed_dev_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? serverRecord(row) : undefined;
  }

  async getByName(projectId: string, name: string): Promise<ManagedDevServerRecord | undefined> {
    const row = await this.db
      .selectFrom('managed_dev_servers')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('name_key', '=', managedDevServerNameKey(name))
      .executeTakeFirst();
    return row ? serverRecord(row) : undefined;
  }

  async create(input: {
    projectId: string;
    name: string;
    command: string;
    workdir?: string | undefined;
  }): Promise<ManagedDevServerRecord> {
    const nameKey = managedDevServerNameKey(input.name);
    try {
      const row = await this.db
        .insertInto('managed_dev_servers')
        .values({
          id: randomUUID(),
          project_id: input.projectId,
          name: input.name.trim(),
          name_key: nameKey,
          command: validateCommand(input.command),
          workdir: normalizeManagedDevServerWorkdir(input.workdir),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return serverRecord(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ManagedDevServerConflictError(
          `a server named like "${input.name.trim()}" already exists`,
        );
      throw error;
    }
  }

  /** A changed command or subdirectory no longer matches its approval. */
  async update(
    id: string,
    patch: {
      name?: string | undefined;
      command?: string | undefined;
      workdir?: string | undefined;
    },
  ): Promise<ManagedDevServerRecord | undefined> {
    const values: { name?: string; name_key?: string; command?: string; workdir?: string } = {};
    if (patch.name !== undefined) {
      values.name = patch.name.trim();
      values.name_key = managedDevServerNameKey(patch.name);
    }
    if (patch.command !== undefined) values.command = validateCommand(patch.command);
    if (patch.workdir !== undefined)
      values.workdir = normalizeManagedDevServerWorkdir(patch.workdir);
    try {
      const row = await this.db
        .updateTable('managed_dev_servers')
        .set({ ...values, updated_at: sql`now()` as unknown as string })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? serverRecord(row) : undefined;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ManagedDevServerConflictError(
          `a server named like "${patch.name?.trim() ?? ''}" already exists`,
        );
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('managed_dev_servers')
      .where('id', '=', id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Approves exactly the command and subdirectory the operator saw. If the agent
   *  changed either in the meantime, nothing is approved. */
  async approve(
    id: string,
    seen: { command: string; workdir: string },
  ): Promise<ManagedDevServerRecord | undefined> {
    const row = await this.db
      .updateTable('managed_dev_servers')
      .set({
        approved_command: seen.command,
        approved_workdir: seen.workdir,
        updated_at: sql`now()` as unknown as string,
      })
      .where('id', '=', id)
      .where('command', '=', seen.command)
      .where('workdir', '=', seen.workdir)
      .returningAll()
      .executeTakeFirst();
    return row ? serverRecord(row) : undefined;
  }

  /** Whether a specific command and subdirectory carry the operator's approval.
   *  Used at restarts, which run the last-run values rather than the current ones. */
  async isApproved(id: string, command: string, workdir: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('managed_dev_servers')
      .select('id')
      .where('id', '=', id)
      .where('approved_command', '=', command)
      .where('approved_workdir', '=', workdir)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The pair of entry and session, created with a free sandbox port on first use. */
  async ensureInstance(input: {
    serverId: string;
    sessionId: string;
    sandboxPorts: readonly number[];
    avoid?: ReadonlySet<number> | undefined;
  }): Promise<ManagedDevServerInstanceRecord> {
    return this.db.transaction().execute(async (tx) => {
      const server = await tx
        .selectFrom('managed_dev_servers')
        .select(['id', 'project_id'])
        .where('id', '=', input.serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) throw new ManagedDevServerInputError('server not found');
      const session = await tx
        .selectFrom('sessions')
        .select('project_id')
        .where('session_id', '=', input.sessionId)
        .executeTakeFirst();
      // An entry runs only in sessions of its own project.
      if (session?.project_id !== server.project_id)
        throw new ManagedDevServerInputError('session not found in this project');
      const existing = await tx
        .selectFrom('managed_dev_server_instances')
        .selectAll()
        .where('server_id', '=', input.serverId)
        .where('session_id', '=', input.sessionId)
        .executeTakeFirst();
      if (existing) return instanceRecord(existing);
      // Serialize sandbox-port allocation within the project.
      await tx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', server.project_id)
        .forUpdate()
        .executeTakeFirst();
      const used = new Set(
        (
          await tx
            .selectFrom('managed_dev_server_instances')
            .select('sandbox_port')
            .where('project_id', '=', server.project_id)
            .execute()
        ).map((row) => row.sandbox_port),
      );
      const port = input.sandboxPorts.find((p) => !used.has(p) && !input.avoid?.has(p));
      if (port === undefined) throw new ManagedDevServerConflictError('no free sandbox port');
      const row = await tx
        .insertInto('managed_dev_server_instances')
        .values({
          id: randomUUID(),
          server_id: input.serverId,
          project_id: server.project_id,
          session_id: input.sessionId,
          sandbox_port: port,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return instanceRecord(row);
    });
  }

  /** Moves an instance to another sandbox port after a collision; the network
   *  port, and with it the operator's bookmark, stays. */
  async moveSandboxPort(
    id: string,
    sandboxPorts: readonly number[],
    avoid: ReadonlySet<number>,
  ): Promise<ManagedDevServerInstanceRecord | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const instance = await tx
        .selectFrom('managed_dev_server_instances')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!instance) return undefined;
      await tx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', instance.project_id)
        .forUpdate()
        .executeTakeFirst();
      const used = new Set(
        (
          await tx
            .selectFrom('managed_dev_server_instances')
            .select('sandbox_port')
            .where('project_id', '=', instance.project_id)
            .execute()
        ).map((row) => row.sandbox_port),
      );
      const port = sandboxPorts.find((p) => !used.has(p) && !avoid.has(p));
      if (port === undefined) throw new ManagedDevServerConflictError('no free sandbox port');
      const row = await tx
        .updateTable('managed_dev_server_instances')
        .set({ sandbox_port: port, updated_at: sql`now()` as unknown as string })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return instanceRecord(row);
    });
  }

  async getInstance(id: string): Promise<ManagedDevServerInstanceRecord | undefined> {
    const row = await this.db
      .selectFrom('managed_dev_server_instances')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? instanceRecord(row) : undefined;
  }

  async listInstances(filter: {
    projectId?: string;
    sessionId?: string;
    serverId?: string;
    desired?: ManagedDevServerDesired;
  }): Promise<ManagedDevServerInstanceRecord[]> {
    let query = this.db.selectFrom('managed_dev_server_instances').selectAll();
    if (filter.projectId !== undefined) query = query.where('project_id', '=', filter.projectId);
    if (filter.sessionId !== undefined) query = query.where('session_id', '=', filter.sessionId);
    if (filter.serverId !== undefined) query = query.where('server_id', '=', filter.serverId);
    if (filter.desired !== undefined) query = query.where('desired', '=', filter.desired);
    const rows = await query.orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
    return rows.map(instanceRecord);
  }

  async updateInstance(
    id: string,
    patch: ManagedDevServerInstancePatch,
  ): Promise<ManagedDevServerInstanceRecord | undefined> {
    const row = await this.db
      .updateTable('managed_dev_server_instances')
      .set({
        ...(patch.desired !== undefined ? { desired: patch.desired } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.lastRunCommand !== undefined ? { last_run_command: patch.lastRunCommand } : {}),
        ...(patch.lastRunWorkdir !== undefined ? { last_run_workdir: patch.lastRunWorkdir } : {}),
        ...(patch.startedAt !== undefined
          ? { started_at: patch.startedAt?.toISOString() ?? null }
          : {}),
        ...(patch.localAccess !== undefined ? { local_access: patch.localAccess } : {}),
        ...(patch.lastRanAt !== undefined
          ? { last_ran_at: patch.lastRanAt?.toISOString() ?? null }
          : {}),
        updated_at: sql`now()` as unknown as string,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? instanceRecord(row) : undefined;
  }

  /**
   * The instance's network port: its own reservation if it has one, else a free
   * port, else one taken from the non-running pair that ran least recently
   * (never-run pairs first). Running and starting pairs, and pairs in `protect`
   * (live public links), are never evicted. `externallyUsed` are ports held by
   * shares outside this table.
   */
  async reserveNetworkPort(
    id: string,
    ports: readonly number[],
    options: { protect: ReadonlySet<string>; externallyUsed: ReadonlySet<number> },
  ): Promise<{ port: number; evictedInstanceId?: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.transaction().execute(async (tx) => {
          const instance = await tx
            .selectFrom('managed_dev_server_instances')
            .selectAll()
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!instance) throw new ManagedDevServerInputError('instance not found');
          if (instance.network_port !== null && ports.includes(instance.network_port))
            return { port: instance.network_port };
          const holders = await tx
            .selectFrom('managed_dev_server_instances')
            .selectAll()
            .where('network_port', 'is not', null)
            // One lock order for every reservation, so two cannot deadlock.
            .orderBy('id', 'asc')
            .forUpdate()
            .execute();
          const held = new Set(holders.map((row) => row.network_port!));
          const free = ports.find((p) => !held.has(p) && !options.externallyUsed.has(p));
          const assign = async (port: number) => {
            await tx
              .updateTable('managed_dev_server_instances')
              .set({ network_port: port, updated_at: sql`now()` as unknown as string })
              .where('id', '=', id)
              .execute();
          };
          if (free !== undefined) {
            await assign(free);
            return { port: free };
          }
          const liveLinks = await tx
            .selectFrom('public_preview_shares')
            .select('managed_instance_id')
            .where('managed_instance_id', 'is not', null)
            .where('state', 'in', ['creating', 'active', 'revoking'])
            .where('expires_at', '>', new Date())
            .execute();
          const protectedLinks = new Set(liveLinks.map((link) => link.managed_instance_id));
          const victim = holders
            .filter(
              (row) =>
                row.id !== id &&
                ports.includes(row.network_port!) &&
                !options.externallyUsed.has(row.network_port!) &&
                row.state !== 'running' &&
                row.state !== 'starting' &&
                row.desired !== 'running' &&
                !options.protect.has(row.id) &&
                !protectedLinks.has(row.id),
            )
            .sort(
              (a, b) =>
                (a.last_ran_at?.getTime() ?? -1) - (b.last_ran_at?.getTime() ?? -1) ||
                a.created_at.getTime() - b.created_at.getTime(),
            )[0];
          if (!victim) throw new ManagedDevServerPortsFullError();
          const port = victim.network_port!;
          await tx
            .updateTable('managed_dev_server_instances')
            .set({ network_port: null, updated_at: sql`now()` as unknown as string })
            .where('id', '=', victim.id)
            .execute();
          await assign(port);
          return { port, evictedInstanceId: victim.id };
        });
      } catch (error) {
        if (!(isUniqueViolation(error) || isSerializationFailure(error)) || attempt === 2)
          throw error;
      }
    }
    throw new ManagedDevServerPortsFullError();
  }

  async deleteInstance(id: string): Promise<void> {
    await this.db.deleteFrom('managed_dev_server_instances').where('id', '=', id).execute();
  }

  async releaseNetworkPort(id: string): Promise<void> {
    await this.db
      .updateTable('managed_dev_server_instances')
      .set({ network_port: null, updated_at: sql`now()` as unknown as string })
      .where('id', '=', id)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('public_preview_shares')
              .select('id')
              .where('managed_instance_id', '=', id)
              .where('state', 'in', ['creating', 'active', 'revoking'])
              .where('expires_at', '>', new Date()),
          ),
        ),
      )
      .execute();
  }

  /** All reserved network ports, for the ad hoc share allocator to skip. */
  async reservedNetworkPorts(): Promise<Set<number>> {
    const rows = await this.db
      .selectFrom('managed_dev_server_instances')
      .select('network_port')
      .where('network_port', 'is not', null)
      .execute();
    return new Set(rows.map((row) => row.network_port!));
  }
}
