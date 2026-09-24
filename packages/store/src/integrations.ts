import type { Kysely } from 'kysely';
import type { Database } from './schema.js';
import { type SecretCipher, createPassthroughCipher } from './crypto.js';

export type IntegrationProvider = 'matrix';
export type IntegrationSourceStatus = 'pending' | 'active' | 'paused';
export type IntegrationEventKind = 'message' | 'edit' | 'redaction';

export interface IntegrationAccount {
  id: string;
  provider: IntegrationProvider;
  endpoint: string;
  displayName: string;
  status: string;
  lastError: string | null;
}

export interface IntegrationSource {
  accountId: string;
  sourceId: string;
  displayName: string;
  inviter: string | null;
  projectId: string | null;
  status: IntegrationSourceStatus;
  activatedAt: Date | null;
  lastIngestedAt: Date | null;
  lastError: string | null;
}

export interface IntegrationEvent {
  accountId: string;
  sourceId: string;
  eventId: string;
  targetEventId: string | null;
  kind: IntegrationEventKind;
  sender: string;
  occurredAt: Date;
  body: string | null;
}

export class IntegrationStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {}

  async projectExists(id: string): Promise<boolean> {
    return (
      (await this.db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst()) !== undefined
    );
  }

  async matrixConfigSummary(): Promise<{
    endpoint: string;
    username: string;
    passwordConfigured: boolean;
  } | null> {
    const row = await this.db
      .selectFrom('matrix_connector_config')
      .selectAll()
      .where('id', '=', 'matrix')
      .executeTakeFirst();
    return row
      ? { endpoint: row.endpoint, username: row.username, passwordConfigured: true }
      : null;
  }

  async matrixConfigForWorker(): Promise<{
    endpoint: string;
    username: string;
    password: string;
  } | null> {
    const row = await this.db
      .selectFrom('matrix_connector_config')
      .selectAll()
      .where('id', '=', 'matrix')
      .executeTakeFirst();
    return row
      ? {
          endpoint: row.endpoint,
          username: row.username,
          password: this.cipher.decrypt(row.password_secret),
        }
      : null;
  }

  async saveMatrixConfig(input: {
    endpoint: string;
    username: string;
    password: string;
  }): Promise<void> {
    const previous = await this.matrixConfigSummary();
    if (
      previous &&
      (previous.endpoint !== input.endpoint || previous.username !== input.username)
    ) {
      throw new Error(
        'Changing the Matrix account requires resetting its device and room bindings',
      );
    }
    await this.db
      .insertInto('matrix_connector_config')
      .values({
        id: 'matrix',
        endpoint: input.endpoint,
        username: input.username,
        password_secret: this.cipher.encrypt(input.password),
      })
      .onConflict((c) =>
        c.column('id').doUpdateSet({ password_secret: this.cipher.encrypt(input.password) }),
      )
      .execute();
  }

  async upsertAccount(input: {
    id: string;
    provider: IntegrationProvider;
    endpoint: string;
    displayName: string;
    status: string;
    lastError?: string | null | undefined;
  }): Promise<void> {
    await this.db
      .insertInto('integration_accounts')
      .values({
        id: input.id,
        provider: input.provider,
        endpoint: input.endpoint,
        display_name: input.displayName,
        status: input.status,
        last_error: input.lastError ?? null,
        updated_at: new Date().toISOString(),
      })
      .onConflict((c) =>
        c.column('id').doUpdateSet({
          endpoint: input.endpoint,
          display_name: input.displayName,
          status: input.status,
          last_error: input.lastError ?? null,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async listAccounts(): Promise<IntegrationAccount[]> {
    const rows = await this.db.selectFrom('integration_accounts').selectAll().execute();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider as IntegrationProvider,
      endpoint: row.endpoint,
      displayName: row.display_name,
      status: row.status,
      lastError: row.last_error,
    }));
  }

  async discoverSource(input: {
    accountId: string;
    sourceId: string;
    displayName: string;
    inviter?: string | null | undefined;
  }): Promise<void> {
    await this.db
      .insertInto('integration_sources')
      .values({
        account_id: input.accountId,
        source_id: input.sourceId,
        display_name: input.displayName,
        inviter: input.inviter ?? null,
        project_id: null,
        status: 'pending',
        activated_at: null,
        last_ingested_at: null,
        last_error: null,
      })
      .onConflict((c) =>
        c.columns(['account_id', 'source_id']).doUpdateSet({
          display_name: input.displayName,
          inviter: input.inviter ?? null,
        }),
      )
      .execute();
  }

  async listSources(projectId?: string): Promise<IntegrationSource[]> {
    let query = this.db.selectFrom('integration_sources').selectAll();
    if (projectId) query = query.where('project_id', '=', projectId);
    const rows = await query.orderBy('display_name').execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      sourceId: row.source_id,
      displayName: row.display_name,
      inviter: row.inviter,
      projectId: row.project_id,
      status: (row.project_id ? row.status : 'pending') as IntegrationSourceStatus,
      activatedAt: row.activated_at,
      lastIngestedAt: row.last_ingested_at,
      lastError: row.last_error,
    }));
  }

  async setSourceBinding(
    accountId: string,
    sourceId: string,
    projectId: string | null,
  ): Promise<IntegrationSource | null> {
    const row = await this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('integration_sources')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('source_id', '=', sourceId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return null;
      if (projectId !== null && current.project_id && current.project_id !== projectId) {
        throw new Error('Source is already connected to another project');
      }
      if (projectId !== null) {
        const project = await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', projectId)
          .executeTakeFirst();
        if (!project) throw new Error('Project not found');
      }
      return tx
        .updateTable('integration_sources')
        .set({
          project_id: projectId,
          status: projectId ? 'active' : 'pending',
          activated_at: projectId ? (current.activated_at ?? new Date()) : null,
          last_error: null,
        })
        .where('account_id', '=', accountId)
        .where('source_id', '=', sourceId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return row
      ? {
          accountId: row.account_id,
          sourceId: row.source_id,
          displayName: row.display_name,
          inviter: row.inviter,
          projectId: row.project_id,
          status: row.status as IntegrationSourceStatus,
          activatedAt: row.activated_at,
          lastIngestedAt: row.last_ingested_at,
          lastError: row.last_error,
        }
      : null;
  }

  async setSourcePaused(accountId: string, sourceId: string, paused: boolean): Promise<void> {
    await this.db
      .updateTable('integration_sources')
      .set({ status: paused ? 'paused' : 'active' })
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .where('project_id', 'is not', null)
      .executeTakeFirst();
  }

  async deleteSource(accountId: string, sourceId: string): Promise<boolean> {
    const row = await this.db
      .deleteFrom('integration_sources')
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .returning('source_id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async ingestEvent(event: IntegrationEvent): Promise<{ projectId: string; inserted: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      const source = await tx
        .selectFrom('integration_sources')
        .select(['project_id', 'status', 'activated_at'])
        .where('account_id', '=', event.accountId)
        .where('source_id', '=', event.sourceId)
        .forUpdate()
        .executeTakeFirst();
      if (!source?.project_id || source.status !== 'active' || !source.activated_at) {
        throw new Error('Source is not connected to a project');
      }
      if (event.occurredAt < source.activated_at) {
        throw new Error('Event predates activation');
      }
      const inserted = await tx
        .insertInto('integration_events')
        .values({
          account_id: event.accountId,
          source_id: event.sourceId,
          event_id: event.eventId,
          target_event_id: event.targetEventId,
          kind: event.kind,
          sender: event.sender,
          occurred_at: event.occurredAt,
          body: event.body,
        })
        .onConflict((c) => c.columns(['account_id', 'source_id', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      return { projectId: source.project_id, inserted: inserted !== undefined };
    });
  }

  async markProjected(accountId: string, sourceId: string): Promise<void> {
    await this.db
      .updateTable('integration_sources')
      .set({ last_ingested_at: new Date(), last_error: null })
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .execute();
  }

  async getEvent(
    accountId: string,
    sourceId: string,
    eventId: string,
  ): Promise<IntegrationEvent | null> {
    const row = await this.db
      .selectFrom('integration_events')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    return row ? this.eventFromRow(row) : null;
  }

  async listEventsForDay(
    accountId: string,
    sourceId: string,
    day: string,
  ): Promise<IntegrationEvent[]> {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await this.db
      .selectFrom('integration_events')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .where('occurred_at', '>=', start)
      .where('occurred_at', '<', end)
      .orderBy('occurred_at')
      .orderBy('event_id')
      .execute();
    return rows.map((row) => this.eventFromRow(row));
  }

  async listChangesForTargets(
    accountId: string,
    sourceId: string,
    eventIds: string[],
  ): Promise<IntegrationEvent[]> {
    if (eventIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('integration_events')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('source_id', '=', sourceId)
      .where('target_event_id', 'in', eventIds)
      .orderBy('occurred_at')
      .orderBy('event_id')
      .execute();
    return rows.map((row) => this.eventFromRow(row));
  }

  private eventFromRow(row: {
    account_id: string;
    source_id: string;
    event_id: string;
    target_event_id: string | null;
    kind: string;
    sender: string;
    occurred_at: Date;
    body: string | null;
  }): IntegrationEvent {
    return {
      accountId: row.account_id,
      sourceId: row.source_id,
      eventId: row.event_id,
      targetEventId: row.target_event_id,
      kind: row.kind as IntegrationEventKind,
      sender: row.sender,
      occurredAt: row.occurred_at,
      body: row.body,
    };
  }
}
