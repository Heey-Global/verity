import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

/**
 * Durable audit events (ADR 0028), first stage: project image builds and image
 * lifecycle. Each project has its own append-only, hash-chained stream, and events
 * without a project go to one installation stream. The legacy secret chain
 * (`secret-audit-log.ts`) is a separate store and is not written here.
 *
 * Integrity verification, head records, retention and pruning are later stages; the
 * `audit_streams` columns for them exist so the allocation counter never has to move.
 */

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_GENESIS_HASH = '0'.repeat(64);
export const AUDIT_INSTALLATION_STREAM = 'installation';

export function projectAuditStream(projectId: string): string {
  return `project:${projectId}`;
}

/** Who started an operation. Request text never sets it: callers pass what the
 *  authenticated request, the agent turn or the system job established. */
export const auditInitiatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1).nullable() }).strict(),
  z
    .object({
      kind: z.literal('session'),
      sessionId: z.string().min(1),
      userId: z.string().min(1).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('system'),
      trigger: z.enum(['sandbox_wake', 'sandbox_reconcile', 'welcome_project', 'image_cleanup']),
    })
    .strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type AuditInitiator = z.infer<typeof auditInitiatorSchema>;

export const UNKNOWN_INITIATOR: AuditInitiator = { kind: 'unknown' };

const digest = z.string().min(1).max(200);

/** Allowlisted payloads per event kind. Nothing else is persisted: no build output,
 *  environment, registry credential or error text. */
const payloads = {
  'build.requested': z
    .object({
      imageTag: z.string().min(1).max(300),
      forceRebuild: z.boolean(),
      commit: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .nullable(),
      baseImageRef: z.string().min(1).max(500),
      /** Content hash over the devcontainer configuration and base image; never secret-bearing. */
      configFingerprint: z.string().regex(/^[0-9a-f]{8,128}$/),
      features: z.array(z.string().min(1).max(500)).max(20),
    })
    .strict(),
  'build.succeeded': z
    .object({
      imageId: digest.nullable(),
      sizeBytes: z.number().int().nonnegative().nullable(),
      baseImageDigest: digest.nullable(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  'build.failed': z
    .object({ reason: z.literal('build_failed'), durationMs: z.number().int().nonnegative() })
    .strict(),
  'image.removed': z
    .object({ imageRef: z.string().min(1).max(500), reason: z.literal('cleanup') })
    .strict(),
  'project.deleted': z.object({}).strict(),
  /** Best-effort writes of this process that failed; counted on the process clock. */
  'audit.write_gap': z
    .object({
      failedWrites: z.number().int().positive(),
      kinds: z.record(z.string(), z.number().int().positive()),
      firstFailureAt: z.string().datetime(),
      lastFailureAt: z.string().datetime(),
    })
    .strict(),
} as const;

export type AuditEventKind = keyof typeof payloads;
export type AuditPayload<K extends AuditEventKind> = z.infer<(typeof payloads)[K]>;

const DOMAINS: Record<AuditEventKind, AuditDomain> = {
  'build.requested': 'builds',
  'build.succeeded': 'builds',
  'build.failed': 'builds',
  'image.removed': 'images',
  'project.deleted': 'resources',
  'audit.write_gap': 'integrity',
};
export type AuditDomain = 'builds' | 'images' | 'resources' | 'integrity';
export const AUDIT_DOMAINS: readonly AuditDomain[] = ['builds', 'images', 'resources', 'integrity'];

export interface AuditServerIdentity {
  release: string;
  generation: number | null;
}

export type AuditEventInput = {
  [K in AuditEventKind]: {
    kind: K;
    payload: AuditPayload<K>;
    operationId: string;
    streamId: string;
    projectId?: string | null;
    projectLabel?: string | null;
    imageId?: string | null;
    initiator: AuditInitiator;
    server: AuditServerIdentity;
  };
}[AuditEventKind];

export interface AuditEvent {
  schemaVersion: number;
  eventId: string;
  streamId: string;
  sequence: number;
  recordedAt: string;
  operationId: string;
  domain: AuditDomain;
  kind: AuditEventKind;
  projectId: string | null;
  projectLabel: string | null;
  imageId: string | null;
  initiator: AuditInitiator;
  server: AuditServerIdentity;
  payload: Record<string, unknown>;
  prevHash: string;
  eventHash: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Domain-separated pre-image so an audit event hash can never collide with a
 *  secret-audit hash over the same bytes. */
export function auditEventHash(event: Omit<AuditEvent, 'eventHash'>): string {
  return sha256Hex(`verity.audit.v1\0${canonicalJson(event)}`);
}

export interface AuditOperationQuery {
  domain?: AuditDomain | undefined;
  /** Operation ID, image ID/digest fragment or project label fragment. */
  search?: string | undefined;
  /** `nextBefore` of the previous page. */
  before?: string | undefined;
  limit?: number | undefined;
}

export interface AuditLog {
  /** Append one event. With `txn` it co-commits with the caller's transaction and a
   *  failure propagates; without, it runs in its own transaction. */
  append(input: AuditEventInput, txn?: Transaction<Database>): Promise<AuditEvent>;
  /** Events grouped by operation, newest operation first. */
  listOperations(query: AuditOperationQuery): Promise<{
    operations: AuditEvent[][];
    nextBefore: string | null;
  }>;
  operation(operationId: string): Promise<AuditEvent[]>;
  /** Time of the oldest retained event, or null for an empty trail. */
  oldestRecordedAt(): Promise<string | null>;
}

function validate(input: AuditEventInput): AuditEventInput {
  const payload = payloads[input.kind].parse(input.payload);
  return {
    ...input,
    initiator: auditInitiatorSchema.parse(input.initiator),
    payload,
  } as AuditEventInput;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function appendWithin(exec: Kysely<Database>, input: AuditEventInput): Promise<AuditEvent> {
  // Serializes appends per stream; released when the enclosing transaction ends.
  await sql`select pg_advisory_xact_lock(hashtext(${`verity.audit:${input.streamId}`}))`.execute(
    exec,
  );
  await exec
    .insertInto('audit_streams')
    .values({ stream_id: input.streamId, next_sequence: 0, unverified: false })
    .onConflict((oc) => oc.column('stream_id').doNothing())
    .execute();
  const stream = await exec
    .selectFrom('audit_streams')
    .select('next_sequence')
    .where('stream_id', '=', input.streamId)
    .executeTakeFirstOrThrow();
  const previous = await exec
    .selectFrom('audit_events')
    .select('event_hash')
    .where('stream_id', '=', input.streamId)
    .orderBy('sequence', 'desc')
    .limit(1)
    .executeTakeFirst();
  // Database time, so events written by different Server processes order on one clock.
  // `clock_timestamp()`, not `now()`: the transaction may have waited on the lock, and
  // its start time would sort this event before its chain predecessor.
  const now = await sql<{ now: Date | string }>`select clock_timestamp() as now`.execute(exec);
  const base: Omit<AuditEvent, 'eventHash'> = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId: randomUUID(),
    streamId: input.streamId,
    sequence: stream.next_sequence,
    recordedAt: iso(now.rows[0]!.now),
    operationId: input.operationId,
    domain: DOMAINS[input.kind],
    kind: input.kind,
    projectId: input.projectId ?? null,
    projectLabel: input.projectLabel ?? null,
    imageId: input.imageId ?? null,
    initiator: input.initiator,
    server: { release: input.server.release, generation: input.server.generation },
    payload: input.payload,
    prevHash: previous?.event_hash ?? AUDIT_GENESIS_HASH,
  };
  const event: AuditEvent = { ...base, eventHash: auditEventHash(base) };
  await exec
    .updateTable('audit_streams')
    .set({ next_sequence: event.sequence + 1 })
    .where('stream_id', '=', event.streamId)
    .execute();
  await exec
    .insertInto('audit_events')
    .values({
      stream_id: event.streamId,
      sequence: event.sequence,
      event_id: event.eventId,
      schema_version: event.schemaVersion,
      recorded_at: event.recordedAt,
      operation_id: event.operationId,
      domain: event.domain,
      kind: event.kind,
      // Denormalized for grouping and search only; `event_json` stays the authority.
      project_id: event.projectId,
      project_label: event.projectLabel,
      image_id: event.imageId,
      event_json: canonicalJson(event),
      prev_hash: event.prevHash,
      event_hash: event.eventHash,
    })
    .execute();
  return event;
}

function parseRow(row: { event_json: string }): AuditEvent {
  return JSON.parse(row.event_json) as AuditEvent;
}

function groupByOperation(events: AuditEvent[], order: string[]): AuditEvent[][] {
  const groups = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const list = groups.get(event.operationId) ?? [];
    list.push(event);
    groups.set(event.operationId, list);
  }
  return order.flatMap((id) => {
    const list = groups.get(id);
    // The stream position breaks ties between events recorded in the same millisecond,
    // so the first event — which the summary reads its start and kind from — is stable.
    return list
      ? [
          list.sort(
            (a, b) =>
              a.recordedAt.localeCompare(b.recordedAt) ||
              a.streamId.localeCompare(b.streamId) ||
              a.sequence - b.sequence,
          ),
        ]
      : [];
  });
}

/** Opaque paging cursor: the last operation's start time and ID. */
function encodeCursor(at: string, operationId: string): string {
  return Buffer.from(JSON.stringify([at, operationId]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; operationId: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      !Number.isNaN(Date.parse(value[0]))
    ) {
      return { at: value[0], operationId: value[1] };
    }
  } catch {
    // Fall through: an unreadable cursor starts from the newest entry.
  }
  return undefined;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createPostgresAuditLog(db: Kysely<Database>): AuditLog {
  return {
    async append(unparsed, txn) {
      const input = validate(unparsed);
      if (txn !== undefined) return appendWithin(txn, input);
      return db.transaction().execute((trx) => appendWithin(trx, input));
    },

    async listOperations(query) {
      const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      // Filters select operations; the start time is still taken over ALL their events,
      // so a filtered list sorts and groups by day exactly like the unfiltered one.
      let matching = db.selectFrom('audit_events').select('operation_id');
      const filtered = query.domain !== undefined || Boolean(query.search?.trim());
      if (query.domain !== undefined) matching = matching.where('domain', '=', query.domain);
      const search = query.search?.trim();
      if (search) {
        const term = search.replace(/^sha256:/i, '');
        const fragment = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
        // A bare `sha256:` must not turn into a pattern that matches everything.
        matching = matching.where((eb) =>
          term.length === 0
            ? eb('operation_id', '=', search)
            : eb.or([
                eb('operation_id', '=', search),
                eb('image_id', 'ilike', fragment),
                eb('project_label', 'ilike', fragment),
              ]),
        );
      }
      let starts = db
        .selectFrom('audit_events')
        .select([
          'operation_id',
          // Text, so the cursor round-trips the stored value exactly through Postgres.
          sql<string>`min(recorded_at)::text`.as('started_at'),
        ])
        .groupBy('operation_id');
      if (filtered) starts = starts.where('operation_id', 'in', matching);
      const cursor = decodeCursor(query.before);
      if (cursor !== undefined) {
        // Compound cursor: operations that started at the same instant are neither
        // skipped nor repeated across pages.
        starts = starts.having(
          sql<boolean>`(min(recorded_at), operation_id) < (${cursor.at}::timestamptz, ${cursor.operationId})`,
        );
      }
      const rows = await starts
        .orderBy(sql`min(recorded_at)`, 'desc')
        .orderBy('operation_id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const ids = page.map((row) => row.operation_id);
      const events =
        ids.length === 0
          ? []
          : (
              await db
                .selectFrom('audit_events')
                .select('event_json')
                .where('operation_id', 'in', ids)
                .execute()
            ).map(parseRow);
      const last = page.at(-1);
      return {
        operations: groupByOperation(events, ids),
        nextBefore:
          rows.length > limit && last !== undefined
            ? encodeCursor(last.started_at, last.operation_id)
            : null,
      };
    },

    async operation(operationId) {
      const rows = await db
        .selectFrom('audit_events')
        .select('event_json')
        .where('operation_id', '=', operationId)
        .execute();
      return groupByOperation(rows.map(parseRow), [operationId])[0] ?? [];
    },

    async oldestRecordedAt() {
      const row = await db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.min('recorded_at').as('oldest'))
        .executeTakeFirst();
      const oldest = row?.oldest as Date | string | null | undefined;
      return oldest === null || oldest === undefined ? null : iso(oldest);
    },
  };
}
