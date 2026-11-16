import type { EventStore } from '@verity/store';

import type { ClaudeEgressIdentityService } from './claude-egress-identity.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { TurnCredentials } from './turn-credentials.js';

type Store = Pick<
  EventStore,
  | 'getSession'
  | 'listQueuedTurns'
  | 'listRunningTurns'
  | 'promptInitiatorAt'
  | 'userDopplerConnections'
  | 'deleteUserProjectGrants'
>;

/**
 * End a removed member's access to a project at once (ADR 0023 §6). Their
 * membership is already gone, so every new request is refused by the route
 * policy; this ends what they started before: queued turns are deleted for
 * good, running ones cancelled, their turn badges, their sandbox's signing and
 * GitHub capabilities and its egress certificate revoked, their
 * membership-scoped connections deleted and their own sandbox put to sleep.
 * The authority is revoked on its own rather than left to the sleep, because a
 * sandbox that is already asleep has nothing to stop and still holds it. Each
 * step runs even when another fails, and nothing here is restored by a restart.
 */
export function createMemberRevocation(deps: {
  store: Store;
  dequeue: (sessionId: string, queuedTurnId: string) => Promise<unknown>;
  cancelTurn: (sessionId: string) => Promise<unknown>;
  sleepSandbox?: ((projectId: string, userId: string) => Promise<void>) | undefined;
  /** Stops the dev servers the person last ran, so supervision does not wake them again. */
  stopDevServers?: ((projectId: string, userId: string) => Promise<void>) | undefined;
  turnCredentials?: Pick<TurnCredentials, 'revokeUser'> | undefined;
  signingCapabilities?: Pick<SigningCapabilityRegistry, 'revokeSandbox'> | undefined;
  ghTokenCapabilities?: Pick<GhTokenCapabilityRegistry, 'revokeSandbox'> | undefined;
  claudeEgressIdentity?: Pick<ClaudeEgressIdentityService, 'revokeSandbox'> | undefined;
  onError?: (step: string, error: unknown) => void;
}) {
  return async (projectId: string, userId: string): Promise<void> => {
    const inProject = new Map<string, boolean>();
    const belongs = async (sessionId: string): Promise<boolean> => {
      const known = inProject.get(sessionId);
      if (known !== undefined) return known;
      const result = (await deps.store.getSession(sessionId))?.projectId === projectId;
      inProject.set(sessionId, result);
      return result;
    };
    const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        deps.onError?.(name, error);
      }
    };
    // Queued first, so a cancelled turn cannot drain the next one of theirs.
    await step('queued turns', async () => {
      for (const queued of await deps.store.listQueuedTurns()) {
        if (queued.opts.initiatedBy?.userId !== userId) continue;
        if (await belongs(queued.sessionId)) await deps.dequeue(queued.sessionId, queued.id);
      }
    });
    await step('running turns', async () => {
      for (const running of await deps.store.listRunningTurns()) {
        if (!(await belongs(running.sessionId))) continue;
        const initiator = await deps.store.promptInitiatorAt(running.sessionId, running.promptSeq);
        if (initiator?.userId === userId) await deps.cancelTurn(running.sessionId);
      }
    });
    // Right after the turns: a cancelled turn can still be settling, and until
    // these go it could sign, push or reach the model as the removed person.
    await step('turn badges', async () => deps.turnCredentials?.revokeUser(projectId, userId));
    await step('signing capability', async () =>
      deps.signingCapabilities?.revokeSandbox(projectId, userId),
    );
    await step('GitHub capability', async () =>
      deps.ghTokenCapabilities?.revokeSandbox(projectId, userId),
    );
    await step('egress certificate', async () =>
      deps.claudeEgressIdentity?.revokeSandbox({ projectId, userId }),
    );
    await step('Doppler connection', () =>
      deps.store.userDopplerConnections.delete(userId, projectId),
    );
    await step('standing grants', () => deps.store.deleteUserProjectGrants(projectId, userId));
    // Before the sandbox sleeps: a running server would otherwise wake it again.
    await step('dev servers', async () => deps.stopDevServers?.(projectId, userId));
    await step('sandbox', async () => deps.sleepSandbox?.(projectId, userId));
  };
}
