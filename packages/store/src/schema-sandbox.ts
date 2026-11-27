import type { JSONColumnType } from 'kysely';
import type { SandboxUpdateState } from './sandbox-update-state.js';

interface SandboxUpdateStateTable {
  project_id: string;
  value: JSONColumnType<SandboxUpdateState>;
}

export interface SandboxDatabase {
  sandbox_update_state: SandboxUpdateStateTable;
}

export interface SandboxRepairIntentsTable {
  project_id: string;
  version: number;
  attempt_id: string;
  status: string;
  source_generation: string | null;
  target_image_ref: string | null;
  failures: number;
  retry_at: Date;
  storage_refused: boolean;
  last_failure_at: Date;
  last_failure_message: string;
}
