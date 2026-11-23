import type { ColumnType } from 'kysely';

// Tables of people in shared projects (ADR 0023), part of `Database` in schema.ts.

/** Local identity is separate from a paired device and from project access. */
interface UsersTable {
  id: string;
  role: 'administrator' | 'member';
  status: 'active' | 'disabled';
  /** Shown to other people in shared projects; never used for authorization. */
  display_name: string | null;
  /** How Uplink knows this person as a team member (D6), once they joined through it. */
  team_membership_ref: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface ProjectMembershipsTable {
  project_id: string;
  user_id: string;
  can_read: boolean;
  can_execute: boolean;
  /** "Code": the session's technical side and adding changes to the project's code. Needs `can_execute`. */
  can_code: ColumnType<boolean, boolean | undefined, boolean>;
  can_manage: boolean;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** A person's git author identity and commit signing key (ADR 0023 §3). */
interface UserGitIdentitiesTable {
  user_id: string;
  author_name: string | null;
  author_email: string | null;
  /** Encrypted at rest like the instance signing key. */
  ssh_private_key: string | null;
  ssh_public_key: string | null;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** A person's own authorization of the instance's GitHub App (ADR 0023 §3). */
interface UserProviderConnectionsTable {
  user_id: string;
  provider: 'claude' | 'codex' | 'opencode';
  /** Encrypted at rest: Claude OAuth credentials, Codex auth.json or an OpenCode key. */
  credential: string;
  base_url: ColumnType<string | null, string | null | undefined, string | null>;
  models: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface UserProjectPreferencesTable {
  user_id: string;
  project_id: string;
  default_model: ColumnType<string | null, string | null | undefined, string | null>;
  last_model: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface ProjectInvitationsTable {
  id: string;
  project_id: string;
  inviter_user_id: string;
  invitee_name: string;
  can_execute: boolean;
  /** Stays on this server: Uplink's invitation carries only read and execute. */
  can_code: ColumnType<boolean, boolean | undefined, boolean>;
  /** SHA-256 of the link secret; the secret itself is never stored. */
  secret_hash: string;
  /** The link secret, encrypted, while the invitation can still be shared; cleared
   *  once it is redeemed or revoked. */
  secret_encrypted: string | null;
  /** Uplink's invitation id (D4), once Uplink created the invitation. */
  invitation_id: string | null;
  /** `failed`: Uplink refused its join for good; the inviter invites again. */
  state: 'creating' | 'open' | 'redeemed' | 'revoked' | 'failed';
  expires_at: ColumnType<Date, string | Date, never>;
  created_at: ColumnType<Date, string | undefined, never>;
  /** The one redemption that used it; a replay of the same one changes nothing. */
  redemption_id: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

/** Core's stored decision on one team join's tunnel (team bootstrap v1). */
interface TeamJoinAdmissionsTable {
  session_id: string;
  /** Uplink's invitation id. */
  invitation_id: string;
  /** Minted by Uplink; the join accepts no other. */
  redemption_id: string;
  decision: 'accepted' | 'refused';
  device_token_encrypted: ColumnType<string | null, string | null | undefined, string | null>;
  device_token_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  expires_at: ColumnType<Date, string | Date, never>;
}

interface TeamOutboxTable {
  operation_id: string;
  kind: string;
  payload: ColumnType<unknown, string, string>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, string | Date | undefined, string | Date>;
  give_up_at: ColumnType<Date, string | Date, string | Date>;
  created_at: ColumnType<Date, string | undefined, never>;
  done_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  failed_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

interface SessionUserModelsTable {
  session_id: string;
  user_id: string;
  model: string;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface SessionCreatorsTable {
  session_id: string;
  user_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface ChangeSubmissionsTable {
  session_id: string;
  submitted_by: string;
  submitted_at: ColumnType<Date, string | undefined, string>;
  revision: string | null;
  pull_request_url: string | null;
  pull_request_head: string | null;
  state: string;
  updated_at: ColumnType<Date, string | undefined, string>;
}

interface ProjectSandboxesTable {
  project_id: string;
  user_id: string;
  /** The project's original container, kept under its pre-multi-user names. */
  project_default: ColumnType<boolean, boolean | undefined, never>;
  /** Container lifecycle of a person's sandbox; unused for the project default,
   *  which reports through `projects.state`. */
  state: ColumnType<string, string | undefined, string>;
  provision_error: ColumnType<string | null, string | null | undefined, string | null>;
  state_changed_at: ColumnType<Date, string | undefined, string | undefined>;
  created_at: ColumnType<Date, string | undefined, never>;
}

interface UserDopplerConnectionsTable {
  user_id: string;
  project_id: string;
  /** Encrypted at rest. */
  token: string;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

interface UserGithubAuthorizationsTable {
  user_id: string;
  github_user_id: string;
  login: string;
  /** Encrypted at rest. */
  access_token: string;
  access_expires_at: ColumnType<Date | null, string | null | undefined, string | null>;
  /** Encrypted at rest. */
  refresh_token: string | null;
  refresh_expires_at: ColumnType<Date | null, string | null | undefined, string | null>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** The tables above, by name; `Database` extends this. */
export interface PeopleDatabase {
  users: UsersTable;
  project_memberships: ProjectMembershipsTable;
  user_git_identities: UserGitIdentitiesTable;
  user_github_authorizations: UserGithubAuthorizationsTable;
  user_doppler_connections: UserDopplerConnectionsTable;
  project_sandboxes: ProjectSandboxesTable;
  user_provider_connections: UserProviderConnectionsTable;
  user_project_preferences: UserProjectPreferencesTable;
  session_user_models: SessionUserModelsTable;
  session_creators: SessionCreatorsTable;
  change_submissions: ChangeSubmissionsTable;
  project_invitations: ProjectInvitationsTable;
  team_outbox: TeamOutboxTable;
  team_join_admissions: TeamJoinAdmissionsTable;
}
