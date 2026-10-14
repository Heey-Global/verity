import { createHash } from 'node:crypto';
import type { SelectedEvidenceMetadata } from '@verity/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import {
  CoordinatedRecordingManager,
  type RecordingUplinkAdapter,
} from './coordinated-recording.js';
import { recordingTransportState } from './recording-transport-state.js';
import { RemoteReturnPathDiagnostics } from './remote-return-path-diagnostics.js';

const id = '01234567-0123-4123-8123-0123456789ab';
const other = '11234567-0123-4123-8123-0123456789ab';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture() {
  let wall = Date.now(),
    mono = 0;
  const descriptor = { enabled: true, installationId: 'secret-installation' };
  const activation = new ReturnPathActivation(
    () => descriptor,
    undefined,
    () => wall,
    () => mono,
  );
  const uplink = {
    start: vi.fn<RecordingUplinkAdapter['start']>(async () => {}),
    status: vi.fn<NonNullable<RecordingUplinkAdapter['status']>>(async () => ({
      state: 'recording',
    })),
    stop: vi.fn<RecordingUplinkAdapter['stop']>(async () => {}),
    export: vi.fn(async () => ({ records: [] })),
  };
  const manager = new CoordinatedRecordingManager(
    activation,
    uplink,
    () => wall,
    () => mono,
  );
  cleanup.push(() => {
    manager.dispose();
    activation.dispose();
  });
  return {
    manager,
    activation,
    uplink,
    descriptor,
    advance: (ms: number, wallMs = ms) => {
      mono += ms;
      wall += wallMs;
    },
  };
}
describe('coordinated recording', () => {
  it('arms both collectors, binds identity, and never renews duplicate starts', async () => {
    const { manager, uplink, advance } = fixture();
    const status = await manager.start(id, 120000);
    expect(status.phase).toBe('recording');
    expect(JSON.stringify(status)).not.toContain('secret-installation');
    advance(1000);
    expect((await manager.start(id, 120000)).expiresAt).toBe(status.expiresAt);
    expect(uplink.start).toHaveBeenCalledTimes(1);
    await expect(manager.start(id, 60000)).rejects.toThrow('recording_conflict');
    await expect(manager.start(other, 120000)).rejects.toThrow('recording_conflict');
    advance(120000, -10000);
    expect(manager.status(id).phase).toBe('expired');
    expect((await manager.start(id, 120000)).phase).toBe('expired');
    advance(3600000);
    expect(() => manager.status(id)).toThrow('recording_not_found');
  });
  it('rolls back Core if Uplink start fails and exposes unavailable exports', async () => {
    const { manager, activation, uplink } = fixture();
    uplink.start.mockRejectedValueOnce(new Error('private text'));
    expect(await manager.start(id, 120000)).toMatchObject({
      phase: 'failed',
      error: 'uplink_start_failed',
    });
    expect(activation.status().enabled).toBe(false);
    expect(uplink.stop).toHaveBeenCalledWith(id);
    uplink.export.mockRejectedValueOnce(new Error('secret'));
    expect(await manager.export(id)).toMatchObject({
      uplink: { available: false, data: null, error: 'uplink_export_failed' },
    });
  });
  it('stops locally while Uplink is offline and retries without reviving capture', async () => {
    const { manager, activation, uplink } = fixture();
    await manager.start(id, 120000);
    uplink.stop.mockRejectedValueOnce(new Error('offline'));
    expect(await manager.stop(id)).toMatchObject({
      phase: 'stopped',
      uplink: { state: 'unavailable' },
    });
    expect(activation.status().enabled).toBe(false);
    expect(await manager.stop(id)).toMatchObject({
      phase: 'stopped',
      uplink: { state: 'stopped' },
    });
  });
  it('late Uplink start cannot revive a stopped run or stop a replacement locally', async () => {
    const { manager, uplink, activation } = fixture();
    let resolve!: () => void;
    uplink.start.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const starting = manager.start(id, 120000);
    await manager.stop(id);
    await manager.start(other, 120000);
    resolve();
    expect((await starting).phase).toBe('stopped');
    expect(manager.status(other).phase).toBe('recording');
    expect(activation.status().enabled).toBe(true);
    expect(uplink.stop.mock.calls.filter((call) => call[0] === id)).toHaveLength(2);
  });
  it('retains stop finalizer output without recursively stopping the collector', async () => {
    const { manager, activation } = fixture();
    await manager.start(id, 120000);
    const diagnostics = new RemoteReturnPathDiagnostics('session');
    const finalizer = vi.fn(() => manager.observe(diagnostics.exportSummary(true)));
    activation.beforeStop(finalizer);
    expect((await manager.stop(id)).phase).toBe('stopped');
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(manager.status(id).core.records).toBe(1);
    manager.dispose();
    expect(finalizer).toHaveBeenCalledTimes(1);
  });
  it('retains only allowlisted metadata with a bounded record budget', async () => {
    const { manager } = fixture();
    await manager.start(id, 120000);
    const diagnostics = new RemoteReturnPathDiagnostics('secret-session');
    const transport = recordingTransportState(undefined);
    const summary = {
      ...diagnostics.exportSummary(),
      transport: { ...transport, payload: 'secret-payload' },
    };
    for (let i = 0; i < 258; i++) manager.observe({ ...summary, token: 'secret-token' });
    expect(manager.status(id).core).toMatchObject({ records: 256, dropped: 2 });
    const result = await manager.export(id);
    expect(result).toMatchObject({
      core: { records: expect.arrayContaining([expect.objectContaining({ transport })]) },
    });
    const exported = JSON.stringify(result);
    expect(exported).not.toContain('secret-payload');
    expect(exported).not.toContain('secret-token');
    expect(exported).not.toContain('secret-session');
    await manager.stop(id);
    manager.observe(summary);
    expect(manager.status(id).core.records).toBe(256);
  });
});

it('passes explicit v2 to Uplink and pins the run version', async () => {
  const { manager, uplink } = fixture();
  await manager.start(id, 120000, 2);
  expect(uplink.start).toHaveBeenCalledWith(id, 120000, 2);
  await expect(manager.start(id, 120000, 1)).rejects.toThrow('recording_conflict');
});

it('reports unsupported diagnostic versions without exposing arbitrary errors', async () => {
  const { manager, uplink } = fixture();
  uplink.start.mockRejectedValueOnce(new Error('diagnostics_version_unavailable'));
  expect(await manager.start(id, 120000, 2)).toMatchObject({
    phase: 'failed',
    error: 'uplink_version_unavailable',
  });
});

it('refreshes a remotely capacity-stopped collector instead of repeating its start receipt', async () => {
  const { manager, uplink } = fixture();
  uplink.status = vi.fn(async () => ({ state: 'stopped' as const, stopReason: 'capacity' }));
  await manager.start(id, 120000, 2);
  expect(await manager.refreshStatus(id)).toMatchObject({
    phase: 'stopped',
    core: { state: 'stopped' },
    uplink: { state: 'stopped' },
  });
});

it('reports unreachable status without claiming continued readiness and recovers after a fresh reply', async () => {
  const { manager, uplink } = fixture();
  await manager.start(id, 120000, 2);
  uplink.status.mockRejectedValueOnce(new Error('private upstream error'));
  expect(await manager.refreshStatus(id)).toMatchObject({ uplink: { state: 'unavailable' } });
  expect(await manager.refreshStatus(id)).toMatchObject({ uplink: { state: 'recording' } });
});

it('does not revive a locally stopped run when an in-flight status request completes', async () => {
  const { manager, uplink } = fixture();
  await manager.start(id, 120000, 2);
  let resolve!: (value: { state: 'recording' }) => void;
  uplink.status.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const refresh = manager.refreshStatus(id);
  await manager.stop(id);
  resolve({ state: 'recording' });
  expect(await refresh).toMatchObject({ phase: 'stopped', uplink: { state: 'stopped' } });
});

function selectedMetadata(
  state: 'preparing' | 'recording' = 'preparing',
): SelectedEvidenceMetadata {
  const at = '2026-01-01T00:00:00.000Z';
  const bound = state === 'recording';
  const peer = {
    bound,
    active: bound,
    socketLifetimeId: bound ? id : null,
    generation: bound ? '0123456789abcdef' : null,
  };
  return {
    version: 3,
    runId: id,
    state,
    startedAt: at,
    endedAt: null,
    expiresAt: at,
    retainedUntil: at,
    collectorReady: true,
    recordCount: 0,
    droppedRecords: 0,
    diagnosticErrors: 0,
    omittedBindings: 0,
    stopReason: null,
    targetSession: createHash('sha256').update('selected-session').digest('hex').slice(0, 16),
    captureDurationMs: 30000,
    preparationExpiresAt: at,
    captureStartedAt: bound ? at : null,
    captureExpiresAt: bound ? at : null,
    burstStartedAt: null,
    samplingPolicy: {
      periodicIntervalMs: 1000,
      burstIntervalMs: 100,
      burstDurationMs: 1000,
      burstTrigger: 'first_periodic_pressure',
      finalStreamLimit: 8,
    },
    readiness: {
      revision: bound ? 1 : 0,
      checkedAt: at,
      monotonicMs: bound ? 100 : 0,
      ready: bound,
      installation: peer,
      app: { ...peer, socketLifetimeId: bound ? other : null },
    },
  };
}
it('keeps delayed selected attachment preparing and unrelated sessions out of Core evidence', async () => {
  const { manager, uplink, advance } = fixture();
  uplink.status.mockResolvedValue(selectedMetadata());
  expect(await manager.start(id, 30000, 3, 'selected-session')).toMatchObject({
    phase: 'starting',
    evidence: { readiness: { ready: false } },
  });
  expect(uplink.start).toHaveBeenCalledWith(id, 30000, 3, 'selected-session');
  const unrelated = new RemoteReturnPathDiagnostics('unrelated-session');
  const unrelatedSummary = unrelated.exportSummary();
  for (let i = 0; i < 300; i++) manager.observe(unrelatedSummary);
  expect(manager.status(id).core).toEqual({ state: 'recording', records: 0, dropped: 0 });
  advance(14000);
  uplink.status.mockResolvedValue(selectedMetadata('recording'));
  expect(await manager.refreshStatus(id)).toMatchObject({
    phase: 'recording',
    evidence: { readiness: { ready: true } },
  });
  const selected = new RemoteReturnPathDiagnostics('selected-session');
  manager.observe(selected.exportSummary());
  expect(manager.status(id).core.records).toBe(1);
  advance(30000);
  expect(manager.status(id).phase).toBe('recording');
  advance(1001, -100000);
  expect(manager.status(id).phase).toBe('expired');
  expect(JSON.stringify(await manager.export(id))).not.toContain('selected-session');
});
it('rejects ambiguous selection, stale status and target changes without fallback', async () => {
  const { manager, uplink } = fixture();
  await expect(manager.start(id, 30000, 3)).rejects.toThrow('invalid_recording');
  await expect(manager.start(id, 30001, 3, 'selected-session')).rejects.toThrow(
    'invalid_recording',
  );
  uplink.status.mockResolvedValue(selectedMetadata('recording'));
  await manager.start(id, 30000, 3, 'selected-session');
  expect(await manager.refreshStatus(id)).toMatchObject({ uplink: { state: 'unavailable' } });
  await expect(manager.start(id, 30000, 3, 'other-session')).rejects.toThrow('recording_conflict');
  uplink.status.mockResolvedValue(selectedMetadata());
  expect(await manager.refreshStatus(id)).toMatchObject({ uplink: { state: 'unavailable' } });
  uplink.status.mockResolvedValue({
    ...selectedMetadata('recording'),
    targetSession: '0000000000000000',
  });
  expect(await manager.refreshStatus(id)).toMatchObject({ uplink: { state: 'unavailable' } });
});
it('propagates preparation timeout and missing-pair termination as terminal evidence', async () => {
  const { manager, uplink } = fixture();
  uplink.status.mockResolvedValue(selectedMetadata());
  await manager.start(id, 30000, 3, 'selected-session');
  uplink.status.mockResolvedValue({
    ...selectedMetadata(),
    state: 'expired',
    endedAt: '2026-01-01T00:00:15.000Z',
    stopReason: 'preparation_timeout',
  });
  expect(await manager.refreshStatus(id)).toMatchObject({
    phase: 'expired',
    core: { state: 'stopped' },
    evidence: { stopReason: 'preparation_timeout', readiness: { ready: false } },
  });
});
