import type { ColumnType } from 'kysely';

// Network shares (SMB) connected centrally and granted per project folder,
// part of `Database` in schema.ts.

/** One SMB share the instance connects to. */
interface NetworkShareConnectionsTable {
  id: string;
  label: string;
  host: string;
  port: number | null;
  share: string;
  username: string;
  /** Encrypted at rest; never listed. */
  password: string;
  /**
   * Changes whenever host, port or share change. Folder grants record the value
   * they were made under, so a grant never silently follows a connection to a
   * different server or share.
   */
  target_revision: string;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** A folder on a share that a project's agents may use. */
interface ProjectNetworkShareFoldersTable {
  id: string;
  project_id: string;
  connection_id: string;
  connection_target_revision: string;
  /** Normalized, `/`-separated, without leading or trailing slash; '' is the share root. */
  path: string;
  name: string;
  access_mode: 'read-only' | 'read-write';
  /** Changes with every access change, so approvals bind to the grant they saw. */
  revision: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface NetworkShareDatabase {
  network_share_connections: NetworkShareConnectionsTable;
  project_network_share_folders: ProjectNetworkShareFoldersTable;
}
