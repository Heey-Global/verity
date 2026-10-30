import { createHash, randomInt, randomUUID } from 'node:crypto';
import { hashPreviewPin } from '@verity/preview-tunnel';
import type {
  EventStore,
  SchedulingHold,
  SchedulingRequest,
  SchedulingShareBinding,
  SchedulingStore,
} from '@verity/store';
import {
  deleteCalendarEvent,
  GoogleCalendarHttpError,
  insertCalendarEvent,
  listCalendarEventsInRange,
  patchCalendarEvent,
  readCalendarEvent,
  type CalendarEventRecord,
} from './google-calendar.js';
import type { GoogleFetch } from './google-drive.js';
import { sendGmailMessage } from './gmail.js';
import { resolveGoogleServiceCredential } from './google-service-credentials.js';
import {
  PreviewShareRemovalQueuedError,
  type PreviewEdgeControl,
} from './preview-share-manager.js';
import {
  bookableSlots,
  busyIntervals,
  holdWindow,
  schedulingMarkers,
  schedulingRole,
  SCHEDULING_POSITION_PROPERTY,
  SCHEDULING_REQUEST_PROPERTY,
  type Slot,
} from './scheduling-slots.js';

const DAY = 24 * 60 * 60 * 1000;
/** How long a request's public link lives: past the booking deadline, to explain it closed. */
const SCHEDULING_LINK_DAYS = 30;
/** The longest a request stays bookable. */
export const SCHEDULING_MAX_BOOKING_DAYS = 7;
/** Range searched for a request's own holds; holds moved further away no longer count. */
const HOLD_SEARCH_DAYS = 90;
const MAX_WINDOW_DAYS = 60;
const PROVISION_PATIENCE_MS = 10 * 60_000;
const CLEANUP_ALERT_ATTEMPT = 5;
const LEASE_MS = 2 * 60_000;
export const SCHEDULING_LINK_PLACEHOLDER = '{link}';

type SchedulingStoreDeps = Pick<EventStore, 'getSession' | 'getGoogleServiceCredentials'> & {
  scheduling: SchedulingStore;
};

export interface SchedulingConnector {
  close(): void;
  waitForDisconnect(): Promise<void>;
}

export type SchedulingNotification =
  | { kind: 'booked'; request: SchedulingRequest }
  | { kind: 'no_slots'; request: SchedulingRequest }
  | { kind: 'cleanup_failed'; request: SchedulingRequest; error: string }
  | { kind: 'email_unconfirmed'; request: SchedulingRequest }
  | { kind: 'closed'; request: SchedulingRequest; reason: string };

export interface SchedulingServiceDeps {
  store: SchedulingStoreDeps;
  googleAccessToken: (accountId?: string) => Promise<string | undefined>;
  edge?: PreviewEdgeControl | undefined;
  /** Opens the public page listener of one request; returns its loopback origin. */
  listen: (requestId: string) => Promise<string>;
  /** Stops a request's listener once its link is retired. */
  unlisten?: (requestId: string) => Promise<void>;
  connect: (binding: SchedulingShareBinding, targetOrigin: string) => Promise<SchedulingConnector>;
  calendarFetch?: GoogleFetch;
  sendMail?: typeof sendGmailMessage;
  notify?: (notification: SchedulingNotification) => Promise<void>;
  /** Asks the scheduler to run due work soon, e.g. right after a booking. */
  wake?: () => void;
  now?: () => Date;
}

interface SchedulingWindowInput {
  start: string;
  end: string;
}

export interface PrepareSchedulingInput {
  sessionId: string;
  projectId: string | null;
  title: string;
  durationMinutes: number;
  windows: SchedulingWindowInput[];
  guest: { email: string; name?: string | undefined };
  colleagues: { email: string; name?: string | undefined }[];
  addGoogleMeet: boolean;
  calendarId: string;
  timeZone: string;
  language: 'en' | 'de';
  bookingDays: number;
  organizerName: string;
  email?: { subject: string; body: string } | undefined;
}

export interface SchedulingSummary {
  requestId: string;
  state: SchedulingRequest['state'];
  title: string;
  durationMinutes: number;
  addGoogleMeet: boolean;
  timeZone: string;
  guest: { email: string; name: string | null };
  colleagues: { email: string; name?: string }[];
  organizer: { email: string; name: string };
  closesAt: string;
  windows: { start: string; end: string; startTimes: string[] }[];
  email: { to: string; subject: string; body: string };
  failure: string | null;
  booked?: { start: string; end: string };
  emailSent: boolean;
  /** The Gmail account the email is sent from; may differ from the calendar's account. */
  sender?: string;
}

export type SchedulingPageModel =
  | { kind: 'open'; request: SchedulingRequest; slots: Slot[] }
  | { kind: 'no_slots'; request: SchedulingRequest }
  | { kind: 'booked'; request: SchedulingRequest }
  | { kind: 'closed'; request: SchedulingRequest }
  | { kind: 'unavailable'; request: SchedulingRequest | undefined };

export type SchedulingBookResult =
  | { kind: 'booked'; request: SchedulingRequest }
  | { kind: 'taken'; model: SchedulingPageModel }
  | { kind: 'closed'; model: SchedulingPageModel }
  | { kind: 'unavailable'; model: SchedulingPageModel };

/** The calendar event id of a hold: deterministic, so a retried create cannot add a second hold. */
function holdEventId(requestId: string, position: number): string {
  // Google allows base32hex characters (a-v, 0-9); hex digits are a subset.
  return `vs${createHash('sha256')
    .update(`${requestId}:${String(position)}`)
    .digest('hex')
    .slice(0, 40)}`;
}

/**
 * Digest of everything the operator approves. Approval is bound to it, so a draft whose content
 * differs from what the card showed can never be provisioned under that approval.
 */
function schedulingDigest(request: SchedulingRequest, holds: SchedulingHold[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.id,
        request.sessionId,
        request.googleAccountId,
        request.calendarId,
        request.timeZone,
        request.language,
        request.title,
        request.durationMinutes,
        request.addMeet,
        request.organizerName,
        request.organizerEmail,
        request.guestEmail,
        request.guestName,
        request.colleagues,
        request.emailSubject,
        request.emailBody,
        request.closesAt.toISOString(),
        holds.map((hold) => [
          hold.position,
          hold.windowStart.toISOString(),
          hold.windowEnd.toISOString(),
          hold.eventId,
        ]),
      ]),
    )
    .digest('hex');
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatInZone(
  date: Date,
  timeZone: string,
  language: 'en' | 'de',
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', {
    timeZone,
    ...options,
  }).format(date);
}

function publicLink(binding: Pick<SchedulingShareBinding, 'publicOrigin' | 'pin'>): string {
  return `${binding.publicOrigin.replace(/\/$/u, '')}/?pin=${encodeURIComponent(binding.pin)}`;
}

function defaultEmail(
  input: PrepareSchedulingInput,
  closesAt: Date,
): { subject: string; body: string } {
  const guest = input.guest.name?.trim() || input.guest.email;
  const until = formatInZone(closesAt, input.timeZone, input.language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return input.language === 'de'
    ? {
        subject: `Terminauswahl: ${input.title}`,
        body: `Hallo ${guest},\n\nbitte wähle hier einen passenden Termin für „${input.title}“ (${String(input.durationMinutes)} Minuten):\n${SCHEDULING_LINK_PLACEHOLDER}\n\nDer Link ist bis ${until} geöffnet.\n\nViele Grüße\n${input.organizerName}`,
      }
    : {
        subject: `Pick a time: ${input.title}`,
        body: `Hi ${guest},\n\nPlease pick a time that suits you for "${input.title}" (${String(input.durationMinutes)} minutes):\n${SCHEDULING_LINK_PLACEHOLDER}\n\nThe link is open until ${until}.\n\nBest,\n${input.organizerName}`,
      };
}

function holdText(request: SchedulingRequest) {
  const guest = request.guestName ?? request.guestEmail;
  const until = formatInZone(request.closesAt, request.timeZone, request.language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return request.language === 'de'
    ? {
        summary: `Reserviert · ${guest} · ${request.title}`,
        description: `Von Verity reserviert, bis ${guest} einen Termin wählt (offen bis ${until}). Lösche diese Reservierung, um die Zeiten nicht mehr anzubieten; verschiebe oder ändere sie, um die angebotenen Zeiten zu ändern.`,
      }
    : {
        summary: `Hold · ${guest} · ${request.title}`,
        description: `Held by Verity until ${guest} picks a time (open until ${until}). Delete this hold to stop offering these times; move or resize it to change them.`,
      };
}

function bookedDescription(request: SchedulingRequest, note: string | undefined): string {
  const guest = request.guestName ?? request.guestEmail;
  const lead =
    request.language === 'de'
      ? `Von ${guest} über eine Verity-Terminanfrage gebucht.`
      : `Booked by ${guest} through a Verity scheduling request.`;
  return note ? `${lead}\n\n${request.language === 'de' ? 'Notiz' : 'Note'}: ${note}` : lead;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Owns scheduling requests from approval to cleanup, independently of any chat turn. */
export class SchedulingService {
  private readonly owner = randomUUID();
  private readonly connectors = new Map<string, SchedulingConnector>();
  private readonly connecting = new Map<string, Promise<void>>();
  /** Requests this process moved to `booked` and has not announced yet. */
  private readonly bookedNow = new Set<string>();
  private sharingGeneration = 0;
  private unsubscribeSharing: (() => void) | undefined;
  private closed = false;

  constructor(private readonly deps: SchedulingServiceDeps) {
    this.unsubscribeSharing = deps.edge?.onSharingDisabled?.(() => {
      this.sharingGeneration += 1;
      for (const connector of this.connectors.values()) connector.close();
      this.connectors.clear();
      // Turning sharing off withdraws every public link; open requests cannot be booked anymore.
      void this.withdrawAll('Online sharing was turned off').catch(() => undefined);
    });
  }

  private get store(): SchedulingStore {
    return this.deps.store.scheduling;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async calendarToken(request: SchedulingRequest): Promise<string> {
    const token = await this.deps.googleAccessToken(request.googleAccountId ?? undefined);
    if (!token) throw new Error('Google Calendar is not connected');
    return token;
  }

  // ---------------------------------------------------------------- prepare and approve

  async prepare(
    input: PrepareSchedulingInput,
  ): Promise<SchedulingSummary & { digest: string; conflicts: string[] }> {
    if (!isValidTimeZone(input.timeZone)) throw new Error(`Unknown time zone: ${input.timeZone}`);
    const credential = await resolveGoogleServiceCredential(
      this.deps.store,
      input.sessionId,
      'calendar',
    );
    const now = this.now();
    const windows = input.windows
      .map((window) => ({ start: new Date(window.start), end: new Date(window.end) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    if (windows.length === 0 || !(input.durationMinutes > 0))
      throw new Error('A scheduling request needs a window and a positive duration');
    for (const window of windows) {
      if (!(window.end > window.start)) throw new Error('Every window must end after it starts');
      if (window.end.getTime() - window.start.getTime() < input.durationMinutes * 60_000)
        throw new Error('Every window must be at least as long as the meeting');
      if (window.end <= now) throw new Error('Every window must lie in the future');
      // Holds are found again within HOLD_SEARCH_DAYS; anything later would never be offered.
      if (window.start.getTime() > now.getTime() + MAX_WINDOW_DAYS * DAY)
        throw new Error(`Windows must start within ${String(MAX_WINDOW_DAYS)} days`);
    }
    const lastEnd = windows.at(-1)!.end;
    const closesAt = new Date(
      Math.min(
        now.getTime() + Math.min(input.bookingDays, SCHEDULING_MAX_BOOKING_DAYS) * DAY,
        lastEnd.getTime(),
      ),
    );
    const email = input.email ?? defaultEmail(input, closesAt);
    const id = randomUUID();
    const request = await this.store.createDraft({
      id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      googleAccountId: credential.accountId,
      calendarId: input.calendarId,
      timeZone: input.timeZone,
      language: input.language,
      title: input.title.trim(),
      durationMinutes: input.durationMinutes,
      addMeet: input.addGoogleMeet,
      organizerName: input.organizerName.trim(),
      organizerEmail: credential.accountEmail,
      guestEmail: input.guest.email.trim(),
      guestName: input.guest.name?.trim() || null,
      colleagues: input.colleagues.map((colleague) => ({
        email: colleague.email.trim(),
        ...(colleague.name?.trim() ? { name: colleague.name.trim() } : {}),
      })),
      emailSubject: email.subject,
      emailBody: email.body.includes(SCHEDULING_LINK_PLACEHOLDER)
        ? email.body
        : `${email.body.trimEnd()}\n\n${SCHEDULING_LINK_PLACEHOLDER}`,
      closesAt,
      windows: windows.map((window, position) => ({
        ...window,
        eventId: holdEventId(id, position),
      })),
    });
    const holds = await this.store.holds(id);
    // Preview the start times against the calendar as it is now; holds of other requests do not
    // block, so they are reported only as information.
    const token = await this.calendarToken(request);
    const events = await listCalendarEventsInRange(
      token,
      {
        calendarId: request.calendarId,
        timeMin: windows[0]!.start.toISOString(),
        timeMax: lastEnd.toISOString(),
      },
      this.deps.calendarFetch,
    );
    const busy = busyIntervals(events, request.timeZone);
    const conflicts = events
      .filter((event) => schedulingRole(event) === 'hold')
      .map((event) => event.summary ?? 'Another scheduling hold');
    const summary = this.summarize(request, holds, (hold) =>
      bookableSlots({
        windows: [
          {
            position: hold.position,
            window: { start: hold.windowStart.getTime(), end: hold.windowEnd.getTime() },
          },
        ],
        busy,
        durationMinutes: request.durationMinutes,
        now,
        closesAt: request.closesAt,
      }),
    );
    return {
      ...summary,
      digest: schedulingDigest(request, holds),
      conflicts: [...new Set(conflicts)],
    };
  }

  /** The approval card's content for a draft, recomputed from what is stored. */
  async approvalSummary(
    requestId: string,
    sessionId: string,
  ): Promise<SchedulingSummary | undefined> {
    const request = await this.store.get(requestId);
    if (!request || request.sessionId !== sessionId) return undefined;
    const holds = await this.store.holds(requestId);
    const sender = await resolveGoogleServiceCredential(this.deps.store, sessionId, 'gmail').then(
      (credential) => credential.accountEmail,
      () => undefined,
    );
    const summary = this.summarize(request, holds, (hold) =>
      bookableSlots({
        windows: [
          {
            position: hold.position,
            window: { start: hold.windowStart.getTime(), end: hold.windowEnd.getTime() },
          },
        ],
        busy: [],
        durationMinutes: request.durationMinutes,
        now: this.now(),
        closesAt: request.closesAt,
      }),
    );
    return sender ? { ...summary, sender } : summary;
  }

  summarize(
    request: SchedulingRequest,
    holds: SchedulingHold[],
    slots?: (hold: SchedulingHold) => Slot[],
  ): SchedulingSummary {
    return {
      requestId: request.id,
      state: request.state,
      title: request.title,
      durationMinutes: request.durationMinutes,
      addGoogleMeet: request.addMeet,
      timeZone: request.timeZone,
      guest: { email: request.guestEmail, name: request.guestName },
      colleagues: request.colleagues,
      organizer: { email: request.organizerEmail, name: request.organizerName },
      closesAt: request.closesAt.toISOString(),
      windows: holds.map((hold) => ({
        start: hold.windowStart.toISOString(),
        end: hold.windowEnd.toISOString(),
        startTimes: (slots?.(hold) ?? []).map((slot) => slot.start.toISOString()),
      })),
      email: { to: request.guestEmail, subject: request.emailSubject, body: request.emailBody },
      failure: request.failure,
      ...(request.bookedStart && request.bookedEnd
        ? {
            booked: {
              start: request.bookedStart.toISOString(),
              end: request.bookedEnd.toISOString(),
            },
          }
        : {}),
      emailSent: request.emailSentAt !== null,
    };
  }

  /**
   * Execute an approved draft: record the approval, then create holds, the public link and send
   * the email. Every step is idempotent, so a crash part-way resumes from the scheduler.
   */
  async send(requestId: string, sessionId: string, digest: string): Promise<SchedulingSummary> {
    const request = await this.store.get(requestId);
    if (!request || request.sessionId !== sessionId)
      throw new Error('Scheduling request not found');
    if (request.state !== 'draft')
      throw new Error(`This scheduling request is already ${request.state}`);
    if (request.closesAt <= this.now())
      throw new Error('This draft is out of date; prepare the request again');
    const holds = await this.store.holds(requestId);
    if (schedulingDigest(request, holds) !== digest)
      throw new Error('The scheduling request differs from the prepared one; prepare it again');
    if (!(await this.store.approve(requestId, digest)))
      throw new Error('This scheduling request was already sent');
    await this.provisionLeased(requestId);
    const current = (await this.store.get(requestId))!;
    if (current.state === 'failed')
      throw new Error(current.failure ?? 'Sending the scheduling request failed');
    return this.summarize(current, await this.store.holds(requestId));
  }

  private async provisionLeased(requestId: string): Promise<void> {
    if (!(await this.store.lease(requestId, this.owner, LEASE_MS))) return;
    try {
      await this.provision(requestId);
    } finally {
      await this.store.release(requestId, this.owner);
    }
  }

  /**
   * The Uplink control to create a link with, undefined to try again shortly (right after a
   * restart Uplink may still be connecting), or an error once waiting is no longer reasonable.
   */
  private async edgeReady(request: SchedulingRequest): Promise<PreviewEdgeControl | undefined> {
    const edge = this.deps.edge;
    const unavailable = new Error(
      'Online sharing through Uplink is not available; turn it on to send booking links',
    );
    if (!edge) throw unavailable;
    if (edge.isAvailable?.() !== false) return edge;
    if (
      this.now().getTime() - (request.approvedAt ?? request.createdAt).getTime() >=
      PROVISION_PATIENCE_MS
    )
      throw unavailable;
    await this.store.update(request.id, {
      nextAttemptAt: new Date(this.now().getTime() + 60_000),
    });
    return undefined;
  }

  private async provision(requestId: string): Promise<void> {
    let request = await this.store.get(requestId);
    if (request?.state !== 'provisioning') return;
    try {
      const token = await this.calendarToken(request);
      const text = holdText(request);
      // A withdrawal can land while this runs; each external step checks the state first.
      const still = async () => (await this.store.get(requestId))?.state === 'provisioning';
      // Check what the later steps need before inviting anyone: failing after the holds would
      // mail colleagues an invitation and then its cancellation.
      if (!request.hasShare && !(await this.edgeReady(request))) return;
      if (request.emailSentAt === null && request.attempts === 0) {
        const gmail = await resolveGoogleServiceCredential(
          this.deps.store,
          request.sessionId,
          'gmail',
        );
        if (!(await this.deps.googleAccessToken(gmail.accountId)))
          throw new Error('Gmail is not connected');
      }
      for (const hold of await this.store.holds(requestId)) {
        if (hold.state !== 'pending') continue;
        if (!(await still())) return;
        const created = await this.createHold(token, request, hold, text);
        const recorded = await this.store.updateHold(
          requestId,
          hold.position,
          { state: created ? 'active' : 'cancelled' },
          ['pending'],
        );
        // Cleanup may already have looked for this hold before it existed; look again.
        if (!recorded && created)
          await this.store.updateHold(
            requestId,
            hold.position,
            { state: 'cancel_pending', nextAttemptAt: this.now() },
            ['cancel_pending', 'cancelled'],
          );
      }
      if (!(await still())) return;
      request = (await this.store.get(requestId))!;
      if (!request.hasShare) {
        const edge = await this.edgeReady(request);
        if (!edge) return;
        const pin = String(randomInt(100_000, 1_000_000));
        const binding = await edge.create({
          durationSeconds: (SCHEDULING_LINK_DAYS * DAY) / 1000,
          pinHash: hashPreviewPin(pin),
        });
        const recorded = await this.store.setShare(requestId, {
          shareId: binding.shareId,
          publicOrigin: binding.publicOrigin,
          edgeUrl: binding.edgeUrl,
          connectorToken: binding.connectorToken,
          sessionSecret: binding.sessionSecret,
          pin,
          expiresAt: binding.expiresAt.toISOString(),
        });
        // Another run recorded a link first; this one would be an orphan nobody was sent.
        if (!recorded) await edge.remove(binding.shareId).catch(() => undefined);
        request = (await this.store.get(requestId))!;
      }
      const binding = (await this.store.share(requestId))!;
      // The scheduler reconnects a link that is not up yet; the email can still go out.
      await this.ensureConnector(requestId).catch(() => undefined);
      if (request.emailSentAt === null) {
        if (request.attempts > 0) {
          // A send was started but never recorded. Gmail has no idempotency key, so sending
          // again could mail the guest twice; the link works, the operator decides.
          await this.store.transition(requestId, ['provisioning'], 'open', {
            failure:
              'Sending the email could not be confirmed. Check your sent mail, or copy the link and send it yourself.',
          });
          await this.deps.notify?.({
            kind: 'email_unconfirmed',
            request: (await this.store.get(requestId))!,
          });
          return;
        }
        if (!(await still())) return;
        const gmail = await resolveGoogleServiceCredential(
          this.deps.store,
          request.sessionId,
          'gmail',
        );
        const gmailToken = await this.deps.googleAccessToken(gmail.accountId);
        if (!gmailToken) throw new Error('Gmail is not connected');
        // Claimed immediately before the send: only a send that may have happened counts, and
        // only one caller can ever get here for a request.
        if (!(await this.store.claimEmailSend(requestId))) return;
        await (this.deps.sendMail ?? sendGmailMessage)(gmailToken, {
          to: [request.guestEmail],
          subject: request.emailSubject,
          body: request.emailBody.split(SCHEDULING_LINK_PLACEHOLDER).join(publicLink(binding)),
        });
        await this.store.update(requestId, { emailSentAt: this.now() });
      }
      await this.store.transition(requestId, ['provisioning'], 'open');
    } catch (error) {
      if (
        await this.store.transition(requestId, ['provisioning'], 'failed', {
          failure: errorText(error),
        })
      ) {
        await this.store.scheduleHoldCleanup(requestId, { at: this.now() });
        this.deps.wake?.();
      }
    }
  }

  /** Create one hold; false when it existed and was already deleted in the calendar. */
  private async createHold(
    token: string,
    request: SchedulingRequest,
    hold: SchedulingHold,
    text: { summary: string; description: string },
  ): Promise<boolean> {
    try {
      await insertCalendarEvent(
        token,
        {
          calendarId: request.calendarId,
          event: {
            id: hold.eventId,
            summary: text.summary,
            description: text.description,
            start: { dateTime: hold.windowStart.toISOString(), timeZone: request.timeZone },
            end: { dateTime: hold.windowEnd.toISOString(), timeZone: request.timeZone },
            transparency: 'opaque',
            attendees: request.colleagues.map((colleague) => ({ email: colleague.email })),
            extendedProperties: { private: schedulingMarkers(request.id, 'hold', hold.position) },
            reminders: { useDefault: false },
          },
          sendUpdates: request.colleagues.length > 0 ? 'all' : 'none',
        },
        this.deps.calendarFetch,
      );
      return true;
    } catch (error) {
      // A retried create meets the event the first attempt made.
      if (!(error instanceof GoogleCalendarHttpError) || error.status !== 409) throw error;
      const existing = await readCalendarEvent(
        token,
        { calendarId: request.calendarId, eventId: hold.eventId },
        this.deps.calendarFetch,
      );
      return existing !== undefined && existing.status !== 'cancelled';
    }
  }

  // ---------------------------------------------------------------- live view and booking

  /**
   * Bookable slots of an open request, read live from the calendar. Seeing this request's own
   * event already marked as booked finishes a booking whose bookkeeping a crash interrupted.
   */
  private async liveSlots(
    scheduling: SchedulingStore,
    request: SchedulingRequest,
    knownToken?: string,
  ): Promise<{
    slots: Slot[];
    events: Map<string, CalendarEventRecord>;
    booked?: SchedulingRequest;
  }> {
    const token = knownToken ?? (await this.calendarToken(request));
    const now = this.now();
    const own = await listCalendarEventsInRange(
      token,
      {
        calendarId: request.calendarId,
        timeMin: new Date(now.getTime() - DAY).toISOString(),
        timeMax: new Date(now.getTime() + HOLD_SEARCH_DAYS * DAY).toISOString(),
        privateExtendedProperty: `${SCHEDULING_REQUEST_PROPERTY}=${request.id}`,
      },
      this.deps.calendarFetch,
    );
    const booked = own.find(
      (event) => event.status !== 'cancelled' && schedulingRole(event) === 'booked',
    );
    if (booked)
      return {
        slots: [],
        events: new Map(),
        booked: await this.finishBooking(scheduling, request, booked),
      };
    const holds = await scheduling.holds(request.id);
    const byId = new Map(own.map((event) => [event.id, event]));
    const windows = holds.flatMap((hold) => {
      if (hold.state !== 'active') return [];
      const window = holdWindow(byId.get(hold.eventId), request.id);
      return window ? [{ position: hold.position, window }] : [];
    });
    if (windows.length === 0) return { slots: [], events: byId };
    const busy = busyIntervals(
      await listCalendarEventsInRange(
        token,
        {
          calendarId: request.calendarId,
          timeMin: new Date(Math.min(...windows.map((w) => w.window.start))).toISOString(),
          timeMax: new Date(Math.max(...windows.map((w) => w.window.end))).toISOString(),
        },
        this.deps.calendarFetch,
      ),
      request.timeZone,
    );
    return {
      slots: bookableSlots({
        windows,
        busy,
        durationMinutes: request.durationMinutes,
        now,
        closesAt: request.closesAt,
      }),
      events: byId,
    };
  }

  private async finishBooking(
    scheduling: SchedulingStore,
    request: SchedulingRequest,
    event: CalendarEventRecord,
  ): Promise<SchedulingRequest> {
    const position = Number(event.extendedProperties?.private?.[SCHEDULING_POSITION_PROPERTY]);
    const start = event.start.dateTime ? new Date(event.start.dateTime) : null;
    const end = event.end.dateTime ? new Date(event.end.dateTime) : null;
    if (
      await scheduling.transition(request.id, ['open', 'provisioning'], 'booked', {
        bookedEventId: event.id,
        bookedStart: start,
        bookedEnd: end,
      })
    ) {
      this.bookedNow.add(request.id);
      if (Number.isInteger(position))
        await scheduling.updateHold(request.id, position, { state: 'converted' });
      await scheduling.scheduleHoldCleanup(request.id, {
        except: Number.isInteger(position) ? position : undefined,
        at: this.now(),
      });
    }
    return (await scheduling.get(request.id))!;
  }

  /** What the public page shows right now. */
  async view(requestId: string): Promise<SchedulingPageModel> {
    const request = await this.store.get(requestId);
    if (!request) return { kind: 'unavailable', request: undefined };
    const model = await this.modelFor(this.store, request);
    await this.announceBooking(requestId);
    if (
      model.kind === 'no_slots' &&
      request.notifiedNoSlotsAt === null &&
      (await this.store.markNoSlotsNotified(request.id, this.now()))
    )
      await this.deps.notify?.({ kind: 'no_slots', request });
    if (model.kind === 'open' && request.notifiedNoSlotsAt !== null)
      await this.store.update(request.id, { notifiedNoSlotsAt: null });
    return model;
  }

  private async modelFor(
    scheduling: SchedulingStore,
    request: SchedulingRequest,
    token?: string,
  ): Promise<SchedulingPageModel> {
    if (request.state === 'booked') return { kind: 'booked', request };
    if (request.state === 'draft' || request.state === 'provisioning')
      return { kind: 'unavailable', request };
    if (request.state !== 'open' || request.closesAt <= this.now())
      return { kind: 'closed', request };
    try {
      const live = await this.liveSlots(scheduling, request, token);
      if (live.booked) return { kind: 'booked', request: live.booked };
      return live.slots.length > 0
        ? { kind: 'open', request, slots: live.slots }
        : { kind: 'no_slots', request };
    } catch {
      return { kind: 'unavailable', request };
    }
  }

  /**
   * Book one start time. All bookings on one calendar run under one lock: inside it, the slot is
   * checked live once more and the hold becomes the appointment, so two guests can never take
   * the same time, whichever request they come from.
   */
  async book(requestId: string, start: string, note?: string): Promise<SchedulingBookResult> {
    const first = await this.store.get(requestId);
    if (!first) return { kind: 'unavailable', model: { kind: 'unavailable', request: undefined } };
    // Resolved before the lock: nothing that may touch the database waits inside it.
    let token: string;
    try {
      token = await this.calendarToken(first);
    } catch {
      return { kind: 'unavailable', model: { kind: 'unavailable', request: first } };
    }
    let transitioned = false;
    const result = await this.store.withCalendarLock(
      this.lockKey(first),
      async (scheduling): Promise<SchedulingBookResult> => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const request = (await scheduling.get(requestId))!;
          if (request.state !== 'open' || request.closesAt <= this.now()) {
            const model = await this.modelFor(scheduling, request, token);
            return { kind: 'closed', model };
          }
          let live: Awaited<ReturnType<SchedulingService['liveSlots']>>;
          try {
            live = await this.liveSlots(scheduling, request, token);
          } catch {
            return { kind: 'unavailable', model: { kind: 'unavailable', request } };
          }
          if (live.booked)
            return { kind: 'closed', model: { kind: 'booked', request: live.booked } };
          const slot = live.slots.find(
            (candidate) => candidate.start.toISOString() === new Date(start).toISOString(),
          );
          const model: SchedulingPageModel =
            live.slots.length > 0
              ? { kind: 'open', request, slots: live.slots }
              : { kind: 'no_slots', request };
          if (!slot) return { kind: 'taken', model };
          const hold = (await scheduling.holds(requestId)).find(
            (candidate) => candidate.position === slot.position,
          )!;
          const event = live.events.get(hold.eventId)!;
          const attendees = new Map(
            (event.attendees ?? [])
              .filter((attendee) => !attendee.self)
              .map((attendee) => [attendee.email.toLowerCase(), { email: attendee.email }]),
          );
          attendees.set(request.guestEmail.toLowerCase(), { email: request.guestEmail });
          const patched = await patchCalendarEvent(
            token,
            {
              calendarId: request.calendarId,
              eventId: hold.eventId,
              expectedEtag: event.etag,
              event: {
                summary: request.title,
                description: bookedDescription(request, note),
                start: { dateTime: slot.start.toISOString(), timeZone: request.timeZone },
                end: { dateTime: slot.end.toISOString(), timeZone: request.timeZone },
                transparency: 'opaque',
                attendees: [...attendees.values()],
                extendedProperties: {
                  private: schedulingMarkers(request.id, 'booked', slot.position),
                },
                reminders: { useDefault: true },
              },
              sendUpdates: 'all',
              ...(request.addMeet ? { meetRequestId: `booking-${request.id}` } : {}),
            },
            this.deps.calendarFetch,
          );
          if (patched.status === 'conflict') continue; // Changed in the calendar meanwhile; look again.
          if (patched.status === 'missing') return { kind: 'taken', model };
          // Announced only once the lock's transaction has committed (see below).
          transitioned = await scheduling.transition(requestId, ['open'], 'booked', {
            bookedEventId: hold.eventId,
            bookedStart: slot.start,
            bookedEnd: slot.end,
            guestNote: note ?? null,
          });
          await scheduling.updateHold(requestId, slot.position, { state: 'converted' });
          await scheduling.scheduleHoldCleanup(requestId, {
            except: slot.position,
            at: this.now(),
          });
          return { kind: 'booked', request: (await scheduling.get(requestId))! };
        }
        const request = (await scheduling.get(requestId))!;
        return { kind: 'taken', model: await this.modelFor(scheduling, request, token) };
      },
    );
    if (transitioned) this.bookedNow.add(requestId);
    await this.announceBooking(requestId);
    return result;
  }

  /**
   * Announce a booking once: only the call whose transition to `booked` succeeded announces
   * it, whether it booked itself or finished a booking a crash interrupted.
   */
  private async announceBooking(requestId: string): Promise<void> {
    if (!this.bookedNow.delete(requestId)) return;
    this.deps.wake?.();
    const request = await this.store.get(requestId);
    if (request) await this.deps.notify?.({ kind: 'booked', request });
  }

  // ---------------------------------------------------------------- revoke, expiry, cleanup

  async revoke(requestId: string, sessionId?: string): Promise<SchedulingRequest> {
    const request = await this.store.get(requestId);
    if (!request || (sessionId !== undefined && request.sessionId !== sessionId))
      throw new Error('Scheduling request not found');
    if (request.state === 'draft') {
      await this.store.transition(requestId, ['draft'], 'revoked');
      return (await this.store.get(requestId))!;
    }
    if (!(await this.closeRequest(request, ['open', 'provisioning'], 'revoked')))
      throw new Error(`This scheduling request is already ${request.state}`);
    this.deps.wake?.();
    return (await this.store.get(requestId))!;
  }

  private lockKey(request: SchedulingRequest): string {
    // `primary` and the account's own address name the same calendar; they must share a lock.
    const calendar = request.calendarId === 'primary' ? request.organizerEmail : request.calendarId;
    return `${request.googleAccountId ?? 'default'}:${calendar.toLowerCase()}`;
  }

  /**
   * Close a request under the calendar lock bookings take, so a withdrawal or the deadline can
   * never land between a booking's live check and its calendar change.
   */
  private async closeRequest(
    request: SchedulingRequest,
    from: SchedulingRequest['state'][],
    to: SchedulingRequest['state'],
    patch: { failure?: string } = {},
  ): Promise<boolean> {
    return this.store.withCalendarLock(this.lockKey(request), async (locked) => {
      if (!(await locked.transition(request.id, from, to, patch))) return false;
      await locked.scheduleHoldCleanup(request.id, { at: this.now() });
      return true;
    });
  }

  private async withdrawAll(reason: string): Promise<void> {
    for (const request of await this.store.listServed()) {
      if (
        await this.closeRequest(request, ['open', 'provisioning'], 'revoked', { failure: reason })
      ) {
        await this.deps.notify?.({
          kind: 'closed',
          request: (await this.store.get(request.id))!,
          reason,
        });
      }
      await this.retireShare(request.id).catch(() => undefined);
    }
    this.deps.wake?.();
  }

  /** Run everything that is due; returns when the next work becomes due. */
  async runDue(): Promise<Date | undefined> {
    const now = this.now();
    for (const request of await this.store.dueRequests(now)) {
      if (!(await this.store.lease(request.id, this.owner, LEASE_MS))) continue;
      try {
        if (request.state === 'provisioning') await this.provision(request.id);
        else if (request.state === 'open' && request.closesAt <= now) {
          await this.closeRequest(request, ['open'], 'expired');
        }
        const current = (await this.store.get(request.id))!;
        if (
          current.hasShare &&
          current.shareRevokedAt === null &&
          current.linkExpiresAt &&
          current.linkExpiresAt <= now
        )
          await this.retireShare(request.id);
      } catch {
        // Retried after a pause, so a lasting outage is not hammered every pass.
        await this.store
          .update(request.id, { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) })
          .catch(() => undefined);
      } finally {
        await this.store.release(request.id, this.owner);
      }
    }
    for (const hold of await this.store.dueHoldCleanups(now)) await this.cleanupHold(hold);
    await this.ensureConnectors();
    return this.store.nextDueAt();
  }

  private async cleanupHold(hold: SchedulingHold): Promise<void> {
    const request = await this.store.get(hold.requestId);
    if (!request) return;
    try {
      const token = await this.calendarToken(request);
      const event = await readCalendarEvent(
        token,
        { calendarId: request.calendarId, eventId: hold.eventId },
        this.deps.calendarFetch,
      );
      if (event && event.status !== 'cancelled' && schedulingRole(event) === 'booked') {
        // Never remove an appointment, whatever the bookkeeping says.
        await this.store.updateHold(hold.requestId, hold.position, { state: 'converted' }, [
          'cancel_pending',
        ]);
        return;
      }
      if (event && event.status !== 'cancelled')
        await deleteCalendarEvent(
          token,
          {
            calendarId: request.calendarId,
            eventId: hold.eventId,
            sendUpdates: request.colleagues.length > 0 ? 'all' : 'none',
          },
          this.deps.calendarFetch,
        );
      await this.store.updateHold(
        hold.requestId,
        hold.position,
        { state: 'cancelled', lastError: null },
        ['cancel_pending'],
      );
    } catch (error) {
      const attempts = hold.attempts + 1;
      await this.store.updateHold(
        hold.requestId,
        hold.position,
        {
          attempts,
          lastError: errorText(error),
          nextAttemptAt: new Date(
            this.now().getTime() + Math.min(60_000 * 2 ** attempts, 6 * 60 * 60_000),
          ),
        },
        ['cancel_pending'],
      );
      // One alert per request: the first of its holds to reach the threshold speaks for all.
      const alerted = (await this.store.holds(request.id)).some(
        (other) => other.position !== hold.position && other.attempts >= CLEANUP_ALERT_ATTEMPT,
      );
      if (attempts === CLEANUP_ALERT_ATTEMPT && !alerted)
        await this.deps.notify?.({ kind: 'cleanup_failed', request, error: errorText(error) });
    }
  }

  // ---------------------------------------------------------------- public link plumbing

  private async retireShare(requestId: string): Promise<void> {
    const binding = await this.store.share(requestId);
    this.connectors.get(requestId)?.close();
    this.connectors.delete(requestId);
    if (binding && this.deps.edge) {
      try {
        await this.deps.edge.remove(binding.shareId);
      } catch (error) {
        if (!(error instanceof PreviewShareRemovalQueuedError)) throw error;
      }
    }
    await this.store.update(requestId, { shareRevokedAt: this.now() });
    await this.deps.unlisten?.(requestId);
  }

  private async ensureConnector(requestId: string): Promise<void> {
    if (this.closed || this.connectors.has(requestId)) return;
    const pending = this.connecting.get(requestId);
    if (pending) return pending;
    const run = (async () => {
      if (this.deps.edge?.isAvailable?.() === false)
        throw new Error('Online sharing is not available');
      const binding = await this.store.share(requestId);
      if (!binding) throw new Error('This request has no public link');
      const generation = this.sharingGeneration;
      const origin = await this.deps.listen(requestId);
      const connector = await this.deps.connect(binding, origin);
      if (generation !== this.sharingGeneration || this.closed) {
        connector.close();
        throw new Error('Online sharing changed while connecting');
      }
      this.connectors.set(requestId, connector);
      void connector
        .waitForDisconnect()
        .then(() => {
          if (this.connectors.get(requestId) === connector) this.connectors.delete(requestId);
        })
        .catch(() => undefined);
    })();
    this.connecting.set(requestId, run);
    try {
      await run;
    } finally {
      this.connecting.delete(requestId);
    }
  }

  /** Reconnect every served link, e.g. after a restart or a dropped connection. */
  async ensureConnectors(): Promise<void> {
    if (this.closed || this.deps.edge?.isAvailable?.() === false) return;
    for (const request of await this.store.listServed()) {
      if (request.linkExpiresAt && request.linkExpiresAt <= this.now()) continue;
      await this.ensureConnector(request.id).catch(() => undefined);
    }
  }

  publicLink = async (requestId: string): Promise<string | undefined> => {
    const request = await this.store.get(requestId);
    if (!request?.hasShare || request.shareRevokedAt) return undefined;
    const binding = await this.store.share(requestId);
    return binding ? publicLink(binding) : undefined;
  };

  close(): void {
    this.closed = true;
    this.unsubscribeSharing?.();
    for (const connector of this.connectors.values()) connector.close();
    this.connectors.clear();
  }
}
