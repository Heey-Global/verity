import { capacityLeasesMigration } from './capacity-leases-migration.js';
import { brokeredToolApprovalMigration } from './brokered-tool-approval-migration.js';
import { projectQAMigration } from './project-qa-migration.js';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Every migration from 0205 on. `migrations.ts` holds the earlier ones and
 * registers these; add new migrations here (docs/adr/0029-module-boundaries-
 * and-file-size.md). Kysely orders migrations by key, so the module a migration
 * is defined in does not change when it runs.
 */
export const laterMigrations: Record<string, Migration> = {};
const migrations = laterMigrations;

migrations['0205_sandbox_repair_intents'] = {
  // An automatic Sandbox repair the Server still owes a project after one of its
  // own recreates failed. Process memory alone forgot it on restart, leaving a
  // `failed` project waiting for a manual Repair.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table sandbox_repair_intents (
      project_id text primary key references projects(id) on delete cascade,
      version integer not null check (version = 1),
      attempt_id text not null,
      status text not null check (status in ('running','waiting')),
      source_generation text,
      target_image_ref text,
      failures integer not null check (failures >= 0),
      retry_at timestamptz not null,
      storage_refused boolean not null,
      last_failure_at timestamptz not null,
      last_failure_message text not null check (char_length(last_failure_message) <= 500)
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table sandbox_repair_intents`.execute(db);
  },
};

migrations['0206_user_display_name'] = {
  // The name other people see for a person in shared projects: turn authors,
  // the Team page and invitations. Optional, because the administrator is asked
  // for it only when first inviting someone; a member sets it when joining.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table users add column display_name text
      check (char_length(btrim(display_name)) between 1 and 80)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table users drop column display_name`.execute(db);
  },
};

migrations['0207_google_account_owners'] = {
  // A Google account belongs to the person who connected it (ADR 0023 §3). The
  // existing accounts were connected by the installation's administrator. Email
  // and Google subject become unique per person, so a second member connecting
  // the same address gets their own row instead of replacing the first one's
  // credentials. Project service connections become per member: each member
  // chooses their own account for a project.
  //
  // Like 0208 and later, the backfill names the administrator only where that
  // row exists. A foreign-key default would be validated against every existing
  // row and abort the upgrade of an installation without it; rows no one can
  // own are dropped, as no person could reach them anyway. No default remains,
  // so a writer that forgets the owner fails instead of handing the account or
  // choice to the administrator.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table google_accounts add column owner_user_id text
      references users(id) on delete cascade`.execute(db);
    await sql`update google_accounts set owner_user_id = '00000000-0000-4000-8000-000000000001'
      where exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
    await sql`delete from google_accounts where owner_user_id is null`.execute(db);
    await sql`alter table google_accounts alter column owner_user_id set not null`.execute(db);
    await sql`drop index google_accounts_email`.execute(db);
    await sql`create unique index google_accounts_owner_email
      on google_accounts(owner_user_id, lower(email))`.execute(db);
    await sql`alter table google_accounts drop constraint google_accounts_subject_key`.execute(db);
    await sql`create unique index google_accounts_owner_subject
      on google_accounts(owner_user_id, subject) where subject is not null`.execute(db);

    await sql`alter table project_google_connections add column user_id text
      references users(id) on delete cascade`.execute(db);
    await sql`update project_google_connections set user_id = '00000000-0000-4000-8000-000000000001'
      where exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
    await sql`update project_google_connections c set user_id = a.owner_user_id
      from google_accounts a where a.id = c.account_id`.execute(db);
    await sql`delete from project_google_connections where user_id is null`.execute(db);
    await sql`alter table project_google_connections alter column user_id set not null`.execute(db);
    await sql`alter table project_google_connections
      drop constraint project_google_connections_pkey`.execute(db);
    await sql`alter table project_google_connections
      add primary key (project_id, service, user_id)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // Only the administrator's choices fit the former one-per-project shape.
    await sql`delete from project_google_connections c using google_accounts a
      where a.id = c.account_id and a.owner_user_id <> '00000000-0000-4000-8000-000000000001'`.execute(
      db,
    );
    await sql`delete from project_google_connections
      where user_id <> '00000000-0000-4000-8000-000000000001'`.execute(db);
    await sql`alter table project_google_connections
      drop constraint project_google_connections_pkey`.execute(db);
    await sql`alter table project_google_connections drop column user_id`.execute(db);
    await sql`alter table project_google_connections
      add primary key (project_id, service)`.execute(db);
    await sql`delete from google_accounts
      where owner_user_id <> '00000000-0000-4000-8000-000000000001'`.execute(db);
    await sql`drop index google_accounts_owner_subject`.execute(db);
    await sql`alter table google_accounts add constraint google_accounts_subject_key
      unique (subject)`.execute(db);
    await sql`drop index google_accounts_owner_email`.execute(db);
    await sql`create unique index google_accounts_email on google_accounts(lower(email))`.execute(
      db,
    );
    await sql`alter table google_accounts drop column owner_user_id`.execute(db);
  },
};

migrations['0208_user_git_identities'] = {
  // Author, committer and commit signature belong to the person whose turn makes
  // the commit (ADR 0023 §3). The installation's existing git identity and
  // signing key were the administrator's, so they become the administrator's
  // personal identity; the encrypted key envelope is copied verbatim so this
  // also runs while the store is sealed. A key configured only by path stays in
  // the instance settings and remains the administrator's fallback.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table user_git_identities (
      user_id text primary key references users(id) on delete cascade,
      author_name text check (author_name is null or char_length(btrim(author_name)) between 1 and 200),
      author_email text check (author_email is null or char_length(btrim(author_email)) between 3 and 320),
      ssh_private_key text,
      ssh_public_key text,
      updated_at timestamptz not null default now()
    )`.execute(db);
    await sql`insert into user_git_identities
        (user_id, author_name, author_email, ssh_private_key, ssh_public_key)
      select '00000000-0000-4000-8000-000000000001',
        nullif(btrim(git_user_name), ''), nullif(btrim(git_user_email), ''),
        nullif(git_ssh_private_key, ''), nullif(git_ssh_public_key, '')
      from verity_settings
      where id = 'global'
        and exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')
        and (nullif(btrim(git_user_name), '') is not null
          or nullif(btrim(git_user_email), '') is not null
          or nullif(git_ssh_private_key, '') is not null)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table user_git_identities`.execute(db);
  },
};

migrations['0209_user_github_authorizations'] = {
  // Each person authorizes the instance's GitHub App for themselves; GitHub then
  // limits their token to their own repository permissions (ADR 0023 §3). The
  // App's OAuth client is kept beside its private key, the secret encrypted.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table verity_settings add column github_app_client_id text`.execute(db);
    await sql`alter table verity_settings add column github_app_client_secret text`.execute(db);
    await sql`create table user_github_authorizations (
      user_id text primary key references users(id) on delete cascade,
      github_user_id text not null,
      login text not null,
      access_token text not null,
      access_expires_at timestamptz,
      refresh_token text,
      refresh_expires_at timestamptz,
      updated_at timestamptz not null default now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table user_github_authorizations`.execute(db);
    await sql`alter table verity_settings drop column github_app_client_secret`.execute(db);
    await sql`alter table verity_settings drop column github_app_client_id`.execute(db);
  },
};

migrations['0210_user_doppler_connections'] = {
  // Doppler access goes through the turn's person, per project (ADR 0023 §3):
  // each member connects their own token, the instance token stays the
  // administrator's. Standing grants become a person's own consent; the existing
  // brokered-prompt grants were approved by the administrator and stay theirs.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table user_doppler_connections (
      user_id text not null references users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      token text not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, project_id)
    )`.execute(db);
    await sql`alter table secret_provider_permissions
      add column user_id text references users(id) on delete cascade`.execute(db);
    await sql`update secret_provider_permissions
      set user_id = '00000000-0000-4000-8000-000000000001'
      where issuer = 'brokered-prompt-v2'
        and exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table secret_provider_permissions drop column user_id`.execute(db);
    await sql`drop table user_doppler_connections`.execute(db);
  },
};

migrations['0211_managed_dev_server_run_user'] = {
  // A dev server's secrets resolve through the Doppler connection of the person
  // who started it, also when it is recovered later (ADR 0023 §3). Deliberately
  // no foreign key: clearing it on user deletion would turn a deleted person's
  // server into one without a person, which resolves with the instance token.
  // Existing instances were started before members existed, by the administrator.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table managed_dev_server_instances add column last_run_user_id text`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table managed_dev_server_instances drop column last_run_user_id`.execute(db);
  },
};

migrations['0212_per_person_brokered_grants'] = {
  // A standing grant is one person's consent (ADR 0023 §3), so two people may each
  // hold the same grant; the single-live-grant fence becomes per person.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`drop index secret_provider_permissions_brokered_v2_active_unique`.execute(db);
    await sql`
      CREATE UNIQUE INDEX secret_provider_permissions_brokered_v2_active_unique
      ON secret_provider_permissions (
        project_id,
        binding_id,
        secret_name,
        tool_id,
        scope,
        COALESCE(session_id, ''),
        COALESCE(user_id, '')
      )
      WHERE state = 'active' AND issuer = 'brokered-prompt-v2'
    `.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop index secret_provider_permissions_brokered_v2_active_unique`.execute(db);
    await sql`
      CREATE UNIQUE INDEX secret_provider_permissions_brokered_v2_active_unique
      ON secret_provider_permissions (
        project_id,
        binding_id,
        secret_name,
        tool_id,
        scope,
        COALESCE(session_id, '')
      )
      WHERE state = 'active' AND issuer = 'brokered-prompt-v2'
    `.execute(db);
  },
};

migrations['0213_project_sandboxes'] = {
  // One sandbox per person and project (ADR 0023 §4): the container is the
  // credential boundary. A row says that a person has a sandbox in a project;
  // container, network, volume and runtime names derive from it. The project's
  // existing container becomes the administrator's sandbox under its current
  // names (`project_default`), so nothing is recreated on upgrade.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table project_sandboxes (
      project_id text not null references projects(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      project_default boolean not null default false,
      created_at timestamptz not null default now(),
      primary key (project_id, user_id)
    )`.execute(db);
    await sql`create unique index project_sandboxes_one_default
      on project_sandboxes (project_id) where project_default`.execute(db);
    await sql`insert into project_sandboxes (project_id, user_id, project_default)
      select id, '00000000-0000-4000-8000-000000000001', true from projects
      where exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table project_sandboxes`.execute(db);
  },
};

migrations['0214_per_sandbox_capabilities'] = {
  // A sandbox's credentials are per person (ADR 0023 §4): its gateway client
  // certificate, signing capability and GitHub capability name the person as well
  // as the project. Every existing row belongs to the project's original container,
  // which became the administrator's sandbox. Rows without an administrator to own
  // them are dropped; they are reissued when the sandbox next starts.
  async up(db: Kysely<unknown>): Promise<void> {
    for (const table of [
      'claude_egress_client_certs',
      'signing_capabilities',
      'gh_token_capabilities',
    ]) {
      await sql`alter table ${sql.table(table)} add column user_id text
        references users(id) on delete cascade`.execute(db);
      await sql`update ${sql.table(table)} set user_id = '00000000-0000-4000-8000-000000000001'
        where exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
        db,
      );
      await sql`delete from ${sql.table(table)} where user_id is null`.execute(db);
      await sql`alter table ${sql.table(table)} alter column user_id set not null`.execute(db);
      await sql`alter table ${sql.table(table)} drop constraint ${sql.raw(`${table}_pkey`)}`.execute(
        db,
      );
      await sql`alter table ${sql.table(table)} add primary key (project_id, user_id)`.execute(db);
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    for (const table of [
      'claude_egress_client_certs',
      'signing_capabilities',
      'gh_token_capabilities',
    ]) {
      await sql`delete from ${sql.table(table)} t using ${sql.table(table)} o
        where t.project_id = o.project_id and t.user_id > o.user_id`.execute(db);
      await sql`alter table ${sql.table(table)} drop constraint ${sql.raw(`${table}_pkey`)}`.execute(
        db,
      );
      await sql`alter table ${sql.table(table)} drop column user_id`.execute(db);
      await sql`alter table ${sql.table(table)} add primary key (project_id)`.execute(db);
    }
  },
};

migrations['0215_project_sandbox_state'] = {
  // A person's sandbox has its own container lifecycle (ADR 0023 §4). The
  // project's original sandbox keeps reporting through the project row.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table project_sandboxes
      add column state text not null default 'absent',
      add column provision_error text,
      add column state_changed_at timestamptz not null default now()`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table project_sandboxes
      drop column state, drop column provision_error, drop column state_changed_at`.execute(db);
  },
};

migrations['0216_user_provider_connections'] = {
  // A person's own Claude, Codex and OpenCode accounts (ADR 0023 §3): their
  // turns run only on these. The instance login stays the administrator's
  // fallback in the instance settings. A project's default model becomes each
  // person's own choice; the existing one was the administrator's.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table user_provider_connections (
      user_id text not null references users(id) on delete cascade,
      provider text not null check (provider in ('claude', 'codex', 'opencode')),
      credential text not null,
      base_url text,
      models text,
      updated_at timestamptz not null default now(),
      primary key (user_id, provider)
    )`.execute(db);
    await sql`create table user_project_preferences (
      user_id text not null references users(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      default_model text,
      updated_at timestamptz not null default now(),
      primary key (user_id, project_id)
    )`.execute(db);
    await sql`insert into user_project_preferences (user_id, project_id, default_model)
      select '00000000-0000-4000-8000-000000000001', project_id, default_model
      from project_settings
      where default_model is not null
        and exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table user_project_preferences`.execute(db);
    await sql`drop table user_provider_connections`.execute(db);
  },
};

migrations['0217_user_project_last_model'] = {
  // The model a person last started work with in a project, so their next session
  // preselects it when their own project default is not usable for them. Also
  // retires the project-wide default, which each person now holds for themselves.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table user_project_preferences add column last_model text`.execute(db);
    // 0216 copied the project default to the administrator, whose it was. Left in
    // place it would keep choosing a model for everyone else in the project. Only
    // a default 0216 actually copied is retired: without the administrator row it
    // copied none, and clearing it would lose the project's only record of it.
    await sql`update project_settings s set default_model = null
      where exists (select 1 from user_project_preferences p
        where p.project_id = s.project_id
          and p.user_id = '00000000-0000-4000-8000-000000000001'
          and p.default_model is not distinct from s.default_model)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table user_project_preferences drop column last_model`.execute(db);
  },
};

migrations['0218_session_user_models'] = {
  // In a shared session each person keeps their own model (ADR 0023 §3): their
  // turns run on it, on their own account, whoever else writes in the session.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table session_user_models (
      session_id text not null references sessions(session_id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      model text not null,
      updated_at timestamptz not null default now(),
      primary key (session_id, user_id)
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table session_user_models`.execute(db);
  },
};

migrations['0219_project_team'] = {
  // Project team invitations, their single redemption and the Uplink outbox
  // (ADR 0023 §1, §7; Uplink team contract D8: Core is the source of truth).
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table project_invitations (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      inviter_user_id text not null references users(id) on delete cascade,
      invitee_name text not null,
      can_execute boolean not null,
      secret_hash text not null,
      secret_encrypted text,
      invitation_id text unique,
      state text not null check (state in ('creating', 'open', 'redeemed', 'revoked')),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      redemption_id text unique,
      redeemed_by_user_id text references users(id) on delete set null,
      redeemed_at timestamptz,
      revoked_at timestamptz
    )`.execute(db);
    await sql`create index project_invitations_project on project_invitations (project_id)`.execute(
      db,
    );
    // The opaque per-person reference Uplink knows a member by (D6); never reused.
    await sql`alter table users add column team_membership_ref text unique`.execute(db);
    await sql`create table team_outbox (
      operation_id text primary key,
      kind text not null,
      payload jsonb not null,
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      give_up_at timestamptz not null,
      created_at timestamptz not null default now(),
      done_at timestamptz
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table team_outbox`.execute(db);
    await sql`alter table users drop column team_membership_ref`.execute(db);
    await sql`drop table project_invitations`.execute(db);
  },
};

migrations['0220_team_join_admissions'] = {
  // Core's decision on one team join's tunnel (team bootstrap interface v1):
  // stored before session.accept, so a repeated team.join.pending gets the
  // same answer, and the join itself accepts only the redemption Uplink
  // minted for an accepted tunnel. A join Uplink refused for good leaves its
  // invitation `failed`, so the inviter sees to invite again.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table team_join_admissions (
      session_id text primary key,
      invitation_id text not null,
      redemption_id text not null unique,
      decision text not null check (decision in ('accepted', 'refused')),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )`.execute(db);
    await sql`alter table project_invitations
      drop constraint project_invitations_state_check`.execute(db);
    await sql`alter table project_invitations add constraint project_invitations_state_check
      check (state in ('creating', 'open', 'redeemed', 'revoked', 'failed'))`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`update project_invitations set state = 'revoked' where state = 'failed'`.execute(db);
    await sql`alter table project_invitations
      drop constraint project_invitations_state_check`.execute(db);
    await sql`alter table project_invitations add constraint project_invitations_state_check
      check (state in ('creating', 'open', 'redeemed', 'revoked'))`.execute(db);
    await sql`drop table team_join_admissions`.execute(db);
  },
};

migrations['0221_managed_dev_server_approver'] = {
  // A secret-bearing dev server runs with the secrets of whoever starts it
  // (ADR 0023 §3). The approval records who reviewed the command, so another
  // person's start needs their own approval rather than borrowing one.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table managed_dev_servers add column approved_by_user_id text`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table managed_dev_servers drop column approved_by_user_id`.execute(db);
  },
};

migrations['0222_google_owner_without_default'] = {
  // 0207 first gave both owner columns the administrator as default. On an
  // installation that already ran it, a writer that left the owner out would
  // still hand the Google account or project choice to the administrator.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table google_accounts alter column owner_user_id drop default`.execute(db);
    await sql`alter table project_google_connections alter column user_id drop default`.execute(db);
  },
  async down(): Promise<void> {
    // The default was a migration aid, not part of the data; nothing to restore.
  },
};

migrations['0223_automation_sponsor_backfill'] = {
  // NULL also results from deleting a sponsor (ON DELETE SET NULL). Without
  // provenance it cannot authorize work under the project's creator.
  async up(): Promise<void> {},
  async down(): Promise<void> {},
};

migrations['0224_managed_dev_server_legacy_approver'] = {
  // Approvals given before 0221 recorded the approver were the administrator's,
  // the only person a project had. Recording that here lets the Server compare
  // an approval with the person starting the server, and never assume an
  // unrecorded approver is anyone in particular.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`update managed_dev_servers set approved_by_user_id = '00000000-0000-4000-8000-000000000001'
      where approved_by_user_id is null and approved_command is not null
        and exists (select 1 from users where id = '00000000-0000-4000-8000-000000000001')`.execute(
      db,
    );
  },
  async down(): Promise<void> {
    // Which approvers this filled in is not recorded; they stay.
  },
};

migrations['0225_team_outbox_exhaustion'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table team_outbox add column failed_at timestamptz`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table team_outbox drop column failed_at`.execute(db);
  },
};

migrations['0226_team_join_replay_device'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table team_join_admissions add column device_token_encrypted text,
      add column device_token_id text`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table team_join_admissions drop column device_token_encrypted,
      drop column device_token_id`.execute(db);
  },
};

migrations['0227_sandbox_update_state'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table sandbox_update_state (
      project_id text primary key references projects(id) on delete cascade,
      value jsonb not null
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table sandbox_update_state`.execute(db);
  },
};

migrations['0228_administrator_provider_accounts'] = {
  // The original administrator manages the original encrypted logins through
  // My AI accounts. Collapse any separately connected personal account into
  // that same refresh pipeline, without decrypting or exchanging credentials.
  async up(db: Kysely<unknown>): Promise<void> {
    const administrator = '00000000-0000-4000-8000-000000000001';
    for (const [provider, column] of [
      ['claude', 'claude_code_oauth_credentials_json'],
      ['codex', 'codex_auth_json'],
    ] as const) {
      await sql`insert into verity_settings (id, ${sql.ref(column)})
        select 'global', credential from user_provider_connections
        where user_id = ${administrator} and provider = ${provider}
        on conflict (id) do update set ${sql.ref(column)} = excluded.${sql.ref(column)}`.execute(
        db,
      );
    }
    await sql`insert into verity_settings (id, opencode_api_key, opencode_base_url, opencode_models)
      select 'global', credential, base_url, models from user_provider_connections
      where user_id = ${administrator} and provider = 'opencode'
      on conflict (id) do update set opencode_api_key = excluded.opencode_api_key,
        opencode_base_url = excluded.opencode_base_url, opencode_models = excluded.opencode_models,
        opencode_disabled_models = null`.execute(db);
    await sql`delete from user_provider_connections where user_id = ${administrator}`.execute(db);
  },
  async down(): Promise<void> {
    // Credentials stay with the original refresh pipeline on rollback.
  },
};

migrations['0229_session_coordination_requests'] = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table session_coordination_requests (
      source_session_id text not null references sessions(session_id) on delete cascade,
      request_id text not null,
      fingerprint text not null,
      target_session_id text not null,
      phase text not null default 'reserved' check (phase in ('reserved','created','linked','delivered')),
      result jsonb,
      primary key (source_session_id, request_id)
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table session_coordination_requests`.execute(db);
  },
};

migrations['0230_brokered_tool_approvals'] = brokeredToolApprovalMigration;

migrations['0231_assistant_handoffs'] = {
  // One row per session the assistant handed work to, so it can later read back that
  // session's published outcome summary — and only for sessions it briefed itself.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table assistant_handoffs (
      target_session_id text primary key references sessions(session_id) on delete cascade,
      assistant_session_id text not null,
      project_id text not null references projects(id) on delete cascade,
      user_id text,
      title text not null,
      handed_off_at timestamptz not null
    )`.execute(db);
    await sql`create index assistant_handoffs_recent
      on assistant_handoffs(user_id, handed_off_at desc)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table assistant_handoffs`.execute(db);
  },
};

migrations['0232_assistant_handoff_results'] = {
  // The result a handoff's target published, recorded once per publication so it is announced
  // exactly once and the conversation can show it on the handoff card.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table assistant_handoffs
      add column result_seq bigint,
      add column result_delivered boolean,
      add column result_summary text check (char_length(result_summary) <= 300),
      add column result_blocker text check (char_length(result_blocker) <= 300),
      add column result_at timestamptz`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table assistant_handoffs
      drop column result_seq, drop column result_delivered,
      drop column result_summary, drop column result_blocker, drop column result_at`.execute(db);
  },
};

migrations['0233_project_inquiry_human_approval'] = {
  // Inquiries are approved per request now; a standing grant only admits
  // questions without a card. The flag records that a person allowed this one
  // request, independent of whether the deciding user id is known. Changes that
  // were already decided under the previous flow keep their approval.
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`alter table project_inquiries
      add column human_approved boolean not null default false`.execute(db);
    await sql`update project_inquiries set human_approved = true
      where kind = 'change' and status in ('approved','queued','answered')`.execute(db);
    await sql`update project_inquiries set status = 'pending'
      where kind = 'change' and status = 'provisioning'`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table project_inquiries drop column human_approved`.execute(db);
  },
};

migrations['0234_project_qa'] = projectQAMigration;

migrations['0235_dependency_capacity_leases'] = capacityLeasesMigration;
