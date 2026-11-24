import type { ColumnType, Generated } from 'kysely';

// Doppler connections and project bindings (ADR 0031), part of `Database` in schema.ts.

/** One Doppler token held by the instance, typically one per Doppler workplace. */
interface DopplerConnectionsTable {
  id: string;
  label: string;
  /** Encrypted at rest; null for a connection only personal tokens use. */
  token: string | null;
  workplace_slug: string | null;
  workplace_name: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** A Doppler project and config a Verity project reads secrets from. */
interface ProjectDopplerBindingsTable {
  id: string;
  project_id: string;
  connection_id: string;
  doppler_project: string;
  doppler_config: string;
  is_default: Generated<boolean>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface DopplerDatabase {
  doppler_connections: DopplerConnectionsTable;
  project_doppler_bindings: ProjectDopplerBindingsTable;
}
