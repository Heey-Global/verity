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
      token_revision text,
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
    await sql`alter table user_doppler_connections
      add column validated_binding_ids text[] not null default '{}'`.execute(db);
    // Legacy tokens stay encrypted but must be revalidated against a verified workplace.
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
    // The previous gateway cannot enforce denials and at-most-once claims for
    // requests identified by a binding snapshot.
    const result = await sql<{ incompatible: boolean }>`select
      exists (select 1 from brokered_tool_approvals where status in ('denied', 'consumed')
        and authorization_snapshot::jsonb ? 'bindings')
      or exists (select 1 from brokered_http_consumptions where call_id like 'doppler-v2:%')
      or (exists (select 1 from secret_provider_bindings where provider = 'doppler' and state = 'active')
        and exists (select 1 from doppler_connections where id <> ${LEGACY_DOPPLER_CONNECTION_ID}))
      as incompatible`.execute(db);
    if (result.rows[0]?.incompatible)
      throw new Error(
        'Cannot downgrade Doppler connections while newer authorization records or an independent Secret Job catalog may be in use.',
      );
    await sql`delete from brokered_tool_approvals a
      where a.authorization_snapshot::jsonb ? 'bindings'
        or (a.status in ('pending', 'approved') and not exists (
          select 1 from project_doppler_bindings b join doppler_connections c on c.id = b.connection_id
          where b.project_id = a.project_id and b.is_default
            and c.id = ${LEGACY_DOPPLER_CONNECTION_ID} and c.token_revision is null
            and b.created_at = c.created_at
            and b.doppler_project = a.authorization_snapshot::jsonb ->> 'dopplerProject'
            and b.doppler_config = a.authorization_snapshot::jsonb ->> 'dopplerConfig'))`.execute(
      db,
    );
    // The old app can only use a default binding on the legacy workplace. Clear
    // complete pairs from other workplaces instead of resolving them via the old token.
    await sql`update project_settings s set doppler_project = null, doppler_config = null
      where exists (select 1 from project_doppler_bindings b
        where b.project_id = s.project_id and b.is_default
          and b.connection_id <> ${LEGACY_DOPPLER_CONNECTION_ID})`.execute(db);
    await sql`insert into verity_settings (id, doppler_service_token)
      values ('global', (select token from doppler_connections where id = ${LEGACY_DOPPLER_CONNECTION_ID}))
      on conflict (id) do update set doppler_service_token = excluded.doppler_service_token`.execute(
      db,
    );
    // A token that already existed at upgrade can return to the unchanged legacy
    // binding, even if we could not prove that binding's validation on upgrade.
    await sql`delete from user_doppler_connections u
      where connection_id <> ${LEGACY_DOPPLER_CONNECTION_ID}
        or not exists (select 1 from project_doppler_bindings b
          join doppler_connections c on c.id = b.connection_id
          where b.project_id = u.project_id and b.is_default and b.connection_id = u.connection_id
            and (b.id = any(u.validated_binding_ids)
              or (c.token_revision is null and b.created_at = c.created_at
                  and u.updated_at <= c.created_at)))`.execute(db);

    // Only single-binding grants for the current legacy default can be carried
    // back. Older revisions, qualified references and multi-binding grants
    // cannot be represented by the previous code.
    const defaults = await sql<{
      project_id: string;
      doppler_project: string;
      doppler_config: string;
      token_revision: string | null;
    }>`
      select b.project_id, b.doppler_project, b.doppler_config, c.token_revision
      from project_doppler_bindings b join doppler_connections c on c.id = b.connection_id
      where b.is_default and c.id = ${LEGACY_DOPPLER_CONNECTION_ID}`.execute(db);
    await sql`delete from secret_provider_permissions p
      where (p.binding_id like 'project-doppler:%' or p.binding_id like 'project-doppler-set:%')
        and not exists (select 1 from project_doppler_bindings b
          where b.project_id = p.project_id and b.is_default
            and b.connection_id = ${LEGACY_DOPPLER_CONNECTION_ID})`.execute(db);
    for (const row of defaults.rows) {
      const current = dopplerBindingGrantId({
        connectionId: LEGACY_DOPPLER_CONNECTION_ID,
        dopplerProject: row.doppler_project,
        dopplerConfig: row.doppler_config,
        tokenRevision: row.token_revision,
      });
      await sql`delete from secret_provider_permissions
        where project_id = ${row.project_id}
          and (binding_id like 'project-doppler:%' or binding_id like 'project-doppler-set:%')
          and (binding_id <> ${current} or position('/' in secret_name) > 0)`.execute(db);
      await sql`update secret_provider_permissions
        set binding_id = ${legacyDopplerBindingGrantId(row.doppler_project, row.doppler_config)}
        where project_id = ${row.project_id} and binding_id = ${current}`.execute(db);
    }
    await sql`alter table user_doppler_connections drop constraint user_doppler_connections_pkey`.execute(
      db,
    );
    await sql`alter table user_doppler_connections add primary key (user_id, project_id)`.execute(
      db,
    );
    await sql`alter table user_doppler_connections drop column validated_binding_ids`.execute(db);
    await sql`alter table user_doppler_connections drop column connection_id`.execute(db);
    await sql`drop table project_doppler_bindings`.execute(db);
    await sql`drop table doppler_connections`.execute(db);
  },
};
