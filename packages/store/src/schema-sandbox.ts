import type { JSONColumnType } from 'kysely';
import type { SandboxUpdateState } from './sandbox-update-state.js';

interface SandboxUpdateStateTable {
  project_id: string;
  value: JSONColumnType<SandboxUpdateState>;
}

export interface SandboxDatabase {
  sandbox_update_state: SandboxUpdateStateTable;
}
