import { performance } from 'node:perf_hooks';
import { coreRecordingSummary } from './coordinated-recording-schema.js';
import type { ReturnPathActivation } from './remote-return-path-activation.js';

export interface RecordingUplinkAdapter {
  start(runId: string, durationMs: number): Promise<void>;
  stop(runId: string): Promise<void>;
  /** The adapter must validate and allowlist metadata before returning it. */
  export(runId: string): Promise<unknown>;
}
export interface CoordinatedRecordingStatus {
  version: 1;
  runId: string;
  phase: 'starting' | 'recording' | 'stopped' | 'expired' | 'failed';
  startedAt: string;
  expiresAt: string;
  installationFingerprint: string;
  core: { state: 'recording' | 'stopped'; records: number; dropped: number };
  uplink: { state: 'pending' | 'recording' | 'stopped' | 'unavailable' };
  error: null | 'uplink_start_failed' | 'uplink_stop_failed' | 'capture_interrupted';
}
type Run = {
  status: CoordinatedRecordingStatus;
  durationMs: number;
  deadline: number;
  retainUntil: number;
  records: unknown[];
  bytes: number;
};
const live = (run: Run) => ['starting', 'recording'].includes(run.status.phase);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export class CoordinatedRecordingManager {
  private runs = new Map<string, Run>();
  private current: Run | undefined;
  private timer: NodeJS.Timeout;
  private finishing = false;
  constructor(
    private readonly activation: ReturnPathActivation,
    private readonly uplink: RecordingUplinkAdapter,
    private readonly wall = Date.now,
    private readonly monotonic = () => performance.now(),
  ) {
    this.timer = setInterval(() => this.sweep(), 250);
    this.timer.unref();
  }
  private sweep(): void {
    const current = this.current;
    if (current && live(current) && !this.finishing) {
      if (
        this.monotonic() >= current.deadline ||
        this.wall() >= Date.parse(current.status.expiresAt)
      ) {
        this.finish(current, 'expired');
        void this.remoteStop(current);
      } else if (!this.activation.status().enabled) {
        this.finish(current, 'failed');
        current.status.error = 'capture_interrupted';
        void this.remoteStop(current);
      }
    }
    for (const [id, run] of this.runs)
      if (!live(run) && this.monotonic() >= run.retainUntil) this.runs.delete(id);
  }
  private finish(run: Run, phase: 'stopped' | 'expired' | 'failed'): void {
    if (this.current === run && live(run)) {
      this.finishing = true;
      try {
        this.activation.stop();
      } finally {
        this.finishing = false;
      }
    }
    run.status.phase = phase;
    run.status.core.state = 'stopped';
  }
  private async remoteStop(run: Run): Promise<void> {
    try {
      await this.uplink.stop(run.status.runId);
      run.status.uplink.state = 'stopped';
    } catch {
      run.status.uplink.state = 'unavailable';
      run.status.error ??= 'uplink_stop_failed';
    }
  }
  private get(runId: string): Run {
    this.sweep();
    const run = this.runs.get(runId);
    if (!run) throw new Error('recording_not_found');
    return run;
  }
  status(runId: string): CoordinatedRecordingStatus {
    return structuredClone(this.get(runId).status);
  }
  async start(runId: string, durationMs: number): Promise<CoordinatedRecordingStatus> {
    if (!UUID.test(runId) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 120000)
      throw new Error('invalid_recording');
    this.sweep();
    const existing = this.runs.get(runId);
    if (existing) {
      if (existing.durationMs !== durationMs) throw new Error('recording_conflict');
      return structuredClone(existing.status);
    }
    if ((this.current && live(this.current)) || this.activation.status().enabled)
      throw new Error('recording_conflict');
    if (this.runs.size >= 8) throw new Error('recording_capacity');
    const started = this.wall();
    const expiresAt = new Date(started + durationMs).toISOString();
    const core = this.activation.start(expiresAt);
    const run: Run = {
      durationMs,
      deadline: this.monotonic() + durationMs,
      retainUntil: this.monotonic() + 3600000,
      records: [],
      bytes: 0,
      status: {
        version: 1,
        runId,
        phase: 'starting',
        startedAt: new Date(started).toISOString(),
        expiresAt,
        installationFingerprint: core.installationFingerprint!,
        core: { state: 'recording', records: 0, dropped: 0 },
        uplink: { state: 'pending' },
        error: null,
      },
    };
    this.current = run;
    this.runs.set(runId, run);
    try {
      await this.uplink.start(runId, durationMs);
      this.sweep();
      if (live(run)) {
        run.status.uplink.state = 'recording';
        run.status.phase = 'recording';
      } else await this.remoteStop(run);
    } catch {
      if (live(run)) this.finish(run, 'failed');
      run.status.error = 'uplink_start_failed';
      await this.remoteStop(run);
    }
    return structuredClone(run.status);
  }
  async stop(runId: string): Promise<CoordinatedRecordingStatus> {
    const run = this.get(runId);
    if (live(run)) this.finish(run, 'stopped');
    await this.remoteStop(run);
    return structuredClone(run.status);
  }
  observe(snapshot: unknown): void {
    this.sweep();
    const run = this.current;
    if (!run || !live(run)) return;
    const parsed = coreRecordingSummary.safeParse(snapshot);
    if (!parsed.success) {
      run.status.core.dropped++;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (run.records.length >= 256 || run.bytes + bytes > 1024 * 1024) {
      run.status.core.dropped++;
      return;
    }
    run.records.push(parsed.data);
    run.bytes += bytes;
    run.status.core.records = run.records.length;
  }
  async export(runId: string): Promise<unknown> {
    const run = this.get(runId);
    let data: unknown = null;
    let available = false;
    try {
      const result = await this.uplink.export(runId);
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('too_large');
      data = structuredClone(result);
      available = true;
    } catch {
      /* An unavailable source is explicit, never an empty successful capture. */
    }
    return {
      version: 1,
      status: structuredClone(run.status),
      core: { records: structuredClone(run.records), dropped: run.status.core.dropped },
      uplink: { available, data, error: available ? null : 'uplink_export_failed' },
    };
  }
  dispose(): void {
    clearInterval(this.timer);
    if (this.current && live(this.current)) {
      this.finish(this.current, 'stopped');
      void this.remoteStop(this.current);
    }
  }
}
