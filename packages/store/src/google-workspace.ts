import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { GoogleAccountStore } from './google-accounts.js';
import type { Database } from './schema.js';

export type GoogleWorkspaceFileKind = 'slides' | 'docs' | 'sheets';

export interface SessionWorkspaceFileRecord {
  accountEmail?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  folderLinkId?: string | null;
  credentialVersion?: number | null;
  sessionId: string;
  assignmentId: string;
  kind: GoogleWorkspaceFileKind;
  fileId: string;
  name: string;
  webViewLink: string;
  revisionId: string | null;
  assignedAt: Date;
}

/** @deprecated Use SessionWorkspaceFileRecord. */
export type SessionSlideDeckRecord = SessionWorkspaceFileRecord;

export interface GoogleSlideImageCleanupRecord {
  accountId?: string | null;
  id: string;
  sessionId: string;
  fileId: string;
  permissionId: string | null;
  readyAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export class GoogleWorkspaceStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly getGoogleAccounts: () => Pick<GoogleAccountStore, 'get'>,
  ) {}

  async getSessionWorkspaceFile(
    sessionId: string,
  ): Promise<SessionWorkspaceFileRecord | undefined> {
    const row = await this.getDb()
      .selectFrom('session_slide_decks')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const account = row.account_id ? await this.getGoogleAccounts().get(row.account_id) : undefined;
    return {
      accountEmail: account?.email ?? null,
      accountName: account?.displayName ?? null,
      accountId: row.account_id,
      folderLinkId: row.folder_link_id,
      credentialVersion: account?.credentialVersion ?? null,
      sessionId: row.session_id,
      assignmentId: row.assignment_id,
      kind: row.kind,
      fileId: row.file_id,
      name: row.name,
      webViewLink: row.web_view_link,
      revisionId: row.revision_id,
      assignedAt: row.assigned_at,
    };
  }

  async setSessionWorkspaceFile(input: {
    accountId?: string | null;
    folderLinkId?: string | null;
    sessionId: string;
    kind: GoogleWorkspaceFileKind;
    fileId: string;
    name: string;
    webViewLink: string;
    revisionId?: string | null;
  }): Promise<SessionWorkspaceFileRecord> {
    const row = await this.getDb()
      .transaction()
      .execute(async (trx) => {
        const assigned = await trx
          .insertInto('session_slide_decks')
          .values({
            account_id: input.accountId ?? null,
            folder_link_id: input.folderLinkId ?? null,
            session_id: input.sessionId,
            assignment_id: randomUUID(),
            kind: input.kind,
            file_id: input.fileId,
            name: input.name,
            web_view_link: input.webViewLink,
            revision_id: input.revisionId ?? null,
          })
          .onConflict((conflict) =>
            conflict.column('session_id').doUpdateSet({
              account_id: input.accountId ?? null,
              folder_link_id: input.folderLinkId ?? null,
              assignment_id: randomUUID(),
              kind: input.kind,
              file_id: input.fileId,
              name: input.name,
              web_view_link: input.webViewLink,
              revision_id: input.revisionId ?? null,
              assigned_at: sql`now()`,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        if (input.accountId)
          await trx
            .insertInto('google_workspace_recents')
            .values({
              account_id: input.accountId,
              file_id: input.fileId,
              kind: input.kind,
            })
            .onConflict((conflict) =>
              conflict
                .columns(['account_id', 'file_id'])
                .doUpdateSet({ kind: input.kind, last_assigned_at: sql`now()` }),
            )
            .execute();
        await trx
          .insertInto('recent_google_slide_decks')
          .values({ file_id: input.fileId, kind: input.kind, account_id: input.accountId ?? null })
          .onConflict((conflict) =>
            conflict
              .column('file_id')
              .doUpdateSet({ kind: input.kind, last_assigned_at: sql`now()` }),
          )
          .execute();
        return assigned;
      });
    return {
      accountId: row.account_id,
      folderLinkId: row.folder_link_id,
      sessionId: row.session_id,
      assignmentId: row.assignment_id,
      kind: row.kind,
      fileId: row.file_id,
      name: row.name,
      webViewLink: row.web_view_link,
      revisionId: row.revision_id,
      assignedAt: row.assigned_at,
    };
  }

  async clearSessionWorkspaceFile(sessionId: string): Promise<void> {
    await this.getDb()
      .deleteFrom('session_slide_decks')
      .where('session_id', '=', sessionId)
      .execute();
  }

  async clearSessionSlideDeck(sessionId: string): Promise<void> {
    await this.getDb()
      .deleteFrom('session_slide_decks')
      .where('session_id', '=', sessionId)
      .where('kind', '=', 'slides')
      .execute();
  }

  /** Persist an observed revision only while the same deck is still assigned.
   * A clear or replacement racing an API call must never be undone by its stale response. */
  async updateSessionWorkspaceRevision(
    sessionId: string,
    assignmentId: string,
    revisionId: string,
  ): Promise<boolean> {
    const result = await this.getDb()
      .updateTable('session_slide_decks')
      .set({ revision_id: revisionId })
      .where('session_id', '=', sessionId)
      .where('assignment_id', '=', assignmentId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async listRecentGoogleWorkspaceFileIds(limit = 8, accountId?: string): Promise<string[]> {
    if (accountId) {
      const rows = await this.getDb()
        .selectFrom('google_workspace_recents')
        .select('file_id')
        .where('account_id', '=', accountId)
        .orderBy('last_assigned_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => row.file_id);
    }
    const rows = await this.getDb()
      .selectFrom('recent_google_slide_decks')
      .select('file_id')
      .$if(accountId !== undefined, (query) => query.where('account_id', '=', accountId!))
      .orderBy('last_assigned_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.file_id);
  }

  async listRecentGoogleSlideDeckFileIds(limit = 8, accountId?: string): Promise<string[]> {
    if (accountId) {
      const rows = await this.getDb()
        .selectFrom('google_workspace_recents')
        .select('file_id')
        .where('account_id', '=', accountId)
        .where('kind', '=', 'slides')
        .orderBy('last_assigned_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => row.file_id);
    }
    const rows = await this.getDb()
      .selectFrom('recent_google_slide_decks')
      .select('file_id')
      .where('kind', '=', 'slides')
      .$if(accountId !== undefined, (query) => query.where('account_id', '=', accountId!))
      .orderBy('last_assigned_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.file_id);
  }

  async createGoogleSlideImageCleanup(input: {
    accountId?: string | null;
    id: string;
    sessionId: string;
    fileId: string;
  }): Promise<void> {
    await this.getDb()
      .transaction()
      .execute(async (tx) => {
        if (input.accountId != null) {
          // Keep account removal behind the cleanup record that retains its credentials.
          await tx
            .selectFrom('google_accounts')
            .select('id')
            .where('id', '=', input.accountId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        }
        await tx
          .insertInto('google_slide_image_cleanup')
          .values({
            id: input.id,
            session_id: input.sessionId,
            file_id: input.fileId,
            account_id: input.accountId ?? null,
          })
          .execute();
      });
  }

  async setGoogleSlideImageCleanupPermission(id: string, permissionId: string): Promise<void> {
    await this.getDb()
      .updateTable('google_slide_image_cleanup')
      .set({ permission_id: permissionId })
      .where('id', '=', id)
      .execute();
  }

  async markGoogleSlideImageCleanupReady(id: string): Promise<void> {
    await this.getDb()
      .updateTable('google_slide_image_cleanup')
      .set({ ready_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async failGoogleSlideImageCleanup(id: string, error: string): Promise<void> {
    await this.getDb()
      .updateTable('google_slide_image_cleanup')
      .set({ attempts: sql`attempts + 1`, last_error: error.slice(0, 200) })
      .where('id', '=', id)
      .execute();
  }

  async completeGoogleSlideImageCleanup(id: string): Promise<void> {
    await this.getDb().deleteFrom('google_slide_image_cleanup').where('id', '=', id).execute();
  }

  async listGoogleSlideImageCleanups(limit = 100): Promise<GoogleSlideImageCleanupRecord[]> {
    const rows = await this.getDb()
      .selectFrom('google_slide_image_cleanup')
      .selectAll()
      // A live insertion owns a fresh row. Explicitly finished rows are ready
      // immediately; an old unmarked row means the process died before finally.
      .where((eb) =>
        eb.or([
          eb('ready_at', 'is not', null),
          eb('created_at', '<', sql<Date>`now() - interval '10 minutes'`),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      id: row.id,
      sessionId: row.session_id,
      fileId: row.file_id,
      permissionId: row.permission_id,
      readyAt: row.ready_at,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
    }));
  }

  async claimGoogleSlideInvocation(input: {
    invocationId: string;
    sessionId: string;
    turnId: string;
  }): Promise<{ status: 'claimed' | 'pending' } | { status: 'completed'; result: unknown }> {
    const inserted = await this.getDb()
      .insertInto('google_slide_invocations')
      .values({
        invocation_id: input.invocationId,
        session_id: input.sessionId,
        turn_id: input.turnId,
      })
      .onConflict((conflict) => conflict.column('invocation_id').doNothing())
      .returning('invocation_id')
      .executeTakeFirst();
    if (inserted !== undefined) return { status: 'claimed' };
    const existing = await this.getDb()
      .selectFrom('google_slide_invocations')
      .select(['session_id', 'turn_id', 'result_json'])
      .where('invocation_id', '=', input.invocationId)
      .executeTakeFirstOrThrow();
    if (existing.session_id !== input.sessionId || existing.turn_id !== input.turnId) {
      throw new Error('Google Slides invocation id was reused across turns');
    }
    if (existing.result_json === null) return { status: 'pending' };
    return { status: 'completed', result: JSON.parse(existing.result_json) as unknown };
  }

  async completeGoogleSlideInvocation(invocationId: string, result: unknown): Promise<void> {
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) throw new Error('Google Slides invocation result is not JSON');
    await this.getDb()
      .updateTable('google_slide_invocations')
      .set({ result_json: resultJson })
      .where('invocation_id', '=', invocationId)
      .execute();
  }

  async getCompletedGoogleWorkspaceInvocation(input: {
    invocationId: string;
    sessionId: string;
    turnId: string;
  }): Promise<{ result: unknown } | undefined> {
    const row = await this.getDb()
      .selectFrom('google_slide_invocations')
      .select(['session_id', 'turn_id', 'result_json'])
      .where('invocation_id', '=', input.invocationId)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.session_id !== input.sessionId || row.turn_id !== input.turnId)
      throw new Error('Google Workspace invocation id was reused across turns');
    return row.result_json === null
      ? undefined
      : { result: JSON.parse(row.result_json) as unknown };
  }

  async pruneGoogleSlideInvocations(olderThan: Date): Promise<void> {
    await this.getDb()
      .deleteFrom('google_slide_invocations')
      .where('created_at', '<', olderThan)
      // The bearer that can replay this id exists only while its turn marker
      // exists. Keep the result for that entire lifetime, however old it gets.
      .where(
        sql<boolean>`not exists (
          select 1 from running_turns
          where running_turns.session_id = google_slide_invocations.session_id
            and running_turns.turn_id = google_slide_invocations.turn_id
        )`,
      )
      .execute();
  }
}
