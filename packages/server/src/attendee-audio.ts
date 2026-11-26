import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

export const ATTENDEE_AUDIO_PATH = '/websockets/attendee/audio';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PARTICIPANTS = 32;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_PENDING_FRAMES = 32;
const MAX_QUEUE = 8;
const MAX_TRANSCRIPTIONS = 5;
const CHUNK_BYTES = 4 * BYTES_PER_SECOND;
const IDLE_MS = 650;
const DRAIN_TIMEOUT_MS = 20_000;

const audioMessage = z.object({
  bot_id: z.string(),
  trigger: z.enum(['realtime_audio.mixed', 'realtime_audio.per_participant']),
  data: z.object({
    chunk: z.string(),
    sample_rate: z.literal(SAMPLE_RATE),
    timestamp_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    participant_uuid: z.string().min(1).max(256).optional(),
  }),
});

export type AttendeeAudioGap =
  'interrupted' | 'overloaded' | 'transcription_failed' | 'invalid_audio';

export interface AttendeeAudioInput {
  wav: Buffer;
  timestampMs: number;
  participantId?: string;
  signal: AbortSignal;
}

interface AudioChunk {
  pcm: Buffer[];
  bytes: number;
  timestampMs: number;
  participantId?: string;
}

interface Track {
  nextTimestampMs?: number;
  silenceBytes?: number;
  chunk?: AudioChunk;
  idle?: ReturnType<typeof setTimeout>;
}

interface AttendeeAudioOptions {
  token: string;
  botId: () => string | undefined;
  transcribe: (input: AttendeeAudioInput) => Promise<void>;
  onGap: (reason: AttendeeAudioGap) => void;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function encodeWav(chunk: AudioChunk): Buffer {
  const wav = Buffer.allocUnsafe(44 + chunk.bytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + chunk.bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(chunk.bytes, 40);
  let offset = 44;
  for (const buffer of chunk.pcm) offset += buffer.copy(wav, offset);
  return wav;
}

/** One loopback listener and bounded in-memory audio queue per online meeting. */
export class AttendeeAudioReceiver {
  private readonly server = createServer((_request, response) => response.writeHead(404).end());
  private readonly websocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  private readonly tracks = new Map<string | undefined, Track>();
  private readonly queued: AudioChunk[] = [];
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private receivedAudio = false;
  private readonly abort = new AbortController();
  private readonly reported = new Set<AttendeeAudioGap>();
  private socket: WebSocket | undefined;
  private disconnectedNormally = false;
  private readonly working = new Set<Promise<void>>();
  private stopping = false;
  private shutdown: Promise<void> | undefined;
  private draining: Promise<void> | undefined;

  constructor(private readonly options: AttendeeAudioOptions) {
    const tokenHash = hashToken(options.token);
    this.server.on('upgrade', (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '', 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      const tokens = url.searchParams.getAll('token');
      if (
        this.stopping ||
        this.socket ||
        url.pathname !== ATTENDEE_AUDIO_PATH ||
        tokens.length !== 1 ||
        !timingSafeEqual(hashToken(tokens[0] ?? ''), tokenHash)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (client) => {
        this.socket = client;
        if (this.disconnectedNormally) {
          this.disconnectedNormally = false;
          this.gap('interrupted');
        }
        client.on('message', (data: WebSocket.RawData, binary: boolean) => {
          if (!this.stopping) this.receive(data, binary);
        });
        client.on('error', () => {
          if (!this.stopping) this.gap('interrupted');
        });
        client.on('close', (code: number) => {
          this.socket = undefined;
          if (this.stopping) return;
          // The provider closes normally while its terminal state webhook is still in flight.
          if (code === 1000) this.disconnectedNormally = true;
          else this.gap('interrupted');
        });
      });
    });
  }

  get hasAudio(): boolean {
    return this.receivedAudio;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get streamClosed(): boolean {
    return this.disconnectedNormally;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const bound = this.server.address();
        if (!bound || typeof bound === 'string') reject(new Error('Audio listener unavailable'));
        else resolve(bound.port);
      });
    });
  }

  private gap(reason: AttendeeAudioGap): void {
    if (this.reported.has(reason) || this.abort.signal.aborted) return;
    this.reported.add(reason);
    this.options.onGap(reason);
  }

  private receive(raw: WebSocket.RawData, binary: boolean): void {
    if (binary || !Buffer.isBuffer(raw)) {
      this.gap('invalid_audio');
      return;
    }

    const expected = this.options.botId();
    if (!expected) {
      // The socket can arrive before the create-bot response. Hold a small amount
      // until the provider ID is known and verify every frame before processing.
      if (
        this.pending.length >= MAX_PENDING_FRAMES ||
        this.pendingBytes + raw.length > MAX_PENDING_BYTES
      ) {
        this.gap('overloaded');
      } else {
        this.pending.push(raw);
        this.pendingBytes += raw.length;
      }
      return;
    }
    this.flushPending(expected);
    this.receiveBound(raw, expected);
  }

  private flushPending(expected: string): void {
    for (const raw of this.pending) this.receiveBound(raw, expected);
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  private receiveBound(raw: Buffer, expected: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      this.gap('invalid_audio');
      return;
    }
    const parsed = audioMessage.safeParse(value);
    if (!parsed.success || parsed.data.bot_id !== expected) {
      this.gap('invalid_audio');
      return;
    }
    const { chunk, timestamp_ms: timestampMs, participant_uuid: participantId } = parsed.data.data;
    if (parsed.data.trigger === 'realtime_audio.per_participant' && !participantId) {
      this.gap('invalid_audio');
      return;
    }

    const pcm = Buffer.from(chunk, 'base64');
    if (!pcm.length || pcm.length % BYTES_PER_SAMPLE !== 0 || pcm.toString('base64') !== chunk) {
      this.gap('invalid_audio');
      return;
    }
    this.receivedAudio = true;
    const track = this.tracks.get(participantId) ?? this.addTrack(participantId);
    if (!track) return;
    // Attendee timestamps each message at send time. Adjacent frames can have
    // equal timestamps when it emits multiple buffered frames together.
    if (track.nextTimestampMs !== undefined && timestampMs > track.nextTimestampMs + 100) {
      this.enqueue(track);
    }
    track.nextTimestampMs =
      Math.max(timestampMs, track.nextTimestampMs ?? timestampMs) +
      (pcm.length / BYTES_PER_SECOND) * 1_000;
    const silent = !pcm.some((byte) => byte !== 0);
    if (silent) {
      if (!track.chunk) return;
      track.silenceBytes = (track.silenceBytes ?? 0) + pcm.length;
      if (track.silenceBytes >= (BYTES_PER_SECOND * IDLE_MS) / 1000) {
        this.enqueue(track);
        return;
      }
    } else {
      delete track.silenceBytes;
    }

    if (track.chunk && track.chunk.bytes + pcm.length > CHUNK_BYTES) {
      this.enqueue(track);
      if (silent) return;
    }
    track.chunk ??= {
      pcm: [],
      bytes: 0,
      timestampMs,
      ...(participantId === undefined ? {} : { participantId }),
    };
    track.chunk.pcm.push(pcm);
    track.chunk.bytes += pcm.length;
    clearTimeout(track.idle);
    track.idle = setTimeout(() => this.enqueue(track), IDLE_MS);
  }

  private addTrack(participantId: string | undefined): Track | undefined {
    if (this.tracks.size >= MAX_PARTICIPANTS) {
      for (const [idleId, track] of this.tracks) {
        if (track.chunk) continue;
        this.tracks.delete(idleId);
        break;
      }
      if (this.tracks.size >= MAX_PARTICIPANTS) {
        this.gap('overloaded');
        return undefined;
      }
    }
    const track = {};
    this.tracks.set(participantId, track);
    return track;
  }

  private enqueue(track: Track): void {
    clearTimeout(track.idle);
    delete track.idle;
    delete track.silenceBytes;
    const chunk = track.chunk;
    delete track.chunk;
    if (!chunk) return;
    if (this.queued.length >= MAX_QUEUE) {
      this.gap('overloaded');
      return;
    }
    this.queued.push(chunk);
    if (this.working.size >= MAX_TRANSCRIPTIONS) return;
    const work = this.processQueue().finally(() => {
      this.working.delete(work);
    });
    this.working.add(work);
  }

  private async processQueue(): Promise<void> {
    let chunk: AudioChunk | undefined;
    while (!this.abort.signal.aborted && (chunk = this.queued.shift())) {
      try {
        await this.options.transcribe({
          wav: encodeWav(chunk),
          timestampMs: chunk.timestampMs,
          ...(chunk.participantId === undefined ? {} : { participantId: chunk.participantId }),
          signal: this.abort.signal,
        });
      } catch {
        this.gap('transcription_failed');
      }
    }
  }

  finish(): Promise<void> {
    this.draining ??= this.drain();
    return this.draining;
  }

  private async drain(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          socket.off('close', done);
          resolve();
        };
        const timeout = setTimeout(() => {
          this.gap('interrupted');
          done();
        }, 2_000);
        socket.once('close', done);
      });
    }
    this.stopping = true;
    const expected = this.options.botId();
    if (expected) this.flushPending(expected);
    for (const track of this.tracks.values()) this.enqueue(track);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.working),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.gap('transcription_failed');
            resolve();
          }, DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      await this.close();
    }
  }

  close(): Promise<void> {
    this.shutdown ??= this.closeNow();
    return this.shutdown;
  }

  private async closeNow(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    for (const track of this.tracks.values()) clearTimeout(track.idle);
    this.tracks.clear();
    this.queued.length = 0;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.socket?.terminate();
    await new Promise<void>((resolve) => this.websocket.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
