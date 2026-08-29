import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgentGatewayUnsealKey } from './agent-gateway-unseal-key.js';

const root = (): string => mkdtempSync(join(tmpdir(), 'verity-unseal-'));

describe('resolveAgentGatewayUnsealKey', () => {
  it('prefers an explicitly configured key and persists nothing', () => {
    const dir = root();
    const key = resolveAgentGatewayUnsealKey(dir, {
      VERITY_AGENT_GATEWAY_UNSEAL_KEY: 'host-provisioned',
    });
    expect(key).toBe('host-provisioned');
    expect(() => statSync(join(dir, 'agent-gateway', 'unseal-key'))).toThrow();
  });

  it('generates a 32-byte hex key and persists it 0600', () => {
    const dir = root();
    const key = resolveAgentGatewayUnsealKey(dir, {});
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    const keyPath = join(dir, 'agent-gateway', 'unseal-key');
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(key);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('reuses the persisted key across restarts', () => {
    // The gateway container outlives a Server recreate, so a fresh key each boot would
    // leave it holding material the Server no longer knows.
    const dir = root();
    const first = resolveAgentGatewayUnsealKey(dir, {});
    expect(resolveAgentGatewayUnsealKey(dir, {})).toBe(first);
  });

  it('replaces a corrupt key file rather than trusting it', () => {
    const dir = root();
    mkdirSync(join(dir, 'agent-gateway'), { recursive: true });
    writeFileSync(join(dir, 'agent-gateway', 'unseal-key'), 'truncated');
    const key = resolveAgentGatewayUnsealKey(dir, {});
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
  });
});
