import type { ProjectRecord } from '@verity/store';

type ProjectSandboxLifecycleOperation = 'sleep' | 'wake';

export interface ProjectSandboxLifecycleEvent {
  projectId: string;
  operation: ProjectSandboxLifecycleOperation;
  outcome: 'succeeded' | 'failed';
  durationMs: number;
}

export interface ProjectSandboxLifecycleSummary {
  windowStartedAt: string;
  projects: {
    active: number;
    sleeping: number;
    transitioning: number;
    other: number;
  };
  sleep: { succeeded: number; failed: number; averageMs: number | null; maxMs: number | null };
  wake: { succeeded: number; failed: number; averageMs: number | null; maxMs: number | null };
}

type Sink = (event: ProjectSandboxLifecycleEvent) => void;

const SUMMARY_INTERVAL_MS = 15 * 60_000;

export class ProjectSandboxLifecycleTelemetry {
  private readonly startedAt: Date;
  private readonly counts = {
    sleep: { succeeded: 0, failed: 0, totalMs: 0, maxMs: 0 },
    wake: { succeeded: 0, failed: 0, totalMs: 0, maxMs: 0 },
  };
  private sink: Sink | undefined;
  private readonly pending: ProjectSandboxLifecycleEvent[] = [];
  private lastSummaryAt: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly summaryIntervalMs = SUMMARY_INTERVAL_MS,
  ) {
    this.lastSummaryAt = now();
    this.startedAt = new Date(this.lastSummaryAt);
  }

  attachSink(sink: Sink): void {
    this.sink = sink;
    for (const event of this.pending.splice(0)) sink(event);
  }

  record(event: ProjectSandboxLifecycleEvent): void {
    const operation = this.counts[event.operation];
    operation[event.outcome] += 1;
    operation.totalMs += event.durationMs;
    operation.maxMs = Math.max(operation.maxMs, event.durationMs);
    if (this.sink !== undefined) this.sink(event);
    else if (this.pending.length < 100) this.pending.push(event);
  }

  summaryIfDue(projects: readonly ProjectRecord[]): ProjectSandboxLifecycleSummary | undefined {
    const at = this.now();
    if (at - this.lastSummaryAt < this.summaryIntervalMs) return undefined;
    this.lastSummaryAt = at;
    const states = { active: 0, sleeping: 0, transitioning: 0, other: 0 };
    for (const project of projects) {
      if (project.kind === 'control_plane') continue;
      if (project.state === 'active') states.active += 1;
      else if (project.state === 'sleeping') states.sleeping += 1;
      else if (project.state === 'sleeping_starting' || project.state === 'waking')
        states.transitioning += 1;
      else states.other += 1;
    }
    const operationSummary = (operation: (typeof this.counts)['sleep']) => {
      const attempts = operation.succeeded + operation.failed;
      return {
        succeeded: operation.succeeded,
        failed: operation.failed,
        averageMs: attempts === 0 ? null : Math.round(operation.totalMs / attempts),
        maxMs: attempts === 0 ? null : operation.maxMs,
      };
    };
    return {
      windowStartedAt: this.startedAt.toISOString(),
      projects: states,
      sleep: operationSummary(this.counts.sleep),
      wake: operationSummary(this.counts.wake),
    };
  }
}
