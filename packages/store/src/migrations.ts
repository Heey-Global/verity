import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';
import {
  backfillInlineAttachments,
  backfillToolResultImages,
  backfillToolResultText,
} from './store.js';

/**
 * In-code migrations (not file-based) so the exact same set runs under tests
 * (pglite) and production (pg) without dist/src file-path resolution friction.
 */
const migrations: Record<string, Migration> = {
  '0001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('sessions')
        .addColumn('session_id', 'text', (c) => c.primaryKey())
        .addColumn('worktree', 'text', (c) => c.notNull().unique())
        .addColumn('model', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable('events')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('session_id', 'text', (c) =>
          // `restrict`: the durable log can't be deleted out from under a
          // session — deleting a session with events is refused by the DB.
          c.notNull().references('sessions.session_id').onDelete('restrict'),
        )
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createIndex('events_session_id_id_idx')
        .on('events')
        .columns(['session_id', 'id'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('events').execute();
      await db.schema.dropTable('sessions').execute();
    },
  },

  '0002_transcript': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('transcript_lines')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('session_id', 'text', (c) =>
          // `restrict`: the verbatim transcript is durable — a session can't be
          // deleted out from under it (matches the events log, §5a).
          c.notNull().references('sessions.session_id').onDelete('restrict'),
        )
        .addColumn('line', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createIndex('transcript_lines_session_id_id_idx')
        .on('transcript_lines')
        .columns(['session_id', 'id'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('transcript_lines').execute();
    },
  },

  '0003_session_name': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Operator-assigned display name (§ session rename). Nullable: a session
      // has no name until the operator sets one at spawn or renames it later;
      // the UI falls back to the worktree/id. No UNIQUE constraint — two agents
      // may share a human label.
      await db.schema.alterTable('sessions').addColumn('name', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('sessions').dropColumn('name').execute();
    },
  },

  '0004_attachments': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Content-addressed image blobs (operator prompt attachments). Stored once,
      // keyed by SHA-256 of the bytes — so the same image sent twice dedupes, and
      // the hash is a stable, immutable cache key. The `prompt` event references
      // these by `id` (the hash) instead of inlining base64, so opening a session
      // never transfers the whole image backlog (images load lazily by id). Not
      // session-scoped (an image may be shared across sessions) and has no FK; a
      // future orphan-GC can prune unreferenced blobs.
      await db.schema
        .createTable('attachments')
        .addColumn('hash', 'text', (c) => c.primaryKey())
        .addColumn('media_type', 'text', (c) => c.notNull())
        .addColumn('bytes', 'bytea', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('attachments').execute();
    },
  },

  '0005_inline_attachments_to_refs': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Back-fill: pull inline base64 image attachments off existing prompt events
      // into the content-addressed blob table so they load lazily like new ones.
      await backfillInlineAttachments(db);
    },
    async down(): Promise<void> {
      // Irreversible data transform (the bytes remain in `attachments`; we don't
      // re-inline them). Dropping the table is handled by 0004's down.
    },
  },

  '0006_queued_turns': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Durable backlog of turns sent while a session was busy (issue #80). The
      // conductor mirrors its in-memory FIFO queue here so a queued turn survives a
      // server restart (recovered on startup). `id` is the client's retract handle;
      // `seq` is the per-session FIFO order. The `session_id` FK CASCADES on delete —
      // dropping a session takes its backlog with it (the queue is ephemeral runtime
      // state, not part of the durable event log, so cascade is correct here unlike
      // the `restrict` on events/transcript_lines).
      await db.schema
        .createTable('queued_turns')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('seq', 'bigserial', (c) => c.notNull().unique())
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('prompt', 'text', (c) => c.notNull())
        .addColumn('opts', 'jsonb', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      // Recovery + per-session listing read by (session_id, seq) — the FIFO order.
      await db.schema
        .createIndex('queued_turns_session_id_seq_idx')
        .on('queued_turns')
        .columns(['session_id', 'seq'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('queued_turns').execute();
    },
  },

  '0007_projects': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Multi-repo fleet registry (concept §19, #174). One row per GitHub repo the
      // App-installation lists + Verity has registered. **Cache** of the GitHub-
      // installation state + the Verity-side `verity-<owner>--<repo>` container
      // lifecycle (§10). `owner`/`repo` are lowercased on persist so the
      // `UNIQUE(owner, repo)` constraint behaves regardless of Postgres collation
      // (GitHub-owners/repos are case-insensitive; the mixed-case display name
      // stays recoverable from the GitHub repo API during `GET /projects` sync).
      // The CHECK constraint below is the DB-side backstop that refuses direct
      // writers (raw INSERT bypassing `upsertProject`, which lowercases) — the SQL
      // `lower(x) = x` predicate is only satisfied by already-lowercased input.
      await db.schema
        .createTable('projects')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('owner', 'text', (c) => c.notNull())
        .addColumn('repo', 'text', (c) => c.notNull())
        .addColumn('container_name', 'text', (c) => c.notNull().unique())
        .addColumn('image_ref', 'text')
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('provision_error', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      // Lowercase-persist guarantee (§19.0/§19.2). We add the CHECK via raw SQL
      // because kysely's CreateTableBuilder chain doesn't expose `.check()`
      // (it only offers `.check()` on `addColumn`'s column builder, which would
      // require attaching it to a specific column rather than the table). The
      // programmatic lowercase in `upsertProject` is the primary guard; this
      // CHECK is the DB-side backstop that rejects direct INSERTs bypassing the
      // API (a stray raw-INSERT writer, a buggy future migration) —
      // `lower(x) = x` is only true for already-lowercased input.
      await sql`alter table projects add constraint projects_lowercase_check
                check (lower(owner) = owner and lower(repo) = repo)`.execute(db);

      // ``(owner, repo)`` is the canonical lookup key (§19.0 + §19.2). Uniqueness
      // is the DB-side backstop against duplicate registration of the same repo
      // — the design's `INSERT … ON CONFLICT (owner, repo) DO UPDATE` upsert leans
      // on it.
      await db.schema
        .createIndex('projects_owner_repo_uniq')
        .on('projects')
        .columns(['owner', 'repo'])
        .unique()
        .execute();

      // Link sessions to their project. NULL is permitted: sessions created
      // before this slice landed have no project, and `(§19.1)` Verity-self as a
      // normal project means a session there will get a FK once `heey-global/
      // verity` has been registered — not at the moment a session is created.
      // ON DELETE SET NULL: dropping a project does NOT cascade-delete its
      // sessions — the durable log + worktree state survive and surface as
      // "no project" in the UI. (Mirrors `events`/`transcript_lines` `restrict`
      // spirit but permissive: the project cache row is recoverable from GitHub,
      // the session log is not.)
      await db.schema
        .alterTable('sessions')
        .addColumn('project_id', 'text', (c) => c.references('projects.id').onDelete('set null'))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('sessions').dropColumn('project_id').execute();
      await db.schema.dropTable('projects').execute();
    },
  },

  '0008_session_backend_state': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('session_backend_state')
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('backend', 'text', (c) => c.notNull())
        .addColumn('backend_session_id', 'text', (c) => c.notNull())
        .addColumn('context_seq', 'bigint', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('session_backend_state_pk', ['session_id', 'backend'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('session_backend_state').execute();
    },
  },

  '0009_project_settings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('project_settings')
        .addColumn('project_id', 'text', (c) =>
          c.primaryKey().references('projects.id').onDelete('cascade'),
        )
        .addColumn('doppler_token_ref', 'text')
        .addColumn('default_branch', 'text')
        .addColumn('default_model', 'text')
        .addColumn('dev_server_command', 'text')
        .addColumn('dev_server_url', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('project_settings').execute();
    },
  },

  '0010_project_runtime_ports': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('project_settings')
        .addColumn('dev_server_workdir', 'text')
        .execute();
      await db.schema
        .alterTable('project_settings')
        .addColumn('dev_server_host_port', 'text')
        .execute();
      await db.schema
        .alterTable('project_settings')
        .addColumn('dev_server_container_port', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('project_settings')
        .dropColumn('dev_server_container_port')
        .execute();
      await db.schema.alterTable('project_settings').dropColumn('dev_server_host_port').execute();
      await db.schema.alterTable('project_settings').dropColumn('dev_server_workdir').execute();
    },
  },

  '0011_verity_settings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('verity_settings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('git_user_name', 'text')
        .addColumn('git_user_email', 'text')
        .addColumn('git_ssh_private_key_path', 'text')
        .addColumn('git_ssh_public_key_path', 'text')
        .addColumn('git_known_hosts_path', 'text')
        .addColumn('git_allowed_signers_path', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('verity_settings').execute();
    },
  },

  '0012_db_backed_secrets': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('project_settings').addColumn('doppler_token', 'text').execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('git_ssh_private_key', 'text')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('git_ssh_public_key', 'text')
        .execute();
      await db.schema.alterTable('verity_settings').addColumn('git_known_hosts', 'text').execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('git_allowed_signers', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('git_allowed_signers').execute();
      await db.schema.alterTable('verity_settings').dropColumn('git_known_hosts').execute();
      await db.schema.alterTable('verity_settings').dropColumn('git_ssh_public_key').execute();
      await db.schema.alterTable('verity_settings').dropColumn('git_ssh_private_key').execute();
      await db.schema.alterTable('project_settings').dropColumn('doppler_token').execute();
    },
  },

  '0013_github_app_creds': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Move the GitHub App credential off the host `.pem` file into
      // app-configurable global settings (ADR 0002 D1). App ID + installation ID
      // are non-secret config; the private key is a secret and is encrypted at
      // rest by the store's SecretCipher before it lands in this column.
      await db.schema.alterTable('verity_settings').addColumn('github_app_id', 'text').execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('github_app_installation_id', 'text')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('github_app_private_key', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('github_app_private_key').execute();
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('github_app_installation_id')
        .execute();
      await db.schema.alterTable('verity_settings').dropColumn('github_app_id').execute();
    },
  },

  '0014_secret_key_meta': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Master-password key-derivation metadata (singleton). Non-secret: the
      // scrypt salt + a verifier (fixed marker encrypted under the derived key).
      // Separate table so it stays readable while the store is SEALED — the raw
      // key is never persisted, only derived in memory on unlock.
      await db.schema
        .createTable('secret_key_meta')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('salt', 'text', (c) => c.notNull())
        .addColumn('verifier', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_key_meta').execute();
    },
  },

  '0015_project_hidden': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Soft-delete marker for projects (#174 follow-up). NULL = visible; a
      // timestamp = operator-hidden. Deleting a project in the UI sets this
      // instead of dropping the row, so the GitHub-installation sync (which
      // re-upserts every installation repo on each `GET /projects`) can no
      // longer resurrect a project the operator removed. `upsertProject`'s
      // ON CONFLICT branch deliberately leaves `hidden_at` untouched, so a
      // re-sync keeps a hidden project hidden; only an explicit restore
      // (POST /projects) clears it.
      await db.schema.alterTable('projects').addColumn('hidden_at', 'timestamptz').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('hidden_at').execute();
    },
  },

  '0016_verity_doppler_service_token': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Account-level Doppler Service Account token (#320), stored globally like
      // the GitHub App private key. A secret: encrypted at rest by the store's
      // SecretCipher before it lands in this column. Later used to auto-mint
      // scoped per-project tokens (that minting is separate work). Unrelated to
      // the pre-existing per-project `project_settings.doppler_token`.
      await db.schema
        .alterTable('verity_settings')
        .addColumn('doppler_service_token', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('doppler_service_token').execute();
    },
  },

  '0017_project_doppler_binding': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Doppler auto-minting binding (#320, PR 1). `doppler_project` +
      // `doppler_config` are the operator-authorized binding stored on the
      // PROJECT (plaintext, non-secret config — they name a Doppler project +
      // config, they are not credentials). At provision time Verity mints a
      // scoped read-only per-project service token from the global account
      // token against this binding and caches the minted token in
      // `doppler_minted_token` — a SECRET, encrypted at rest by the store's
      // SecretCipher, mirroring the existing `doppler_token` column. The minted
      // token (not the account token) is what reaches the container as
      // DOPPLER_TOKEN. Single config this PR; multi-config token map is a
      // deferred follow-up.
      await db.schema.alterTable('project_settings').addColumn('doppler_project', 'text').execute();
      await db.schema.alterTable('project_settings').addColumn('doppler_config', 'text').execute();
      await db.schema
        .alterTable('project_settings')
        .addColumn('doppler_minted_token', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('project_settings').dropColumn('doppler_minted_token').execute();
      await db.schema.alterTable('project_settings').dropColumn('doppler_config').execute();
      await db.schema.alterTable('project_settings').dropColumn('doppler_project').execute();
    },
  },

  '0018_tool_result_images_to_refs': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Back-fill: pull inline base64 images off existing tool_result events into the
      // content-addressed blob table (#115) so they load lazily like new ones — a
      // session with tool-returned images no longer transfers its whole image
      // backlog on open. Reuses the `attachments` table from 0004.
      await backfillToolResultImages(db);
    },
    async down(): Promise<void> {
      // Irreversible data transform (the bytes remain in `attachments`; we don't
      // re-inline them). Dropping the table is handled by 0004's down.
    },
  },

  '0019_tool_result_text_to_refs': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Back-fill: move large inline TEXT outputs off existing tool_result events
      // into the content-addressed blob table, keeping only a truncated preview +
      // an outputRef — so a session with big tool outputs (large file Reads, long
      // command output, diffs) no longer transfers its whole text backlog on open.
      // Runs after 0018 so the stored full body already references images by id.
      await backfillToolResultText(db);
    },
    async down(): Promise<void> {
      // Irreversible data transform (the full bodies remain in `attachments`; we
      // don't re-inline them). Dropping the table is handled by 0004's down.
    },
  },

  // Renumbered from 0018 to 0020 on rebase onto main: main already shipped 0018/0019
  // (tool_result → refs). Migrations already merged must never change number, so this
  // doppler follow-up takes the next free slot and runs last.
  '0020_project_doppler_minted_token_slug': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Doppler token-sprawl revoke (#320 follow-up). Doppler's config-token API
      // returns a `slug` alongside the minted token — the token's stable
      // identifier, needed to DELETE it later. We persist the slug of the cached
      // `doppler_minted_token` so that when the operator rebinds the project's
      // Doppler project/config, Verity can best-effort revoke the superseded
      // token instead of orphaning it in Doppler forever. PLAINTEXT: the slug is
      // an identifier, not a credential — it names which token to revoke, it
      // does not grant access.
      await db.schema
        .alterTable('project_settings')
        .addColumn('doppler_minted_token_slug', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('project_settings')
        .dropColumn('doppler_minted_token_slug')
        .execute();
    },
  },

  '0021_session_pending_note': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Server-authored context the agent must see on its NEXT turn without a
      // visible chat message or a wasted standalone turn (post-merge worktree
      // reset). The conductor prepends these to the model prompt and deletes them
      // (consume-once); they never become `prompt` events. The `session_id` FK
      // CASCADES — like `queued_turns`, this is ephemeral runtime context, not part
      // of the durable event log (contrast the `restrict` on events/transcript).
      await db.schema
        .createTable('session_pending_note')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('note', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      // Consumed per session in insert order.
      await db.schema
        .createIndex('session_pending_note_session_id_id_idx')
        .on('session_pending_note')
        .columns(['session_id', 'id'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('session_pending_note').execute();
    },
  },

  '0022_project_release_status': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Display-cache of the repo's latest GitHub release (project-overview version
      // badge). Persisted so the version survives a restart and is served from the
      // DB on a cold in-memory cache — the live freshness/TTL is owned by the
      // in-memory GitHubReleaseService, so no fetched-at column is needed here.
      // `published_at` is stored as TEXT (GitHub's ISO string, display-only: never
      // queried or sorted on). All nullable: absent until a lookup resolves, and
      // for a repo that publishes no releases.
      await db.schema.alterTable('projects').addColumn('latest_release_tag', 'text').execute();
      await db.schema.alterTable('projects').addColumn('latest_release_name', 'text').execute();
      await db.schema.alterTable('projects').addColumn('latest_release_url', 'text').execute();
      await db.schema
        .alterTable('projects')
        .addColumn('latest_release_published_at', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('latest_release_published_at').execute();
      await db.schema.alterTable('projects').dropColumn('latest_release_url').execute();
      await db.schema.alterTable('projects').dropColumn('latest_release_name').execute();
      await db.schema.alterTable('projects').dropColumn('latest_release_tag').execute();
    },
  },

  '0023_session_automation_marker': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Durable de-dupe for server-authored automatic turns (e.g. one CI-failure
      // repair prompt per PR head). CASCADES with the session because these markers
      // are runtime automation state, not part of the durable transcript.
      await db.schema
        .createTable('session_automation_marker')
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('marker', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('session_automation_marker_pk', ['session_id', 'marker'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('session_automation_marker').execute();
    },
  },

  '0024_project_provision_warning': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Non-fatal provisioning diagnostics surfaced to operators while a project
      // remains usable. Example: a devcontainer explicitly asks to run as root.
      await db.schema.alterTable('projects').addColumn('provision_warning', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('provision_warning').execute();
    },
  },

  '0025_sandbox_auto_update_settings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .addColumn('sandbox_auto_update_security', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('sandbox_auto_update_normal', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('sandbox_auto_update_normal')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('sandbox_auto_update_security')
        .execute();
    },
  },

  '0026_auth_tokens': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Per-device API bearer tokens (C1 auth gate). A token is minted when a
      // device proves the master password via /secret/init | /secret/unlock; the
      // raw token is returned once and never stored — only its SHA-256 hash lands
      // here, so a DB read yields no usable credential. Deliberately NOT a secret
      // column (no cipher envelope): the auth gate must validate tokens while the
      // store is still SEALED, exactly like secret_key_meta. `id` is an opaque
      // public handle for listing/revoking a device without exposing the token.
      await db.schema
        .createTable('auth_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('token_hash', 'text', (c) => c.notNull().unique())
        .addColumn('label', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('last_seen_at', 'timestamptz')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('auth_tokens').execute();
    },
  },

  '0027_backend_subscription_creds': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Subscription-login credentials for Codex. Encrypted at rest by the
      // store's SecretCipher and stored globally like the GitHub App key /
      // Doppler token.
      await db.schema.alterTable('verity_settings').addColumn('codex_auth_json', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('codex_auth_json').execute();
    },
  },

  '0028_project_archived_flag': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Cached GitHub archive state for installation repositories. Existing rows
      // default to false until the next installation sync refreshes them.
      await db.schema
        .alterTable('projects')
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('archived').execute();
    },
  },

  '0029_claude_oauth_credentials_json': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Full Claude Code OAuth credential state from `~/.claude/.credentials.json`.
      // Store the refreshable credential bundle encrypted so the server can
      // refresh access tokens for usage probes without host volumes.
      await db.schema
        .alterTable('verity_settings')
        .addColumn('claude_code_oauth_credentials_json', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('claude_code_oauth_credentials_json')
        .execute();
    },
  },

  '0030_remove_claude_token_column': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`alter table verity_settings drop column if exists claude_code_oauth_token`.execute(
        db,
      );
    },
    async down(): Promise<void> {
      // Breaking change: Claude auth is stored only as credentials JSON.
    },
  },

  '0031_project_sort_order': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Operator-defined project order for the overview. NULL means a project has
      // not been manually ordered yet; listProjects keeps those rows after the
      // explicitly ordered block using the existing stable created_at/id tie-break.
      await db.schema.alterTable('projects').addColumn('sort_order', 'integer').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('sort_order').execute();
    },
  },

  '0032_gh_token_capabilities': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Persist the GitHub-token-broker capability registry (was in-memory) so it
      // survives a server restart/redeploy — otherwise every existing sandbox's
      // capability is silently invalidated on restart → 401 on `git push`. One row
      // per project; only the SHA-256 hash of the capability is stored, never the
      // raw secret. cap_hash is UNIQUE (the redeem path looks a capability up by
      // its hash); project_id is the PK (re-issue upserts, deprovision deletes).
      await db.schema
        .createTable('gh_token_capabilities')
        .addColumn('project_id', 'text', (c) => c.primaryKey())
        .addColumn('cap_hash', 'text', (c) => c.notNull().unique())
        .addColumn('owner', 'text', (c) => c.notNull())
        .addColumn('repo', 'text', (c) => c.notNull())
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('gh_token_capabilities').execute();
    },
  },
  // This feature branch originally used a 0033 name before main advanced through
  // 0037. Keep the release migration after main's published history: Kysely
  // rejects migrations inserted alphabetically before already-executed entries.
  '0038_agent_loops': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Session discriminator (ADR 0008 §1): mark a session as the durable runtime
      // of an Agent Loop so the list UI can pin/label it without a join back
      // through `agent_loops.session_id`. notNull default `'normal'`, so existing
      // sessions read back as ordinary runs.
      await db.schema
        .alterTable('sessions')
        .addColumn('kind', 'text', (c) => c.notNull().defaultTo('normal'))
        .execute();

      // Recurring automations ("der Loop", ADR 0008): a project-scoped
      // `{ script, schedule }` bound to one durable agent session. Both tables
      // CASCADE with the project/loop — this is runtime automation config +
      // history, not part of the durable event log. No column holds a credential,
      // so nothing here is encrypted. `schedule_config` is jsonb (structured
      // schedule, never a raw cron string). A loop starts as `status:'draft'` with
      // no schedule/script yet, so those columns are nullable.
      await db.schema
        .createTable('agent_loops')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
        .addColumn('schedule_kind', 'text')
        .addColumn('schedule_config', 'jsonb')
        .addColumn('script', 'text')
        .addColumn('reaction_prompt', 'text')
        .addColumn('reaction_model', 'text')
        .addColumn('session_id', 'text', (c) =>
          c.references('sessions.session_id').onDelete('set null'),
        )
        .addColumn('tested_script_fingerprint', 'text')
        .addColumn('consecutive_error_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('last_run_at', 'timestamptz')
        .addColumn('last_outcome', 'text')
        .addColumn('next_run_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      // The scheduler's hot path: pick the minimum next_run_at across enabled,
      // scheduled loops. Index (status, next_run_at) serves that scan.
      await db.schema
        .createIndex('agent_loops_status_next_run_at_idx')
        .on('agent_loops')
        .columns(['status', 'next_run_at'])
        .execute();

      // Per-project loop listing.
      await db.schema
        .createIndex('agent_loops_project_id_idx')
        .on('agent_loops')
        .column('project_id')
        .execute();

      // Append-only run history, one row per scheduler pass that touched a loop.
      await db.schema
        .createTable('agent_loop_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        // Monotonic insert order: the reliable newest-first tiebreak when several
        // runs share a `started_at` millisecond (a random UUID id would not).
        .addColumn('seq', 'bigserial', (c) => c.notNull())
        .addColumn('loop_id', 'text', (c) =>
          c.notNull().references('agent_loops.id').onDelete('cascade'),
        )
        .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('finished_at', 'timestamptz')
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('exit_code', 'integer')
        .addColumn('detail', 'text')
        .addColumn('session_id', 'text')
        .addColumn('is_test', 'boolean', (c) => c.notNull().defaultTo(false))
        .execute();

      // Run history is read newest-first per loop, ordered by insertion seq.
      await db.schema
        .createIndex('agent_loop_runs_loop_id_seq_idx')
        .on('agent_loop_runs')
        .columns(['loop_id', 'seq'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('agent_loop_runs').execute();
      await db.schema.dropTable('agent_loops').execute();
      await db.schema.alterTable('sessions').dropColumn('kind').execute();
    },
  },

  '0033_running_turns': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Durable "a turn is in flight for this session" marker (lifecycle Phase 1,
      // the keystone). Written before a turn launches, cleared on its terminal
      // event. On restart, a session that STILL has a marker had its turn abandoned
      // by the crash — so recovery can settle it (append `interrupted`) instead of
      // INFERRING un-run work from the event tail, which double-ran steered prompts
      // and silently dropped mid-turn crashes. One row per session (only one turn
      // runs at a time), so session_id is the PK. FK CASCADES like queued_turns —
      // ephemeral runtime state, not part of the durable event log. prompt_seq is
      // the seq of the prompt event this turn is executing (recovery/reattach anchor).
      await db.schema
        .createTable('running_turns')
        .addColumn('session_id', 'text', (c) =>
          c.primaryKey().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('prompt_seq', 'bigint', (c) => c.notNull())
        .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('running_turns').execute();
    },
  },
  '0034_runner_frames': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Idempotency ledger for the restart-safe Runner event transport (ADR 0006
      // D3/D4). One row per Runner frame; `(turn_id, frame_seq)` is the primary key,
      // so the Server's ingest transaction CLAIMS the next contiguous frame here
      // atomically with persisting its `events` row. After a crash the append-only
      // frame file is re-tailed from byte zero and an already-claimed frame is a
      // no-op — replay is safe because ingestion is idempotent. `runner_instance_id`
      // binds immutably to the turn and `payload_hash` guards a reused sequence
      // carrying a changed payload; either mismatch is corruption, not a duplicate.
      // `event_id` records the persisted `events.id` for event frames (null for
      // session/permission/result frames) so a post-commit-pre-publish crash can
      // re-publish the right seq on replay. NOT part of the durable event log — pure
      // runtime dedup state — so no session FK cascade wiring is attached here.
      //
      // FOLLOW-UP: this ledger is append-only and unpruned in this slice. A retention
      // path (prune a turn's rows once it has terminally settled, or by age) lands with
      // the reattach/terminal-frame slice that knows when a turn is safe to forget. The
      // transport is opt-in (`VERITY_RUNNER_TRANSPORT`) and not a default path until then.
      await db.schema
        .createTable('runner_frames')
        .addColumn('turn_id', 'text', (c) => c.notNull())
        .addColumn('frame_seq', 'bigint', (c) => c.notNull())
        .addColumn('runner_instance_id', 'text', (c) => c.notNull())
        .addColumn('session_id', 'text', (c) => c.notNull())
        .addColumn('payload_hash', 'text', (c) => c.notNull())
        .addColumn('event_id', 'bigint')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('runner_frames_pkey', ['turn_id', 'frame_seq'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('runner_frames').execute();
    },
  },
  '0035_project_settings_memory': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Per-project agent memory (ADR 0008). Free-text notes injected into each
      // session's runtime system prompt at context init: the agent appends via the
      // memory broker (POST /internal/project/memory) and the operator curates the
      // text in Project Settings. PLAINTEXT — operator-visible content, not a
      // credential, so it is never encrypted (contrast the `doppler_*` secret
      // columns on this table). Existing rows backfill as NULL and inject nothing.
      await db.schema.alterTable('project_settings').addColumn('memory', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('project_settings').dropColumn('memory').execute();
    },
  },

  '0036_device_push_tokens': {
    async up(db: Kysely<unknown>): Promise<void> {
      // One current Expo token per paired device. `auth_tokens.id` is the
      // existing opaque device handle; revoking a pairing removes its push
      // binding automatically. Phase 1 is deliberately iOS-only.
      await db.schema
        .createTable('device_push_tokens')
        .addColumn('auth_token_id', 'text', (c) =>
          c.primaryKey().references('auth_tokens.id').onDelete('cascade'),
        )
        .addColumn('expo_token', 'text', (c) => c.notNull().unique())
        .addColumn('platform', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addCheckConstraint('device_push_tokens_platform_check', sql`platform = 'ios'`)
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('device_push_tokens').execute();
    },
  },

  '0037_push_receipts': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Expo returns a ticket immediately and a delivery receipt later. Keep the
      // ticket→token mapping durable so restarts cannot lose
      // DeviceNotRegistered pruning. Token rotation/revocation drops stale work.
      await db.schema
        .createTable('push_receipts')
        .addColumn('receipt_id', 'text', (c) => c.primaryKey())
        .addColumn('expo_token', 'text', (c) =>
          c.notNull().references('device_push_tokens.expo_token').onDelete('cascade'),
        )
        .addColumn('available_at', 'timestamptz', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createIndex('push_receipts_available_at_idx')
        .on('push_receipts')
        .column('available_at')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('push_receipts').execute();
    },
  },
  '0038_running_turns_turn_identity': {
    async up(db: Kysely<unknown>): Promise<void> {
      // ADR 0006 Stage 4 (remote attach): the in-flight marker gains the turn's
      // durable identity so recovery can DISCOVER the turn on the Sandbox
      // supervisor and re-issue an idempotent StartTurn, instead of only settling
      // it from the event tail. The Server allocates `turn_id` + `start_command_id`
      // before launch (D2) and binds them onto the already-written marker row
      // before calling the Runner; a re-anchored marker (resume-retry) resets them
      // to NULL until the fresh attempt rebinds. Both are nullable: the loopback
      // path never sets them, and an old row from before this migration reads NULL.
      await db.schema
        .alterTable('running_turns')
        .addColumn('turn_id', 'text')
        .addColumn('start_command_id', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('running_turns')
        .dropColumn('turn_id')
        .dropColumn('start_command_id')
        .execute();
    },
  },

  '0039_dev_servers': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Multi-dev-server data model (slice 1): one-or-more named preview processes
      // per project, each with its own command/url/workdir/ports. This table becomes
      // the source of truth; the legacy singular `project_settings.dev_server_*`
      // columns stay as a derived view of a project's FIRST row (store.ts). CASCADEs
      // with the project — runtime config, not the durable event log; no credential
      // lives here, so nothing is encrypted.
      await db.schema
        .createTable('dev_servers')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull().defaultTo('Dev server'))
        .addColumn('command', 'text')
        .addColumn('url', 'text')
        .addColumn('workdir', 'text')
        .addColumn('host_port', 'text')
        .addColumn('container_port', 'text')
        .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();

      // Per-project listing + the "first dev server" lookup that backs the legacy
      // settings view.
      await db.schema
        .createIndex('dev_servers_project_id_sort_order_idx')
        .on('dev_servers')
        .columns(['project_id', 'sort_order'])
        .execute();

      // Backfill every legacy configuration, including URL-/port-only setups.
      await sql`
        INSERT INTO dev_servers
          (id, project_id, name, command, url, workdir, host_port, container_port, sort_order, created_at, updated_at)
        SELECT gen_random_uuid(), project_id, 'Dev server', dev_server_command, dev_server_url,
               dev_server_workdir, dev_server_host_port, dev_server_container_port, 0, now(), now()
        FROM project_settings
        WHERE NULLIF(btrim(dev_server_command), '') IS NOT NULL
           OR NULLIF(btrim(dev_server_url), '') IS NOT NULL
           OR NULLIF(btrim(dev_server_workdir), '') IS NOT NULL
           OR NULLIF(btrim(dev_server_host_port), '') IS NOT NULL
           OR NULLIF(btrim(dev_server_container_port), '') IS NOT NULL
      `.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      // Preserve the current source-of-truth value for rollback. A downgraded
      // server reads the legacy columns again, so copy each project's first row
      // back before dropping the collection.
      await sql`
        UPDATE project_settings AS ps
        SET dev_server_command = NULL,
            dev_server_url = NULL,
            dev_server_workdir = NULL,
            dev_server_host_port = NULL,
            dev_server_container_port = NULL,
            updated_at = now()
        WHERE NOT EXISTS (
          SELECT 1 FROM dev_servers WHERE project_id = ps.project_id
        )
      `.execute(db);
      await sql`
        WITH first AS (
          SELECT DISTINCT ON (project_id)
                 project_id, command, url, workdir, host_port, container_port
          FROM dev_servers
          ORDER BY project_id, sort_order ASC, created_at ASC, id ASC
        )
        UPDATE project_settings AS ps
        SET dev_server_command = first.command,
            dev_server_url = first.url,
            dev_server_workdir = first.workdir,
            dev_server_host_port = first.host_port,
            dev_server_container_port = first.container_port,
            updated_at = now()
        FROM first
        WHERE first.project_id = ps.project_id
      `.execute(db);
      await db.schema.dropTable('dev_servers').execute();
    },
  },

  '0040_dev_server_host_port_registry': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`
        WITH duplicates AS (
          SELECT id, row_number() OVER (
            PARTITION BY host_port ORDER BY created_at ASC, id ASC
          ) AS occurrence
          FROM dev_servers WHERE host_port IS NOT NULL
        )
        UPDATE dev_servers AS server
        SET host_port = NULL, updated_at = now()
        FROM duplicates
        WHERE duplicates.id = server.id AND duplicates.occurrence > 1
      `.execute(db);
      await db.schema
        .createIndex('dev_servers_host_port_unique_idx')
        .unique()
        .on('dev_servers')
        .column('host_port')
        .where('host_port', 'is not', null)
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('dev_servers_host_port_unique_idx').execute();
    },
  },

  '0041_drop_legacy_dev_server_settings': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('project_settings')
        .dropColumn('dev_server_command')
        .dropColumn('dev_server_url')
        .dropColumn('dev_server_workdir')
        .dropColumn('dev_server_host_port')
        .dropColumn('dev_server_container_port')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('project_settings')
        .addColumn('dev_server_command', 'text')
        .addColumn('dev_server_url', 'text')
        .addColumn('dev_server_workdir', 'text')
        .addColumn('dev_server_host_port', 'text')
        .addColumn('dev_server_container_port', 'text')
        .execute();
      await sql`
        WITH first AS (
          SELECT DISTINCT ON (project_id)
            project_id, command, url, workdir, host_port, container_port
          FROM dev_servers
          ORDER BY project_id, sort_order ASC, created_at ASC, id ASC
        )
        UPDATE project_settings AS settings
        SET dev_server_command = first.command,
            dev_server_url = first.url,
            dev_server_workdir = first.workdir,
            dev_server_host_port = first.host_port,
            dev_server_container_port = first.container_port,
            updated_at = now()
        FROM first
        WHERE first.project_id = settings.project_id
      `.execute(db);
    },
  },

  '0042_dev_server_detection_identity': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('dev_servers').addColumn('source_key', 'text').execute();
      await db.schema
        .createIndex('dev_servers_project_source_key_unique_idx')
        .unique()
        .on('dev_servers')
        .columns(['project_id', 'source_key'])
        .where('source_key', 'is not', null)
        .execute();
      await db.schema
        .createTable('dev_server_detection_state')
        .addColumn('project_id', 'text', (column) =>
          column.primaryKey().references('projects.id').onDelete('cascade'),
        )
        .addColumn('fingerprint', 'text', (column) => column.notNull())
        .addColumn('detected_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn('reviewed_fingerprint', 'text')
        .addColumn('reviewed_at', 'timestamptz')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('dev_server_detection_state').execute();
      await db.schema.dropIndex('dev_servers_project_source_key_unique_idx').execute();
      await db.schema.alterTable('dev_servers').dropColumn('source_key').execute();
    },
  },

  '0043_project_collapsed': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Operator's overview fold state for a project group, persisted so the
      // expand/collapse choice syncs across every device hitting this server
      // (there is no per-device/per-operator scoping — the row is global). NOT
      // NULL defaulting to false: a freshly registered project starts expanded.
      await db.schema
        .alterTable('projects')
        .addColumn('collapsed', 'boolean', (column) => column.notNull().defaultTo(false))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('collapsed').execute();
    },
  },
  '0044_claude_egress_identity': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Persist the Verity-owned Claude-egress TLS identity (ADR 0006 D10) so it
      // survives restarts/redeploys instead of being regenerated per provision
      // (ADR 0002: no container-create-time secrets; materialize at runtime from
      // the encrypted DB). The private keys (ca_key_pem, gateway_key_pem, key_pem)
      // are encrypted at rest by the store's SecretCipher BEFORE they reach these
      // columns; the certs + fingerprint are non-secret public material. The CA is
      // a singleton (id='global'); client certs are one row per project and CASCADE
      // with the project on deprovision.
      await db.schema
        .createTable('claude_egress_ca')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('ca_cert_pem', 'text', (c) => c.notNull())
        .addColumn('ca_key_pem', 'text', (c) => c.notNull())
        .addColumn('gateway_server_name', 'text', (c) => c.notNull())
        .addColumn('gateway_cert_pem', 'text', (c) => c.notNull())
        .addColumn('gateway_key_pem', 'text', (c) => c.notNull())
        .addColumn('ca_expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('gateway_expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('claude_egress_client_certs')
        .addColumn('project_id', 'text', (c) =>
          c.primaryKey().references('projects.id').onDelete('cascade'),
        )
        .addColumn('cert_pem', 'text', (c) => c.notNull())
        .addColumn('key_pem', 'text', (c) => c.notNull())
        .addColumn('fingerprint256', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('claude_egress_client_certs').execute();
      await db.schema.dropTable('claude_egress_ca').execute();
    },
  },

  '0045_verity_google_drive_connection': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Google Drive connection for importing reference docs (ADR 0009). The iOS
      // OAuth client id is non-secret config (it ships in the app); the connected
      // account email is non-secret display metadata; the refresh token is a
      // secret, encrypted at rest by the store's SecretCipher before it lands in
      // this column. Modeled as singleton columns like the GitHub App credential —
      // a dedicated per-account table would replace these when multi-account
      // support lands (out of scope for the MVP).
      await db.schema
        .alterTable('verity_settings')
        .addColumn('google_drive_client_id', 'text')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('google_drive_account_email', 'text')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('google_drive_refresh_token', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('google_drive_refresh_token')
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('google_drive_account_email')
        .execute();
      await db.schema.alterTable('verity_settings').dropColumn('google_drive_client_id').execute();
    },
  },
  '0046_project_setup_status': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('projects')
        .addColumn('setup_status', 'text', (column) => column.notNull().defaultTo('complete'))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('setup_status').execute();
    },
  },
  '0047_project_overview_visible': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('projects')
        .addColumn('overview_visible', 'boolean', (column) => column.notNull().defaultTo(false))
        .execute();

      // Existing servers predate this marker. Keep rows in the overview if they
      // were already actual Verity projects: currently running/failed projects,
      // projects with sessions, or projects with local settings. Plain GitHub
      // installation-cache rows remain picker-only.
      await sql`
        update projects p
        set overview_visible = true
        where p.state <> 'absent'
           or exists (select 1 from sessions s where s.project_id = p.id)
           or exists (select 1 from project_settings ps where ps.project_id = p.id)
      `.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('overview_visible').execute();
    },
  },
  '0048_session_last_seen_event_count': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Operator's per-session "last seen" mark for the overview unread dot: the
      // session's monotonic event count at the last open. Persisted server-side so
      // clearing an unread dot on one device clears it on every device (there is no
      // per-device/per-operator scoping — the mark is global). NULLABLE with no
      // default: NULL means "never opened", which reads as NOT unread (matches the
      // prior per-device behaviour and keeps a fresh session from lighting up).
      await db.schema
        .alterTable('sessions')
        .addColumn('last_seen_event_count', 'integer')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('sessions').dropColumn('last_seen_event_count').execute();
    },
  },
  '0049_verity_control_project': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('projects')
        .addColumn('kind', 'text', (column) => column.notNull().defaultTo('github'))
        .execute();
      await db.schema
        .alterTable('verity_settings')
        .addColumn('advanced_mode_enabled', 'boolean', (column) =>
          column.notNull().defaultTo(false),
        )
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('advanced_mode_enabled').execute();
      await db.schema.alterTable('projects').dropColumn('kind').execute();
    },
  },

  '0050_secret_run_grants': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_run_grants')
        .addColumn('capability_hash', 'text', (column) => column.primaryKey())
        .addColumn('grant_id', 'text', (column) => column.notNull().unique())
        .addColumn('claims_json', 'text', (column) => column.notNull())
        .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
        .addColumn('consumed_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createIndex('secret_run_grants_expiry_idx')
        .on('secret_run_grants')
        .column('expires_at')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_run_grants').execute();
    },
  },
  '0051_secret_approvals': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_approvals')
        .addColumn('id', 'text', (column) => column.primaryKey())
        .addColumn('project_id', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text', (column) => column.notNull())
        .addColumn('tool_call_id', 'text', (column) => column.notNull())
        .addColumn('claims_json', 'text', (column) => column.notNull())
        .addColumn('state', 'text', (column) => column.notNull())
        .addColumn('actor_id', 'text')
        .addColumn('authorization_hash', 'text')
        .addColumn('decision_hash', 'text')
        .addColumn('decided_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          'secret_approvals_state_check',
          sql`state in ('pending', 'approved', 'denied', 'issue_reserved')`,
        )
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_approvals').execute();
    },
  },
  '0052_secret_revocations': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_revocations')
        .addColumn('id', 'bigserial', (column) => column.primaryKey())
        .addColumn('project_id', 'text', (column) => column.notNull())
        .addColumn('subject_kind', 'text', (column) => column.notNull())
        .addColumn('subject_id', 'text', (column) => column.notNull())
        .addColumn('subject_version', 'integer', (column) => column.notNull())
        .addColumn('reason', 'text', (column) => column.notNull())
        .addColumn('revoked_at', 'timestamptz', (column) => column.notNull())
        .addCheckConstraint(
          'secret_revocations_kind_check',
          sql`subject_kind in ('project', 'profile', 'alias', 'provider_binding')`,
        )
        .addCheckConstraint(
          'secret_revocations_subject_check',
          sql`(subject_kind = 'project' and subject_id = project_id and subject_version = 0)
            or (subject_kind <> 'project' and subject_version > 0)`,
        )
        .addUniqueConstraint('secret_revocations_subject_unique', [
          'project_id',
          'subject_kind',
          'subject_id',
          'subject_version',
        ])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_revocations').execute();
    },
  },
  '0053_runner_frame_terminal': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('runner_frames')
        .addColumn('terminal', 'boolean', (column) => column.notNull().defaultTo(false))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('runner_frames').dropColumn('terminal').execute();
    },
  },
  '0054_secret_audit_events': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_audit_events')
        .addColumn('project_id', 'text', (column) => column.notNull())
        .addColumn('sequence', 'integer', (column) => column.notNull())
        .addColumn('kind', 'text', (column) => column.notNull())
        .addColumn('request_hash', 'text', (column) => column.notNull())
        .addColumn('grant_id', 'text')
        .addColumn('job_id', 'text')
        .addColumn('approval_id', 'text')
        .addColumn('event_json', 'text', (column) => column.notNull())
        .addColumn('prev_hash', 'text', (column) => column.notNull())
        .addColumn('event_hash', 'text', (column) => column.notNull())
        .addColumn('recorded_at', 'timestamptz', (column) => column.notNull())
        // (project_id, sequence) is the per-project chain position: append-only, contiguous from 0.
        .addPrimaryKeyConstraint('secret_audit_events_pkey', ['project_id', 'sequence'])
        // event_hash is globally unique — a duplicated chain node cannot be silently inserted.
        .addUniqueConstraint('secret_audit_events_hash_unique', ['event_hash'])
        .addCheckConstraint('secret_audit_events_sequence_check', sql`sequence >= 0`)
        .addCheckConstraint(
          'secret_audit_events_kind_check',
          sql`kind in (
            'approval_approved', 'approval_denied',
            'grant_issued', 'grant_redeemed', 'grant_redemption_refused',
            'job_succeeded', 'job_failed', 'job_cancelled',
            'cleanup_complete', 'cleanup_attention'
          )`,
        )
        .execute();
      // Provenance reads filter by project and often by a grant or job; index those hot paths.
      await db.schema
        .createIndex('secret_audit_events_grant_idx')
        .on('secret_audit_events')
        .columns(['project_id', 'grant_id'])
        .execute();
      await db.schema
        .createIndex('secret_audit_events_job_idx')
        .on('secret_audit_events')
        .columns(['project_id', 'job_id'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_audit_events').execute();
    },
  },
  '0055_dev_server_preview_session': {
    async up(db: Kysely<unknown>): Promise<void> {
      // A dev server normally serves the project's main checkout (/work). This
      // runtime override points it at one session's worktree instead, so the
      // operator can preview a session's branch before merging. It is a pointer,
      // not config: the server's `workdir` stays relative to whichever checkout
      // root is active. ON DELETE SET NULL resets the server to main when the
      // previewed session is deleted (its worktree is gone by then).
      await db.schema
        .alterTable('dev_servers')
        .addColumn('preview_session_id', 'text', (c) =>
          c.references('sessions.session_id').onDelete('set null'),
        )
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('dev_servers').dropColumn('preview_session_id').execute();
    },
  },
  '0056_gh_capability_container_generation': {
    async up(db: Kysely<unknown>): Promise<void> {
      // NULL preserves legacy TCP capabilities. Project-bound Unix listeners
      // require an exact, non-null container-generation match.
      await db.schema
        .alterTable('gh_token_capabilities')
        .addColumn('container_generation', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('gh_token_capabilities')
        .dropColumn('container_generation')
        .execute();
    },
  },
  '0057_dev_server_auto_start': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('dev_servers')
        .addColumn('auto_start', 'boolean', (column) => column.notNull().defaultTo(false))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('dev_servers').dropColumn('auto_start').execute();
    },
  },
  '0058_signing_capabilities': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('signing_capabilities')
        .addColumn('project_id', 'text', (column) =>
          column.primaryKey().references('projects.id').onDelete('cascade'),
        )
        .addColumn('cap_hash', 'text', (column) => column.notNull().unique())
        .addColumn('container_generation', 'text', (column) => column.notNull())
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('signing_capabilities').execute();
    },
  },
  '0059_session_initial_model': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Nullable keeps the additive migration forward-compatible with an older
      // server during a rolling upgrade. Readers fall back to `model` for those
      // legacy rows; new writers always persist the immutable creation choice.
      await db.schema.alterTable('sessions').addColumn('initial_model', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('sessions').dropColumn('initial_model').execute();
    },
  },
  '0060_message_search_projection': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('messages')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('first_event_seq', 'bigint', (c) => c.notNull())
        .addColumn('last_event_seq', 'bigint', (c) => c.notNull())
        .addColumn('finalized', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('projection_version', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addUniqueConstraint('messages_session_first_seq_unique', ['session_id', 'first_event_seq'])
        .execute();
      await db.schema
        .createIndex('messages_session_seq_idx')
        .on('messages')
        .columns(['session_id', 'first_event_seq'])
        .execute();
      await sql`create index messages_search_fts_idx on messages
                using gin (to_tsvector('simple', text)) where finalized = true`.execute(db);
      await db.schema
        .createTable('message_projection_state')
        .addColumn('session_id', 'text', (c) =>
          c.primaryKey().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('last_event_seq', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('projection_version', 'integer', (c) => c.notNull().defaultTo(1))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('message_projection_state').execute();
      await db.schema.dropTable('messages').execute();
    },
  },
  // Durable, job-scoped spool of ALREADY-REDACTED secret-job output frames (ADR 0009 D8 / W8): the
  // only permitted output path from the Secret Job Executor, written persist-before-publish. Rows
  // are redacted by construction; `payload` is additionally encrypted at rest as defense in depth.
  // The composite (job_id, sequence) primary key makes appends 0-based, contiguous, and idempotent
  // per job; `created_at` carries an index for the retention sweep. The W5 reaper deletes by job.
  '0061_secret_job_frames': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_job_frames')
        .addColumn('job_id', 'text', (c) => c.notNull())
        .addColumn('protocol_version', 'integer', (c) => c.notNull())
        // int4, not int8: node-postgres returns int8 as a string (pglite as a number), which would
        // break the `sequence` contiguity arithmetic and the numeric schema parse on real Postgres.
        // The per-job frame count is bounded far below the int4 ceiling. Mirrors secret_audit_events.
        .addColumn('sequence', 'integer', (c) => c.notNull())
        .addColumn('stream', 'text', (c) => c.notNull())
        .addColumn('encoding', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('byte_length', 'integer', (c) => c.notNull())
        .addColumn('emitted_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('secret_job_frames_pkey', ['job_id', 'sequence'])
        .execute();
      await db.schema
        .createIndex('secret_job_frames_created_at_idx')
        .on('secret_job_frames')
        .column('created_at')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_job_frames').execute();
    },
  },
  // Durable ownership/lifecycle index for authenticated Secret Job replay and restart recovery.
  '0062_secret_jobs': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_jobs')
        .addColumn('job_id', 'text', (c) => c.primaryKey())
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('authorization_hash', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('result_json', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createIndex('secret_jobs_updated_at_idx')
        .on('secret_jobs')
        .column('updated_at')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_jobs').execute();
    },
  },
  // Versioned server-owned Brokered Secrets catalog and encrypted provider credentials. Alias and
  // binding versions are immutable; state changes create a new version through the provisioning
  // service. Credential plaintext is encrypted by SecretCipher before reaching this table.
  '0063_secret_provider_catalog': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_provider_credentials')
        .addColumn('credential_ref', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('ciphertext', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('secret_provider_bindings')
        .addColumn('id', 'text', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('credential_ref', 'text', (c) =>
          c.notNull().references('secret_provider_credentials.credential_ref'),
        )
        .addColumn('doppler_project', 'text', (c) => c.notNull())
        .addColumn('doppler_config', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('secret_provider_bindings_pkey', ['project_id', 'id', 'version'])
        .execute();
      await db.schema
        .createTable('secret_aliases')
        .addColumn('id', 'text', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('binding_json', 'text', (c) => c.notNull())
        .addColumn('provider_key', 'text', (c) => c.notNull())
        .addColumn('injection_json', 'text', (c) => c.notNull())
        .addColumn('profile_json', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('secret_aliases_pkey', ['project_id', 'id', 'version'])
        .execute();
      await db.schema
        .createTable('secret_provider_permissions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('binding_id', 'text', (c) => c.notNull())
        .addColumn('binding_version', 'integer', (c) => c.notNull())
        .addColumn('secret_name', 'text', (c) => c.notNull())
        .addColumn('tool_id', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('session_id', 'text')
        .addColumn('expires_at', 'timestamptz')
        .addColumn('remaining_uses', 'integer')
        .addColumn('granted_by', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createIndex('secret_provider_bindings_project_idx')
        .on('secret_provider_bindings')
        .column('project_id')
        .execute();
      await db.schema
        .createIndex('secret_aliases_project_idx')
        .on('secret_aliases')
        .column('project_id')
        .execute();
      await db.schema
        .createIndex('secret_provider_permissions_lookup_idx')
        .on('secret_provider_permissions')
        .columns(['project_id', 'binding_id', 'binding_version', 'secret_name', 'tool_id', 'state'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_provider_permissions').execute();
      await db.schema.dropTable('secret_aliases').execute();
      await db.schema.dropTable('secret_provider_bindings').execute();
      await db.schema.dropTable('secret_provider_credentials').execute();
    },
  },
  // Server-owned execution profiles are immutable, project-scoped policy records. Repository
  // content and Secret Job callers may reference them but cannot define or replace them.
  '0064_secret_execution_profiles': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('secret_execution_profiles')
        .addColumn('id', 'text', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('profile_json', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('secret_execution_profiles_pkey', ['project_id', 'id', 'version'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('secret_execution_profiles').execute();
    },
  },
  // Keep the authenticated requester binding distinct from the later approval decision actor.
  '0065_secret_approval_requesters': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('secret_approvals')
        .addColumn('requester_authorization_hash', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('secret_approvals')
        .dropColumn('requester_authorization_hash')
        .execute();
    },
  },
  // At-most-once fence for approved brokered HTTP calls. It is committed before network I/O:
  // after an ambiguous crash Verity fails the replay rather than duplicate a mutation.
  '0066_brokered_http_consumptions': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('brokered_http_consumptions')
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('session_id', 'text', (c) =>
          c.notNull().references('sessions.session_id').onDelete('cascade'),
        )
        .addColumn('turn_id', 'text', (c) => c.notNull())
        .addColumn('call_id', 'text', (c) => c.notNull())
        .addColumn('request_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('brokered_http_consumptions_pkey', [
          'project_id',
          'session_id',
          'turn_id',
          'call_id',
        ])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('brokered_http_consumptions').execute();
    },
  },
  // One active brokered grant per project/binding/alias/target/scope. COALESCE
  // makes project-scoped NULL session ids participate in uniqueness.
  '0067_unique_brokered_http_grants': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY
                project_id,
                binding_id,
                secret_name,
                tool_id,
                scope,
                COALESCE(session_id, '')
              ORDER BY created_at DESC, id DESC
            ) AS duplicate_rank
          FROM secret_provider_permissions
          WHERE state = 'active' AND tool_id LIKE 'verity_http_request:%'
        )
        UPDATE secret_provider_permissions
        SET state = 'revoked', updated_at = now()
        WHERE id IN (SELECT id FROM ranked WHERE duplicate_rank > 1)
      `.execute(db);
      await sql`
        CREATE UNIQUE INDEX secret_provider_permissions_brokered_active_unique
        ON secret_provider_permissions (
          project_id,
          binding_id,
          secret_name,
          tool_id,
          scope,
          COALESCE(session_id, '')
        )
        WHERE state = 'active' AND tool_id LIKE 'verity_http_request:%'
      `.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('secret_provider_permissions_brokered_active_unique').execute();
    },
  },
  // Temporary public preview links are bound to one dev server and one exact
  // sandbox generation. Only one live lifecycle may own a dev server at once.
  '0068_public_preview_shares': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('public_preview_shares')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('dev_server_id', 'text', (c) =>
          c.notNull().references('dev_servers.id').onDelete('cascade'),
        )
        .addColumn('container_generation', 'text', (c) => c.notNull())
        .addColumn('target_port', 'integer', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('public_origin', 'text', (c) => c.notNull())
        .addColumn('edge_url', 'text', (c) => c.notNull())
        .addColumn('pin_hash_secret', 'text', (c) => c.notNull())
        .addColumn('connector_token_secret', 'text', (c) => c.notNull())
        .addColumn('session_secret', 'text', (c) => c.notNull())
        .addColumn('connector_container_name', 'text', (c) => c.notNull())
        .addColumn('connector_container_id', 'text')
        .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('revoked_at', 'timestamptz')
        .addColumn('failure', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await sql`
        CREATE UNIQUE INDEX public_preview_shares_one_live_per_dev_server
        ON public_preview_shares (dev_server_id)
        WHERE state IN ('creating', 'active', 'revoking')
      `.execute(db);
      await db.schema
        .createIndex('public_preview_shares_expiry_idx')
        .on('public_preview_shares')
        .columns(['state', 'expires_at'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('public_preview_shares').execute();
    },
  },

  '0069_projects_state_changed_at': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Additive: the stale-provisioning sweep needs an age that only the state
      // writer moves. `updated_at` is bumped by every writer — including the
      // installation sync, which explicitly preserves `state` — so a project
      // stuck in `cloning`/`container_starting` never looked old enough to
      // demote and stayed stranded mid-transition forever.
      await db.schema
        .alterTable('projects')
        .addColumn('state_changed_at', 'timestamptz', (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();
      // Backfill from `updated_at` rather than leaving every row at the
      // migration timestamp: for rows whose last write WAS a state write this is
      // exact, and for the rest it is the closest upper bound available. Either
      // way it beats resetting the fleet's clock, which would grant every
      // already-stranded row a fresh grace period.
      await sql`UPDATE projects SET state_changed_at = updated_at`.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('state_changed_at').execute();
    },
  },
  // `secret_provider_permissions` has two independent writers: the catalog authorization
  // path and the brokered-prompt grant store. 0067 told them apart by a `tool_id` prefix,
  // which is not provenance — a catalog `toolId` is `<profileId>@<version>:<policyHash>`
  // and `secretContractIdSchema` permits `:` inside `<profileId>`, so a profile id of
  // `verity_http_request:x` produces a row matching the prefix. That row would then be
  // listed as an operator grant, be revocable through the grant route, and — worst —
  // satisfy the auto-approval check for a brokered prompt. Record the issuer explicitly
  // and key everything the grant store does on that instead.
  '0070_brokered_grants_issuer': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('secret_provider_permissions')
        .addColumn('issuer', 'text')
        .execute();
      // Deliberately NOT backfilled. Rows written before this column existed cannot be
      // attributed: any test that would claim them ("granted_by = 'operator' and a
      // `verity_http_request:` tool_id") is the very heuristic whose ambiguity this
      // migration exists to remove, so a backfill could promote a catalog row into a
      // standing grant that auto-approves a prompt no operator ever answered. Pre-existing
      // rows therefore stay `issuer IS NULL`: invisible to the grant store, which means an
      // operator who had granted brokered HTTP access before this migration is asked once
      // more at the next request. Re-prompting is the fail-closed direction, and the only
      // one available without provenance that was never recorded.
      //
      // Those rows are left otherwise untouched rather than revoked: an ambiguous row may
      // just as well be a genuine catalog authorization, and revoking it would break a
      // catalog workflow on the same guesswork. Inert for this store is enough.
      // Re-key the uniqueness the grant store's `onConflict … doNothing()` relies on to the
      // issuer, so it covers this store's rows whatever tool they name — including
      // `verity_secret_run`, which standing grants answer as of this change — and no one
      // else's. No deduplication run is needed: nothing carries the issuer yet, so the new
      // predicate matches no existing row and the index cannot fail to build.
      await db.schema.dropIndex('secret_provider_permissions_brokered_active_unique').execute();
      await sql`
        CREATE UNIQUE INDEX secret_provider_permissions_brokered_active_unique
        ON secret_provider_permissions (
          project_id,
          binding_id,
          secret_name,
          tool_id,
          scope,
          COALESCE(session_id, '')
        )
        WHERE state = 'active' AND issuer = 'brokered-prompt'
      `.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      // The prefix predicate covers rows this one did not: an un-attributed pre-0070 row
      // and a grant issued after it can share a key while sitting in different indexes.
      // Deduplicate before rebuilding, or the rollback fails on a live database.
      await db.schema.dropIndex('secret_provider_permissions_brokered_active_unique').execute();
      await sql`
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY
                project_id,
                binding_id,
                secret_name,
                tool_id,
                scope,
                COALESCE(session_id, '')
              ORDER BY created_at DESC, id DESC
            ) AS duplicate_rank
          FROM secret_provider_permissions
          WHERE state = 'active' AND tool_id LIKE 'verity_http_request:%'
        )
        UPDATE secret_provider_permissions
        SET state = 'revoked', updated_at = now()
        WHERE id IN (SELECT id FROM ranked WHERE duplicate_rank > 1)
      `.execute(db);
      await sql`
        CREATE UNIQUE INDEX secret_provider_permissions_brokered_active_unique
        ON secret_provider_permissions (
          project_id,
          binding_id,
          secret_name,
          tool_id,
          scope,
          COALESCE(session_id, '')
        )
        WHERE state = 'active' AND tool_id LIKE 'verity_http_request:%'
      `.execute(db);
      await db.schema.alterTable('secret_provider_permissions').dropColumn('issuer').execute();
    },
  },
  '0071_project_image_override': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').addColumn('image_override_ref', 'text').execute();
      // Before this migration image_ref was used as both the requested override
      // and the observed runtime image. Preserve every non-null value as an
      // explicit override; subsequent provisions can then update image_ref
      // without changing the operator's configuration.
      await sql`UPDATE projects SET image_override_ref = image_ref WHERE image_ref IS NOT NULL`.execute(
        db,
      );
    },
    async down(db: Kysely<unknown>): Promise<void> {
      // Restore the configured value so rolling back does not turn the last
      // observed managed image into a permanent override.
      await sql`UPDATE projects SET image_ref = image_override_ref`.execute(db);
      await db.schema.alterTable('projects').dropColumn('image_override_ref').execute();
    },
  },
  '0072_project_clone_dir': {
    async up(db: Kysely<unknown>): Promise<void> {
      // NULL for every existing row, which keeps the derived `<owner>-<repo>`
      // clone path unchanged. Only projects created without a GitHub repo carry
      // an explicit directory name, so that linking one to GitHub later can
      // rewrite `(owner, repo)` without moving the clone out from under the
      // sessions whose worktree paths are persisted inside it.
      await db.schema.alterTable('projects').addColumn('clone_dir', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('clone_dir').execute();
    },
  },
  '0073_project_identity_claims': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('project_identity_claims')
        .addColumn('owner', 'text', (column) => column.notNull())
        .addColumn('repo', 'text', (column) => column.notNull())
        .addColumn('project_id', 'text', (column) => column.notNull())
        .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('project_identity_claims_pkey', ['owner', 'repo'])
        .execute();
      await sql`
        insert into project_identity_claims (owner, repo, project_id)
        select owner, repo, id from projects
      `.execute(db);
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('project_identity_claims').execute();
    },
  },

  '0074_verity_transcription_backend': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .addColumn('transcribe_base_url', 'text')
        .addColumn('transcribe_api_key', 'text')
        .addColumn('transcribe_model', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('transcribe_base_url')
        .dropColumn('transcribe_api_key')
        .dropColumn('transcribe_model')
        .execute();
    },
  },

  '0075_verity_transcription_backend_mode': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .addColumn('transcribe_backend_mode', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('verity_settings').dropColumn('transcribe_backend_mode').execute();
    },
  },
  // Records WHICH toolkit a project's provisioning verdict was made against.
  // Existing rows stay NULL rather than being backfilled from the current
  // server: their images were built against an unknown toolkit, and inventing a
  // value here would make every pre-existing project claim to be current.
  '0076_project_toolkit_identity': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').addColumn('toolkit_identity', 'text').execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('projects').dropColumn('toolkit_identity').execute();
    },
  },
  // ADR 0014 D3: when each standing brokered-secret grant was last approved, per
  // transport. The ACP channel only auto-approves a prompt while its OWN approval is
  // under 24 hours old, so the timestamp cannot live on the grant row — a decision on
  // the native relay would refresh the ACP window it never touched.
  //
  // Deliberately not backfilled, for the reason 0070 gives about `issuer`: a grant
  // predating this table was answered on a channel nobody recorded, and inventing one
  // would hand the weaker channel a window no operator granted it. Those grants keep
  // working on `native` (which has no ceiling) and show the card once more on ACP.
  '0077_brokered_grant_channel_approvals': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('brokered_grant_approvals')
        .addColumn('grant_id', 'text', (c) =>
          c.notNull().references('secret_provider_permissions.id').onDelete('cascade'),
        )
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('approved_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('brokered_grant_approvals_pkey', ['grant_id', 'channel'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('brokered_grant_approvals').execute();
    },
  },
  '0078_gateway_audit_events': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The MCP gateway's own record of each `tools/call` it serves (ADR 0014 D3) joins
      // the existing per-project audit chain rather than starting a second log: a call
      // and the grant it redeemed belong in one ordered, tamper-evident trail.
      await db.schema
        .alterTable('secret_audit_events')
        .dropConstraint('secret_audit_events_kind_check')
        .execute();
      await db.schema
        .alterTable('secret_audit_events')
        .addCheckConstraint(
          'secret_audit_events_kind_check',
          sql`kind in (
            'approval_approved', 'approval_denied',
            'grant_issued', 'grant_redeemed', 'grant_redemption_refused',
            'job_succeeded', 'job_failed', 'job_cancelled',
            'cleanup_complete', 'cleanup_attention',
            'gateway_call_received', 'gateway_call_served', 'gateway_call_rejected'
          )`,
        )
        .execute();
      // A gateway event has no lifecycle `request_hash`: it is identified by a keyed MAC
      // instead, because its parameters are attacker-supplied and an unkeyed digest over
      // them is a durable verifier to guess against.
      await db.schema
        .alterTable('secret_audit_events')
        .alterColumn('request_hash', (column) => column.dropNotNull())
        .execute();
      await db.schema.alterTable('secret_audit_events').addColumn('request_mac', 'text').execute();
      // Existing rows are lifecycle events and keep their hash; the constraint holds both
      // families to exactly one identifier, so a row can never carry both or neither. The
      // single exception is a rejected malformed body: nothing parsed, so there is no
      // canonical request to key and the row is deliberately identified by neither.
      await db.schema
        .alterTable('secret_audit_events')
        .addCheckConstraint(
          'secret_audit_events_identifier_check',
          sql`(kind in ('gateway_call_received', 'gateway_call_served', 'gateway_call_rejected'))
                = (request_hash is null)
              and not (request_hash is not null and request_mac is not null)
              and (kind not in ('gateway_call_received', 'gateway_call_served')
                   or request_mac is not null)`,
        )
        .execute();
      // Reconciliation reads a call's records by MAC; without this it is a chain scan.
      await db.schema
        .createIndex('secret_audit_events_request_mac_idx')
        .on('secret_audit_events')
        .columns(['project_id', 'request_mac'])
        .execute();
      await db.schema
        .createTable('audit_mac_keys')
        .addColumn('key_id', 'text', (column) => column.primaryKey())
        .addColumn('key_material', 'text', (column) => column.notNull())
        .addColumn('state', 'text', (column) => column.notNull())
        .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint('audit_mac_keys_state_check', sql`state in ('active', 'retired')`)
        .execute();
      // Rotation retires the old key and mints a new one; two active keys would mean two
      // concurrent writers keying the same project's calls differently, and MACs that no
      // longer compare are the one failure this table exists to prevent.
      await sql`create unique index audit_mac_keys_active_unique on audit_mac_keys (state) where state = 'active'`.execute(
        db,
      );
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('audit_mac_keys').execute();
      await db.schema.dropIndex('secret_audit_events_request_mac_idx').execute();
      await db.schema
        .alterTable('secret_audit_events')
        .dropConstraint('secret_audit_events_identifier_check')
        .execute();
      // A recorded gateway event cannot come back out. It sits in the interior of a
      // hash chain, so deleting it breaks every link after it, and renumbering to close
      // the gap rewrites `sequence` — which the event hashes cover — and breaks them all.
      // Either way the project's trail stops verifying, which is indistinguishable from
      // the tampering the chain exists to detect. So this refuses rather than silently
      // destroying the evidence; roll back to a build without the gateway instead.
      const recorded = await sql<{
        count: string | number | bigint;
      }>`select count(*) as count from secret_audit_events
         where kind in ('gateway_call_received', 'gateway_call_served', 'gateway_call_rejected')`.execute(
        db,
      );
      if (Number(recorded.rows[0]?.count ?? 0) > 0) {
        throw new Error(
          '0078_gateway_audit_events cannot be reverted: gateway audit events are recorded, and removing them would break the audit chain they are part of',
        );
      }
      await db.schema.alterTable('secret_audit_events').dropColumn('request_mac').execute();
      await db.schema
        .alterTable('secret_audit_events')
        .alterColumn('request_hash', (column) => column.setNotNull())
        .execute();
      await db.schema
        .alterTable('secret_audit_events')
        .dropConstraint('secret_audit_events_kind_check')
        .execute();
      await db.schema
        .alterTable('secret_audit_events')
        .addCheckConstraint(
          'secret_audit_events_kind_check',
          sql`kind in (
            'approval_approved', 'approval_denied',
            'grant_issued', 'grant_redeemed', 'grant_redemption_refused',
            'job_succeeded', 'job_failed', 'job_cancelled',
            'cleanup_complete', 'cleanup_attention'
          )`,
        )
        .execute();
    },
  },
  '0079_control_plane_generation_fence': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('control_plane_generation')
        .addColumn('singleton', 'boolean', (column) => column.primaryKey())
        .addColumn('generation', 'integer', (column) => column.notNull())
        .addColumn('holder_id', 'text')
        .addColumn('operation_id', 'text')
        .addColumn('state', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint('control_plane_generation_singleton_check', sql`singleton = true`)
        .addCheckConstraint('control_plane_generation_value_check', sql`generation >= 0`)
        .addCheckConstraint(
          'control_plane_generation_state_check',
          sql`(state = 'active' and holder_id is not null and operation_id is not null)
              or (state = 'quiesced' and holder_id is null)`,
        )
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('control_plane_generation').execute();
    },
  },

  '0080_verity_uplink_subscription': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .addColumn('uplink_subscription_key', 'text')
        .addColumn('uplink_installation_id', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('verity_settings')
        .dropColumn('uplink_installation_id')
        .dropColumn('uplink_subscription_key')
        .execute();
    },
  },
  '0081_public_preview_static_target': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('public_preview_shares')
        .alterColumn('dev_server_id', (c) => c.dropNotNull())
        .alterColumn('target_port', (c) => c.dropNotNull())
        .addColumn('target_kind', 'text', (c) => c.notNull().defaultTo('dev-server'))
        .addColumn('static_path', 'text')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      // Static shares cannot be represented by the previous schema. Remove them
      // before restoring its non-null dev-server target invariants.
      await sql`delete from public_preview_shares where target_kind = 'static-folder'`.execute(db);
      await db.schema
        .alterTable('public_preview_shares')
        .dropColumn('static_path')
        .dropColumn('target_kind')
        .alterColumn('dev_server_id', (c) => c.setNotNull())
        .alterColumn('target_port', (c) => c.setNotNull())
        .execute();
    },
  },
  '0082_uplink_pending_share_removals': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('uplink_pending_share_removals')
        .addColumn('share_id', 'text', (column) => column.primaryKey())
        .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('uplink_pending_share_removals').execute();
    },
  },
  '0083_drop_local_transcribe_backend_mode': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Verity no longer bundles a local speech-to-text backend, so `local` names
      // a backend no deployment can have. An installation that picked it before
      // the removal would otherwise carry a choice that can never be satisfied:
      // the app would show it as the selected backend while every upload is
      // rejected as "not configured", with no way back other than picking another
      // backend blind. Clearing it (rather than rewriting it to `external`)
      // returns those installations to the "no backend chosen yet" state the app
      // renders as "Choose backend", so the operator makes a fresh, explicit
      // choice for a backend that actually exists. `external` is deliberately not
      // invented on their behalf — that would claim consent to an off-host
      // service nobody gave.
      await sql`
        update verity_settings
        set transcribe_backend_mode = null
        where transcribe_backend_mode = 'local'
      `.execute(db);
    },
    async down(): Promise<void> {
      // Irreversible by design: the previous value is not recoverable, and
      // re-introducing `local` would only restore the unsatisfiable state. The
      // column itself is 0075's to drop.
    },
  },
  '0085_broker_only_doppler_credentials': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Project-scoped credentials are deliberately not migrated. The central
      // broker identity already lives encrypted in verity_settings; retaining or
      // copying any legacy token would preserve the split trust path this
      // migration removes. The non-secret minted-token slug is retained as a
      // durable revocation tombstone: deleting that identifier here would make an
      // already-issued Doppler credential impossible to revoke after upgrade.
      await sql`
        create table doppler_legacy_cutovers (
          project_id text primary key,
          container_name text not null,
          doppler_project text,
          doppler_config text,
          token_slug text,
          token_ref text,
          manual_credential boolean not null,
          catalog_credential boolean not null default false,
          created_at timestamptz not null default now(),
          runtime_cutover_at timestamptz,
          credential_remediated_at timestamptz,
          remediation_actor_id text,
          remediation_evidence text,
          remediation_request_id text
        )
      `.execute(db);
      await sql`
        insert into doppler_legacy_cutovers (
          project_id, container_name, doppler_project, doppler_config, token_ref,
          manual_credential, catalog_credential
        )
        select distinct on (bindings.project_id)
               bindings.project_id, projects.container_name, bindings.doppler_project,
               bindings.doppler_config, bindings.credential_ref, false, true
        from secret_provider_bindings bindings
        join projects on projects.id = bindings.project_id
        where bindings.provider = 'doppler'
        order by bindings.project_id, bindings.version desc
        on conflict (project_id) do update
        set catalog_credential = true,
            manual_credential = true,
            token_ref = coalesce(doppler_legacy_cutovers.token_ref, excluded.token_ref)
      `.execute(db);
      await sql`
        insert into doppler_legacy_cutovers (
          project_id, container_name, doppler_project, doppler_config, token_slug, token_ref,
          manual_credential
        )
        select ps.project_id, p.container_name, ps.doppler_project, ps.doppler_config,
               ps.doppler_minted_token_slug, ps.doppler_token_ref,
               (ps.doppler_token is not null
                or ps.doppler_token_ref is not null
                or (ps.doppler_minted_token is not null
                    and ps.doppler_minted_token_slug is null))
        from project_settings ps
        join projects p on p.id = ps.project_id
        where ps.doppler_token is not null
           or ps.doppler_token_ref is not null
           or ps.doppler_minted_token is not null
           or ps.doppler_minted_token_slug is not null
        on conflict (project_id) do update
        set doppler_project = coalesce(excluded.doppler_project, doppler_legacy_cutovers.doppler_project),
            doppler_config = coalesce(excluded.doppler_config, doppler_legacy_cutovers.doppler_config),
            token_slug = coalesce(excluded.token_slug, doppler_legacy_cutovers.token_slug),
            token_ref = coalesce(excluded.token_ref, doppler_legacy_cutovers.token_ref),
            manual_credential = doppler_legacy_cutovers.manual_credential
                                or excluded.manual_credential
      `.execute(db);
      await sql`
        alter table secret_provider_bindings
        drop constraint if exists secret_provider_bindings_credential_ref_fkey
      `.execute(db);
      await sql`
        create function enforce_non_doppler_binding_credential()
        returns trigger language plpgsql as $$
        begin
          if new.provider <> 'doppler' and not exists (
            select 1 from secret_provider_credentials
            where credential_ref = new.credential_ref
          ) then
            raise foreign_key_violation using
              message = 'non-Doppler secret provider binding requires an existing credential';
          end if;
          return new;
        end
        $$
      `.execute(db);
      await sql`
        create trigger secret_provider_bindings_credential_integrity
        before insert or update of provider, credential_ref on secret_provider_bindings
        for each row execute function enforce_non_doppler_binding_credential()
      `.execute(db);
      await sql`
        create function protect_non_doppler_binding_credential()
        returns trigger language plpgsql as $$
        begin
          if exists (
            select 1
            from secret_provider_bindings bindings
            join projects on projects.id = bindings.project_id
            where bindings.provider <> 'doppler'
              and bindings.credential_ref = old.credential_ref
          ) then
            raise foreign_key_violation using
              message = 'credential is still referenced by a non-Doppler binding';
          end if;
          return old;
        end
        $$
      `.execute(db);
      await sql`
        create trigger secret_provider_credentials_binding_integrity
        before delete or update of credential_ref on secret_provider_credentials
        for each row execute function protect_non_doppler_binding_credential()
      `.execute(db);
      // Doppler catalog credentials stay encrypted and referenced until the
      // unlocked Server proves the central broker can access every mapped
      // project/config. The cutover worker then atomically removes exclusively
      // Doppler credentials and switches these bindings to the broker sentinel.
    },
    async down(db: Kysely<unknown>): Promise<void> {
      // Fail closed whenever rollback would delete a recovery identifier. Empty
      // databases may rewind for schema tests and pre-cutover deployments.
      const pending = await sql<{ count: string }>`
        select count(*)::text as count from doppler_legacy_cutovers
      `.execute(db);
      if (pending.rows[0]?.count !== '0') {
        throw new Error('0085 broker-only Doppler cutover is irreversible while audit rows exist');
      }
      const brokerBindings = await sql<{ count: string }>`
        select count(*)::text as count
        from secret_provider_bindings
        where provider = 'doppler' and credential_ref = 'secretref:broker/doppler'
      `.execute(db);
      if (brokerBindings.rows[0]?.count !== '0') {
        throw new Error('0085 broker-only Doppler cutover cannot reconstruct deleted credentials');
      }
      await sql`
        drop trigger secret_provider_credentials_binding_integrity
        on secret_provider_credentials
      `.execute(db);
      await sql`drop function protect_non_doppler_binding_credential()`.execute(db);
      await sql`
        drop trigger secret_provider_bindings_credential_integrity
        on secret_provider_bindings
      `.execute(db);
      await sql`drop function enforce_non_doppler_binding_credential()`.execute(db);
      await sql`
        alter table secret_provider_bindings
        add constraint secret_provider_bindings_credential_ref_fkey
        foreign key (credential_ref) references secret_provider_credentials (credential_ref)
      `.execute(db);
      await sql`drop table doppler_legacy_cutovers`.execute(db);
    },
  },

  '0084_cross_project_workflows': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('workflow_services')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('source_project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('restrict'),
        )
        .addColumn('source_repository', 'text', (c) => c.notNull())
        .addColumn('image_repository', 'text', (c) => c.notNull())
        .addColumn('deployments', 'jsonb', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('workflows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('template_kind', 'text', (c) => c.notNull())
        .addColumn('template_version', 'integer', (c) => c.notNull())
        .addColumn('control_project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('restrict'),
        )
        .addColumn('root_session_id', 'text', (c) =>
          c.references('sessions.session_id').onDelete('set null'),
        )
        .addColumn('created_by_actor_id', 'text', (c) => c.notNull())
        .addColumn('objective', 'text', (c) => c.notNull())
        .addColumn('environment', 'text', (c) => c.notNull())
        .addColumn('service_id', 'text', (c) =>
          c.notNull().references('workflow_services.id').onDelete('restrict'),
        )
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('blocker', 'jsonb')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          'workflows_state_check',
          sql`state in ('draft','awaiting_authorization','running','awaiting_decision','blocked','succeeded','failed','cancelled','rolled_back')`,
        )
        .execute();
      await db.schema
        .createTable('workflow_steps')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('ordinal', 'integer', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('target_project_id', 'text', (c) =>
          c.references('projects.id').onDelete('restrict'),
        )
        .addColumn('depends_on', sql`text[]`, (c) => c.notNull().defaultTo(sql`array[]::text[]`))
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('attempt', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('max_attempts', 'integer', (c) => c.notNull().defaultTo(2))
        .addColumn('input_artifact_refs', sql`text[]`, (c) =>
          c.notNull().defaultTo(sql`array[]::text[]`),
        )
        .addColumn('completion_gate', 'text', (c) => c.notNull())
        .addColumn('lease_expires_at', 'timestamptz')
        .addColumn('next_reconcile_at', 'timestamptz')
        .addColumn('expected_evidence', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint('workflow_steps_workflow_ordinal_unique', ['workflow_id', 'ordinal'])
        .addCheckConstraint(
          'workflow_steps_state_check',
          sql`state in ('pending','ready','dispatching','running','result_submitted','waiting_for_gate','completed','retryable_failed','permanently_failed','cancelled')`,
        )
        .execute();
      await db.schema
        .createTable('workflow_handoffs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('step_id', 'text', (c) =>
          c.notNull().references('workflow_steps.id').onDelete('cascade'),
        )
        .addColumn('attempt', 'integer', (c) => c.notNull())
        .addColumn('target_project_id', 'text', (c) =>
          c.notNull().references('projects.id').onDelete('restrict'),
        )
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('capability_hash', 'text', (c) => c.notNull().unique())
        .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('session_id', 'text', (c) =>
          c.references('sessions.session_id').onDelete('set null'),
        )
        .addColumn('previous_handoff_id', 'text', (c) =>
          c.references('workflow_handoffs.id').onDelete('set null'),
        )
        .addColumn('dispatched_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint('workflow_handoffs_attempt_unique', ['step_id', 'attempt'])
        .execute();
      await db.schema
        .createTable('workflow_results')
        .addColumn('handoff_id', 'text', (c) =>
          c.primaryKey().references('workflow_handoffs.id').onDelete('cascade'),
        )
        .addColumn('attempt', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('summary', 'text', (c) => c.notNull())
        .addColumn('outputs', 'jsonb', (c) => c.notNull())
        .addColumn('evidence', 'jsonb', (c) => c.notNull())
        .addColumn('blocker', 'jsonb')
        .addColumn('submitted_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addCheckConstraint(
          'workflow_results_status_check',
          sql`status in ('completed','blocked','failed','cancelled')`,
        )
        .execute();
      await db.schema
        .createTable('workflow_artifacts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('producer_step_id', 'text', (c) =>
          c.notNull().references('workflow_steps.id').onDelete('restrict'),
        )
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('uri', 'text', (c) => c.notNull())
        .addColumn('digest', 'text')
        .addColumn('metadata', 'jsonb', (c) => c.notNull())
        .addColumn('verified_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('workflow_policy_decisions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('transition', 'text', (c) => c.notNull())
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('authorization_hash', 'text', (c) => c.notNull())
        .addColumn('decision', 'text', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('workflow_events')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('event_id', 'text', (c) => c.notNull().unique())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('actor_type', 'text', (c) => c.notNull())
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('previous_state', 'text')
        .addColumn('new_state', 'text')
        .addColumn('policy_decision_id', 'text', (c) =>
          c.references('workflow_policy_decisions.id').onDelete('restrict'),
        )
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
      await db.schema
        .createTable('workflow_provider_inbox')
        .addColumn('id', 'bigserial', (c) => c.primaryKey())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('delivery_id', 'text', (c) => c.notNull())
        .addColumn('event_type', 'text', (c) => c.notNull())
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('received_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addColumn('processed_at', 'timestamptz')
        .addColumn('error', 'text')
        .addUniqueConstraint('workflow_provider_inbox_delivery_unique', ['provider', 'delivery_id'])
        .execute();
      await db.schema
        .createTable('workflow_dispatch_outbox')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workflow_id', 'text', (c) =>
          c.notNull().references('workflows.id').onDelete('cascade'),
        )
        .addColumn('step_id', 'text', (c) =>
          c.notNull().references('workflow_steps.id').onDelete('cascade'),
        )
        .addColumn('attempt', 'integer', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('available_at', 'timestamptz', (c) => c.notNull())
        .addColumn('claimed_until', 'timestamptz')
        .addColumn('completed_at', 'timestamptz')
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint('workflow_dispatch_outbox_attempt_unique', [
          'step_id',
          'attempt',
          'kind',
        ])
        .execute();
      await db.schema
        .createTable('workflow_commands')
        .addColumn('actor_id', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('workflow_id', 'text', (c) => c.references('workflows.id').onDelete('cascade'))
        .addColumn('command_kind', 'text', (c) => c.notNull())
        .addColumn('request_hash', 'text', (c) => c.notNull())
        .addColumn('response', 'jsonb', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint('workflow_commands_pkey', ['actor_id', 'idempotency_key'])
        .execute();
      await db.schema
        .createIndex('workflow_steps_due_idx')
        .on('workflow_steps')
        .columns(['state', 'next_reconcile_at'])
        .execute();
      await db.schema
        .createIndex('workflow_outbox_due_idx')
        .on('workflow_dispatch_outbox')
        .columns(['completed_at', 'available_at'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      for (const table of [
        'workflow_commands',
        'workflow_dispatch_outbox',
        'workflow_provider_inbox',
        'workflow_events',
        'workflow_policy_decisions',
        'workflow_artifacts',
        'workflow_results',
        'workflow_handoffs',
        'workflow_steps',
        'workflows',
        'workflow_services',
      ]) {
        await db.schema.dropTable(table).execute();
      }
    },
  },
};

export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  },
};

/**
 * The latest (highest-ordered) migration key — i.e. the schema generation this
 * build targets. Kysely orders migrations by `Object.keys(...).sort()` (plain
 * lexicographic), applying them in that order, so the last key after the same
 * sort IS the current schema generation. Our keys are zero-padded (`0001_…`),
 * so lexicographic order matches numeric order. Pure: reads the in-code
 * migration set only, no DB access. Throws only if the set were somehow empty
 * (a programming error), which keeps callers from silently baking `undefined`.
 */
export function latestMigrationKey(): string {
  const key = Object.keys(migrations).sort().at(-1);
  if (key === undefined) {
    throw new Error('no migrations are defined');
  }
  return key;
}

/**
 * The oldest (lowest-ordered) migration key defined by this build. Same ordering
 * as {@link latestMigrationKey}. Pure: reads the in-code migration set only.
 * Throws on an empty set for the same fail-loud reason.
 */
export function earliestMigrationKey(): string {
  const key = Object.keys(migrations).sort().at(0);
  if (key === undefined) {
    throw new Error('no migrations are defined');
  }
  return key;
}

/**
 * The schema-generation compatibility window this Server build declares
 * (ADR 0008 D9 — "Every image declares minimum, current, and maximum compatible
 * schema generations"). Values are migration keys ordered by the same sort
 * Kysely applies, so the window is directly comparable against
 * {@link executedSchemaGeneration}.
 *
 * - `current` — the generation this build targets ({@link latestMigrationKey}).
 * - `min` — the OLDEST generation this build can still read and write: the N−1
 *   rollback floor. Verity migrations are additive (expand/contract), so every
 *   generation from the earliest in-code migration up to `current` stays
 *   readable; the earliest key is therefore the safe declared floor. It is not
 *   derived from "the previous release" because migration keys alone cannot
 *   identify release boundaries, and it must only ever be RAISED (never guessed
 *   forward) — after a destructive contraction moves the rollback window past a
 *   generation, release engineering removes the contracted migrations, which
 *   raises `earliestMigrationKey()` accordingly.
 * - `max` — the NEWEST generation this build can read. This build only defines
 *   migrations up to `current`, so it equals `current`. Advertising a `max`
 *   ABOVE `current` (forward tolerance, so an older Server N−1 can read the
 *   additive generation a newer Server N writes) is a release-controlled forward
 *   promise that names the next release's migration keys; it cannot be derived
 *   from this build's code and is intentionally left to a later, per-release
 *   declaration.
 */
export interface SchemaCompatibilityWindow {
  readonly min: string;
  readonly current: string;
  readonly max: string;
}

/**
 * Build this image's {@link SchemaCompatibilityWindow}. Pure: reads the in-code
 * migration set only, no DB access. The window is always coherent
 * (`min <= current <= max`) because `min` is the earliest and `current`/`max`
 * the latest key of the same non-empty set.
 */
export function schemaCompatibilityWindow(): SchemaCompatibilityWindow {
  const current = latestMigrationKey();
  return { min: earliestMigrationKey(), current, max: current };
}

/**
 * READ-ONLY: the ordered names of migrations already applied to `db`. Uses
 * Kysely's migrator inspection (`getMigrations`), which only SELECTs the
 * migration bookkeeping table (and returns an empty list when it does not yet
 * exist) — it never creates tables, runs migrations, or otherwise mutates the
 * database. Intended for schema-generation/compatibility checks (ADR 0008 D5
 * preflight) that must observe the current generation without advancing it.
 */
export async function getExecutedMigrations(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const infos = await migrator.getMigrations();
  return infos.filter((info) => info.executedAt !== undefined).map((info) => info.name);
}

/**
 * READ-ONLY convenience over {@link getExecutedMigrations}: the highest-ordered
 * migration actually applied to `db`, or `null` when none have run. Ordering
 * matches {@link latestMigrationKey} (Kysely's lexicographic sort), so this is
 * directly comparable against it to detect a pending-migration or ahead/behind
 * schema generation without mutating the database.
 */
export async function executedSchemaGeneration(db: Kysely<Database>): Promise<string | null> {
  const executed = await getExecutedMigrations(db);
  return executed.sort().at(-1) ?? null;
}
