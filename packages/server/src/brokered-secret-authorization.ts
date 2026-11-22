import type { Conductor } from '@verity/session';
import type { McpGatewayDeps } from './mcp-gateway.js';
import {
  brokeredDopplerBindingId,
  parseBrokeredDopplerBinding,
} from './brokered-doppler-binding.js';

type SecretCall = Parameters<NonNullable<McpGatewayDeps['authorizationSnapshot']>>[0];

/** Detached cards bypass requestExternalPermission, so reusable consent must be
 * checked before creating another card, against the current provider and caller. */
export function createBrokeredSecretAuthorization(input: {
  conductor: Pick<Conductor, 'isCoveredByBrokeredGrant'>;
  gateway: Pick<McpGatewayDeps, 'authorizationSnapshot'>;
  initiator: (sessionId: string, turnId: string) => Promise<{ userId: string } | undefined>;
}) {
  const snapshot = async (call: SecretCall): Promise<string> => {
    const value = await input.gateway.authorizationSnapshot?.(call);
    if (value === undefined) throw new Error('approved Doppler binding is unavailable');
    return JSON.stringify(parseBrokeredDopplerBinding(value));
  };
  return {
    snapshot,
    async covers(call: SecretCall & { authorizationSnapshot?: string }): Promise<boolean> {
      if (call.authorizationSnapshot === undefined) return false;
      const bindingId = brokeredDopplerBindingId(
        parseBrokeredDopplerBinding(call.authorizationSnapshot),
      );
      const userId = (await input.initiator(call.sessionId, call.turnId))?.userId ?? null;
      return input.conductor.isCoveredByBrokeredGrant(
        call.sessionId,
        {
          requestId: 'standing-secret',
          toolUseId: 'standing-secret',
          toolName: call.toolName,
          input: call.request as Record<string, unknown>,
        },
        'acp',
        bindingId,
        userId,
      );
    },
  };
}
