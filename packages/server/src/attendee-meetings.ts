import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PreviewConnector, hashPreviewPin } from '@verity/preview-tunnel';
import type { EventStore, LiveMeetingSyncRecord } from '@verity/store';
import { z } from 'zod';
import {
  PREVIEW_CREATE_FAILURE_CODES,
  PreviewShareRemovalQueuedError,
  type PreviewEdgeControl,
  type PreviewEdgeBinding,
  type PreviewCreateDiagnostic,
} from './preview-share-manager.js';
import {
  ATTENDEE_WEBHOOK_PATH,
  AttendeeClient,
  AttendeeRequestRejected,
  normalizeAttendeeTranscript,
  verifyAttendeeSignature,
} from './attendee-client.js';
import {
  attendeeBotSchema,
  joinProgress,
  providerCode,
  type OnlineJoinStatus,
} from './attendee-join-status.js';
import { meetingCallKey, meetingPlatform, type MeetingPlatform } from './calendar-meeting-links.js';

interface MeetingStartDiagnostic {
  requestId?: string;
  meetingId: string;
  phase:
    PreviewCreateDiagnostic['phase'] | 'connector_connect' | 'connector_ready' | 'provider_setup';
  code: string;
  shareCreateSent: boolean;
  bindingPresent: boolean;
  botCreateAttempted: boolean;
  event: 'progress' | 'failed';
}
const UPLINK_SHARE_REFUSALS: Record<string, string> = {
  webhook_unsupported: 'The Uplink refused a webhook share for this server.',
  limit_reached: 'The Uplink share limit is reached. End another online meeting or preview first.',
  not_entitled: 'Online sharing is not included in the Uplink plan of this server.',
  unavailable: 'The Uplink cannot create a share right now.',
  invalid_request: 'The Uplink rejected the share request as invalid.',
};

/**
 * Names the Uplink step that failed before the bot was created. Phases and codes come from
 * the bounded diagnostic vocabulary, so the text never carries raw upstream errors.
 */
export function uplinkStartFailure(phase: MeetingStartDiagnostic['phase'], code: string) {
  const hint = 'Check Uplink / Online Sharing and retry.';
  // Only codes this server knows reach the message; anything else is reported as `unknown`.
  const shown = PREVIEW_CREATE_FAILURE_CODES.has(code) ? code : 'unknown';
  const step = `(Uplink step: ${phase}${code === 'pending' || code === 'ready' ? '' : ` · ${shown}`})`;
  const reason = ((): string => {
    switch (phase) {
      case 'ensure_sharing':
        return 'Could not enable online sharing on the Uplink.';
      case 'capability_check':
        return code === 'webhook_not_negotiated'
          ? 'The current Uplink connection has not confirmed webhook support. Reconnecting Uplink renegotiates it.'
          : 'Online sharing is not available on the Uplink connection.';
      case 'share_create':
        return code === 'pending'
          ? 'The Uplink share request did not complete: no answer or an unusable reply.'
          : (Object.hasOwn(UPLINK_SHARE_REFUSALS, shown) && UPLINK_SHARE_REFUSALS[shown]) ||
              'The Uplink refused the webhook share.';
      case 'connector_connect':
        return 'The webhook share was created, but its connector could not connect to the Uplink.';
      case 'share_ready':
        return 'Online sharing stopped while the webhook share was being created.';
      case 'connector_ready':
      case 'provider_setup':
        // The Uplink steps finished; the failure lies in local setup before the bot request.
        return 'The webhook share is ready, but preparing the meeting failed before Verity contacted the provider.';
      default: {
        const unhandled: never = phase;
        return `Online meeting start failed at ${String(unhandled)}.`;
      }
    }
  })();
  return `${reason} ${hint} ${step}`;
}

/** Safe startup guidance that the API may expose without internal error details. */
export class OnlineMeetingStartError extends Error {}
export class UnassignedMeetingNotFoundError extends Error {
  constructor() {
    super('This meeting is no longer waiting to be assigned.');
  }
}

export interface AttendeeConfig {
  apiKey: string;
  webhookSecret: string;
}
/** The meeting as this owner keeps it. `sessionId` stays null while the meeting is
 * unassigned: Verity joined before anyone chose a project, so nothing is published to a
 * session, and assigning it later publishes the complete transcript at once. */
type OwnedMeeting = Omit<LiveMeetingSyncRecord, 'sessionId'> & { sessionId: string | null };
export interface UnassignedOnlineMeeting {
  id: string;
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  state: LiveMeetingSyncRecord['state'];
  captureStatus: string;
  people: number;
}
interface OnlineMeeting {
  meeting: OwnedMeeting;
  botId?: string;
  binding?: Omit<PreviewEdgeBinding, 'expiresAt'> & { expiresAt: string };
  pin: string;
  credentials: AttendeeConfig;
  identities: Record<string, number>;
  phase: 'preparing' | 'running' | 'stopping' | 'ended' | 'interrupted';
  stopRequested: boolean;
  listenForVerity: boolean;
  pendingRequests?: Record<string, string>;
  processedRequests?: Record<string, boolean>;
  timeOriginMs?: number;
  speakerNameOverrides?: Record<string, string>;
  botCreateAttempted?: boolean;
  /** Set by discard: the provider is stopped and the state deleted once it has ended. */
  discarded?: boolean;
  /** The call the bot joined, so a second join of the same call can find it. */
  meetingUrl?: string;
  error?: string;
  /** Last provider bot state, kept only to log its transitions. */
  botState?: string;
  /** How far the bot got into the call; absent until the provider was first asked. */
  joinStatus?: OnlineJoinStatus;
  /** Provider failure code (for example `login_required`) when joining failed. */
  joinReason?: string | null;
  /** When the bot was first seen inside the call. */
  joinedAt?: number;
}

/** What the app shows while Verity is getting into an online meeting. */
export interface OnlineMeetingStatus {
  status: OnlineJoinStatus;
  reason: string | null;
  platform: MeetingPlatform | null;
}
/** Operational log for the meeting data path. Never receives tokens or meeting content. */
export interface AttendeeMeetingsLog {
  info(entry: Record<string, unknown>, message: string): void;
  warn(entry: Record<string, unknown>, message: string): void;
}
const SNAPSHOT_LOG_INTERVAL_MS = 60_000;
function failureFields(error: unknown) {
  return {
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof AttendeeRequestRejected ? { status: error.status } : {}),
  };
}
function assigned(meeting: OwnedMeeting): LiveMeetingSyncRecord | undefined {
  return meeting.sessionId === null ? undefined : { ...meeting, sessionId: meeting.sessionId };
}
const terminal = new Set(['ended', 'fatal_error']);
const webhookSchema = z.object({
  idempotency_key: z.string().uuid(),
  bot_id: z.string().min(1).max(256),
  bot_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  trigger: z.enum(['transcript.update', 'bot.state_change']),
  data: z.unknown(),
});

/** The enum fields of a `bot.state_change` payload; anything else stays out of the log. */
function stateChangeFields(data: unknown) {
  const fields = z
    .object({
      new_state: z.unknown(),
      old_state: z.unknown(),
      event_type: z.unknown(),
      event_sub_type: z.unknown(),
    })
    .partial()
    .safeParse(data);
  if (!fields.success) return {};
  return {
    newState: providerCode(fields.data.new_state),
    oldState: providerCode(fields.data.old_state),
    eventType: providerCode(fields.data.event_type),
    eventSubType: providerCode(fields.data.event_sub_type),
  };
}

function onlineStatus(state: OnlineMeeting): OnlineMeetingStatus {
  return {
    status: state.joinStatus ?? (state.phase === 'ended' ? 'ended' : 'joining'),
    reason: state.joinReason ?? null,
    platform: meetingPlatform(state.meetingUrl),
  };
}

/** The app only issues commands; this owner survives app closure and Core restart. */
export class AttendeeMeetings {
  private receiver: Server | undefined;
  private targetOrigin = '';
  private timer: NodeJS.Timeout | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private sharingGeneration = 0;
  private unsubscribeSharing: (() => void) | undefined;
  private polling: Promise<void> | undefined;
  private readonly researchJobs = new Map<string, Promise<void>>();
  private readonly connectors = new Map<string, PreviewConnector>();
  private readonly snapshotLogs = new Map<string, { utterances: number; at: number }>();
  /** Last logged reconciliation failure per meeting, so a stuck meeting warns once per kind. */
  private readonly failureLogs = new Map<string, string>();
  constructor(
    private readonly options: {
      store: EventStore;
      edge?: PreviewEdgeControl;
      ingest: (meeting: LiveMeetingSyncRecord) => Promise<void>;
      spoken?: (
        meeting: LiveMeetingSyncRecord,
        utterance: string,
        requestId: string,
      ) => Promise<void>;
      client?: (key: string) => AttendeeClient;
      log?: AttendeeMeetingsLog;
    },
  ) {
    this.unsubscribeSharing = options.edge?.onSharingDisabled?.(() => {
      this.sharingGeneration += 1;
      for (const connector of this.connectors.values()) connector.close();
      this.connectors.clear();
      // Provider recovery must not reopen a webhook after local authority loss.
      void this.serial(async () => {
        for (const row of await this.records()) {
          const state = row.state;
          if (!state.binding) continue;
          const shareId = state.binding.shareId;
          try {
            await this.revokeShare(shareId);
          } catch {
            // Retain the handle when durable revocation cannot be confirmed.
            continue;
          }
          delete state.binding;
          await this.save(state);
        }
      }).catch(() => undefined);
    });
  }

  private async revokeShare(shareId: string): Promise<void> {
    if (!this.options.edge) throw new Error('Uplink cleanup is unavailable');
    try {
      await this.options.edge.remove(shareId);
    } catch (error) {
      // Provider completion can proceed once revocation survives a restart.
      if (!(error instanceof PreviewShareRemovalQueuedError)) throw error;
    }
  }

  private client(key: string) {
    return this.options.client?.(key) ?? new AttendeeClient(key);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async records() {
    return (await this.options.store.listAttendeeState<OnlineMeeting>()).filter((row) =>
      row.id.startsWith('meeting:'),
    );
  }
  private async save(state: OnlineMeeting) {
    await this.options.store.putAttendeeState(`meeting:${state.meeting.id}`, state);
  }
  private async publish(state: OnlineMeeting) {
    state.meeting.revision += 1;
    await this.save(state);
    const meeting = assigned(state.meeting);
    if (meeting) await this.options.ingest(meeting);
  }
  async config() {
    const config = await this.options.store.getAttendeeState<AttendeeConfig>('config');
    return { configured: Boolean(config?.apiKey && config.webhookSecret) };
  }
  async configure(config: AttendeeConfig | null) {
    if (config) await this.options.store.putAttendeeState('config', config);
    else await this.options.store.deleteAttendeeState('config');
    return this.config();
  }
  async test() {
    const config = await this.options.store.getAttendeeState<AttendeeConfig>('config');
    if (!config) throw new Error('Configure Attendee first.');
    await this.client(config.apiKey).request('bots');
    return { connected: true };
  }

  async open(): Promise<void> {
    this.receiver = createServer((request, response) => {
      // Outcome only: the payload carries transcript text and the URL carries the share PIN.
      const answer = (status: number, outcome: string, entry: Record<string, unknown> = {}) => {
        response.writeHead(status).end();
        // Info, not warn: the public share lets anyone probe this receiver.
        this.options.log?.info({ status, outcome, ...entry }, 'Attendee webhook answered');
      };
      void (async () => {
        if (request.method !== 'POST' || request.url !== ATTENDEE_WEBHOOK_PATH) {
          answer(404, 'unknown_path');
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request as AsyncIterable<unknown>) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body');
          bytes += chunk.length;
          if (bytes > 1_000_000) {
            answer(413, 'too_large');
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const event = webhookSchema.parse(payload);
        const state = (await this.records()).find(
          (row) =>
            row.state.botId === event.bot_id ||
            (!row.state.botId && event.bot_metadata?.verityMeetingId === row.state.meeting.id),
        )?.state;
        const signature = request.headers['x-webhook-signature'];
        const rejected = !state
          ? 'unknown_meeting'
          : state.phase === 'ended'
            ? 'meeting_ended'
            : typeof signature !== 'string'
              ? 'signature_missing'
              : !verifyAttendeeSignature(payload, signature, state.credentials.webhookSecret)
                ? 'signature_invalid'
                : undefined;
        const entry = {
          trigger: event.trigger,
          botId: event.bot_id,
          ...(state ? { meetingId: state.meeting.id } : {}),
        };
        if (rejected) {
          answer(401, rejected, entry);
          return;
        }
        // Delivery acknowledgment is independent of provider/model calls. The durable
        // marker is a wake-up hint; full snapshots supply idempotent transcript recovery.
        await this.options.store.putAttendeeState(`event:${event.bot_id}`, event);
        // Only a signed delivery describes the bot; probes never reach the log with content.
        answer(202, 'accepted', {
          ...entry,
          ...(event.trigger === 'bot.state_change' ? stateChangeFields(event.data) : {}),
        });
      })().catch((error: unknown) => {
        if (!response.headersSent) answer(400, 'invalid', failureFields(error));
      });
    });
    this.receiver.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.receiver!.once('error', reject);
      this.receiver!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not start meeting receiver');
    this.targetOrigin = `http://127.0.0.1:${address.port}`;
    this.timer = setInterval(() => {
      this.poll();
    }, 10_000);
    this.timer.unref();
    this.poll();
  }
  async close() {
    this.closed = true;
    this.unsubscribeSharing?.();
    clearInterval(this.timer);
    await this.polling;
    await this.tail;
    await Promise.all(this.researchJobs.values());
    for (const connector of this.connectors.values()) connector.close();
    this.connectors.clear();
    const receiver = this.receiver;
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
    // Persisted bots continue; shutdown must not masquerade as an explicit End.
  }
  private async connect(state: OnlineMeeting) {
    if (!state.binding || this.connectors.has(state.meeting.id)) return;
    if (this.options.edge?.isAvailable?.() === false)
      throw new Error('Online sharing authority lost before connection');
    const generation = this.sharingGeneration;
    const connector = new PreviewConnector({
      shareId: state.binding.shareId,
      edgeUrl: state.binding.edgeUrl,
      connectorToken: state.binding.connectorToken,
      targetOrigin: this.targetOrigin,
      maxBodyBytes: 1_000_000,
      requestTimeoutMs: 8_000,
      onDiagnostic: (diagnostic) => {
        try {
          const entry = {
            meetingId: state.meeting.id,
            shareId: state.binding?.shareId,
            ...diagnostic,
          };
          if (diagnostic.event === 'connect.failed' || diagnostic.event === 'heartbeat.timeout')
            this.options.log?.warn(entry, 'Online meeting connector transport');
          else this.options.log?.info(entry, 'Online meeting connector transport');
        } catch {
          /* Diagnostics must not affect the connection. */
        }
      },
    });
    await connector.connect();
    if (generation !== this.sharingGeneration || this.options.edge?.isAvailable?.() === false) {
      connector.close();
      throw new Error('Online sharing authority lost during connection');
    }
    this.connectors.set(state.meeting.id, connector);
    void connector
      .waitForDisconnect()
      .then(() => {
        if (this.connectors.get(state.meeting.id) === connector)
          this.connectors.delete(state.meeting.id);
      })
      .catch(() => undefined);
  }

  /** Starts a bot for `sessionId`, or unassigned when `sessionId` is null. */
  async start(
    sessionId: string | null,
    meetingUrl: string,
    listenForVerity: boolean,
    title?: string,
    diagnostics?: { requestId: string; emit: (entry: MeetingStartDiagnostic) => void },
  ) {
    return this.serial(async () => {
      if (!this.options.edge || !this.targetOrigin)
        throw new OnlineMeetingStartError(
          'Online meetings require an available Uplink webhook connection. Check Uplink / Online Sharing and retry.',
        );
      if (sessionId !== null && !(await this.options.store.getSession(sessionId)))
        throw new Error('Session not found.');
      const credentials = await this.options.store.getAttendeeState<AttendeeConfig>('config');
      if (!credentials) throw new Error('Configure Attendee in Connected services first.');
      if (sessionId !== null && (await this.activeIn(sessionId)))
        throw new Error('An online meeting is already active in this session.');
      const id = randomUUID();
      const state: OnlineMeeting = {
        meeting: {
          id,
          sessionId,
          engine: 'attendee',
          title: title?.trim() || null,
          startedAt: Date.now(),
          endedAt: null,
          state: 'active',
          transcript: '',
          captureStatus: 'preparing',
          ownerTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          revision: 0,
        },
        pin: String(randomInt(100_000, 1_000_000)),
        meetingUrl,
        credentials,
        identities: {},
        phase: 'preparing',
        stopRequested: false,
        listenForVerity,
        pendingRequests: {},
        processedRequests: {},
      };
      await this.publish(state);
      const sharingGeneration = this.sharingGeneration;
      let phase: MeetingStartDiagnostic['phase'] = 'ensure_sharing';
      let code = 'pending';
      let shareCreateSent = false;
      const emit = (event: MeetingStartDiagnostic['event']) => {
        try {
          const entry = {
            ...(diagnostics?.requestId === undefined ? {} : { requestId: diagnostics.requestId }),
            meetingId: id,
            phase,
            code,
            shareCreateSent,
            bindingPresent: Boolean(state.binding),
            botCreateAttempted: Boolean(state.botCreateAttempted),
            event,
          } satisfies MeetingStartDiagnostic;
          if (diagnostics) diagnostics.emit(entry);
          // Calendar starts have no request diagnostic callback.
          else if (event === 'failed') this.options.log?.warn(entry, 'Online meeting start failed');
          else this.options.log?.info(entry, 'Online meeting start progress');
        } catch {
          /* Diagnostics must not affect meeting state. */
        }
      };
      const progress = (entry: PreviewCreateDiagnostic) => {
        phase = entry.phase;
        code = entry.code;
        shareCreateSent = entry.shareCreateSent;
        emit('progress');
      };
      try {
        emit('progress');
        const binding = await this.options.edge.create(
          {
            durationSeconds: 30 * 24 * 60 * 60,
            pinHash: hashPreviewPin(state.pin),
            webhook: { path: ATTENDEE_WEBHOOK_PATH },
          },
          progress,
        );
        state.binding = { ...binding, expiresAt: binding.expiresAt.toISOString() };
        await this.save(state);
        phase = 'connector_connect';
        code = 'pending';
        emit('progress');
        await this.connect(state);
        phase = 'connector_ready';
        code = 'ready';
        emit('progress');
        const webhookUrl = new URL(ATTENDEE_WEBHOOK_PATH, binding.publicOrigin);
        webhookUrl.searchParams.set('pin', state.pin);
        phase = 'provider_setup';
        code = 'pending';
        state.botCreateAttempted = true;
        await this.save(state);
        if (
          sharingGeneration !== this.sharingGeneration ||
          this.options.edge.isAvailable?.() === false
        ) {
          state.botCreateAttempted = false;
          throw new Error('Online sharing authority lost before bot creation');
        }
        const bot = z.object({ id: z.string() }).parse(
          await this.client(credentials.apiKey).request('bots', 'POST', {
            meeting_url: meetingUrl,
            bot_name: 'Verity — Meeting notes',
            deduplication_key: id,
            metadata: { verityMeetingId: id },
            webhooks: [
              { url: webhookUrl.toString(), triggers: ['bot.state_change', 'transcript.update'] },
            ],
          }),
        );
        state.botId = bot.id;
        state.phase = 'running';
        await this.publish(state);
        return { meetingId: id };
      } catch (error) {
        const failedPhase = phase;
        const failedCode = code;
        if (code === 'pending' || code === 'ready') code = 'failed';
        emit('failed');
        if (error instanceof AttendeeRequestRejected) state.botCreateAttempted = false;
        if (!state.botCreateAttempted) {
          if (state.binding) {
            try {
              await this.revokeShare(state.binding.shareId);
              delete state.binding;
            } catch {
              // Keep preparation cleanup retryable when the durable queue fails.
            }
          }
          this.connectors.get(id)?.close();
          this.connectors.delete(id);
          state.phase = state.binding ? 'stopping' : 'ended';
          state.meeting.state = 'ended';
          state.meeting.endedAt = Date.now();
          state.credentials = { apiKey: '', webhookSecret: '' };
          state.pin = '';
          await this.publish(state);
          throw new OnlineMeetingStartError(
            error instanceof AttendeeRequestRejected
              ? `Attendee rejected the meeting request (${error.status}). Check Connected services and the meeting link, then retry.`
              : uplinkStartFailure(failedPhase, failedCode),
            { cause: error },
          );
        }
        state.phase = 'interrupted';
        state.meeting.state = 'interrupted';
        state.error =
          'Online meeting start did not complete. Provider state will be reconciled; do not start another bot.';
        await this.publish(state);
        // Keep the saved binding: a timed-out bot creation may still deliver its ID.
        throw new OnlineMeetingStartError(state.error, { cause: error });
      }
    });
  }

  async edit(
    sessionId: string,
    id: string,
    edits: Pick<
      LiveMeetingSyncRecord,
      'title' | 'speakerNames' | 'speakerCorrections' | 'speakerMerges'
    >,
  ) {
    return this.serial(async () => {
      const state = await this.options.store.getAttendeeState<OnlineMeeting>(`meeting:${id}`);
      if (!state || state.meeting.sessionId !== sessionId)
        throw new Error('Online meeting not found.');
      if (edits.speakerNames) {
        state.speakerNameOverrides ??= {};
        for (const speaker of Object.keys(state.speakerNameOverrides)) {
          if (!(speaker in edits.speakerNames)) delete state.speakerNameOverrides[speaker];
        }
        for (const [speaker, name] of Object.entries(edits.speakerNames)) {
          if (name !== state.meeting.speakerNames?.[speaker]) {
            state.speakerNameOverrides[speaker] = name;
          }
        }
      }
      Object.assign(state.meeting, edits);
      await this.publish(state);
      return { accepted: true };
    });
  }
  async stop(sessionId: string, id: string) {
    return this.serial(async () => {
      const state = await this.options.store.getAttendeeState<OnlineMeeting>(`meeting:${id}`);
      if (!state || state.meeting.sessionId !== sessionId)
        throw new Error('Online meeting not found.');
      // Repeated End taps must not ask the provider again; reconciliation keeps retrying.
      if (state.phase === 'ended' || state.stopRequested) return { accepted: true };
      state.stopRequested = true;
      state.phase = 'stopping';
      await this.publish(state);
      await this.reconcileOne(state);
      return { accepted: true };
    });
  }

  /** Join progress of an online meeting in `sessionId`; undefined when it is not one. */
  async status(sessionId: string, id: string): Promise<OnlineMeetingStatus | undefined> {
    const state = await this.options.store.getAttendeeState<OnlineMeeting>(`meeting:${id}`);
    if (!state || state.meeting.sessionId !== sessionId) return undefined;
    return onlineStatus(state);
  }

  /** Join status of every running online meeting, for the floating meeting card. */
  async joinStatuses(): Promise<Map<string, OnlineJoinStatus>> {
    return new Map(
      (await this.records())
        .filter((row) => row.state.phase !== 'ended')
        .map((row) => [row.state.meeting.id, onlineStatus(row.state).status]),
    );
  }

  /** Unassigned meetings, newest first. Discarded ones are on their way out. */
  async unassigned(): Promise<UnassignedOnlineMeeting[]> {
    return (await this.records())
      .map((row) => row.state)
      .filter((state) => state.meeting.sessionId === null && !state.discarded)
      .map((state) => ({
        id: state.meeting.id,
        title: state.meeting.title ?? null,
        startedAt: state.meeting.startedAt,
        endedAt: state.meeting.endedAt,
        state: state.meeting.state,
        captureStatus: state.meeting.captureStatus,
        people: new Set(Object.values(state.identities)).size,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Attaches an unassigned meeting to a session and publishes everything said so far. */
  async assign(id: string, sessionId: string): Promise<{ meetingId: string }> {
    return this.serial(async () => {
      const state = await this.options.store.getAttendeeState<OnlineMeeting>(`meeting:${id}`);
      if (!state || state.meeting.sessionId !== null || state.discarded)
        throw new UnassignedMeetingNotFoundError();
      if (!(await this.options.store.getSession(sessionId))) throw new Error('Session not found.');
      if (state.phase !== 'ended' && (await this.activeIn(sessionId)))
        throw new Error('An online meeting is already active in this session.');
      state.meeting.sessionId = sessionId;
      await this.publish(state);
      this.schedulePendingRequests(state);
      return { meetingId: id };
    });
  }

  /** Stops the bot of an unassigned meeting and forgets what it heard. False when the
   * meeting is unknown or was assigned meanwhile: published meetings stay. */
  async discard(id: string): Promise<boolean> {
    return this.discardOwned(id, null);
  }

  /** Forgets the provider state of a finished meeting discarded from `sessionId`; the
   * published meeting itself is deleted by the caller. False when it is not ours. */
  async discardFinished(sessionId: string, id: string): Promise<boolean> {
    return this.discardOwned(id, sessionId);
  }

  private async discardOwned(id: string, sessionId: string | null): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.options.store.getAttendeeState<OnlineMeeting>(`meeting:${id}`);
      if (!state || state.meeting.sessionId !== sessionId) return false;
      state.discarded = true;
      this.forget(state);
      await this.save(state);
      // A provider failure leaves the flag for the reconcile loop to finish.
      await this.finishDiscard(state).catch(() => undefined);
      return true;
    });
  }

  /** The meeting whose bot is in that call now, assigned or not. */
  async runningFor(meetingUrl: string): Promise<string | undefined> {
    const call = meetingCallKey(meetingUrl);
    return (await this.records()).find(
      (row) =>
        row.state.meetingUrl !== undefined &&
        meetingCallKey(row.state.meetingUrl) === call &&
        row.state.phase !== 'ended' &&
        !row.state.stopRequested &&
        !row.state.discarded,
    )?.state.meeting.id;
  }

  private async activeIn(sessionId: string): Promise<boolean> {
    return (await this.records()).some(
      (row) =>
        row.state.meeting.sessionId === sessionId &&
        row.state.phase !== 'ended' &&
        !row.state.discarded,
    );
  }

  /** Drops transcript and pending work so a discarded meeting keeps nothing it heard. */
  private forget(state: OnlineMeeting) {
    this.snapshotLogs.delete(state.meeting.id);
    this.failureLogs.delete(state.meeting.id);
    state.stopRequested = true;
    state.pendingRequests = {};
    state.meeting.transcript = '';
    state.meeting.timedWords = [];
    state.meeting.speakerTurns = [];
  }

  /** Ends the provider side of a discarded meeting; deletes the state once it has ended.
   * A failure leaves the state for the reconcile loop to finish. */
  private async finishDiscard(state: OnlineMeeting) {
    if (state.phase !== 'ended') await this.reconcileOne(state, true);
    if (state.phase !== 'ended') return;
    await this.options.store.deleteAttendeeState(`meeting:${state.meeting.id}`);
    if (state.botId) await this.options.store.deleteAttendeeState(`event:${state.botId}`);
  }

  private poll() {
    if (this.closed || this.polling) return;
    this.polling = this.reconcile()
      .catch((error: unknown) => {
        this.options.log?.warn(failureFields(error), 'Online meeting reconciliation failed');
      })
      .finally(() => {
        this.polling = undefined;
      });
  }
  private async reconcile() {
    if (this.closed) return;
    for (const { id } of await this.records()) {
      await this.serial(async () => {
        if (this.closed) return;
        const state = await this.options.store.getAttendeeState<OnlineMeeting>(id);
        if (!state) return;
        try {
          const sessionId = state.meeting.sessionId;
          const deleted =
            state.discarded === true ||
            (sessionId !== null && !(await this.options.store.getSession(sessionId)));
          if (deleted) {
            this.forget(state);
            await this.save(state);
            await this.finishDiscard(state);
          } else {
            if (state.phase !== 'ended') await this.reconcileOne(state);
            this.failureLogs.delete(state.meeting.id);
            this.schedulePendingRequests(state);
          }
        } catch (error) {
          const failure = failureFields(error);
          const kind = JSON.stringify(failure);
          if (this.failureLogs.get(state.meeting.id) !== kind) {
            this.failureLogs.set(state.meeting.id, kind);
            this.options.log?.warn(
              { meetingId: state.meeting.id, phase: state.phase, ...failure },
              'Online meeting reconciliation failed',
            );
          }
          state.error = 'Meeting connection interrupted; retrying recovery.';
          await this.save(state);
        }
      });
    }
  }
  private schedulePendingRequests(state: OnlineMeeting) {
    // Requests wait until the meeting has a session to answer in.
    if (
      this.closed ||
      !this.options.spoken ||
      state.meeting.sessionId === null ||
      this.researchJobs.has(state.meeting.id)
    )
      return;
    const job = this.processPendingRequests(state)
      .catch(() => undefined)
      .finally(() => this.researchJobs.delete(state.meeting.id));
    this.researchJobs.set(state.meeting.id, job);
  }
  private async processPendingRequests(state: OnlineMeeting) {
    const meeting = assigned(state.meeting);
    if (!this.options.spoken || !meeting) return;
    for (const [identity, text] of Object.entries(state.pendingRequests ?? {})) {
      if (this.closed) return;
      await this.options.spoken(meeting, text, `meeting-${state.meeting.id}-${identity}`);
      // Classification must not hold the lifecycle queue or overwrite a newer stop/snapshot.
      await this.serial(async () => {
        const latest = await this.options.store.getAttendeeState<OnlineMeeting>(
          `meeting:${state.meeting.id}`,
        );
        if (
          !latest ||
          latest.discarded ||
          latest.meeting.sessionId === null ||
          !(await this.options.store.getSession(latest.meeting.sessionId))
        )
          return;
        latest.processedRequests ??= {};
        latest.processedRequests[identity] = true;
        delete latest.pendingRequests?.[identity];
        await this.save(latest);
      });
    }
  }
  /** Utterance count and newest provider timestamp, at most once a minute while it grows. */
  private logSnapshot(
    state: OnlineMeeting,
    botState: string,
    snapshot: Array<{ timestamp_ms: number }>,
    final: boolean,
  ) {
    const id = state.meeting.id;
    const previous = this.snapshotLogs.get(id);
    const now = Date.now();
    const changed = previous?.utterances !== snapshot.length;
    const due = !previous || now - previous.at >= SNAPSHOT_LOG_INTERVAL_MS;
    if (!final && !(changed && due)) return;
    if (final) this.snapshotLogs.delete(id);
    else this.snapshotLogs.set(id, { utterances: snapshot.length, at: now });
    this.options.log?.info(
      {
        meetingId: id,
        botState,
        utterances: snapshot.length,
        lastTimestampMs: snapshot.reduce<number | null>(
          (latest, item) =>
            latest === null ? item.timestamp_ms : Math.max(latest, item.timestamp_ms),
          null,
        ),
      },
      'Online meeting transcript snapshot',
    );
  }
  private async reconcileOne(state: OnlineMeeting, discard = false) {
    let event = await this.options.store.getAttendeeState<z.infer<typeof webhookSchema>>(
      `event:${state.botId ?? ''}`,
    );
    if (!state.botId && !state.botCreateAttempted) {
      // A restart before provider submission must not leave a phantom active meeting.
      if (state.binding) {
        if (!this.options.edge) throw new Error('Uplink cleanup is unavailable');
        await this.revokeShare(state.binding.shareId);
      }
      this.connectors.get(state.meeting.id)?.close();
      this.connectors.delete(state.meeting.id);
      state.phase = 'ended';
      state.meeting.state = 'ended';
      state.meeting.endedAt = Date.now();
      state.credentials = { apiKey: '', webhookSecret: '' };
      state.pin = '';
      delete state.binding;
      if (discard) await this.save(state);
      else await this.publish(state);
      return;
    }
    if (!state.botId) {
      // A webhook can arrive before create returns; recover the provider ID from its signed metadata.
      const rows = await this.options.store.listAttendeeState<z.infer<typeof webhookSchema>>();
      const found = rows.find(
        (row) =>
          row.id.startsWith('event:') &&
          row.state.bot_metadata?.verityMeetingId === state.meeting.id,
      );
      if (found) {
        state.botId = found.state.bot_id;
        event = found.state;
        await this.save(state);
      } else {
        if (state.binding && new Date(state.binding.expiresAt).getTime() > Date.now()) {
          await this.connect(state);
        }
        return;
      }
    }
    const client = this.client(state.credentials.apiKey);
    const bot = attendeeBotSchema.parse(
      await client.request(`bots/${encodeURIComponent(state.botId)}`),
    );
    if (
      state.stopRequested &&
      !terminal.has(bot.state) &&
      bot.state !== 'post_processing' &&
      bot.state !== 'leaving'
    ) {
      await client.request(`bots/${encodeURIComponent(state.botId)}/leave`, 'POST');
    }
    const join = joinProgress(bot, state.joinedAt !== undefined);
    if (join.status === 'joined') state.joinedAt ??= Date.now();
    if (
      state.botState !== bot.state ||
      state.joinStatus !== join.status ||
      (state.joinReason ?? null) !== join.reason
    ) {
      // Content-free: provider identifiers and enum codes only, never the meeting link.
      const entry = {
        meetingId: state.meeting.id,
        botId: state.botId,
        platform: meetingPlatform(state.meetingUrl),
        botState: providerCode(bot.state) ?? 'unrecognized',
        previousBotState: state.botState ?? null,
        joinStatus: join.status,
        reason: join.reason,
        eventType: join.eventType,
        eventSubType: join.eventSubType,
      };
      if (join.status === 'failed')
        this.options.log?.warn(entry, 'Online meeting bot could not join');
      else this.options.log?.info(entry, 'Online meeting bot state changed');
      state.botState = bot.state;
      state.joinStatus = join.status;
      state.joinReason = join.reason;
      await this.save(state);
    }
    const final = terminal.has(bot.state);
    const snapshot = discard ? [] : await client.transcript(state.botId);
    if (!discard) this.logSnapshot(state, bot.state, snapshot, final);
    if (!discard) {
      if (state.timeOriginMs === undefined && snapshot.length) {
        state.timeOriginMs = snapshot.reduce(
          (earliest, item) => Math.min(earliest, item.timestamp_ms),
          Infinity,
        );
        await this.save(state);
      }
      const normalized = normalizeAttendeeTranscript(
        snapshot,
        state.identities,
        state.timeOriginMs,
      );
      const previous = JSON.stringify(state.meeting);
      const speakerNames = { ...normalized.speakerNames, ...state.speakerNameOverrides };
      Object.assign(state.meeting, normalized, { speakerNames });
      state.meeting.captureStatus = bot.state === 'joined_recording' ? 'listening' : 'preparing';
      state.meeting.state = final ? 'ended' : 'active';
      state.phase = final ? 'stopping' : state.stopRequested ? 'stopping' : 'running';
      if (final) state.meeting.endedAt ??= Date.now();
      if (previous !== JSON.stringify(state.meeting)) await this.publish(state);
      else {
        const meeting = assigned(state.meeting);
        if (meeting) await this.options.ingest(meeting);
      }
      if (state.listenForVerity && this.options.spoken) {
        state.pendingRequests ??= {};
        state.processedRequests ??= {};
        const current = new Set<string>();
        for (const utterance of snapshot) {
          const text = utterance.transcription.transcript;
          if (!/\bverity\b/iu.test(text)) continue;
          const identity = createHash('sha256')
            .update(JSON.stringify([utterance.speaker_uuid, utterance.timestamp_ms, text]))
            .digest('hex');
          current.add(identity);
          if (!state.processedRequests[identity]) state.pendingRequests[identity] = text;
        }
        for (const identity of Object.keys(state.pendingRequests)) {
          if (!current.has(identity)) delete state.pendingRequests[identity];
        }
        await this.save(state);
      }
    }
    if (final) {
      if (state.binding) await this.revokeShare(state.binding.shareId);
      this.connectors.get(state.meeting.id)?.close();
      this.connectors.delete(state.meeting.id);
      state.phase = 'ended';
      // Erase per-meeting credentials after final durable reconciliation.
      state.credentials = { apiKey: '', webhookSecret: '' };
      state.pin = '';
      delete state.binding;
      await this.save(state);
    } else if (state.binding && new Date(state.binding.expiresAt).getTime() > Date.now()) {
      try {
        await this.connect(state);
      } catch {
        /* Snapshot recovery remains available. */
      }
    } else if (!final) {
      state.phase = 'interrupted';
      state.error = 'Webhook share expired; recovering transcript through Attendee.';
      await this.save(state);
    }
    if (event) await this.options.store.deleteAttendeeState(`event:${state.botId}`);
  }
}
