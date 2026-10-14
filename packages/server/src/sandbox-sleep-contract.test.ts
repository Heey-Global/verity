import { describe, expect, it } from 'vitest';
import type { ContainerInspect } from './docker.js';
import { sandboxSleepCompatibilityFingerprint } from './provisioner.js';

describe('sandbox sleep compatibility contract', () => {
  const running: ContainerInspect = {
    id: 'retained-sandbox',
    running: true,
    image: 'sandbox:current',
    networks: { 'project-network': { ipAddress: '172.30.0.2' } },
  };

  it('retains compatibility when Docker releases and reallocates endpoint addresses', () => {
    const fingerprint = sandboxSleepCompatibilityFingerprint(running);
    expect(
      sandboxSleepCompatibilityFingerprint({
        ...running,
        running: false,
        networks: { 'project-network': {} },
      }),
    ).toBe(fingerprint);
    expect(
      sandboxSleepCompatibilityFingerprint({
        ...running,
        networks: { 'project-network': { ipAddress: '172.30.0.9' } },
      }),
    ).toBe(fingerprint);
  });

  it('rejects network membership and container identity drift', () => {
    const fingerprint = sandboxSleepCompatibilityFingerprint(running);
    for (const drift of [
      { networks: { 'other-project-network': {} } },
      { networks: {} },
      { networks: { ...running.networks, 'shared-network': {} } },
      { id: 'replacement-sandbox' },
      { image: 'sandbox:other' },
    ]) {
      expect(sandboxSleepCompatibilityFingerprint({ ...running, ...drift })).not.toBe(fingerprint);
    }
  });
});
