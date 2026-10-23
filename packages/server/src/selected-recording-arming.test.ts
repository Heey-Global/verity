import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedEvidenceMetadata } from '@verity/events';
import { ReturnPathActivation } from './remote-return-path-activation.js';
import {
  CoordinatedRecordingManager,
  type RecordingUplinkAdapter,
} from './coordinated-recording.js';
import { RemoteReturnPathDiagnostics } from './remote-return-path-diagnostics.js';
const golden = JSON.parse(
  readFileSync(
    new URL('../../events/src/fixtures/socket-evidence-v3.json', import.meta.url),
    'utf8',
  ),
) as {
  preparing: SelectedEvidenceMetadata & {
    type?: string;
    requestId?: string;
    exportHash?: string | null;
  };
  ready: SelectedEvidenceMetadata & {
    type?: string;
    requestId?: string;
    exportHash?: string | null;
  };
};
function metadata(value: typeof golden.preparing): SelectedEvidenceMetadata {
  const result = { ...value };
  delete result.type;
  delete result.requestId;
  delete result.exportHash;
  return result;
}
const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(golden.preparing.startedAt));
  const descriptor = { enabled: true, installationId: 'paired' };
  const activation = new ReturnPathActivation(() => descriptor);
  const ack = { ...structuredClone(golden.preparing), targetSession: hash('selected') };
  const ready = { ...structuredClone(golden.ready), targetSession: hash('selected') };
  const uplink = {
    selectedConnectorId: () => '00000000-0000-4000-8000-000000000088',
    start: vi.fn<RecordingUplinkAdapter['start']>(async () => metadata(ack)),
    status: vi.fn(async () => metadata(ready)),
    stop: vi.fn(async () => {}),
    export: vi.fn(async () => null),
  };
  const manager = new CoordinatedRecordingManager(activation, uplink);
  cleanup.push(() => {
    manager.dispose();
    activation.dispose();
  });
  return { activation, manager, uplink, ack, ready, descriptor, id: ack.runId };
}
describe('selected Core arming', () => {
  it('requires a preparing ACK before returning confirmation and later fresh ready status', async () => {
    const { manager, uplink, activation, id } = fixture();
    const start = await manager.start(id, 30000, 3, 'selected');
    expect(uplink.start).toHaveBeenCalledWith(id, 30000, 3, 'selected');
    expect(start).toMatchObject({
      phase: 'starting',
      selection: { sessionHash: hash('selected'), confirmed: true },
    });
    expect(activation.expiry(hash('foreign'))).toBeUndefined();
    expect(await manager.selectedStatus(id)).toMatchObject({
      phase: 'recording',
      selection: { confirmed: true, readiness: { ready: true } },
    });
    expect(await manager.selectedStatus(id)).toMatchObject({
      phase: 'failed',
      selection: { confirmed: false, readiness: { ready: false } },
    });
    expect(activation.status().enabled).toBe(false);
  });
  it.each(['missing', 'foreign', 'already_app_bound', 'wrong_duration', 'wrong_run'])(
    'fails closed for %s confirmation',
    async (kind) => {
      const { manager, uplink, ack, activation, id } = fixture();
      const bad = structuredClone(ack);
      if (kind === 'foreign') bad.targetSession = hash('foreign');
      if (kind === 'already_app_bound') bad.readiness.app.bound = true;
      if (kind === 'wrong_duration') bad.captureDurationMs = 1;
      if (kind === 'wrong_run') bad.runId = '00000000-0000-4000-8000-000000000099';
      uplink.start.mockResolvedValueOnce(kind === 'missing' ? undefined : metadata(bad));
      expect(await manager.start(id, 30000, 3, 'selected')).toMatchObject({
        phase: 'failed',
        selection: { confirmed: false },
      });
      expect(activation.status().enabled).toBe(false);
      expect(uplink.stop).toHaveBeenCalledWith(id);
    },
  );
  it('does not resurrect confirmation after Stop races a delayed ACK', async () => {
    const { manager, uplink, ack, activation, id } = fixture();
    let resolve!: (value: typeof ack) => void;
    uplink.start.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = (value) => r(metadata(value));
        }),
    );
    const pending = manager.start(id, 30000, 3, 'selected');
    expect((await manager.selectedStatus(id)).selection?.confirmed).toBe(false);
    expect(uplink.status).not.toHaveBeenCalled();
    await manager.stop(id);
    resolve(ack);
    expect(await pending).toMatchObject({ phase: 'stopped', selection: { confirmed: false } });
    expect(activation.status().enabled).toBe(false);
  });
  it('revokes on identity loss, preparation expiry and pair replacement', async () => {
    for (const mode of ['identity', 'expiry', 'pair']) {
      const { manager, activation, descriptor, id, ready, uplink } = fixture();
      await manager.start(id, 30000, 3, 'selected');
      if (mode === 'identity') {
        descriptor.installationId = 'foreign';
        manager.status(id);
      }
      if (mode === 'expiry') await vi.advanceTimersByTimeAsync(15000);
      if (mode === 'pair') {
        await manager.selectedStatus(id);
        ready.readiness.revision++;
        ready.readiness.installation.socketLifetimeId = '00000000-0000-4000-8000-000000000099';
        uplink.status.mockResolvedValueOnce(metadata(ready));
        await manager.selectedStatus(id);
      }
      expect(manager.status(id).selection?.confirmed).toBe(false);
      expect(activation.status().enabled).toBe(false);
    }
  });
  it('preserves selected Core records in export and excludes foreign sessions', async () => {
    const { manager, id } = fixture();
    await manager.start(id, 30000, 3, 'selected');
    manager.observe(new RemoteReturnPathDiagnostics('foreign').exportSummary());
    manager.observe(new RemoteReturnPathDiagnostics('selected').exportSummary());
    await manager.stop(id);
    expect(await manager.export(id)).toMatchObject({
      core: { records: [expect.objectContaining({ session: hash('selected') })], dropped: 1 },
    });
  });
  it('rejects widening, a different target, and new duration on duplicate starts', async () => {
    const { manager, id } = fixture();
    await manager.start(id, 30000, 3, 'selected');
    await expect(manager.start(id, 30000, 3, 'other')).rejects.toThrow('recording_conflict');
    await expect(manager.start(id, 30000, 1)).rejects.toThrow('recording_conflict');
    await expect(manager.start(id, 30001, 3, 'selected')).rejects.toThrow('invalid_recording');
    expect((await manager.start(id, 30000, 3, 'selected')).selection?.confirmed).toBe(true);
  });
});
