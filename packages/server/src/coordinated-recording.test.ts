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
