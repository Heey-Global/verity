import type { ColumnType } from 'kysely';

// Server monitoring settings (docs/adr/0032-server-metrics-and-diagnostics.md),
// part of `Database` in schema.ts.

interface ServerMonitoringSettingsTable {
  id: ColumnType<'global', 'global' | undefined, never>;
  measurement_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  detail_until: Date | null;
  detail_started_by: 'app' | 'control' | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ServerMonitoringDatabase {
  server_monitoring_settings: ServerMonitoringSettingsTable;
}
