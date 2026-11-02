import { describe, expect, it } from 'vitest';
import { verifyOfflineEvidence } from './build-storage-reconcile.mjs';

function fixture() {
  const record = {
    version: 1,
    operation: 'image-import',
    hostIdentity: 'a'.repeat(64),
    hostBootId: '11111111-1111-4111-8111-111111111111',
  };
  const host = { identity: record.hostIdentity, bootId: '22222222-2222-4222-8222-222222222222' };
  const services: Record<string, { UnitFileState: string; ActiveState: string; MainPID: string }> =
    Object.fromEntries(
      ['verity-buildkit.service', 'docker.service', 'docker.socket', 'containerd.service'].map(
        (unit) => [unit, { UnitFileState: 'masked', ActiveState: 'inactive', MainPID: '0' }],
      ),
    );
  services['emergency.target'] = { UnitFileState: 'static', ActiveState: 'active', MainPID: '0' };
  services['multi-user.target'] = {
    UnitFileState: 'static',
    ActiveState: 'inactive',
    MainPID: '0',
  };
  services['sockets.target'] = { UnitFileState: 'static', ActiveState: 'inactive', MainPID: '0' };
  return {
    record,
    host,
    services,
    verify: (executables: string[] = []) =>
      verifyOfflineEvidence(record, host, services, executables),
  };
}

describe('offline build storage reconciliation', () => {
  it('accepts only a different boot of the same host with all runtimes stopped in emergency mode', () => {
    const f = fixture();
    expect(() => f.verify()).not.toThrow();
    f.host.bootId = f.record.hostBootId;
    expect(() => f.verify()).toThrow('host boot has not ended');
    f.host.bootId = '22222222-2222-4222-8222-222222222222';
    f.host.identity = 'b'.repeat(64);
    expect(() => f.verify()).toThrow('not the recorded build host');
  });
  it.each(['verity-buildkit.service', 'docker.service', 'docker.socket', 'containerd.service'])(
    'requires stopped %s',
    (unit) => {
      const f = fixture();
      delete f.services[unit];
      expect(() => f.verify()).toThrow('stopped');
      f.services[unit] = { UnitFileState: 'enabled', ActiveState: 'inactive', MainPID: '0' };
      expect(() => f.verify()).not.toThrow();
      f.services[unit] = { UnitFileState: 'masked', ActiveState: 'active', MainPID: '123' };
      expect(() => f.verify()).toThrow('stopped');
    },
  );
  it.each(['node', 'buildkitd', 'dockerd', 'containerd-shim-runc-v2', 'runsc', 'devcontainer'])(
    'blocks remaining %s processes',
    (executable) => {
      expect(() => fixture().verify([executable])).toThrow('processes still exist');
    },
  );
  it('rejects missing host proof and malformed records', () => {
    const f = fixture();
    f.record.hostBootId = '';
    expect(() => f.verify()).toThrow('invalid remote operation');
  });
});

it('requires emergency mode without normal targets or socket activation', () => {
  const f = fixture();
  f.services['sockets.target']!.ActiveState = 'active';
  expect(() => f.verify()).toThrow('emergency.target');
});

it('accepts inactive socket units without a service-only MainPID property', () => {
  const f = fixture();
  f.services['docker.socket'] = {
    ActiveState: 'inactive',
    UnitFileState: 'disabled',
  } as (typeof f.services)[string];
  expect(() => f.verify()).not.toThrow();
});
