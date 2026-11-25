import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Server monitoring settings (docs/adr/0032-server-metrics-and-diagnostics.md):
 * one row for the whole installation. Measurement is on by default; detail mode
 * is a deadline rather than a switch, so a forgotten detail mode ends by itself.
 */
export const serverMonitoringMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table server_monitoring_settings (
      id text primary key default 'global' check (id = 'global'),
      measurement_enabled boolean not null default true,
      detail_until timestamptz,
      detail_started_by text check (detail_started_by in ('app', 'control')),
      updated_at timestamptz not null default now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table server_monitoring_settings`.execute(db);
  },
};
