import type { ColumnType } from 'kysely';

// Google Workspace file assignments and Slides bookkeeping, part of `Database` in schema.ts.

interface GoogleWorkspaceRecentsTable {
  account_id: string;
  file_id: string;
  kind: 'docs' | 'sheets' | 'slides';
  last_assigned_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Workspace file ids ordered by their latest explicit assignment. */
interface RecentGoogleSlideDecksTable {
  account_id: ColumnType<string | null, string | null | undefined, string | null>;
  file_id: string;
  kind: 'slides' | 'docs' | 'sheets';
  last_assigned_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Durable cleanup outbox created before a temporary Drive image becomes public. */
interface GoogleSlideImageCleanupTable {
  account_id: ColumnType<string | null, string | null | undefined, string | null>;
  id: string;
  session_id: string;
  file_id: string;
  permission_id: string | null;
  ready_at: ColumnType<Date | null, string | null | undefined, string | null>;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Durable at-most-once fence for non-idempotent Slides gateway invocations. */
interface GoogleSlideInvocationsTable {
  invocation_id: string;
  session_id: string;
  turn_id: string;
  result_json: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface GoogleWorkspaceDatabase {
  google_workspace_recents: GoogleWorkspaceRecentsTable;
  recent_google_slide_decks: RecentGoogleSlideDecksTable;
  google_slide_image_cleanup: GoogleSlideImageCleanupTable;
  google_slide_invocations: GoogleSlideInvocationsTable;
}
