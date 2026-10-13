import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.js';
import type { SecretCipher } from './crypto.js';

export interface MatrixSendSnapshot {
  accountId: string;
  endpoint: string;
  roomId: string;
  roomName: string;
  bindingVersion: number;
  body: string;
}
export interface MatrixDelivery {
  invocationId: string;
  state: 'queued' | 'pending' | 'sent' | 'failed' | 'cancelled';
  eventId: string | null;
  error: string | null;
}
export interface MatrixDispatch extends MatrixSendSnapshot {
  invocationId: string;
  transactionId: string;
  leaseId: string;
}

function sameSnapshot(a: MatrixSendSnapshot, b: MatrixSendSnapshot): boolean {
  return (
    a.accountId === b.accountId &&
    a.endpoint === b.endpoint &&
    a.roomId === b.roomId &&
    a.roomName === b.roomName &&
    a.bindingVersion === b.bindingVersion &&
    a.body === b.body
  );
}

class MatrixDestinationError extends Error {}

export class MatrixOutboundStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  private async snapshot(
    db: Kysely<Database> | Transaction<Database>,
    projectId: string,
    accountId: string,
    roomId: string,
    body: string,
    lock = false,
  ): Promise<MatrixSendSnapshot> {
    let query = db
      .selectFrom('integration_sources')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('source_id', '=', roomId);
    if (lock) query = query.forUpdate();
    const source = await query.executeTakeFirst();
    const account = await db
      .selectFrom('integration_accounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirst();
    const config = await db
      .selectFrom('matrix_connector_config')
      .selectAll()
      .where('id', '=', 'matrix')
      .executeTakeFirst();
    if (
      !source ||
      source.project_id !== projectId ||
      source.status !== 'active' ||
      !source.activated_at ||
      !account ||
      account.provider !== 'matrix' ||
      !config ||
      config.endpoint !== account.endpoint ||
      config.username !== accountId
    ) {
      throw new MatrixDestinationError('Matrix room is not active for this project and account');
    }
    return {
      accountId,
      endpoint: account.endpoint,
      roomId,
      roomName: source.display_name,
      bindingVersion: source.binding_version,
      body,
    };
  }

  async prepare(
    projectId: string,
    accountId: string,
    roomId: string,
    body: string,
  ): Promise<MatrixSendSnapshot> {
    return this.snapshot(this.db, projectId, accountId, roomId, body);
  }

  async validate(projectId: string, snapshot: MatrixSendSnapshot): Promise<void> {
    const current = await this.prepare(
      projectId,
      snapshot.accountId,
      snapshot.roomId,
      snapshot.body,
    );
    if (!sameSnapshot(current, snapshot))
      throw new MatrixDestinationError(
        'Matrix destination changed; prepare a new send and obtain approval',
      );
  }

  async enqueue(input: {
    projectId: string;
    sessionId: string;
    invocationId: string;
    approvedByCard?: boolean;
    snapshot: MatrixSendSnapshot;
  }): Promise<MatrixDelivery> {
    if (input.approvedByCard !== true)
      throw new Error('Each Matrix send requires explicit approval');
    return this.db.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom('sessions')
        .select('project_id')
        .where('session_id', '=', input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (session?.project_id !== input.projectId)
        throw new Error('Matrix session belongs to another project');
      const current = await this.snapshot(
        tx,
        input.projectId,
        input.snapshot.accountId,
        input.snapshot.roomId,
        input.snapshot.body,
        true,
      );
      if (!sameSnapshot(current, input.snapshot))
        throw new MatrixDestinationError(
          'Matrix destination changed; prepare a new send and obtain approval',
        );
      await tx
        .insertInto('matrix_outbound')
        .values({
          invocation_id: input.invocationId,
          session_id: input.sessionId,
          project_id: input.projectId,
          account_id: current.accountId,
          source_id: current.roomId,
          binding_version: current.bindingVersion,
          payload_secret: this.cipher.encrypt(JSON.stringify(current)),
          transaction_id: `verity-${input.invocationId}`,
          state: 'queued',
          lease_id: null,
          lease_until: null,
          event_id: null,
          error: null,
        })
        .onConflict((c) => c.column('invocation_id').doNothing())
        .execute();
      const row = await tx
        .selectFrom('matrix_outbound')
        .selectAll()
        .where('invocation_id', '=', input.invocationId)
        .executeTakeFirstOrThrow();
      if (
        row.session_id !== input.sessionId ||
        row.project_id !== input.projectId ||
        !sameSnapshot(
          JSON.parse(this.cipher.decrypt(row.payload_secret)) as MatrixSendSnapshot,
          input.snapshot,
        )
      ) {
        throw new Error('Matrix invocation was already used for another message');
      }
      return this.delivery(row);
    });
  }

  private delivery(row: {
    invocation_id: string;
    state: string;
    event_id: string | null;
    error: string | null;
  }): MatrixDelivery {
    return {
      invocationId: row.invocation_id,
      state: row.state as MatrixDelivery['state'],
      eventId: row.event_id,
      error: row.error,
    };
  }

  private async valid(row: {
    project_id: string;
    session_id: string;
    payload_secret: string;
  }): Promise<boolean> {
    const session = await this.db
      .selectFrom('sessions')
      .select('project_id')
      .where('session_id', '=', row.session_id)
      .executeTakeFirst();
    if (session?.project_id !== row.project_id) return false;
    try {
      await this.validate(
        row.project_id,
        JSON.parse(this.cipher.decrypt(row.payload_secret)) as MatrixSendSnapshot,
      );
      return true;
    } catch (error) {
      if (error instanceof MatrixDestinationError) return false;
      throw error;
    }
  }

  async status(
    projectId: string,
    sessionId: string,
    invocationId: string,
  ): Promise<MatrixDelivery | null> {
    const row = await this.db
      .selectFrom('matrix_outbound')
      .selectAll()
      .where('invocation_id', '=', invocationId)
      .where('project_id', '=', projectId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!row) return null;
    if ((row.state === 'queued' || row.state === 'pending') && !(await this.valid(row))) {
      await this.cancel(invocationId);
      return this.status(projectId, sessionId, invocationId);
    }
    return this.delivery(row);
  }

  private async cancel(invocationId: string): Promise<void> {
    await this.db
      .updateTable('matrix_outbound')
      .set({
        state: 'cancelled',
        error: 'Access revoked; an in-flight Matrix send may already have been accepted',
      })
      .where('invocation_id', '=', invocationId)
      .where('state', 'in', ['queued', 'pending'])
      .execute();
  }

  async claim(accountId: string): Promise<MatrixDispatch | null> {
    // Expired claims retain their transaction ID: a lost Matrix response must not duplicate a message.
    for (let n = 0; n < 20; n++) {
      const row = await this.db.transaction().execute(async (tx) => {
        const now = new Date();
        const candidate = await tx
          .selectFrom('matrix_outbound')
          .selectAll()
          .where('account_id', '=', accountId)
          .where('state', 'in', ['queued', 'pending'])
          .where('next_attempt_at', '<=', now)
          .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', now)]))
          .orderBy('created_at')
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!candidate) return null;
        return tx
          .updateTable('matrix_outbound')
          .set({
            state: 'pending',
            lease_id: randomUUID(),
            lease_until: new Date(now.getTime() + 180_000),
            attempts: candidate.attempts + 1,
          })
          .where('invocation_id', '=', candidate.invocation_id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      if (!row) return null;
      if (!(await this.valid(row))) {
        await this.cancel(row.invocation_id);
        continue;
      }
      return {
        ...(JSON.parse(this.cipher.decrypt(row.payload_secret)) as MatrixSendSnapshot),
        invocationId: row.invocation_id,
        transactionId: row.transaction_id,
        leaseId: row.lease_id!,
      };
    }
    return null;
  }

  async checkLease(accountId: string, invocationId: string, leaseId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('matrix_outbound')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('invocation_id', '=', invocationId)
      .where('lease_id', '=', leaseId)
      .where('state', '=', 'pending')
      .executeTakeFirst();
    if (!row || !row.lease_until || row.lease_until <= new Date()) return false;
    if (!(await this.valid(row))) {
      await this.cancel(invocationId);
      return false;
    }
    // Validation awaits I/O; movement or lease recovery can revoke this attempt meanwhile.
    const current = await this.db
      .selectFrom('matrix_outbound')
      .select('invocation_id')
      .where('account_id', '=', accountId)
      .where('invocation_id', '=', invocationId)
      .where('lease_id', '=', leaseId)
      .where('state', '=', 'pending')
      .where('lease_until', '>', new Date())
      .executeTakeFirst();
    return current !== undefined;
  }

  async finish(
    accountId: string,
    invocationId: string,
    leaseId: string,
    result: {
      eventId?: string | undefined;
      error?: string | undefined;
      retryAfterMs?: number | undefined;
    },
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('matrix_outbound')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('invocation_id', '=', invocationId)
      .where('lease_id', '=', leaseId)
      .executeTakeFirst();
    if (!row || !['pending', 'cancelled'].includes(row.state)) return false;
    const valid = await this.valid(row);
    const state = result.eventId
      ? 'sent'
      : !valid || row.state === 'cancelled'
        ? 'cancelled'
        : result.retryAfterMs !== undefined
          ? 'pending'
          : 'failed';
    const update = await this.db
      .updateTable('matrix_outbound')
      .set((eb) => ({
        // A revocation committed while validation awaited must survive a late failure result.
        state: result.eventId
          ? state
          : eb
              .case()
              .when('state', '=', 'cancelled')
              .then('cancelled' as const)
              .else(state)
              .end(),
        event_id: result.eventId ?? null,
        error: result.eventId ? null : (result.error ?? 'Matrix send failed'),
        lease_until: null,
        next_attempt_at: new Date(Date.now() + Math.max(10_000, result.retryAfterMs ?? 0)),
      }))
      .where('invocation_id', '=', invocationId)
      .where('lease_id', '=', leaseId)
      .where('state', 'in', ['pending', 'cancelled'])
      .returning('invocation_id')
      .executeTakeFirst();
    return update !== undefined;
  }
}
