import { createHash } from 'node:crypto';
import { selectedEvidenceMetadataSchema, type SelectedEvidenceMetadata } from '@verity/events';
import { performance } from 'node:perf_hooks';
import { coreRecordingSummary } from './coordinated-recording-schema.js';
import type { ReturnPathActivation } from './remote-return-path-activation.js';

export interface RecordingUplinkAdapter {
  start(
    runId: string,
    durationMs: number,
    diagnosticsVersion?: 1 | 2 | 3,
    targetSessionId?: string,
  ): Promise<void>;
  status?(runId: string): Promise<
    | {
        state: 'preparing' | 'recording' | 'stopped' | 'expired';
        stopReason?: string | null;
      }
    | SelectedEvidenceMetadata
  >;
  stop(runId: string): Promise<void>;
  /** The adapter must validate and allowlist metadata before returning it. */
  export(runId: string): Promise<unknown>;
}
export interface CoordinatedRecordingStatus {
  version: 1;
  evidence?: SelectedEvidenceMetadata;
  runId: string;
  phase: 'starting' | 'recording' | 'stopped' | 'expired' | 'failed';
  startedAt: string;
  expiresAt: string;
  installationFingerprint: string;
  core: { state: 'recording' | 'stopped'; records: number; dropped: number };
  uplink: { state: 'pending' | 'recording' | 'stopped' | 'unavailable' };
  error:
    | null
    | 'uplink_start_failed'
    | 'uplink_version_unavailable'
    | 'uplink_stop_failed'
    | 'capture_interrupted';
}
type Run = {
  status: CoordinatedRecordingStatus;
  durationMs: number;
  diagnosticsVersion: 1 | 2 | 3;
  targetSessionId: string | undefined;
  targetSession: string | undefined;
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
    if (run.status.evidence && ['preparing', 'recording'].includes(run.status.evidence.state))
      delete run.status.evidence;
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
  async refreshStatus(runId: string): Promise<CoordinatedRecordingStatus> {
    const run = this.get(runId);
    if (!live(run)) return structuredClone(run.status);
    try {
      if (!this.uplink.status) throw new Error('status_unavailable');
      const remote = await this.uplink.status(runId);
      this.sweep();
      // A delayed response cannot revive a locally stopped or replaced run.
      if (live(run)) {
        if (run.diagnosticsVersion === 3) {
          const evidence = selectedEvidenceMetadataSchema.parse(remote);
          if (
            evidence.runId !== runId ||
            evidence.targetSession !== run.targetSession ||
            evidence.captureDurationMs !== run.durationMs
          )
            throw new Error('selection_mismatch');
          // Replayed live metadata cannot establish current socket readiness.
          if (
            run.status.evidence &&
            (evidence.readiness.revision < run.status.evidence.readiness.revision ||
              evidence.readiness.monotonicMs < run.status.evidence.readiness.monotonicMs ||
              (['preparing', 'recording'].includes(evidence.state) &&
                evidence.readiness.monotonicMs === run.status.evidence.readiness.monotonicMs &&
                evidence.readiness.revision === run.status.evidence.readiness.revision))
          )
            throw new Error('stale_status');
          run.status.evidence = evidence;
        }
        if (remote.state === 'preparing') {
          run.status.phase = 'starting';
          run.status.uplink.state = 'pending';
        } else if (remote.state !== 'recording') {
          this.finish(run, remote.state === 'expired' ? 'expired' : 'stopped');
          run.status.uplink.state = 'stopped';
        } else {
          run.status.uplink.state = 'recording';
          run.status.phase = 'recording';
        }
      }
    } catch {
      if (live(run)) run.status.uplink.state = 'unavailable';
    }
    return structuredClone(run.status);
  }
  async start(
    runId: string,
    durationMs: number,
    diagnosticsVersion: 1 | 2 | 3 = 1,
    targetSessionId?: string,
  ): Promise<CoordinatedRecordingStatus> {
    if (
      diagnosticsVersion === 3
        ? !targetSessionId || !/^[A-Za-z0-9_-]{1,128}$/u.test(targetSessionId) || durationMs > 30000
        : targetSessionId !== undefined
    )
      throw new Error('invalid_recording');
    if (![1, 2, 3].includes(diagnosticsVersion)) throw new Error('invalid_recording');
    if (!UUID.test(runId) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 120000)
      throw new Error('invalid_recording');
    this.sweep();
    const existing = this.runs.get(runId);
    if (existing) {
      if (
        existing.durationMs !== durationMs ||
        existing.diagnosticsVersion !== diagnosticsVersion ||
        existing.targetSessionId !== targetSessionId
      )
        throw new Error('recording_conflict');
      return structuredClone(existing.status);
    }
    if ((this.current && live(this.current)) || this.activation.status().enabled)
      throw new Error('recording_conflict');
    if (this.runs.size >= 8) throw new Error('recording_capacity');
    const started = this.wall();
    const overallDurationMs = durationMs + (diagnosticsVersion === 3 ? 15000 : 0);
    const expiresAt = new Date(started + overallDurationMs).toISOString();
    const core = this.activation.start(expiresAt);
    const run: Run = {
      durationMs,
      diagnosticsVersion,
      targetSessionId,
      targetSession: targetSessionId
        ? createHash('sha256').update(targetSessionId).digest('hex').slice(0, 16)
        : undefined,
      deadline: this.monotonic() + overallDurationMs,
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
      if (diagnosticsVersion === 3)
        await this.uplink.start(runId, durationMs, diagnosticsVersion, targetSessionId);
      else await this.uplink.start(runId, durationMs, diagnosticsVersion);
      this.sweep();
      if (live(run)) {
        run.status.uplink.state = 'recording';
        run.status.phase = diagnosticsVersion === 3 ? 'starting' : 'recording';
        if (diagnosticsVersion === 3) await this.refreshStatus(runId);
      } else await this.remoteStop(run);
    } catch (error) {
      if (live(run)) this.finish(run, 'failed');
      run.status.error =
        error instanceof Error && error.message === 'diagnostics_version_unavailable'
          ? 'uplink_version_unavailable'
          : 'uplink_start_failed';
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
    if (run.targetSession && parsed.data.session !== run.targetSession) return;
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
