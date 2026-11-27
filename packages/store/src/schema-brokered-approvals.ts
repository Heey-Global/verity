import type { ColumnType, Generated } from 'kysely';

export interface BrokeredApprovalDatabase {
  brokered_tool_approvals: BrokeredToolApprovalsTable;
}

interface BrokeredToolApprovalsTable {
  scope_saved: Generated<boolean>;
  id: string;
  project_id: string;
  session_id: string;
  invocation_id: string;
  consumed_invocation_id: string | null;
  tool_name: 'verity_http_request' | 'verity_secret_run';
  canonical_input: string;
  request_mac: string;
  mac_key_id: string;
  authorization_snapshot: string;
  binding_digest: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  scope: 'once' | 'session' | 'project' | null;
  decided_by: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/**
 * Master-password key-derivation metadata (singleton, id='global'). Non-secret:
 * the scrypt `salt` and a `verifier` (a fixed marker encrypted under the derived
 * key). Kept in its OWN table, not in `verity_settings`, so it can be
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
