import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remoteControlIngressForTls } from './remote-control-deployment.js';

describe('remoteControlIngressForTls', () => {
  it('does not offer a plaintext direct listener', () => {
    expect(remoteControlIngressForTls('direct', false, 8082)).toBeUndefined();
  });

  it('dials only the local listener presenting the paired certificate', () => {
    expect(remoteControlIngressForTls('direct', true, 8082)).toEqual({
      localHost: '127.0.0.1',
      localPort: 8082,
    });
    expect(remoteControlIngressForTls('backend', false, 8787)).toEqual({
      localHost: 'verity',
      localPort: 8082,
    });
  });

  it('targets the managed Gateway endpoint published on the Server network', () => {
    const compose = readFileSync(
      new URL('../../../deploy/docker-compose.yml', import.meta.url),
      'utf8',
    );
    const gateway = compose.split('  verity-managed-gateway:')[1]?.split('  verity-updater:')[0];
    expect(gateway).toBeDefined();
    const alias = /aliases: \[([^\]]+)\]/u.exec(gateway!)?.[1];
    const port = /\$\{VERITY_API_HOST_PORT:-\d+\}:(\d+)/u.exec(gateway!)?.[1];
    expect(remoteControlIngressForTls('backend', false, 8787)).toEqual({
      localHost: alias,
      localPort: Number(port),
    });
    expect(compose).not.toContain('VERITY_REMOTE_CONTROL_ENABLED');
  });

  it('rejects an ambiguous direct TLS target', () => {
    expect(() => remoteControlIngressForTls('direct', true, 0)).toThrow('fixed TLS port');
  });
});
