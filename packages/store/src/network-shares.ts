import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export type NetworkShareAccessMode = 'read-only' | 'read-write';

export interface NetworkShareConnectionRecord {
  id: string;
  label: string;
  host: string;
  port: number | null;
  share: string;
  username: string;
  /** Number of projects with at least one folder on this share. */
  projectCount: number;
  createdAt: Date;
}

export interface NetworkShareCredentials {
  host: string;
  port: number | null;
  share: string;
  username: string;
  /** Owned bytes; the caller erases them after use. */
  password: Buffer;
  targetRevision: string;
}

export interface ProjectNetworkShareFolderRecord {
  id: string;
  projectId: string;
  connectionId: string;
  connectionLabel: string;
  path: string;
  name: string;
  accessMode: NetworkShareAccessMode;
  revision: string;
  /** The connection now points to another server or share; the grant no longer applies. */
  stale: boolean;
}

export class InvalidNetworkSharePathError extends Error {
  constructor(message = 'Use a folder path inside the share, without “..” or special characters.') {
    super(message);
    this.name = 'InvalidNetworkSharePathError';
  }
}

export class NetworkShareTargetChangedError extends Error {
  constructor() {
    super(
      'The network share now points to another server or shared folder. Choose the folder again.',
    );
    this.name = 'NetworkShareTargetChangedError';
  }
}

const MAX_PATH_LENGTH = 1024;
// `:` would address an alternate data stream; the others are invalid in SMB names.
const FORBIDDEN_CHARACTERS = /[:*?"<>|]/;
const forbidden = (segment: string) =>
  FORBIDDEN_CHARACTERS.test(segment) ||
  [...segment].some((character) => character.charCodeAt(0) < 0x20 || character === '\u007f');

/**
 * The canonical form of a path inside a share: `/`-separated, no leading or
 * trailing separator, '' for the root. Both separators are accepted on input
 * because SMB treats `\` as a separator too; `.`/`..` and stream syntax are
 * rejected rather than resolved, so a path can never name something outside
 * the folder it is checked against.
 */
export function normalizeNetworkSharePath(input: string): string {
  if (input.length > MAX_PATH_LENGTH) throw new InvalidNetworkSharePathError();
  const segments = input.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || forbidden(segment))
      throw new InvalidNetworkSharePathError();
    if (segment.trim() !== segment || segment.endsWith('.'))
      throw new InvalidNetworkSharePathError(
        'Folder and file names cannot start or end with spaces or end with a dot.',
      );
  }
  return segments.join('/');
}

/** Whether `path` is `folder` itself or lies inside it; both normalized. */
export function networkSharePathWithin(folder: string, path: string): boolean {
  if (folder === '') return true;
  const a = folder.toLowerCase();
  const b = path.toLowerCase();
  // SMB names are case-insensitive on every NAS this targets; compare that way
  // so “briefs/../Briefs” style tricks cannot be built from case differences.
  return b === a || b.startsWith(`${a}/`);
}

/**
 * Central SMB connections and the folders projects may use on them. Passwords
 * are encrypted at rest and decrypted only by {@link credentials}.
 */
export class NetworkShareStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly getCipher: () => SecretCipher,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  private get cipher(): SecretCipher {
    return this.getCipher();
  }

  async listConnections(): Promise<NetworkShareConnectionRecord[]> {
    const rows = await this.db
      .selectFrom('network_share_connections as c')
      .select([
        'c.id',
        'c.label',
        'c.host',
        'c.port',
        'c.share',
        'c.username',
        'c.created_at',
        sql<number>`(select count(distinct f.project_id)::int from project_network_share_folders f
          where f.connection_id = c.id and f.connection_target_revision = c.target_revision)`.as(
          'project_count',
        ),
      ])
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      share: row.share,
      username: row.username,
      projectCount: Number(row.project_count),
      createdAt: row.created_at,
    }));
  }

  async getConnection(id: string): Promise<NetworkShareConnectionRecord | undefined> {
    return (await this.listConnections()).find((connection) => connection.id === id);
  }

  async createConnection(input: {
    label: string;
    host: string;
    port: number | null;
    share: string;
    username: string;
    password: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.db
      .insertInto('network_share_connections')
      .values({
        id,
        label: input.label,
        host: input.host,
        port: input.port,
        share: input.share,
        username: input.username,
        password: this.cipher.encrypt(input.password),
        target_revision: randomUUID(),
      })
      .execute();
    return id;
  }

  /**
   * Changes a connection. A new host, port, share or username starts a new
   * target revision, which ends every folder grant made for the previous target:
   * a grant was checked against what that account could reach, and another
   * account's permissions on the NAS may differ. Names compare without case, as
   * SMB servers treat them.
   * Returns false when the connection does not exist.
   */
  async updateConnection(
    id: string,
    patch: {
      label?: string;
      host?: string;
      port?: number | null;
      share?: string;
      username?: string;
      password?: string;
      /** The target the new details were tested on; another current target refuses the change. */
      expectedTargetRevision?: string;
    },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('network_share_connections')
        .select(['host', 'port', 'share', 'username', 'target_revision'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      if (
        patch.expectedTargetRevision !== undefined &&
        patch.expectedTargetRevision !== current.target_revision
      )
        throw new NetworkShareTargetChangedError();
      const targetChanged =
        (patch.host !== undefined && patch.host.toLowerCase() !== current.host.toLowerCase()) ||
        (patch.port !== undefined && patch.port !== current.port) ||
        (patch.share !== undefined && patch.share.toLowerCase() !== current.share.toLowerCase()) ||
        (patch.username !== undefined &&
          patch.username.toLowerCase() !== current.username.toLowerCase());
      await tx
        .updateTable('network_share_connections')
        .set({
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.host === undefined ? {} : { host: patch.host }),
          ...(patch.port === undefined ? {} : { port: patch.port }),
          ...(patch.share === undefined ? {} : { share: patch.share }),
          ...(patch.username === undefined ? {} : { username: patch.username }),
          ...(patch.password === undefined
            ? {}
            : { password: this.cipher.encrypt(patch.password) }),
          ...(targetChanged ? { target_revision: randomUUID() } : {}),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  /** Disconnects a share; every project folder on it goes with it. */
  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('network_share_connections')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async credentials(id: string): Promise<NetworkShareCredentials | undefined> {
    const row = await this.db
      .selectFrom('network_share_connections')
      .select(['host', 'port', 'share', 'username', 'password', 'target_revision'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      host: row.host,
      port: row.port,
      share: row.share,
      username: row.username,
      password: this.cipher.decryptBytes(row.password),
      targetRevision: row.target_revision,
    };
  }

  private foldersQuery() {
    return this.db
      .selectFrom('project_network_share_folders as f')
      .innerJoin('network_share_connections as c', 'c.id', 'f.connection_id')
      .select([
        'f.id',
        'f.project_id',
        'f.connection_id',
        'c.label as connection_label',
        'f.path',
        'f.name',
        'f.access_mode',
        'f.revision',
        'f.connection_target_revision',
        'c.target_revision',
      ]);
  }

  async projectFolders(projectId: string): Promise<ProjectNetworkShareFolderRecord[]> {
    const rows = await this.foldersQuery()
      .where('f.project_id', '=', projectId)
      .orderBy('f.created_at')
      .orderBy('f.id')
      .execute();
    return rows.map(folderRecord);
  }

  async projectFolder(
    projectId: string,
    id: string,
  ): Promise<ProjectNetworkShareFolderRecord | undefined> {
    const row = await this.foldersQuery()
      .where('f.project_id', '=', projectId)
      .where('f.id', '=', id)
      .executeTakeFirst();
    return row ? folderRecord(row) : undefined;
  }

  /**
   * Grants a project a folder on the connection's current target. Granting the
   * same folder again sets the given access mode, or keeps the current one when
   * none is given (a new grant is read only then). Returns undefined when the
   * connection does not exist.
   */
  async grantFolder(input: {
    projectId: string;
    connectionId: string;
    path: string;
    name: string;
    accessMode?: NetworkShareAccessMode | undefined;
    /** The target the folder was verified on; a different current target refuses the grant. */
    targetRevision?: string;
  }): Promise<string | undefined> {
    const path = normalizeNetworkSharePath(input.path);
    return this.db.transaction().execute(async (tx) => {
      // Locked exclusively so grants on one share run one after another: two
      // first grants of the same folder must not both insert.
      const connection = await tx
        .selectFrom('network_share_connections')
        .select('target_revision')
        .where('id', '=', input.connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!connection) return undefined;
      if (input.targetRevision !== undefined && input.targetRevision !== connection.target_revision)
        throw new NetworkShareTargetChangedError();
      // One grant per folder whatever its case; granting it again replaces it.
      const existing = await tx
        .selectFrom('project_network_share_folders')
        .select(['id', 'connection_target_revision'])
        .where('project_id', '=', input.projectId)
        .where('connection_id', '=', input.connectionId)
        .where(sql<string>`lower(path)`, '=', path.toLowerCase())
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        await tx
          .updateTable('project_network_share_folders')
          .set({
            path,
            name: input.name,
            // A grant from an earlier target carries no access over to this one.
            ...(input.accessMode !== undefined
              ? { access_mode: input.accessMode }
              : existing.connection_target_revision !== connection.target_revision
                ? { access_mode: 'read-only' as const }
                : {}),
            connection_target_revision: connection.target_revision,
            revision: randomUUID(),
          })
          .where('id', '=', existing.id)
          .execute();
        return existing.id;
      }
      const id = randomUUID();
      await tx
        .insertInto('project_network_share_folders')
        .values({
          id,
          project_id: input.projectId,
          connection_id: input.connectionId,
          connection_target_revision: connection.target_revision,
          path,
          name: input.name,
          access_mode: input.accessMode ?? 'read-only',
          revision: randomUUID(),
        })
        .execute();
      return id;
    });
  }

  async setFolderAccess(
    projectId: string,
    id: string,
    accessMode: NetworkShareAccessMode,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('project_network_share_folders')
      .set({ access_mode: accessMode, revision: randomUUID() })
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async removeFolder(projectId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('project_network_share_folders')
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** Number of projects using any network share, for the connectors overview. */
  async projectsUsingShares(): Promise<number> {
    const row = await this.db
      .selectFrom('project_network_share_folders as f')
      .innerJoin('network_share_connections as c', 'c.id', 'f.connection_id')
      .whereRef('f.connection_target_revision', '=', 'c.target_revision')
      .select(sql<number>`count(distinct f.project_id)::int`.as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}

function folderRecord(row: {
  id: string;
  project_id: string;
  connection_id: string;
  connection_label: string;
  path: string;
  name: string;
  access_mode: NetworkShareAccessMode;
  revision: string;
  connection_target_revision: string;
  target_revision: string;
}): ProjectNetworkShareFolderRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    connectionLabel: row.connection_label,
    path: row.path,
    name: row.name,
    accessMode: row.access_mode,
    revision: row.revision,
    stale: row.connection_target_revision !== row.target_revision,
  };
}
