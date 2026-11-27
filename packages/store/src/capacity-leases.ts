import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export type CapacityLeaseKind = 'dependency-copy' | 'dependency-prepare' | 'dependency-private';
export type CapacityLeaseState = 'reserved' | 'started' | 'uncertain' | 'settled';

export interface CapacityLeaseInput {
  /** Client request UUID; an exact retry always returns this same durable lease. */
  id: string;
  projectId: string;
  userId: string;
  sessionId: string;
  containerGeneration: string;
  kind: CapacityLeaseKind;
  bytes: number;
  inodes: number;
}

export interface CapacityLease extends CapacityLeaseInput {
  state: CapacityLeaseState;
  createdAt: Date;
  updatedAt: Date;
}

export interface CapacityLeaseInventory {
  leases: CapacityLease[];
  /** A partial inventory must never be used to admit more filesystem work. */
  overflow: boolean;
}

export const CAPACITY_LEASE_INVENTORY_LIMIT = 10_000;
export class CapacityLeaseBindingConflictError extends Error {
  readonly code = 'capacity_lease_binding_conflict';
  constructor() {
    super('Capacity lease request id is already bound to a different operation');
    this.name = 'CapacityLeaseBindingConflictError';
  }
}
export class CapacityLeaseInputError extends Error {
  readonly code = 'capacity_lease_invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'CapacityLeaseInputError';
  }
}

interface Row {
  id: string;
  project_id: string;
  user_id: string;
  session_id: string;
  container_generation: string;
  kind: CapacityLeaseKind;
  bytes: string | number;
  inodes: string | number;
  state: CapacityLeaseState;
  created_at: Date;
  updated_at: Date;
}
const states = new Set<CapacityLeaseState>(['reserved', 'started', 'uncertain', 'settled']);
const kinds = new Set<CapacityLeaseKind>([
  'dependency-copy',
  'dependency-prepare',
  'dependency-private',
]);
const bindingFields = [
  'id',
  'projectId',
  'userId',
  'sessionId',
  'containerGeneration',
  'kind',
  'bytes',
  'inodes',
] as const;

function id(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value))
    throw new CapacityLeaseInputError('Capacity lease id must be a UUID');
  return value.toLowerCase();
}
function input(value: CapacityLeaseInput): CapacityLeaseInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !bindingFields.includes(key as (typeof bindingFields)[number]))
  )
    throw new CapacityLeaseInputError(
      'Capacity leases accept only operation bindings and resource amounts',
    );
  for (const field of ['projectId', 'userId', 'sessionId', 'containerGeneration'] as const) {
    if (typeof value[field] !== 'string' || !/^[A-Za-z0-9._:@-]{1,255}$/u.test(value[field]))
      throw new CapacityLeaseInputError(`Invalid capacity lease ${field}`);
  }
  if (!kinds.has(value.kind)) throw new CapacityLeaseInputError('Invalid capacity lease kind');
  for (const field of ['bytes', 'inodes'] as const)
    if (!Number.isSafeInteger(value[field]) || value[field] < 0)
      throw new CapacityLeaseInputError(
        `Capacity lease ${field} must be a safe nonnegative integer`,
      );
  return { ...value, id: id(value.id) };
}
function record(row: Row): CapacityLease {
  const bytes = Number(row.bytes),
    inodes = Number(row.inodes);
  if (![bytes, inodes].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Stored capacity lease resource amount is invalid');
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    sessionId: row.session_id,
    containerGeneration: row.container_generation,
    kind: row.kind,
    bytes,
    inodes,
    state: row.state,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Installation-wide durable reservations, without TTL expiry or deletion.
 * Transactional admission must serialize its inventory read and reserve call
 * externally; these methods never infer that an old operation has stopped. */
export class CapacityLeaseStore {
  constructor(private readonly db: Kysely<Database>) {}

  async get(requestId: string): Promise<CapacityLease | null> {
    const result =
      await sql<Row>`select * from dependency_capacity_leases where id=${id(requestId)}::uuid`.execute(
        this.db,
      );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async reserve(request: CapacityLeaseInput): Promise<CapacityLease> {
    const value = input(request);
    await sql`insert into dependency_capacity_leases
      (id,project_id,user_id,session_id,container_generation,kind,bytes,inodes,state)
      values (${value.id}::uuid,${value.projectId},${value.userId},${value.sessionId},${value.containerGeneration},${value.kind},${value.bytes},${value.inodes},'reserved')
      on conflict(id) do nothing`.execute(this.db);
    const lease = await this.get(value.id);
    if (!lease) throw new Error('Capacity lease reservation could not be read');
    if (bindingFields.some((field) => lease[field] !== value[field]))
      throw new CapacityLeaseBindingConflictError();
    return lease;
  }

  async listUnsettled(limit = 1000): Promise<CapacityLeaseInventory> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAPACITY_LEASE_INVENTORY_LIMIT)
      throw new CapacityLeaseInputError('Capacity lease inventory limit is out of bounds');
    const result = await sql<Row>`select * from dependency_capacity_leases where state <> 'settled'
      order by created_at,id limit ${limit + 1}`.execute(this.db);
    return {
      leases: result.rows.slice(0, limit).map(record),
      overflow: result.rows.length > limit,
    };
  }

  /** A terminal lease cannot be reopened, and an operation cannot become unstarted. */
  async transition(
    requestId: string,
    expectedStates: readonly CapacityLeaseState[],
    to: CapacityLeaseState,
  ): Promise<CapacityLease | null> {
    const leaseId = id(requestId);
    if (
      !states.has(to) ||
      to === 'reserved' ||
      expectedStates.length < 1 ||
      expectedStates.length > states.size ||
      expectedStates.some((state) => !states.has(state)) ||
      (to !== 'settled' && expectedStates.includes('settled'))
    )
      throw new CapacityLeaseInputError('Invalid capacity lease state transition');
    const result =
      await sql<Row>`update dependency_capacity_leases set state=${to},updated_at=greatest(updated_at,now())
      where id=${leaseId}::uuid and state in (${sql.join(expectedStates)}) returning *`.execute(
        this.db,
      );
    return result.rows[0] ? record(result.rows[0]) : null;
  }
}
