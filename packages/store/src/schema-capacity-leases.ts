import type { ColumnType, Generated } from 'kysely';

export interface CapacityLeasesTable {
  id: string;
  project_id: string;
  user_id: string;
  session_id: string;
  container_generation: string;
  kind: 'dependency-copy' | 'dependency-prepare' | 'dependency-private';
  bytes: ColumnType<string, number, number>;
  inodes: ColumnType<string, number, number>;
  state: 'reserved' | 'started' | 'uncertain' | 'settled';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CapacityLeaseDatabase {
  dependency_capacity_leases: CapacityLeasesTable;
}
