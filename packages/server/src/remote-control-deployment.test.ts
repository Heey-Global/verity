import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remoteControlIngressFromEnv } from './remote-control-deployment.js';

describe('remoteControlIngressFromEnv', () => {
  it('leaves remote admission disabled until explicitly enabled', () => {
    expect(remoteControlIngressFromEnv(undefined, 'backend', false, 8082)).toBeUndefined();
    expect(remoteControlIngressFromEnv('0', 'direct', true, 8082)).toBeUndefined();
  });

  it('dials only the local listener presenting the paired certificate', () => {
    expect(remoteControlIngressFromEnv('1', 'direct', true, 8082)).toEqual({
      localHost: '127.0.0.1',
      localPort: 8082,
    });
    expect(remoteControlIngressFromEnv('1', 'backend', false, 8787)).toEqual({
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
    expect(remoteControlIngressFromEnv('1', 'backend', false, 8787)).toEqual({
      localHost: alias,
      localPort: Number(port),
    });
    expect(compose).toContain('VERITY_REMOTE_CONTROL_ENABLED: ${VERITY_REMOTE_CONTROL_ENABLED:-0}');
  });

  it('rejects an insecure or ambiguous opt-in', () => {
    expect(() => remoteControlIngressFromEnv('yes', 'direct', true, 8082)).toThrow(
      'must be 0 or 1',
    );
    expect(() => remoteControlIngressFromEnv('1', 'direct', false, 8082)).toThrow('TLS listener');
    expect(() => remoteControlIngressFromEnv('1', 'direct', true, 0)).toThrow('fixed TLS port');
  });
});
