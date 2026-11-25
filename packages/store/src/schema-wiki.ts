import type { Generated } from 'kysely';

// Wiki occasions and maintenance runs, part of `Database` in schema.ts.

export interface WikiOccasionsTable {
  id: string;
  project_id: string;
  kind: 'source' | 'meeting' | 'decision' | 'chat' | 'session' | 'merge';
  ref: string;
  title: string;
  body: string | null;
  created_at: Generated<Date>;
  closed_at: Date | null;
}

interface WikiMaintenanceTable {
  project_id: string;
  session_id: string | null;
  last_run_at: Date | null;
}

export interface WikiDatabase {
  wiki_occasions: WikiOccasionsTable;
  wiki_maintenance: WikiMaintenanceTable;
}
