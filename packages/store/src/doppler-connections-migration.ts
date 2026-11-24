import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { dopplerBindingGrantId, legacyDopplerBindingGrantId } from './doppler-binding-identity.js';

/** The connection that takes over the single instance token (ADR 0031). */
export const LEGACY_DOPPLER_CONNECTION_ID = 'legacy-doppler';

/**
 * Several Doppler connections per instance and several bindings per project
 * (ADR 0031). The instance token becomes the `legacy-doppler` connection, each
 * project's config its default binding, personal tokens and grants follow it.
 * The old columns stay as they are: `project_settings.doppler_project/config`
 * keeps mirroring the default binding for older readers.
 */
export const dopplerConnectionsMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table doppler_connections (
      id text primary key,
      label text not null,
      token text,
      workplace_slug text,
      workplace_name text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
    // Copy the encrypted envelope as is; no unlocked secret store is needed.
    await sql`insert into doppler_connections (id, label, token)
      select ${LEGACY_DOPPLER_CONNECTION_ID}, 'Doppler', s.doppler_service_token
      from (select 1) one
      left join verity_settings s on s.id = 'global'
      where s.doppler_service_token is not null
        or exists (select 1 from project_settings
          where coalesce(trim(doppler_project), '') <> '' and coalesce(trim(doppler_config), '') <> '')
        or exists (select 1 from user_doppler_connections)`.execute(db);
    await sql`create table project_doppler_bindings (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      connection_id text not null references doppler_connections(id) on delete cascade,
      doppler_project text not null check (doppler_project <> ''),
      doppler_config text not null check (doppler_config <> ''),
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      unique (project_id, doppler_project, doppler_config)
    )`.execute(db);
    await sql`create unique index project_doppler_bindings_default
      on project_doppler_bindings(project_id) where is_default`.execute(db);
    await sql`create index project_doppler_bindings_connection
      on project_doppler_bindings(connection_id)`.execute(db);
    await sql`insert into project_doppler_bindings
        (id, project_id, connection_id, doppler_project, doppler_config, is_default)
      select gen_random_uuid()::text, project_id, ${LEGACY_DOPPLER_CONNECTION_ID},
        trim(doppler_project), trim(doppler_config), true
      from project_settings
      where coalesce(trim(doppler_project), '') <> '' and coalesce(trim(doppler_config), '') <> ''`.execute(
      db,
    );
    await sql`alter table user_doppler_connections add column connection_id text
      references doppler_connections(id) on delete cascade`.execute(db);
    await sql`update user_doppler_connections set connection_id = ${LEGACY_DOPPLER_CONNECTION_ID}`.execute(
      db,
    );
    await sql`alter table user_doppler_connections alter column connection_id set not null`.execute(
      db,
    );
    await sql`alter table user_doppler_connections drop constraint user_doppler_connections_pkey`.execute(
      db,
    );
    await sql`alter table user_doppler_connections
      add primary key (user_id, project_id, connection_id)`.execute(db);
    // Grants were keyed by project and config alone; key them by the binding.
    const bindings = await sql<{
      project_id: string;
      doppler_project: string;
      doppler_config: string;
    }>`
      select project_id, doppler_project, doppler_config from project_doppler_bindings`.execute(db);
    for (const row of bindings.rows) {
      await sql`update secret_provider_permissions
        set binding_id = ${dopplerBindingGrantId({
          connectionId: LEGACY_DOPPLER_CONNECTION_ID,
          dopplerProject: row.doppler_project,
          dopplerConfig: row.doppler_config,
        })}
        where project_id = ${row.project_id}
          and binding_id = ${legacyDopplerBindingGrantId(row.doppler_project, row.doppler_config)}`.execute(
        db,
      );
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`delete from user_doppler_connections
      where connection_id <> ${LEGACY_DOPPLER_CONNECTION_ID}`.execute(db);
    await sql`alter table user_doppler_connections drop constraint user_doppler_connections_pkey`.execute(
      db,
    );
    await sql`alter table user_doppler_connections add primary key (user_id, project_id)`.execute(
      db,
    );
    await sql`alter table user_doppler_connections drop column connection_id`.execute(db);
    await sql`drop table project_doppler_bindings`.execute(db);
    await sql`drop table doppler_connections`.execute(db);
  },
};
