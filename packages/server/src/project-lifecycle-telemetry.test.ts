import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSandboxLifecycleTelemetry } from './project-lifecycle-telemetry.js';

describe('project Sandbox lifecycle telemetry', () => {
  it('counts transitions and emits a bounded operational summary', () => {
    let now = 1_000;
    const telemetry = new ProjectSandboxLifecycleTelemetry(() => now, 300);
    telemetry.record({ projectId: 'p1', operation: 'sleep', outcome: 'succeeded', durationMs: 40 });
    telemetry.record({ projectId: 'p2', operation: 'sleep', outcome: 'failed', durationMs: 20 });
    telemetry.record({ projectId: 'p1', operation: 'wake', outcome: 'succeeded', durationMs: 90 });
    now += 300;

    expect(
      telemetry.summaryIfDue([
        { id: 'p1', state: 'active' } as ProjectRecord,
        { id: 'p2', state: 'sleeping' } as ProjectRecord,
        { id: 'p3', state: 'waking' } as ProjectRecord,
        { id: 'control', state: 'active', kind: 'control_plane' } as ProjectRecord,
      ]),
    ).toEqual({
      windowStartedAt: new Date(1_000).toISOString(),
      projects: { active: 1, sleeping: 1, transitioning: 1, other: 0 },
      sleep: { succeeded: 1, failed: 1, averageMs: 30, maxMs: 40 },
      wake: { succeeded: 1, failed: 0, averageMs: 90, maxMs: 90 },
    });
  });

  it('buffers startup transitions until the server logger attaches', () => {
    const telemetry = new ProjectSandboxLifecycleTelemetry();
    const sink = vi.fn();
    const event = {
      projectId: 'p1',
      operation: 'wake',
      outcome: 'failed',
      durationMs: 12,
    } as const;
    telemetry.record(event);
    telemetry.attachSink(sink);
    expect(sink).toHaveBeenCalledWith(event);
  });
});
