import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PreviewConnector, hashPreviewPin } from '@verity/preview-tunnel';
import type { EventStore, LiveMeetingSyncRecord } from '@verity/store';
import { z } from 'zod';
import type { PreviewEdgeControl, PreviewEdgeBinding } from './preview-share-manager.js';
import {
  ATTENDEE_WEBHOOK_PATH,
  AttendeeClient,
  AttendeeRequestRejected,
  normalizeAttendeeTranscript,
  verifyAttendeeSignature,
} from './attendee-client.js';

export interface AttendeeConfig {
  apiKey: string;
  webhookSecret: string;
}
interface OnlineMeeting {
  meeting: LiveMeetingSyncRecord;
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
  error?: string;
}
const terminal = new Set(['ended', 'fatal_error']);
const webhookSchema = z.object({
  idempotency_key: z.string().uuid(),
  bot_id: z.string().min(1).max(256),
  bot_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  trigger: z.enum(['transcript.update', 'bot.state_change']),
  data: z.unknown(),
});

/** The app only issues commands; this owner survives app closure and Core restart. */
export class AttendeeMeetings {
  private receiver: Server | undefined;
  private targetOrigin = '';
  private timer: NodeJS.Timeout | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly researchJobs = new Map<string, Promise<void>>();
  private readonly connectors = new Map<string, PreviewConnector>();
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
    },
  ) {}

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
    await this.options.ingest(state.meeting);
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
      void (async () => {
        if (request.method !== 'POST' || request.url !== ATTENDEE_WEBHOOK_PATH) {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request as AsyncIterable<unknown>) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body');
          bytes += chunk.length;
          if (bytes > 1_000_000) {
            response.writeHead(413).end();
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
        if (
          !state ||
          state.phase === 'ended' ||
          typeof signature !== 'string' ||
          !verifyAttendeeSignature(payload, signature, state.credentials.webhookSecret)
        ) {
          response.writeHead(401).end();
          return;
        }
        // Delivery acknowledgment is independent of provider/model calls. The durable
        // marker is a wake-up hint; full snapshots supply idempotent transcript recovery.
        await this.options.store.putAttendeeState(`event:${event.bot_id}`, event);
        response.writeHead(202).end();
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400).end();
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
      void this.serial(() => this.reconcile()).catch(() => undefined);
    }, 10_000);
    this.timer.unref();
    void this.serial(() => this.reconcile()).catch(() => undefined);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
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
    const connector = new PreviewConnector({
      edgeUrl: state.binding.edgeUrl,
      connectorToken: state.binding.connectorToken,
      targetOrigin: this.targetOrigin,
      maxBodyBytes: 1_000_000,
      requestTimeoutMs: 8_000,
    });
    await connector.connect();
    this.connectors.set(state.meeting.id, connector);
    void connector
      .waitForDisconnect()
      .then(() => {
        if (this.connectors.get(state.meeting.id) === connector)
          this.connectors.delete(state.meeting.id);
      })
      .catch(() => undefined);
  }

  async start(sessionId: string, meetingUrl: string, listenForVerity: boolean) {
    return this.serial(async () => {
      if (!this.options.edge || !this.targetOrigin)
        throw new Error('Online meetings require an available Uplink webhook connection.');
      if (!(await this.options.store.getSession(sessionId))) throw new Error('Session not found.');
      const credentials = await this.options.store.getAttendeeState<AttendeeConfig>('config');
      if (!credentials) throw new Error('Configure Attendee in Connected services first.');
      if (
        (await this.records()).some(
          (row) => row.state.meeting.sessionId === sessionId && row.state.phase !== 'ended',
        )
      )
        throw new Error('An online meeting is already active in this session.');
      const id = randomUUID();
      const state: OnlineMeeting = {
        meeting: {
          id,
          sessionId,
          engine: 'attendee',
          startedAt: Date.now(),
          endedAt: null,
          state: 'active',
          transcript: '',
          captureStatus: 'preparing',
          ownerTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          revision: 0,
        },
        pin: String(randomInt(100_000_000, 1_000_000_000)),
        credentials,
        identities: {},
        phase: 'preparing',
        stopRequested: false,
        listenForVerity,
        pendingRequests: {},
        processedRequests: {},
      };
      await this.publish(state);
      try {
        const binding = await this.options.edge.create({
          durationSeconds: 30 * 24 * 60 * 60,
          pinHash: hashPreviewPin(state.pin),
          webhook: { path: ATTENDEE_WEBHOOK_PATH },
        });
        state.binding = { ...binding, expiresAt: binding.expiresAt.toISOString() };
        await this.save(state);
        await this.connect(state);
        const webhookUrl = new URL(ATTENDEE_WEBHOOK_PATH, binding.publicOrigin);
        webhookUrl.searchParams.set('pin', state.pin);
        state.botCreateAttempted = true;
        await this.save(state);
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
        if (error instanceof AttendeeRequestRejected) state.botCreateAttempted = false;
        if (!state.botCreateAttempted) {
          if (state.binding)
            await this.options.edge.remove(state.binding.shareId).catch(() => undefined);
          this.connectors.get(id)?.close();
          this.connectors.delete(id);
          state.phase = 'ended';
          state.meeting.state = 'ended';
          state.meeting.endedAt = Date.now();
          state.credentials = { apiKey: '', webhookSecret: '' };
          state.pin = '';
          delete state.binding;
          await this.publish(state);
          throw new Error(
            error instanceof AttendeeRequestRejected
              ? `Attendee rejected the meeting request (${error.status}). Check Connected services and the meeting link, then retry.`
              : 'Could not open the Uplink webhook connection. Check Uplink / Online Sharing and retry.',
            { cause: error },
          );
        }
        state.phase = 'interrupted';
        state.meeting.state = 'interrupted';
        state.error =
          'Online meeting start did not complete. Provider state will be reconciled; do not start another bot.';
        await this.publish(state);
        // Keep the saved binding: a timed-out bot creation may still deliver its ID.
        throw new Error(state.error, { cause: error });
      }
    });
  }

  async edit(
    sessionId: string,
    id: string,
    edits: Pick<LiveMeetingSyncRecord, 'speakerNames' | 'speakerCorrections' | 'speakerMerges'>,
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
      if (state.phase === 'ended') return { accepted: true };
      state.stopRequested = true;
      state.phase = 'stopping';
      await this.publish(state);
      await this.reconcileOne(state);
      return { accepted: true };
    });
  }

  private async reconcile() {
    if (this.closed) return;
    for (const { state } of await this.records()) {
      try {
        const deleted = !(await this.options.store.getSession(state.meeting.sessionId));
        if (deleted) {
          state.stopRequested = true;
          state.pendingRequests = {};
          state.meeting.transcript = '';
          state.meeting.timedWords = [];
          state.meeting.speakerTurns = [];
          await this.save(state);
        }
        if (state.phase !== 'ended') await this.reconcileOne(state, deleted);
        if (deleted && state.phase === 'ended') {
          await this.options.store.deleteAttendeeState(`meeting:${state.meeting.id}`);
          if (state.botId) await this.options.store.deleteAttendeeState(`event:${state.botId}`);
        } else if (!deleted) this.schedulePendingRequests(state);
      } catch {
        state.error = 'Meeting connection interrupted; retrying recovery.';
        await this.save(state);
      }
    }
  }
  private schedulePendingRequests(state: OnlineMeeting) {
    if (this.closed || !this.options.spoken || this.researchJobs.has(state.meeting.id)) return;
    const job = this.processPendingRequests(state)
      .catch(() => undefined)
      .finally(() => this.researchJobs.delete(state.meeting.id));
    this.researchJobs.set(state.meeting.id, job);
  }
  private async processPendingRequests(state: OnlineMeeting) {
    if (!this.options.spoken) return;
    for (const [identity, text] of Object.entries(state.pendingRequests ?? {})) {
      if (this.closed) return;
      await this.options.spoken(state.meeting, text, `meeting-${state.meeting.id}-${identity}`);
      // Classification must not hold the lifecycle queue or overwrite a newer stop/snapshot.
      await this.serial(async () => {
        const latest = await this.options.store.getAttendeeState<OnlineMeeting>(
          `meeting:${state.meeting.id}`,
        );
        if (!latest || !(await this.options.store.getSession(latest.meeting.sessionId))) return;
        latest.processedRequests ??= {};
        latest.processedRequests[identity] = true;
        delete latest.pendingRequests?.[identity];
        await this.save(latest);
      });
    }
  }
  private async reconcileOne(state: OnlineMeeting, discard = false) {
    const event = await this.options.store.getAttendeeState<z.infer<typeof webhookSchema>>(
      `event:${state.botId ?? ''}`,
    );
    if (!state.botId && !state.botCreateAttempted) {
      // A restart before provider submission must not leave a phantom active meeting.
      if (state.binding) {
        if (!this.options.edge) throw new Error('Uplink cleanup is unavailable');
        await this.options.edge.remove(state.binding.shareId);
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
      if (state.binding && new Date(state.binding.expiresAt).getTime() > Date.now()) {
        await this.connect(state);
      }
      // A webhook can arrive before create returns; recover the provider ID from its signed metadata.
      const rows = await this.options.store.listAttendeeState<z.infer<typeof webhookSchema>>();
      const found = rows.find(
        (row) =>
          row.id.startsWith('event:') &&
          row.state.bot_metadata?.verityMeetingId === state.meeting.id,
      );
      if (found) state.botId = found.state.bot_id;
      else return;
    }
    const client = this.client(state.credentials.apiKey);
    const bot = z
      .object({ state: z.string() })
      .parse(await client.request(`bots/${encodeURIComponent(state.botId)}`));
    if (
      state.stopRequested &&
      !terminal.has(bot.state) &&
      bot.state !== 'post_processing' &&
      bot.state !== 'leaving'
    ) {
      await client.request(`bots/${encodeURIComponent(state.botId)}/leave`, 'POST');
    }
    const final = terminal.has(bot.state);
    const snapshot = discard ? [] : await client.transcript(state.botId);
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
      else await this.options.ingest(state.meeting);
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
      if (state.binding) await this.options.edge?.remove(state.binding.shareId);
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
