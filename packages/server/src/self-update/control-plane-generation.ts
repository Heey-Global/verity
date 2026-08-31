import type { Database } from '@verity/store';
import type { Kysely, Transaction } from 'kysely';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const MAX_GENERATION = 2_147_483_647;

export interface ControlPlaneGeneration {
  readonly generation: number;
  readonly holderId: string | null;
  readonly operationId: string | null;
  readonly state: 'active' | 'quiesced';
}

export class GenerationFenceLostError extends Error {
  constructor() {
    super('control-plane generation fence is not held');
    this.name = 'GenerationFenceLostError';
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} is invalid`);
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_GENERATION)
    throw new Error('control-plane generation must be a non-negative PostgreSQL integer');
}

/** PostgreSQL is the sole generation authority. The updater never receives this API. */
export function createControlPlaneGenerationFence(db: Kysely<Database>) {
  const read = async (): Promise<ControlPlaneGeneration | null> => {
    const row = await db
      .selectFrom('control_plane_generation')
      .select(['generation', 'holder_id', 'operation_id', 'state'])
      .where('singleton', '=', true)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          generation: row.generation,
          holderId: row.holder_id,
          operationId: row.operation_id,
          state: row.state,
        };
  };

  const initialize = async (holderId: string, operationId: string): Promise<boolean> => {
    validateIdentifier(holderId, 'holder id');
    validateIdentifier(operationId, 'operation id');
    const result = await db
      .insertInto('control_plane_generation')
      .values({
        singleton: true,
        generation: 1,
        holder_id: holderId,
        operation_id: operationId,
        state: 'active',
      })
      .onConflict((conflict) => conflict.column('singleton').doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  };

  const quiesce = async (expected: ControlPlaneGeneration): Promise<boolean> => {
    validateGeneration(expected.generation);
    if (expected.holderId === null || expected.operationId === null || expected.state !== 'active')
      throw new Error('only an active generation can quiesce');
    const result = await db
      .updateTable('control_plane_generation')
      .set({ holder_id: null, state: 'quiesced', updated_at: new Date().toISOString() })
      .where('singleton', '=', true)
      .where('generation', '=', expected.generation)
      .where('holder_id', '=', expected.holderId)
      .where('operation_id', '=', expected.operationId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) === 1;
  };

  const acquire = async (options: {
    expectedGeneration: number;
    holderId: string;
    operationId: string;
  }): Promise<ControlPlaneGeneration | null> => {
    validateGeneration(options.expectedGeneration);
    validateIdentifier(options.holderId, 'holder id');
    validateIdentifier(options.operationId, 'operation id');
    if (options.expectedGeneration >= MAX_GENERATION)
      throw new Error('control-plane generation is exhausted');
    const row = await db
      .updateTable('control_plane_generation')
      .set({
        generation: options.expectedGeneration + 1,
        holder_id: options.holderId,
        operation_id: options.operationId,
        state: 'active',
        updated_at: new Date().toISOString(),
      })
      .where('singleton', '=', true)
      .where('generation', '=', options.expectedGeneration)
      .where('state', '=', 'quiesced')
      .returning(['generation', 'holder_id', 'operation_id', 'state'])
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          generation: row.generation,
          holderId: row.holder_id,
          operationId: row.operation_id,
          state: row.state,
        };
  };

  const assertActive = async (expected: {
    generation: number;
    holderId: string;
    operationId: string;
  }): Promise<void> => {
    validateGeneration(expected.generation);
    validateIdentifier(expected.holderId, 'holder id');
    validateIdentifier(expected.operationId, 'operation id');
    const row = await db
      .selectFrom('control_plane_generation')
      .select('generation')
      .where('singleton', '=', true)
      .where('generation', '=', expected.generation)
      .where('holder_id', '=', expected.holderId)
      .where('operation_id', '=', expected.operationId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (row === undefined) throw new GenerationFenceLostError();
  };

  const runActive = async <T>(
    expected: { generation: number; holderId: string; operationId: string },
    work: (transaction: Transaction<Database>) => Promise<T>,
  ): Promise<T> => {
    validateGeneration(expected.generation);
    validateIdentifier(expected.holderId, 'holder id');
    validateIdentifier(expected.operationId, 'operation id');
    return await db.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('control_plane_generation')
        .select('generation')
        .where('singleton', '=', true)
        .where('generation', '=', expected.generation)
        .where('holder_id', '=', expected.holderId)
        .where('operation_id', '=', expected.operationId)
        .where('state', '=', 'active')
        .forShare()
        .executeTakeFirst();
      if (row === undefined) throw new GenerationFenceLostError();
      return await work(transaction);
    });
  };

  return { read, initialize, quiesce, acquire, assertActive, runActive };
}

export type ControlPlaneGenerationFence = ReturnType<typeof createControlPlaneGenerationFence>;
