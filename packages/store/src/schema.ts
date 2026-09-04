import type { AgentEvent, Attachment } from '@verity/events';
import type { ColumnType, Generated } from 'kysely';

/**
 * Postgres schema for the durable source of truth (concept §5a): an append-only
 * canonical-event log plus the session registry. The {@link EventStore} API
 * only ever inserts and selects — it exposes no update or delete — and the
 * `events -> sessions` foreign key is `restrict`, so the database itself refuses
 * to delete a session while its log exists. The log is the truth; the `.jsonl`
 * is a disposable materialized view of it.
 *
 * Note: `payload` integers must stay within `Number.MAX_SAFE_INTEGER` — jsonb
 * round-trips through a JS number. All canonical event fields (token counts,
 * `resetsAt` epoch seconds) are well within that range.
 */

export interface SessionsTable {
  /** The Claude Code session id — also the `--resume` handle. */
  session_id: string;
  /** Worktree the agent runs in. UNIQUE: session ↔ worktree is strictly 1:1 (§5a). */
  worktree: string;
  model: string;
  /** Model selected when the session was created. Immutable; null only for rows
   * written by a pre-migration server during a rolling upgrade. */
  initial_model: ColumnType<string | null, string | null | undefined, never>;
  /** Operator-assigned display name; null until set at spawn or via rename. */
  name: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Project the session runs in (concept §19, multi-repo fleet registry). NULL for
   * sessions created before the projects slice landed (migration-safe) and for any
   * future session in a project-less mode. ON DELETE SET NULL: dropping a project
   * does not cascade-delete its sessions — they keep their durable log + worktree
   * (the orphan-handling + attention-queue surfaces them as "no project").
   */
  project_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Session discriminator (ADR 0008): `'normal'` for an ordinary agent run,
   * `'agent_loop'` for a session that is the durable runtime of an Agent Loop.
   * notNull default `'normal'`, so pre-existing sessions read back as normal.
   */
  kind: ColumnType<string, string | undefined, string>;
  /**
   * Operator's "last seen" mark for the overview unread dot (#387): the session's
   * `eventCount` at the last open. NULL = never opened → not unread. Global (no
   * per-device scoping), so the mark syncs across every device hitting this server.
   * Advanced monotonically by {@link EventStore.setSessionSeen}.
   */
  last_seen_event_count: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Multi-repo fleet registry (concept §19, #174). One row per GitHub repo the
 * App-installation lists + Verity has registered. **Cache** of the GitHub-
 * installation state + the Verity-side container lifecycle (§10: GitHub is the
 * source of truth for repo existence; this table mirrors it + tracks the
 * provisioned `verity-<owner>--<repo>` container state).
 *
 * Naming conventions (§19.0 canonicalization):
 *   - `owner`, `repo`: persisted LOWERCASE (GitHub-owners/repos are case-
 *     insensitive; persisting the lowercase form lets `UNIQUE(owner, repo)`
 *     behave regardless of Postgres collation, without needing CITEXT). The mixed-
 *     case display name stays recoverable from the GitHub repo API during the
 *     `GET /projects` sync.
 *   - `container_name`: deterministic derived form `verity-<owner>--<repo>` (single
 *     hyphen-slug, lowercased). Uniquely-restrained so two concurrent provisions
 *     can't collide at the Docker daemon.
 */
export interface ProjectsTable {
  /** App-generated UUID; stable across re-provisioning of the same repo. */
  id: string;
  /** Lowercase canonical owner (`heey-global`). */
  owner: string;
  /** Lowercase canonical repo (`verity`). */
  repo: string;
  /** `verity-<owner>--<repo>` — single hyphen-slug, lowercased. */
  container_name: string;
  /** `github` for ordinary repository projects; `control_plane` for Verity's
   *  internal advanced workspace; `local` for a project Verity created with
   *  `git init` and no remote (no GitHub link yet). */
  kind: ColumnType<string, string | undefined, string>;
  /** Host clone-directory NAME under the clone root, when it must not be derived
   *  from `(owner, repo)`. NULL = derive `<owner>-<repo>` (every pre-existing row).
   *  Written when a `local` project is created, and DELIBERATELY kept when that
   *  project is later linked to a GitHub repo: sessions persist ABSOLUTE worktree
   *  paths under this directory, so moving the clone on link would orphan every
   *  session the project already has. */
  clone_dir: ColumnType<string | null, string | null | undefined, string | null>;
  /** Resolved image ref for the project container; NULL = resolve Verity default
   *  at build time (§19.5 — not frozen at registration). */
  image_ref: ColumnType<string | null, string | null | undefined, string | null>;
  /** Optional operator-configured image. Kept separate from `image_ref`, which
   *  records the image actually selected by the latest provisioning attempt. */
  image_override_ref: ColumnType<string | null, string | null | undefined, string | null>;
  /** Content identity of the runner-boundary trust root (the bundled sandbox
   *  toolkit's boundary binaries) that the LAST provisioning of this project
   *  judged against. Written next to `image_ref`, because the pair is what a
   *  verdict was made from: the image, and the toolkit it was measured against.
   *  NULL for projects last provisioned before this column existed and on
   *  servers that ship no bundle — "unknown", never "matches". */
  toolkit_identity: ColumnType<string | null, string | null | undefined, string | null>;
  /** `absent` | `cloning` | `container_starting` | `active` | `failed` (§19.3). */
  state: string;
  /** GitHub repository archive flag from the installation sync. Archived repos
   *  stay cached for state/history, but are not offered by project pickers. */
  archived: ColumnType<boolean, boolean | undefined, boolean>;
  /** Failure reason when `state='failed'`; NULL otherwise. */
  provision_error: ColumnType<string | null, string | null | undefined, string | null>;
  /** Non-fatal provisioning warning when `state='active'`; NULL otherwise. */
  provision_warning: ColumnType<string | null, string | null | undefined, string | null>;
  /** Soft-delete marker (#174 follow-up). NULL = visible in the picker; a
   *  timestamp = operator-hidden. Set by `hideProject` (the UI delete), cleared
   *  by an explicit restore. The installation-sync upsert leaves it untouched so
   *  a hidden repo is not resurrected by the next `GET /projects`. */
  hidden_at: ColumnType<Date | null, string | null | undefined, string | null>;
  /** Operator-defined overview order. NULL = never manually ordered; those rows
   *  sort after ordered projects by their stable creation order. */
  sort_order: ColumnType<number | null, number | null | undefined, number | null>;
  /** Operator's overview fold state for this project group. `false` = expanded
   *  (default for a freshly registered project). Persisted so the choice syncs
   *  across every device; there is no per-device/per-operator scoping. */
  collapsed: ColumnType<boolean, boolean | undefined, boolean>;
  /** True once a repo was explicitly added as a Verity project. Installation-sync
   *  cache rows stay false while still `absent`, so the overview can show paused
   *  projects without listing every installable GitHub repo. */
  overview_visible: ColumnType<boolean, boolean | undefined, boolean>;
  /** Durable guided-setup state shared across devices. */
  setup_status: ColumnType<string, string | undefined, string>;
  /** Display-cache of the repo's latest GitHub release (project-overview version
   *  badge). Persisted so the version survives a restart and is shown from the DB
   *  on a cold in-memory cache; the live freshness/TTL is owned by the in-memory
   *  `GitHubReleaseService`, so there is no fetched-at column here. `published_at`
   *  is stored as TEXT — GitHub's ISO string, display-only (never queried/sorted).
   *  All NULL until a release lookup resolves / for a repo with no releases. */
  latest_release_tag: ColumnType<string | null, string | null | undefined, string | null>;
  latest_release_name: ColumnType<string | null, string | null | undefined, string | null>;
  latest_release_url: ColumnType<string | null, string | null | undefined, string | null>;
  latest_release_published_at: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
  /** When the provisioning worker last wrote `state`. Distinct from `updated_at`,
   *  which every writer bumps — including the installation sync and the
   *  release-badge cache, both of which deliberately leave `state` alone. The
   *  stale-provisioning sweep (`reconcileProjectContainerStates`) measures how
   *  long a row has been stuck mid-transition, so it has to read a column only
   *  the state writer moves: against `updated_at` any unrelated periodic write
   *  refreshes the age forever and the sweep never fires. */
  state_changed_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface ProjectIdentityClaimsTable {
  owner: string;
  repo: string;
  project_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Per-project operator settings. Kept separate from {@link ProjectsTable} so
 * GitHub/project sync can refresh lifecycle metadata without touching local
 * runtime preferences or secret references. */
export interface ProjectSettingsTable {
  project_id: string;
  doppler_token_ref: ColumnType<string | null, string | null | undefined, string | null>;
  doppler_token: ColumnType<string | null, string | null | undefined, string | null>;
  /** Operator-authorized Doppler binding (#320): the Doppler project + config a
   *  scoped read-only token is minted against at provision time. Plaintext
   *  (non-secret config, not credentials). */
  doppler_project: ColumnType<string | null, string | null | undefined, string | null>;
  doppler_config: ColumnType<string | null, string | null | undefined, string | null>;
  /** Cached scoped read-only per-project Doppler token minted from the global
   *  account token against the binding above. A SECRET: encrypted at rest by the
   *  store's SecretCipher, exactly like `doppler_token`. */
  doppler_minted_token: ColumnType<string | null, string | null | undefined, string | null>;
  /** Doppler's identifier (`slug`) for the cached minted token above (#320
   *  follow-up). PLAINTEXT — the slug is an opaque token identifier, not a
   *  credential; it names WHICH config-token to revoke, never grants access.
   *  Persisted alongside `doppler_minted_token` at mint time and used to
   *  best-effort revoke the superseded token when the binding is rebound. */
  doppler_minted_token_slug: ColumnType<string | null, string | null | undefined, string | null>;
  default_branch: ColumnType<string | null, string | null | undefined, string | null>;
  default_model: ColumnType<string | null, string | null | undefined, string | null>;
  /** Per-project agent memory (ADR 0008): free-text notes the agent appends via
   *  the memory broker and the operator curates in Project Settings, injected into
   *  each session's runtime system prompt at context init. PLAINTEXT — it is
   *  operator-visible content, not a credential, so (unlike the `doppler_*` secret
   *  columns above) it is never encrypted at rest. */
  memory: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/**
 * When a standing brokered-secret grant was last approved, per transport (ADR 0014 D3).
 *
 * A separate table rather than columns on `secret_provider_permissions`, because the
 * two channels must not overwrite each other: an approval on the native relay would
 * otherwise reset the ACP channel's 24-hour window, and a grant that only the native
 * path ever answered would auto-approve an ACP prompt no operator saw. Keyed by
 * (grant, channel), so each channel carries its own last decision.
 *
 * Rows exist only for grants approved after this table did. A pre-existing grant has
 * none, which is why an ACP prompt covered by one still shows the card — the
 * fail-closed direction, and the only one available without provenance that was never
 * recorded.
 */
interface BrokeredGrantApprovalsTable {
  grant_id: string;
  /** `native` | `acp` — see `brokeredGrantChannel()` in @verity/session. Stored as
   *  text rather than an enum so adding a transport is a code change, not a migration. */
  channel: string;
  approved_at: ColumnType<Date, string | undefined, string>;
}

interface BrokeredHttpConsumptionsTable {
  project_id: string;
  session_id: string;
  turn_id: string;
  call_id: string;
  request_hash: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Global operator-controlled Verity settings. Singleton row keyed by
 * id='global' so deployment defaults can be imported once and then managed via
 * the Verity API/UI instead of scattered container-local git config. */
export interface VeritySettingsTable {
  id: string;
  /** Shows internal Verity Control project/workspace surfaces when enabled. */
  advanced_mode_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  git_user_name: ColumnType<string | null, string | null | undefined, string | null>;
  git_user_email: ColumnType<string | null, string | null | undefined, string | null>;
  git_ssh_private_key_path: ColumnType<string | null, string | null | undefined, string | null>;
  git_ssh_private_key: ColumnType<string | null, string | null | undefined, string | null>;
  git_ssh_public_key_path: ColumnType<string | null, string | null | undefined, string | null>;
  git_ssh_public_key: ColumnType<string | null, string | null | undefined, string | null>;
  git_known_hosts_path: ColumnType<string | null, string | null | undefined, string | null>;
  git_known_hosts: ColumnType<string | null, string | null | undefined, string | null>;
  git_allowed_signers_path: ColumnType<string | null, string | null | undefined, string | null>;
  git_allowed_signers: ColumnType<string | null, string | null | undefined, string | null>;
  /** GitHub App identity. App ID + installation ID are non-secret config; the
   *  private key is a secret, encrypted at rest via the store's SecretCipher.
   *  Moves the credential off the host `.pem` file into app-configurable
   *  settings (ADR 0002 D1). */
  github_app_id: ColumnType<string | null, string | null | undefined, string | null>;
  github_app_installation_id: ColumnType<string | null, string | null | undefined, string | null>;
  github_app_private_key: ColumnType<string | null, string | null | undefined, string | null>;
  /** Account-level Doppler Service Account token (#320). A secret, encrypted at
   *  rest via the store's SecretCipher. Stored globally (like the GitHub App key);
   *  later used to auto-mint scoped per-project tokens. The pre-existing
   *  per-project `project_settings.doppler_token` is unrelated. */
  doppler_service_token: ColumnType<string | null, string | null | undefined, string | null>;
  /** Optional OpenAI-compatible meeting transcription backend. The API key is
   * encrypted at rest; URL and model are non-secret configuration. */
  transcribe_base_url: ColumnType<string | null, string | null | undefined, string | null>;
  transcribe_api_key: ColumnType<string | null, string | null | undefined, string | null>;
  transcribe_model: ColumnType<string | null, string | null | undefined, string | null>;
  transcribe_backend_mode: ColumnType<string | null, string | null | undefined, string | null>;
  /** Full Claude OAuth credential state from `~/.claude/.credentials.json`.
   *  Stored encrypted at rest so the server can refresh access tokens for
   *  account-level usage probes without relying on host-local Claude files. */
  claude_code_oauth_credentials_json: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  /** Subscription-login credential for the Codex CLI (the contents of
   *  `~/.codex/auth.json` from `codex login`). A secret, encrypted at rest;
   *  materialized into the codex config volume. */
  codex_auth_json: ColumnType<string | null, string | null | undefined, string | null>;
  /** Google Drive connection for importing reference docs (ADR 0009). The iOS
   *  OAuth client id is non-secret config (it ships in the app); the connected
   *  account email is non-secret display metadata; the refresh token is a
   *  secret, encrypted at rest via the store's SecretCipher. Singleton columns
   *  (like the GitHub App credential); a per-account table replaces these when
   *  multi-account support lands. */
  google_drive_client_id: ColumnType<string | null, string | null | undefined, string | null>;
  google_drive_account_email: ColumnType<string | null, string | null | undefined, string | null>;
  google_drive_refresh_token: ColumnType<string | null, string | null | undefined, string | null>;
  /** Paid Uplink credential. Encrypted at rest; never sourced from an environment
   * variable or materialized to a host file. The installation id is public and
   * is assigned by the Uplink during the first successful handshake. */
  uplink_subscription_key: ColumnType<string | null, string | null | undefined, string | null>;
  uplink_installation_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** VESTIGIAL — no longer read or written. These were the nightly sandbox
   *  auto-update policy, removed once the relay reconciler started rebuilding
   *  every sandbox onto the current image after each Server restart: on a released
   *  Server that rolls the fleet onto `verity-sandbox:v<version>` within a minute
   *  of the update, which the 3 a.m. pass could only ever trail. They stay in the
   *  schema because dropping a `NOT NULL` column is a contraction that would break
   *  the N-1 rollback window (an older Server's insert still writes them); the
   *  `DEFAULT false` keeps this Server's insert valid — both columns are declared
   *  `.notNull().defaultTo(false)` in `migrations.ts`
   *  (`0025_sandbox_auto_update_settings`), so
   *  omitting them from the insert cannot fail on an existing deployment either.
   *  Drop in a later release. */
  sandbox_auto_update_security: ColumnType<boolean, boolean | undefined, boolean>;
  sandbox_auto_update_normal: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/**
 * Master-password key-derivation metadata (singleton, id='global'). Non-secret:
 * the scrypt `salt` and a `verifier` (a fixed marker encrypted under the derived
 * key). Kept in its OWN table, not in {@link VeritySettingsTable}, so it can be
 * read while the store is SEALED — reading verity_settings decrypts the secret
 * columns and would itself require an unlocked cipher. The raw key is never
 * persisted; it lives only in server memory after unlock.
 */
export interface SecretKeyMetaTable {
  id: string;
  salt: string;
  verifier: string;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/**
 * Per-device API bearer tokens for the control-plane auth gate (C1). A token is
 * minted when a device proves the master password; only its SHA-256 hash is
 * persisted (the raw token is returned once and lives in the device keychain).
 * NOT a secret column — validated while the store is SEALED, like
 * {@link SecretKeyMetaTable}. `id` is an opaque public handle for revocation.
 */
export interface AuthTokenTable {
  id: string;
  token_hash: string;
  label: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  last_seen_at: ColumnType<Date | null, string | undefined, string | undefined>;
}

/** The current Expo push-token binding for one paired device. The auth-token id
 * is Verity's existing opaque device handle; deleting/revoking that pairing
 * cascades to this row. */
export interface DevicePushTokensTable {
  auth_token_id: string;
  expo_token: string;
  platform: 'ios';
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Durable Expo receipt work. A successful send ticket becomes available as a
 * receipt later; persisting it prevents a server restart from losing dead-token
 * pruning. Deleting/rotating the referenced push token cascades stale work. */
interface PushReceiptsTable {
  receipt_id: string;
  expo_token: string;
  available_at: ColumnType<Date, string, string>;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface EventsTable {
  /** Monotonic insert order — the per-session event order is `order by id`. */
  id: Generated<number>;
  session_id: string;
  /** The canonical event discriminant (`AgentEvent['t']`), denormalized for filtering. */
  type: string;
  /** The full canonical {@link AgentEvent}. Read back as the object; written as JSON text. */
  payload: ColumnType<AgentEvent, string, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Rebuildable visible-message projection derived from the canonical event log. */
interface MessagesTable {
  id: Generated<number>;
  session_id: string;
  role: 'user' | 'agent';
  kind: 'prompt' | 'text' | 'notice';
  text: string;
  first_event_seq: number;
  last_event_seq: number;
  finalized: ColumnType<boolean, boolean | undefined, boolean>;
  projection_version: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, string | Date, never>;
}

interface MessageProjectionStateTable {
  session_id: string;
  last_event_seq: number;
  projection_version: ColumnType<number, number | undefined, number>;
}

/**
 * Verbatim transcript lines (concept §5a) — the raw `.jsonl` claude `--resume`
 * reads, stored line-for-line so the file can be reconstructed (line-faithful,
 * LF-delimited) after a container rebuild. Distinct from {@link EventsTable},
 * which holds the lossy-but-rich canonical view; this is the lossless source
 * for resume.
 */
export interface TranscriptLinesTable {
  /** Monotonic insert order — the per-session line order is `order by id`. */
  id: Generated<number>;
  session_id: string;
  /** One verbatim `.jsonl` line, without its trailing newline. */
  line: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Content-addressed image blobs (operator prompt attachments). Keyed by the
 * SHA-256 hex of the bytes so identical images dedupe and the id is an immutable
 * cache key. `prompt` events reference these by `id` (= `hash`) rather than
 * inlining base64, so a session opens without transferring its image backlog.
 */
interface AttachmentsTable {
  /** SHA-256 hex of the raw bytes — primary key + reference id. */
  hash: string;
  media_type: string;
  /** Raw image bytes. Read back as a Uint8Array (pglite) / Buffer (pg). */
  bytes: ColumnType<Uint8Array, Buffer, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Per-turn options persisted alongside a queued turn (issue #80). Mirrors the
 * conductor's `TurnOptions`, EXCEPT `attachments` are stored as content-addressed
 * references ({@link Attachment}, id = SHA-256 hash) rather than the raw base64
 * upload — the heavy bytes live once in {@link AttachmentsTable}, so a queued
 * screenshot survives a restart without bloating this row. On recovery the
 * conductor rehydrates the upload from the blob store.
 */
export interface QueuedTurnOpts {
  permissionMode?: string;
  timeoutMs?: number;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  attachments?: Attachment[];
  displayPrompt?: string;
}

/**
 * Durable backlog of turns sent while a session was busy (issue #80, building on
 * the in-memory queue from #90). The conductor keeps the live queue in memory but
 * mirrors each enqueue here and deletes the row when the turn dispatches or the
 * operator retracts it, so the backlog survives a server restart (recovered on
 * startup) instead of being lost. `seq` (bigserial) is the per-session FIFO order;
 * `id` is a stable opaque handle the client uses to retract a specific item. The
 * `session_id` FK cascades on delete — dropping a session takes its backlog with it.
 */
export interface QueuedTurnsTable {
  /** Stable opaque id (a UUID minted by the conductor) — the retract handle. */
  id: string;
  /** Per-session FIFO order; monotonic across the table. */
  seq: Generated<number>;
  session_id: string;
  /** The operator's prompt text (may be empty for an attachments-only turn). */
  prompt: string;
  /** {@link QueuedTurnOpts} as jsonb (attachments as content-addressed refs). */
  opts: ColumnType<QueuedTurnOpts, string, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * "A turn is in flight for this session" marker (lifecycle Phase 1). One row per
 * session, written before a turn launches and cleared on its terminal event; a
 * row still present at startup means the turn was abandoned by a crash/restart.
 */
interface RunningTurnsTable {
  session_id: string;
  /** Seq of the prompt event this turn is executing — recovery/reattach anchor. */
  prompt_seq: number;
  started_at: ColumnType<Date, string | undefined, string | undefined>;
  /** ADR 0006 Stage 4: the Server-allocated turn id, bound onto the marker before
   * the Runner launches (D2). NULL until an attempt binds it, and on the loopback
   * path that never routes through the supervisor. Recovery keys turn discovery
   * on it. */
  turn_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** ADR 0006 Stage 4: the idempotency key for this turn's StartTurn (D2). Recovery
   * repeats StartTurn under it so a lost start ACK cannot spawn a second agent.
   * Nullable for the same reasons as {@link turn_id}. */
  start_command_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
}

export interface SessionBackendStateTable {
  session_id: string;
  backend: string;
  backend_session_id: string;
  /** Last event seq from this Verity session reflected in backend_session_id. */
  context_seq: number;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/**
 * Idempotency ledger for the restart-safe Runner event transport (ADR 0006 D3/D4).
 * One row per Runner frame, keyed by `(turn_id, frame_seq)`. The Server ingests a
 * turn's append-only frame file through a single transaction that claims the next
 * contiguous `(turn_id, frame_seq)` here BEFORE (and atomically with) persisting the
 * corresponding {@link EventsTable} row. After a Server crash the frame file is
 * re-tailed from byte zero; a frame whose `(turn_id, frame_seq)` is already present
 * is a duplicate and is neither re-persisted nor re-published — replay from zero is
 * safe because ingestion is idempotent. The `payload_hash` (an opaque token minted
 * by the Runner) guards against a reused sequence carrying a DIFFERENT payload, and
 * a `turn_id` binds immutably to one `runner_instance_id` — a mismatch on either is
 * corruption, not a duplicate.
 */
interface RunnerFramesTable {
  /** The turn this frame belongs to (Server-allocated before StartTurn). */
  turn_id: string;
  /**
   * 1-based, contiguous within a turn — the ingestion sequence anchor.
   *
   * The column is `bigint`, so a SELECT reads this back as a STRING under
   * node-postgres and as a number under pglite; this `number` describes what is
   * written, not what a driver hands back. Coerce with `Number(...)` before
   * comparing or doing arithmetic on a value read from the database — writing
   * `row.frame_seq + 1` yields `"11"` in production and `2` in a pglite test.
   * Contrast `secret_job_frames.sequence`, which is deliberately int4 to avoid
   * exactly this (see migration 0061).
   */
  frame_seq: number;
  /** The Runner process instance that produced the turn; immutable per `turn_id`. */
  runner_instance_id: string;
  /** The session the turn runs for — terminal ingest uses it with `turn_id` to
   * close only the matching `running_turns` marker in the same transaction. */
  session_id: string;
  /** Opaque per-frame payload token minted by the Runner; a replayed sequence must
   * present the same one, else the log is corrupt. */
  payload_hash: string;
  /** The {@link EventsTable} `id` this frame persisted, when it was an `event` frame;
   * null for session/permission/result frames that touch no event row. */
  event_id: ColumnType<number | null, number | null | undefined, never>;
  /** True only for the final `result` frame. Once present, no later sequence may
   * be claimed for this turn. */
  terminal: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Durable server-authored notes to fold into the agent's context on its NEXT
 * turn, WITHOUT surfacing as a chat message or burning a standalone turn. Written
 * by deterministic server actions the agent must be aware of but that aren't the
 * operator speaking — currently the post-merge worktree reset (the operator clicks
 * "Merge", the server resets the worktree to the merged base + deletes the local
 * branch, and leaves a note so the agent knows its branch moved). The conductor
 * prepends any rows here to the model prompt of the next backend turn and deletes
 * them (consume-once) — they never become `prompt` events, so the chat transcript
 * stays clean. Multiple rows accumulate (ordered by `id`) if several actions land
 * between turns. The `session_id` FK CASCADES on delete: this is ephemeral runtime
 * context, not part of the durable event log (mirrors `queued_turns`).
 */
interface SessionPendingNoteTable {
  /** Monotonic insert order — notes are consumed `order by id`. */
  id: Generated<number>;
  session_id: string;
  /** The note text prepended to the next turn's model prompt. */
  note: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Durable de-dupe markers for server-authored automatic turns. */
interface SessionAutomationMarkerTable {
  session_id: string;
  marker: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** GitHub-token-broker capabilities (security review #662). One row per project:
 *  the SHA-256 HASH of the opaque per-container capability (never the raw secret)
 *  → the project binding minted-tokens are scoped to. Persisted (not in-memory) so
 *  a server restart/redeploy does NOT invalidate the capabilities already handed
 *  to running sandboxes — the previous in-memory registry lost them on every
 *  restart, so existing sandboxes' `git push` failed with 401 after any redeploy.
 *  A re-provision UPSERTs (rotating the hash); a deprovision DELETEs (revocation). */
interface GhTokenCapabilitiesTable {
  project_id: string;
  cap_hash: string;
  owner: string;
  repo: string;
  container_generation: string | null;
}

/** Project/container-generation-bound git-signing capabilities. Only the hash of
 * the opaque capability is persisted; one row per project provides rotation. */
interface SigningCapabilitiesTable {
  project_id: string;
  cap_hash: string;
  container_generation: string;
}

/** Single-use Brokered Secrets grants. Claims contain identifiers and hashes only; neither the
 * opaque capability nor secret material is persisted. `consumed_at` is set by one conditional
 * update, making redemption fail closed across concurrent servers and restarts. */
export interface SecretRunGrantsTable {
  capability_hash: string;
  grant_id: string;
  claims_json: string;
  expires_at: ColumnType<Date, string, never>;
  consumed_at: ColumnType<Date | null, string | null | undefined, string>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Durable approval state for Brokered Secrets. Claims are value-free identifiers/hashes. */
export interface SecretApprovalsTable {
  id: string;
  project_id: string;
  session_id: string;
  tool_call_id: string;
  claims_json: string;
  state: string;
  actor_id: string | null;
  requester_authorization_hash: string | null;
  authorization_hash: string | null;
  decision_hash: string | null;
  decided_at: ColumnType<Date | null, string | null | undefined, string>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface SecretRevocationsTable {
  id: Generated<number>;
  project_id: string;
  subject_kind: string;
  subject_id: string;
  subject_version: number;
  reason: string;
  revoked_at: ColumnType<Date, string, never>;
}

/**
 * Append-only, hash-chained provenance trail for Brokered Secrets. `(project_id, sequence)` is the
 * per-project chain position; `event_json` is the canonical safe projection the `event_hash` is
 * computed over. No column holds a secret value — only ids, versioned refs, and hashes. `sequence`
 * is int4 (portable number read across pg/pglite); its ~2.1e9 ceiling per project is ample for
 * Phase 1 — the day a single project needs more audit events, migrate this column to bigint.
 */
interface SecretAuditEventsTable {
  project_id: string;
  sequence: number;
  kind: string;
  /** Null on the `gateway_*` kinds, which are keyed by `request_mac` instead. */
  request_hash: string | null;
  /** Keyed MAC over an MCP gateway call's canonical request (ADR 0014 D3). Denormalized
   *  out of `event_json` so reconciliation can find a call's records without reading the
   *  whole chain; null on every lifecycle kind and on a rejected malformed body. */
  request_mac: string | null;
  grant_id: string | null;
  job_id: string | null;
  approval_id: string | null;
  event_json: string;
  prev_hash: string;
  event_hash: string;
  recorded_at: ColumnType<Date, string, never>;
}

/**
 * Server-held keys the MCP gateway takes request MACs under (ADR 0014 D3).
 *
 * Durable and versioned on purpose: an ephemeral per-process key would make every record
 * written before the last restart incomparable with every record after it, which is the
 * same as not having them — and reconciliation across time is the whole point. Rotation is
 * additive: a new key gets a new id, older events stay comparable among themselves, and
 * `secret_audit_events.event_json` names the key each MAC was taken under.
 *
 * `key_material` is encrypted at rest under the store cipher, so a database copy without
 * the master password yields no forgeries and no offline guessing against the MACs.
 */
interface AuditMacKeysTable {
  key_id: string;
  key_material: string;
  /** `active` | `retired` — at most one active key, enforced by a partial unique index. */
  state: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Durable, job-scoped spool of ALREADY-REDACTED secret-job output frames (ADR 0009 D8 / W8). It is
 * the only permitted output path from the Secret Job Executor: the supervisor appends each redacted,
 * framed chunk here BEFORE it may be published anywhere (persist-before-publish). Frames are redacted
 * by construction, so `payload` holds no secret bytes; it is still encrypted at rest (`enc:v1:`
 * envelope) as defense in depth against a redaction bug. `sequence` is 0-based and contiguous within
 * a `job_id` (the composite primary key also makes a replayed append idempotent). `byte_length` is
 * the decoded redacted size, so the per-job size bound is enforced without decrypting. `created_at`
 * is the ingestion time the retention sweep prunes by; the W5 reaper deletes a job's frames outright.
 */
interface SecretJobFramesTable {
  job_id: string;
  protocol_version: number;
  sequence: number;
  stream: string;
  encoding: string;
  /** Redacted frame payload, encrypted at rest. Immutable once written. */
  payload: ColumnType<string, string, never>;
  byte_length: number;
  /** The frame's own `emittedAt` ISO string, stored verbatim so replay round-trips exactly. */
  emitted_at: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * Recurring automation ("der Loop", ADR 0008). One row per configured Agent
 * Loop: a project-scoped `{ script, schedule }` bound to one durable agent
 * session. Project-scoped, `onDelete cascade` — dropping a project removes its
 * loops. No column holds a credential, so nothing here is encrypted; loop config
 * reads work while the secret store is sealed.
 *
 * A loop is created as `status:'draft'` (no schedule/script yet); only an
 * `'enabled'` loop fires. `schedule_config` is stored as jsonb (structured, not a
 * raw cron string) — see {@link ScheduleConfig}.
 */
export interface AgentLoopsTable {
  id: string;
  project_id: string;
  name: string;
  /** `'draft' | 'enabled' | 'paused'` — only `enabled` loops fire (ADR 0008 §7). */
  status: ColumnType<string, string | undefined, string>;
  /** `'interval' | 'daily' | 'weekly'` — the discriminant for `schedule_config`.
   *  NULL on a draft that has no schedule yet. */
  schedule_kind: ColumnType<string | null, string | null | undefined, string | null>;
  /** Structured schedule params for `schedule_kind` (never a raw cron string).
   *  Read as a parsed object; written as a `JSON.stringify`'d string (jsonb).
   *  NULL on a draft with no schedule yet. */
  schedule_config: ColumnType<ScheduleConfig | null, string | null, string | null>;
  /** The loop's script; owns the condition + spawn signal. NULL on a draft. */
  script: ColumnType<string | null, string | null | undefined, string | null>;
  /** Fallback turn prompt when the script signals without supplying one. */
  reaction_prompt: ColumnType<string | null, string | null | undefined, string | null>;
  /** Model for the dispatched turn; NULL → project/server default. */
  reaction_model: ColumnType<string | null, string | null | undefined, string | null>;
  /** The loop's durable session; FK `sessions.session_id` `onDelete set null`. */
  session_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Fingerprint of the script last proven by a green test run (draft-until-tested). */
  tested_script_fingerprint: ColumnType<string | null, string | null | undefined, string | null>;
  /** Consecutive error runs — the circuit-breaker counter (deferred logic). */
  consecutive_error_count: ColumnType<number, number | undefined, number>;
  /** Denormalized last-run time for the list UI. NULL until first run. */
  last_run_at: ColumnType<Date | null, string | null | undefined, string | null>;
  /** Denormalized last result: `'ok' | 'acted' | 'error' | 'skipped'`. */
  last_outcome: ColumnType<string | null, string | null | undefined, string | null>;
  /** The scheduler's due-time index: when this loop next fires. NULL = draft or
   *  paused. The DB is the source of truth; the timer is stateless. */
  next_run_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Structured Agent Loop schedule (ADR 0008 §3). A discriminated union stored as
 *  jsonb so the mobile UI never handles raw cron. All times are server-local. */
export type ScheduleConfig =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

/**
 * Append-only run history for an Agent Loop (ADR 0008). One row per scheduler
 * pass that touched the loop. `onDelete cascade` with the loop.
 */
export interface AgentLoopRunsTable {
  id: string;
  /** Monotonic insert order — the reliable newest-first tiebreak (`started_at`
   *  can tie to the millisecond when a pass fires several runs; the random UUID
   *  `id` does not reflect insertion order). */
  seq: Generated<number>;
  loop_id: string;
  started_at: ColumnType<Date, string | undefined, never>;
  finished_at: ColumnType<Date | null, string | null | undefined, string | null>;
  /** `'ok' | 'acted' | 'error' | 'skipped'`. */
  outcome: string;
  /** The script's exit code, if it ran. */
  exit_code: ColumnType<number | null, number | null | undefined, number | null>;
  /** Short human summary (stdout tail, error message). */
  detail: ColumnType<string | null, string | null | undefined, string | null>;
  /** The session this run used, if any. */
  session_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** True for the creation-time validation run (ADR 0008 §7A). */
  is_test: ColumnType<boolean, boolean | undefined, boolean>;
}

/** One-or-more dev servers per project (multi-dev-server data model, slice 1).
 *  The table is the source of truth; the legacy `project_settings.dev_server_*`
 *  columns are a derived view of this project's FIRST row (see store.ts). Each row
 *  is a named preview process with its own command/url/workdir/ports. CASCADEs with
 *  the project — runtime config, not part of the durable event log; nothing here is
 *  a credential, so no column is encrypted. */
interface DevServersTable {
  id: string;
  project_id: ColumnType<string, string, never>;
  /** Stable detector identity (`workdir:scriptName`). NULL for manually-created servers. */
  source_key: ColumnType<string | null, string | null | undefined, string | null>;
  name: ColumnType<string, string | undefined, string>;
  command: ColumnType<string | null, string | null | undefined, string | null>;
  url: ColumnType<string | null, string | null | undefined, string | null>;
  workdir: ColumnType<string | null, string | null | undefined, string | null>;
  host_port: ColumnType<string | null, string | null | undefined, string | null>;
  container_port: ColumnType<string | null, string | null | undefined, string | null>;
  /** Session whose worktree this server previews instead of the main checkout.
   *  NULL = serve main. ON DELETE SET NULL: deleting the session resets to main. */
  preview_session_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Desired lifecycle state. Enabled servers start whenever the project environment starts. */
  auto_start: ColumnType<boolean, boolean | undefined, boolean>;
  /** Operator-facing ordering; the "first" dev server (lowest sort_order, then
   *  created_at, then id) backs the legacy singular settings view. */
  sort_order: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Last normalized detector result for one project. Review state is persisted so
 * future mobile clients can suppress an unchanged result across devices. */
export interface DevServerDetectionStateTable {
  project_id: ColumnType<string, string, never>;
  fingerprint: string;
  detected_at: ColumnType<Date, string | undefined, string | undefined>;
  reviewed_fingerprint: ColumnType<string | null, string | null | undefined, string | null>;
  reviewed_at: ColumnType<Date | null, string | null | undefined, string | null>;
}

/** One temporary public link to a generation-bound project dev server. Secret
 * material is encrypted by EventStore before it reaches the three *_secret
 * columns. */
export interface PublicPreviewSharesTable {
  id: string;
  project_id: string;
  dev_server_id: string | null;
  container_generation: string;
  target_port: number | null;
  target_kind: 'dev-server' | 'static-folder';
  static_path: string | null;
  state: string;
  public_origin: string;
  edge_url: string;
  pin_hash_secret: string;
  connector_token_secret: string;
  session_secret: string;
  connector_container_name: string;
  connector_container_id: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: ColumnType<Date, string, never>;
  revoked_at: ColumnType<Date | null, string | null | undefined, string | null>;
  failure: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

export interface UplinkPendingShareRemovalsTable {
  share_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Singleton (id='global') Verity-owned Claude-egress CA + gateway server
 * identity (ADR 0006 D10). `ca_key_pem` and `gateway_key_pem` are SECRETS,
 * encrypted at rest by the store's SecretCipher before they reach these columns
 * (same pattern as the verity_settings/project_settings secret columns); the
 * certs + server name are non-secret public material. The CA private key stays
 * server-side and is never projected into a Sandbox. */
interface ClaudeEgressCaTable {
  id: string;
  ca_cert_pem: ColumnType<string, string, string>;
  ca_key_pem: ColumnType<string, string, string>;
  gateway_server_name: ColumnType<string, string, string>;
  gateway_cert_pem: ColumnType<string, string, string>;
  gateway_key_pem: ColumnType<string, string, string>;
  ca_expires_at: ColumnType<Date, string, string>;
  gateway_expires_at: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Per-project Claude-egress client identity, keyed by project_id (PK, FK→
 * projects cascade). `key_pem` is a SECRET (encrypted at rest); the cert +
 * fingerprint are non-secret. The fingerprint feeds the gateway's
 * fingerprint→project peer bindings. */
interface ClaudeEgressClientCertTable {
  project_id: string;
  cert_pem: ColumnType<string, string, string>;
  key_pem: ColumnType<string, string, string>;
  fingerprint256: ColumnType<string, string, string>;
  expires_at: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface SecretJobsTable {
  job_id: string;
  actor_id: string;
  authorization_hash: string;
  state: string;
  result_json: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

interface SecretProviderCredentialsTable {
  credential_ref: string;
  project_id: string;
  ciphertext: string;
  updated_at: ColumnType<Date, string | undefined, string>;
}

interface SecretProviderBindingsTable {
  id: string;
  project_id: string;
  version: number;
  provider: string;
  credential_ref: string;
  doppler_project: string;
  doppler_config: string;
  state: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface SecretAliasesTable {
  id: string;
  project_id: string;
  version: number;
  name: string;
  description: string;
  binding_json: string;
  provider_key: string;
  injection_json: string;
  profile_json: string;
  state: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface SecretExecutionProfilesTable {
  id: string;
  project_id: string;
  version: number;
  profile_json: string;
  state: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface SecretProviderPermissionsTable {
  id: string;
  project_id: string;
  binding_id: string;
  binding_version: number;
  secret_name: string;
  tool_id: string;
  scope: string;
  session_id: string | null;
  expires_at: ColumnType<Date | null, string | null | undefined, string | null>;
  remaining_uses: number | null;
  granted_by: string;
  /** Which subsystem issued this row. The table has two independent writers, and a
   *  `tool_id` prefix does not tell them apart (a catalog profile id may contain `:`),
   *  so the brokered-prompt grant store keys its list/revoke/auto-approve on this.
   *  NULL means the catalog authorization path or a row predating migration 0070. */
  issuer: string | null;
  state: string;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

interface ControlPlaneGenerationTable {
  singleton: boolean;
  generation: number;
  holder_id: string | null;
  operation_id: string | null;
  state: 'active' | 'quiesced';
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface WorkflowServicesTable {
  id: string;
  source_project_id: string;
  source_repository: string;
  image_repository: string;
  deployments: unknown;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface WorkflowsTable {
  id: string;
  version: number;
  template_kind: string;
  template_version: number;
  control_project_id: string;
  root_session_id: string | null;
  created_by_actor_id: string;
  objective: string;
  environment: string;
  service_id: string;
  state: string;
  blocker: unknown;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface WorkflowStepsTable {
  id: string;
  workflow_id: string;
  ordinal: number;
  kind: string;
  target_project_id: string | null;
  depends_on: string[];
  state: string;
  attempt: number;
  max_attempts: number;
  input_artifact_refs: string[];
  completion_gate: string;
  lease_expires_at: ColumnType<Date | null, string | null | undefined, string | null>;
  next_reconcile_at: ColumnType<Date | null, string | null | undefined, string | null>;
  expected_evidence: unknown;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface WorkflowHandoffsTable {
  id: string;
  workflow_id: string;
  step_id: string;
  attempt: number;
  target_project_id: string;
  kind: string;
  payload: unknown;
  capability_hash: string;
  expires_at: ColumnType<Date, string, string>;
  session_id: string | null;
  previous_handoff_id: string | null;
  dispatched_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowResultsTable {
  handoff_id: string;
  attempt: number;
  status: string;
  summary: string;
  outputs: unknown;
  evidence: unknown;
  blocker: unknown;
  submitted_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowArtifactsTable {
  id: string;
  workflow_id: string;
  producer_step_id: string;
  type: string;
  uri: string;
  digest: string | null;
  metadata: unknown;
  verified_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowEventsTable {
  id: Generated<number>;
  workflow_id: string;
  event_id: string;
  kind: string;
  actor_type: string;
  actor_id: string;
  previous_state: string | null;
  new_state: string | null;
  policy_decision_id: string | null;
  payload: unknown;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowProviderInboxTable {
  id: Generated<number>;
  provider: string;
  delivery_id: string;
  event_type: string;
  payload: unknown;
  received_at: ColumnType<Date, string | undefined, never>;
  processed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  error: string | null;
}

export interface WorkflowDispatchOutboxTable {
  id: string;
  workflow_id: string;
  step_id: string;
  attempt: number;
  kind: string;
  payload: unknown;
  available_at: ColumnType<Date, string, string>;
  claimed_until: ColumnType<Date | null, string | null | undefined, string | null>;
  completed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  attempts: number;
  last_error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowCommandsTable {
  actor_id: string;
  idempotency_key: string;
  workflow_id: string | null;
  command_kind: string;
  request_hash: string;
  response: unknown;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface WorkflowPolicyDecisionsTable {
  id: string;
  workflow_id: string;
  transition: string;
  actor_id: string;
  authorization_hash: string;
  decision: string;
  reason: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface Database {
  workflow_services: WorkflowServicesTable;
  workflows: WorkflowsTable;
  workflow_steps: WorkflowStepsTable;
  workflow_handoffs: WorkflowHandoffsTable;
  workflow_results: WorkflowResultsTable;
  workflow_artifacts: WorkflowArtifactsTable;
  workflow_events: WorkflowEventsTable;
  workflow_provider_inbox: WorkflowProviderInboxTable;
  workflow_dispatch_outbox: WorkflowDispatchOutboxTable;
  workflow_commands: WorkflowCommandsTable;
  workflow_policy_decisions: WorkflowPolicyDecisionsTable;
  control_plane_generation: ControlPlaneGenerationTable;
  sessions: SessionsTable;
  events: EventsTable;
  messages: MessagesTable;
  message_projection_state: MessageProjectionStateTable;
  transcript_lines: TranscriptLinesTable;
  attachments: AttachmentsTable;
  queued_turns: QueuedTurnsTable;
  running_turns: RunningTurnsTable;
  projects: ProjectsTable;
  project_identity_claims: ProjectIdentityClaimsTable;
  project_settings: ProjectSettingsTable;
  verity_settings: VeritySettingsTable;
  secret_key_meta: SecretKeyMetaTable;
  auth_tokens: AuthTokenTable;
  device_push_tokens: DevicePushTokensTable;
  push_receipts: PushReceiptsTable;
  session_backend_state: SessionBackendStateTable;
  session_pending_note: SessionPendingNoteTable;
  session_automation_marker: SessionAutomationMarkerTable;
  gh_token_capabilities: GhTokenCapabilitiesTable;
  signing_capabilities: SigningCapabilitiesTable;
  secret_run_grants: SecretRunGrantsTable;
  secret_approvals: SecretApprovalsTable;
  secret_revocations: SecretRevocationsTable;
  secret_audit_events: SecretAuditEventsTable;
  audit_mac_keys: AuditMacKeysTable;
  secret_job_frames: SecretJobFramesTable;
  secret_jobs: SecretJobsTable;
  secret_provider_credentials: SecretProviderCredentialsTable;
  secret_provider_bindings: SecretProviderBindingsTable;
  secret_aliases: SecretAliasesTable;
  secret_execution_profiles: SecretExecutionProfilesTable;
  secret_provider_permissions: SecretProviderPermissionsTable;
  brokered_grant_approvals: BrokeredGrantApprovalsTable;
  brokered_http_consumptions: BrokeredHttpConsumptionsTable;
  agent_loops: AgentLoopsTable;
  agent_loop_runs: AgentLoopRunsTable;
  runner_frames: RunnerFramesTable;
  dev_servers: DevServersTable;
  dev_server_detection_state: DevServerDetectionStateTable;
  public_preview_shares: PublicPreviewSharesTable;
  uplink_pending_share_removals: UplinkPendingShareRemovalsTable;
  claude_egress_ca: ClaudeEgressCaTable;
  claude_egress_client_certs: ClaudeEgressClientCertTable;
}
