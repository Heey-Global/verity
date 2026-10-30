import { sql, type Kysely } from 'kysely';
import { createPassthroughCipher, type SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

/**
 * A scheduling request: windows offered to one guest, held in the organizer's calendar.
 *
 * - `draft`: prepared by the agent, nothing has happened outside Verity yet.
 * - `provisioning`: approved; holds, the public link and the email are being set up.
 * - `open`: the guest can book until `closes_at`.
 * - `booked` / `expired` / `revoked`: closed; remaining holds are being or have been removed.
 * - `failed`: provisioning stopped; `failure` says why, and holds already created are removed.
 */
export type SchedulingRequestState =
  'draft' | 'provisioning' | 'open' | 'booked' | 'expired' | 'revoked' | 'failed';

/**
 * One offered window and its calendar event.
 *
 * - `pending`: the event is not known to exist yet.
 * - `active`: the hold exists.
 * - `converted`: the hold became the booked appointment.
 * - `cancel_pending` / `cancelled`: the hold is being or has been removed.
 */
export type SchedulingHoldState =
  'pending' | 'active' | 'converted' | 'cancel_pending' | 'cancelled';

export interface SchedulingColleague {
  email: string;
  name?: string;
}

export interface SchedulingRequest {
  id: string;
  sessionId: string;
  projectId: string | null;
  googleAccountId: string | null;
  calendarId: string;
  timeZone: string;
  language: 'en' | 'de';
  title: string;
  durationMinutes: number;
  addMeet: boolean;
  organizerName: string;
  organizerEmail: string;
  guestEmail: string;
  guestName: string | null;
  colleagues: SchedulingColleague[];
  emailSubject: string;
  emailBody: string;
  state: SchedulingRequestState;
  failure: string | null;
  closesAt: Date;
  linkExpiresAt: Date | null;
  approvedAt: Date | null;
  approvalDigest: string | null;
  hasShare: boolean;
  shareRevokedAt: Date | null;
  emailSentAt: Date | null;
  bookedEventId: string | null;
  bookedStart: Date | null;
  bookedEnd: Date | null;
  guestNote: string | null;
  notifiedNoSlotsAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchedulingHold {
  requestId: string;
  position: number;
  windowStart: Date;
  windowEnd: Date;
  eventId: string;
  state: SchedulingHoldState;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
}

/** The Uplink binding of a request's public link; stored encrypted. */
export interface SchedulingShareBinding {
  shareId: string;
  publicOrigin: string;
  edgeUrl: string;
  connectorToken: string;
  sessionSecret: string;
  pin: string;
  expiresAt: string;
}

export interface CreateSchedulingDraft {
  id: string;
  sessionId: string;
  projectId: string | null;
  googleAccountId: string | null;
  calendarId: string;
  timeZone: string;
  language: 'en' | 'de';
  title: string;
  durationMinutes: number;
  addMeet: boolean;
  organizerName: string;
  organizerEmail: string;
  guestEmail: string;
  guestName: string | null;
  colleagues: SchedulingColleague[];
  emailSubject: string;
  emailBody: string;
  closesAt: Date;
  windows: { start: Date; end: Date; eventId: string }[];
}

export type SchedulingRequestPatch = Partial<{
  failure: string | null;
  closesAt: Date;
  linkExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  emailSentAt: Date | null;
  bookedEventId: string | null;
  bookedStart: Date | null;
  bookedEnd: Date | null;
  guestNote: string | null;
  notifiedNoSlotsAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
}>;

type Row = Record<string, unknown>;

const COLUMNS: Record<keyof SchedulingRequestPatch, string> = {
  failure: 'failure',
  closesAt: 'closes_at',
  linkExpiresAt: 'link_expires_at',
  shareRevokedAt: 'share_revoked_at',
  emailSentAt: 'email_sent_at',
  bookedEventId: 'booked_event_id',
  bookedStart: 'booked_start',
  bookedEnd: 'booked_end',
  guestNote: 'guest_note',
  notifiedNoSlotsAt: 'notified_no_slots_at',
  attempts: 'attempts',
  nextAttemptAt: 'next_attempt_at',
};

const date = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

function requestFromRow(row: Row): SchedulingRequest {
  const colleagues =
    typeof row.colleagues === 'string'
      ? (JSON.parse(row.colleagues) as SchedulingColleague[])
      : (row.colleagues as SchedulingColleague[]);
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    projectId: row.project_id as string | null,
    googleAccountId: row.google_account_id as string | null,
    calendarId: row.calendar_id as string,
    timeZone: row.time_zone as string,
    language: row.language as 'en' | 'de',
    title: row.title as string,
    durationMinutes: Number(row.duration_minutes),
    addMeet: row.add_meet as boolean,
    organizerName: row.organizer_name as string,
    organizerEmail: row.organizer_email as string,
    guestEmail: row.guest_email as string,
    guestName: row.guest_name as string | null,
    colleagues,
    emailSubject: row.email_subject as string,
    emailBody: row.email_body as string,
    state: row.state as SchedulingRequestState,
    failure: row.failure as string | null,
    closesAt: date(row.closes_at)!,
    linkExpiresAt: date(row.link_expires_at),
    approvedAt: date(row.approved_at),
    approvalDigest: row.approval_digest as string | null,
    hasShare: row.share_secret !== null,
    shareRevokedAt: date(row.share_revoked_at),
    emailSentAt: date(row.email_sent_at),
    bookedEventId: row.booked_event_id as string | null,
    bookedStart: date(row.booked_start),
    bookedEnd: date(row.booked_end),
    guestNote: row.guest_note as string | null,
    notifiedNoSlotsAt: date(row.notified_no_slots_at),
    attempts: Number(row.attempts),
    nextAttemptAt: date(row.next_attempt_at),
    revision: Number(row.revision),
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,
  };
}

function holdFromRow(row: Record<string, unknown>): SchedulingHold {
  return {
    requestId: row.request_id as string,
    position: Number(row.position),
    windowStart: date(row.window_start)!,
    windowEnd: date(row.window_end)!,
    eventId: row.event_id as string,
    state: row.state as SchedulingHoldState,
    attempts: Number(row.attempts),
    nextAttemptAt: date(row.next_attempt_at),
    lastError: row.last_error as string | null,
  };
}

/** Requests that are closed: their link only shows a closing page and holds go away. */
export const CLOSED_SCHEDULING_STATES: readonly SchedulingRequestState[] = [
  'booked',
  'expired',
  'revoked',
  'failed',
];

/** Durable state of scheduling requests. The calendar remains the source of truth for times. */
export class SchedulingStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {}

  async createDraft(input: CreateSchedulingDraft): Promise<SchedulingRequest> {
    if (input.windows.length === 0) throw new Error('A scheduling request needs a window');
    await this.db.transaction().execute(async (tx) => {
      await sql`insert into scheduling_requests (
        id, session_id, project_id, google_account_id, calendar_id, time_zone, language, title,
        duration_minutes, add_meet, organizer_name, organizer_email, guest_email, guest_name,
        colleagues, email_subject, email_body, state, closes_at
      ) values (
        ${input.id}, ${input.sessionId}, ${input.projectId}, ${input.googleAccountId},
        ${input.calendarId}, ${input.timeZone}, ${input.language}, ${input.title},
        ${input.durationMinutes}, ${input.addMeet}, ${input.organizerName}, ${input.organizerEmail},
        ${input.guestEmail}, ${input.guestName}, ${JSON.stringify(input.colleagues)}::jsonb,
        ${input.emailSubject}, ${input.emailBody}, 'draft', ${input.closesAt}
      )`.execute(tx);
      for (const [position, window] of input.windows.entries())
        await sql`insert into scheduling_holds (request_id, position, window_start, window_end, event_id, state)
          values (${input.id}, ${position}, ${window.start}, ${window.end}, ${window.eventId}, 'pending')`.execute(
          tx,
        );
    });
    return (await this.get(input.id))!;
  }

  async get(id: string): Promise<SchedulingRequest | undefined> {
    const row = (
      await sql<Row>`select * from scheduling_requests where id = ${id}`.execute(this.db)
    ).rows[0];
    return row ? requestFromRow(row) : undefined;
  }

  async listForSession(sessionId: string, limit = 50): Promise<SchedulingRequest[]> {
    return (
      await sql<Row>`select * from scheduling_requests where session_id = ${sessionId} and state <> 'draft' order by created_at desc limit ${limit}`.execute(
        this.db,
      )
    ).rows.map(requestFromRow);
  }

  /** Requests worth showing across sessions: everything not a draft, newest first. */
  async listRecent(limit = 50): Promise<SchedulingRequest[]> {
    return (
      await sql<Row>`select * from scheduling_requests where state <> 'draft' order by created_at desc limit ${limit}`.execute(
        this.db,
      )
    ).rows.map(requestFromRow);
  }

  /** Requests whose public link must be served: a share that is not revoked yet. */
  async listServed(): Promise<SchedulingRequest[]> {
    return (
      await sql<Row>`select * from scheduling_requests where share_secret is not null and share_revoked_at is null`.execute(
        this.db,
      )
    ).rows.map(requestFromRow);
  }

  async holds(requestId: string): Promise<SchedulingHold[]> {
    return (
      await sql<
        Record<string, unknown>
      >`select * from scheduling_holds where request_id = ${requestId} order by position`.execute(
        this.db,
      )
    ).rows.map(holdFromRow);
  }

  /**
   * Move a request between states only from the states the caller expects. Returns false when
   * another worker or server generation got there first, so a transition happens exactly once.
   */
  async transition(
    id: string,
    from: readonly SchedulingRequestState[],
    to: SchedulingRequestState,
    patch: SchedulingRequestPatch = {},
  ): Promise<boolean> {
    if (from.length === 0) return false;
    const sets = [sql`state = ${to}`, ...this.patchSets(patch)];
    const result =
      await sql`update scheduling_requests set ${sql.join(sets)}, revision = revision + 1, updated_at = now()
      where id = ${id} and state in (${sql.join([...from])}) returning id`.execute(this.db);
    return result.rows.length === 1;
  }

  /**
   * Record the operator's approval of exactly the draft they saw. The digest binds the grant to
   * the reviewed content; a draft edited after review cannot be approved with an old digest.
   */
  async approve(id: string, digest: string): Promise<boolean> {
    const result =
      await sql`update scheduling_requests set state = 'provisioning', approved_at = now(),
      approval_digest = ${digest}, revision = revision + 1, updated_at = now()
      where id = ${id} and state = 'draft' returning id`.execute(this.db);
    return result.rows.length === 1;
  }

  async update(id: string, patch: SchedulingRequestPatch): Promise<void> {
    const sets = this.patchSets(patch);
    if (sets.length === 0) return;
    await sql`update scheduling_requests set ${sql.join(sets)}, revision = revision + 1, updated_at = now() where id = ${id}`.execute(
      this.db,
    );
  }

  async setShare(id: string, binding: SchedulingShareBinding): Promise<void> {
    await sql`update scheduling_requests set share_secret = ${this.cipher.encrypt(JSON.stringify(binding))},
      link_expires_at = ${new Date(binding.expiresAt)}, share_revoked_at = null,
      revision = revision + 1, updated_at = now() where id = ${id}`.execute(this.db);
  }

  async share(id: string): Promise<SchedulingShareBinding | undefined> {
    const row = (
      await sql<{
        share_secret: string | null;
      }>`select share_secret from scheduling_requests where id = ${id}`.execute(this.db)
    ).rows[0];
    return row?.share_secret
      ? (JSON.parse(this.cipher.decrypt(row.share_secret)) as SchedulingShareBinding)
      : undefined;
  }

  async updateHold(
    requestId: string,
    position: number,
    patch: Partial<{
      state: SchedulingHoldState;
      attempts: number;
      nextAttemptAt: Date | null;
      lastError: string | null;
    }>,
    from?: readonly SchedulingHoldState[],
  ): Promise<boolean> {
    const sets = [
      ...(patch.state === undefined ? [] : [sql`state = ${patch.state}`]),
      ...(patch.attempts === undefined ? [] : [sql`attempts = ${patch.attempts}`]),
      ...(patch.nextAttemptAt === undefined ? [] : [sql`next_attempt_at = ${patch.nextAttemptAt}`]),
      ...(patch.lastError === undefined ? [] : [sql`last_error = ${patch.lastError}`]),
    ];
    if (sets.length === 0) return false;
    const result = await sql`update scheduling_holds set ${sql.join(sets)}, updated_at = now()
      where request_id = ${requestId} and position = ${position}
      ${from ? sql`and state in (${sql.join([...from])})` : sql``} returning position`.execute(
      this.db,
    );
    return result.rows.length === 1;
  }

  /** Schedule every hold of a request that may still exist for removal. */
  async scheduleHoldCleanup(
    requestId: string,
    options: { except?: number | undefined; at?: Date } = {},
  ): Promise<void> {
    // Due at the caller's clock, the one the scheduler compares against.
    const at = options.at ?? new Date();
    const except = options.except;
    await sql`update scheduling_holds set state = 'cancel_pending', next_attempt_at = ${at}, updated_at = now()
      where request_id = ${requestId} and state in ('pending', 'active')
      ${except === undefined ? sql`` : sql`and position <> ${except}`}`.execute(this.db);
  }

  /** Holds due for removal, oldest first. */
  async dueHoldCleanups(now: Date, limit = 20): Promise<SchedulingHold[]> {
    return (
      await sql<
        Record<string, unknown>
      >`select * from scheduling_holds where state = 'cancel_pending' and (next_attempt_at is null or next_attempt_at <= ${now})
        order by next_attempt_at nulls first limit ${limit}`.execute(this.db)
    ).rows.map(holdFromRow);
  }

  /** Requests with work due: provisioning to resume, deadlines passed, links to retire. */
  async dueRequests(now: Date, limit = 20): Promise<SchedulingRequest[]> {
    return (
      await sql<Row>`select * from scheduling_requests where
        ((state = 'provisioning')
        or (state = 'open' and closes_at <= ${now})
        or (share_secret is not null and share_revoked_at is null and link_expires_at <= ${now}))
        and (next_attempt_at is null or next_attempt_at <= ${now})
        -- A leased row is being worked on; it must not crowd out the rest of the batch.
        and (lease_until is null or lease_until < now())
        order by updated_at limit ${limit}`.execute(this.db)
    ).rows.map(requestFromRow);
  }

  /** Record the "no times left" notice once; false when another view already did. */
  async markNoSlotsNotified(id: string, at: Date): Promise<boolean> {
    return (
      (
        await sql`update scheduling_requests set notified_no_slots_at = ${at}
          where id = ${id} and notified_no_slots_at is null returning id`.execute(this.db)
      ).rows.length === 1
    );
  }

  /** The earliest moment any scheduled work becomes due, or undefined when there is none. */
  async nextDueAt(): Promise<Date | undefined> {
    const row = (
      await sql<{ at: Date | string | null }>`select least(
        (select min(coalesce(next_attempt_at, updated_at)) from scheduling_requests where state = 'provisioning' and (lease_until is null or lease_until < now())),
        (select min(greatest(closes_at, coalesce(next_attempt_at, closes_at))) from scheduling_requests where state = 'open'),
        (select min(greatest(link_expires_at, coalesce(next_attempt_at, link_expires_at))) from scheduling_requests where share_secret is not null and share_revoked_at is null),
        (select min(coalesce(next_attempt_at, updated_at)) from scheduling_holds where state = 'cancel_pending')
      ) as at`.execute(this.db)
    ).rows[0];
    return row?.at ? new Date(row.at) : undefined;
  }

  /**
   * Take a short lease on one request, so overlapping server generations never run the same
   * provisioning, booking or expiry step concurrently. Expired leases can be taken over.
   */
  async lease(id: string, owner: string, ms: number): Promise<boolean> {
    const result = await sql`update scheduling_requests set lease_owner = ${owner},
      lease_until = now() + ${`${String(ms)} milliseconds`}::interval
      where id = ${id} and (lease_until is null or lease_until < now())
      returning id`.execute(this.db);
    return result.rows.length === 1;
  }

  /**
   * Claim the one email send of a request. Exactly one caller wins; the claim stays even if
   * the send fails, because Gmail cannot tell whether a failed send went out.
   */
  async claimEmailSend(id: string): Promise<boolean> {
    return (
      (
        await sql`update scheduling_requests set attempts = 1
          where id = ${id} and attempts = 0 and email_sent_at is null returning id`.execute(this.db)
      ).rows.length === 1
    );
  }

  async release(id: string, owner: string): Promise<void> {
    await sql`update scheduling_requests set lease_owner = null, lease_until = null
      where id = ${id} and lease_owner = ${owner}`.execute(this.db);
  }

  /**
   * Run `fn` while holding a transaction-scoped advisory lock on one calendar. Bookings across
   * all requests of that calendar are serialized, also across overlapping server generations.
   * `fn` gets a store bound to the locking transaction: writes through it commit with the lock
   * released, and on a single-connection database they cannot wait on the lock's own connection.
   */
  async withCalendarLock<T>(
    calendarKey: string,
    fn: (store: SchedulingStore) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`scheduling:${calendarKey}`}))`.execute(tx);
      return fn(new SchedulingStore(tx, this.cipher));
    });
  }

  private patchSets(patch: SchedulingRequestPatch) {
    return Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(
        ([key, value]) => sql`${sql.ref(COLUMNS[key as keyof SchedulingRequestPatch])} = ${value}`,
      );
  }
}
