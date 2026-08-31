import { describe, expect, it } from 'vitest';

import {
  claudeEgressAgentEnv,
  claudeEgressRelayGeneration,
  claudeEgressRelayHealthy,
  claudeEgressRouteEnabled,
  claudeProjectEgressRefusal,
  claudeTransportRefusal,
} from './claude-egress-agent-env.js';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';

describe('claudeTransportRefusal', () => {
  it('admits a Claude turn only on the ACP transport', () => {
    expect(
      claudeTransportRefusal({ isClaudeSession: true, runnerSupervisorBackend: 'claude-acp' }),
    ).toBeUndefined();
  });

  it('refuses a Claude turn on any other transport and names it', () => {
    // 'claude' is the retired native transport. It must not silently run: every
    // branch downstream assumes ACP and therefore hands out no credential at all.
    for (const backend of ['claude', 'codex', 'codex-acp', undefined]) {
      const refusal = claudeTransportRefusal({
        isClaudeSession: true,
        runnerSupervisorBackend: backend,
      });
      expect(refusal).toContain('require the ACP transport');
      // The quoted form, so the assertion cannot pass on a substring the fixed
      // prefix happens to contain ('claude') or another backend name spells
      // ('codex' inside 'codex-acp').
      expect(refusal).toContain(`'${backend ?? 'none'}'`);
    }
  });

  it('leaves a non-Claude session alone whatever it resolved', () => {
    for (const backend of ['codex', 'codex-acp', undefined]) {
      expect(
        claudeTransportRefusal({ isClaudeSession: false, runnerSupervisorBackend: backend }),
      ).toBeUndefined();
    }
  });
});

describe('claudeProjectEgressRefusal', () => {
  it('refuses a Claude project turn when the gateway egress is unconfigured', () => {
    expect(claudeProjectEgressRefusal({ isClaudeSession: true, egressActive: false })).toContain(
      'require the agent gateway egress',
    );
  });

  it('admits a Claude project turn with an active egress', () => {
    expect(
      claudeProjectEgressRefusal({ isClaudeSession: true, egressActive: true }),
    ).toBeUndefined();
  });

  it('never refuses a non-Claude project turn, which does not use the egress', () => {
    expect(
      claudeProjectEgressRefusal({ isClaudeSession: false, egressActive: false }),
    ).toBeUndefined();
  });
});

describe('claudeEgressAgentEnv', () => {
  it('routes through the connector with only the placeholder token (no real token)', () => {
    const env = claudeEgressAgentEnv({ routed: true, connectorPort: 9444 });
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9444',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
    });
  });

  it('hands a non-routed session no Claude environment at all', () => {
    // There is no unrouted Claude path left to express (ADR 0010 Phase 2): the
    // options carry no access token to inject, so the only reachable non-routed
    // caller is a NON-Claude session, and it must receive nothing.
    expect(claudeEgressAgentEnv({ routed: false, connectorPort: 9444 })).toEqual({});
    expect(claudeEgressAgentEnv({ routed: false, connectorPort: undefined })).toEqual({});
  });

  it('fails closed if routing is requested without a connector port', () => {
    expect(() => claudeEgressAgentEnv({ routed: true, connectorPort: undefined })).toThrow(
      'connector port',
    );
  });
});

describe('claudeEgressRouteEnabled', () => {
  it('routes every Claude session with an active egress path', () => {
    expect(claudeEgressRouteEnabled({ isClaudeSession: true, egressActive: true })).toBe(true);
  });

  it('never routes a non-Claude or inactive egress session', () => {
    for (const [isClaudeSession, egressActive] of [
      [false, true],
      [true, false],
    ] as const) {
      expect(claudeEgressRouteEnabled({ isClaudeSession, egressActive })).toBe(false);
    }
  });

  it('does not depend on the Sandbox target stamp', () => {
    // A Sandbox is single-homed on its project network and always carries its
    // RELAY as the stamped target — the relay is what forwards to the gateway.
    // Gating routing on that stamp matching the gateway origin never matched and
    // failed every Claude turn closed.
    const labels = {
      'verity.claude-egress.gateway-url': 'https://verity-relay-abc123:8443',
      'verity.container-generation': 'generation-1',
    };
    expect(
      claudeEgressRelayGeneration({ running: true, labels }, 'verity.container-generation'),
    ).toBe('generation-1');
    expect(claudeEgressRouteEnabled({ isClaudeSession: true, egressActive: true })).toBe(true);
  });
});

describe('claudeEgressRelayGeneration', () => {
  const label = 'verity.container-generation';

  it('requires a running container with a non-empty relay generation stamp', () => {
    expect(
      claudeEgressRelayGeneration({ running: true, labels: { [label]: 'generation-1' } }, label),
    ).toBe('generation-1');
    expect(
      claudeEgressRelayGeneration({ running: false, labels: { [label]: 'generation-1' } }, label),
    ).toBeUndefined();
    expect(
      claudeEgressRelayGeneration({ running: true, labels: { [label]: '' } }, label),
    ).toBeUndefined();
    expect(claudeEgressRelayGeneration({ running: true }, label)).toBeUndefined();
  });
});

describe('claudeEgressRelayHealthy', () => {
  const label = 'verity.container-generation';

  it('requires the exact running relay generation to be healthy', async () => {
    const healthy = async (generation: string): Promise<boolean> => generation === 'generation-2';

    await expect(
      claudeEgressRelayHealthy(
        { running: true, labels: { [label]: 'generation-2' } },
        label,
        healthy,
      ),
    ).resolves.toBe(true);
    await expect(
      claudeEgressRelayHealthy(
        { running: true, labels: { [label]: 'generation-1' } },
        label,
        healthy,
      ),
    ).resolves.toBe(false);
    await expect(
      claudeEgressRelayHealthy(
        { running: false, labels: { [label]: 'generation-2' } },
        label,
        healthy,
      ),
    ).resolves.toBe(false);
    await expect(
      claudeEgressRelayHealthy({ running: true, labels: {} }, label, healthy),
    ).resolves.toBe(false);
  });

  it('propagates an indeterminate relay health check fail-closed', async () => {
    const unavailable = async (): Promise<boolean> => {
      throw new Error('relay inspect unavailable');
    };
    await expect(
      claudeEgressRelayHealthy(
        { running: true, labels: { [label]: 'generation-2' } },
        label,
        unavailable,
      ),
    ).rejects.toThrow('relay inspect unavailable');
  });
});
