import { createHash } from 'node:crypto';

import type { ProjectTeamStore, TeamOutboxEntry } from '@verity/store';

import type { TeamAvailability } from './uplink-feature-state.js';

type Team = Pick<
  ProjectTeamStore,
  | 'clearExpiredJoinCredentials'
  | 'dueOperations'
  | 'failExhaustedOperations'
  | 'completeOperation'
  | 'retryOperation'
  | 'markInvitationCreated'
  | 'confirmJoin'
  | 'failJoin'
  | 'failInvitation'
>;

export interface TeamUplink {
  teamNegotiated(): boolean;
  /** Why team v1 is not negotiated, for the log; absent → reported as offline. */
  teamAvailability?(): TeamAvailability;
  teamRequest(
    type: string,
    fields: Record<string, unknown>,
    responses: readonly string[],
  ): Promise<Record<string, unknown>>;
}

/** `sha256-` + base64url SHA-256 of the Core identity key (SPKI, base64url). */
function installationKeyFingerprint(identityKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(identityKey, 'base64url')).digest();
  return `sha256-${digest.toString('base64url')}`;
}

const RESPONSES: Record<string, string> = {
  'team.invite.create': 'team.invite.created',
  'team.invite.cancel': 'team.invite.cancelled',
  'team.join.commit': 'team.join.committed',
  'team.membership.remove': 'team.membership.removed',
};

const backoff = (attempts: number): number => Math.min(30_000 * 2 ** attempts, 60 * 60_000);

/** How often a lasting wait for team v1 is logged again. */
export const TEAM_WAIT_LOG_MS = 60 * 60_000;
/** How long a wait for a connection may last before it is worth a log line:
 * waking the Uplink connection for new team work takes a moment. */
export const TEAM_OFFLINE_GRACE_MS = 60_000;

/**
 * Deliver queued team changes to Uplink (Uplink team contract D8: Core is the
 * source of truth, Uplink learns through a durable outbox). Each operation is
 * sent with its own operationId, so a retry after a lost answer is a replay
 * Uplink deduplicates. A refusal Uplink calls final is dropped; anything else
 * is retried with backoff until the operation gives up after seven days.
 */
export function createTeamOutboxWorker(deps: {
  team: Team;
  uplink: TeamUplink;
  /** The Core identity key; an invitation cannot be created without it. */
  identityKey: () => string | undefined;
  now?: () => Date;
  log?: {
    warn: (fields: Record<string, unknown>, message: string) => void;
  };
}) {
  const now = deps.now ?? (() => new Date());
  let running: Promise<void> | undefined;
  let waiting: { reason: TeamAvailability; since: number } | undefined;
  // Kept across reasons and empty passes: neither may bypass the log interval.
  let loggedAt: number | undefined;

  // Without this, queued work waits in silence: no log line, no state change,
  // until the operations give up after seven days.
  const noteWaiting = async (): Promise<void> => {
    const queued = (await deps.team.dueOperations(now())).length;
    if (queued === 0) {
      waiting = undefined;
      return;
    }
    const at = now().getTime();
    const reason = deps.uplink.teamAvailability?.() ?? 'uplink_offline';
    if (waiting?.reason !== reason) waiting = { reason, since: at };
    if (reason === 'uplink_offline' && at - waiting.since < TEAM_OFFLINE_GRACE_MS) return;
    if (loggedAt !== undefined && at - loggedAt < TEAM_WAIT_LOG_MS) return;
    loggedAt = at;
    deps.log?.warn(
      { queued, teamSharing: reason },
      'verity: team changes are waiting; Uplink has not negotiated team v1',
    );
  };

  const send = async (operation: TeamOutboxEntry): Promise<void> => {
    const payload = operation.payload as Record<string, unknown>;
    const response = RESPONSES[operation.kind];
    if (response === undefined) {
      await deps.team.completeOperation(operation.operationId);
      return;
    }
    let fields: Record<string, unknown> = payload;
    if (operation.kind === 'team.invite.create') {
      const identityKey = deps.identityKey();
      if (identityKey === undefined) throw new Error('Core identity key unavailable');
      fields = { ...payload, installationKeyFingerprint: installationKeyFingerprint(identityKey) };
    }
    const answer = await deps.uplink.teamRequest(operation.kind, fields, [response]);
    if (answer.type === 'team.error') {
      if (answer.retryable === true) {
        const after =
          typeof answer.retryAfterSeconds === 'number'
            ? answer.retryAfterSeconds * 1000
            : backoff(operation.attempts);
        await deps.team.retryOperation(operation.operationId, new Date(now().getTime() + after));
      } else {
        deps.log?.warn(
          { kind: operation.kind, code: answer.code },
          'verity: Uplink refused a team change',
        );
        // Refused for good: the person or invitation it was for must not stay
        // pending forever. The inviter sees it failed and invites again.
        if (operation.kind === 'team.join.commit')
          await deps.team.failJoin(String(payload.redemptionId));
        if (operation.kind === 'team.invite.create')
          await deps.team.failInvitation(String(payload.localInviteId));
        await deps.team.completeOperation(operation.operationId);
      }
      return;
    }
    if (operation.kind === 'team.invite.create' && typeof answer.invitationId === 'string') {
      await deps.team.markInvitationCreated(
        String(payload.localInviteId),
        answer.invitationId,
        new Date(Number(answer.expiresAt) * 1000),
      );
    }
    // Only the redemption this operation committed; an answer naming another
    // one confirms nothing.
    if (operation.kind === 'team.join.commit') {
      if (answer.redemptionId !== payload.redemptionId)
        throw new Error('Uplink confirmed another redemption');
      await deps.team.confirmJoin(String(payload.redemptionId));
    }
    await deps.team.completeOperation(operation.operationId);
  };

  const tick = async (): Promise<void> => {
    await deps.team.clearExpiredJoinCredentials(now());
    for (const operation of await deps.team.failExhaustedOperations(now()))
      deps.log?.warn(
        operation,
        'verity: team change exhausted its retry window; awaiting the next team change',
      );
    if (!deps.uplink.teamNegotiated()) {
      await noteWaiting();
      return;
    }
    waiting = undefined;
    for (const operation of await deps.team.dueOperations(now())) {
      try {
        await send(operation);
      } catch (error) {
        // Offline, timed out or a malformed answer: try again later.
        await deps.team.retryOperation(
          operation.operationId,
          new Date(now().getTime() + backoff(operation.attempts)),
        );
        deps.log?.warn(
          { kind: operation.kind, err: error },
          'verity: a team change for Uplink will be retried',
        );
      }
    }
  };

  return {
    /** One delivery pass; concurrent calls share it. */
    run(): Promise<void> {
      running ??= tick().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

/**
 * Deliver queued team changes every ten seconds while Uplink negotiated team v1,
 * holding the Uplink connection while someone may join or a change is queued.
 * One pass at a time: a slow store or Uplink must not start a second delivery
 * of the same change beside the first.
 */
export function installTeamOutbox(
  app: { addHook(name: 'onClose', hook: () => void): unknown },
  deps: Parameters<typeof createTeamOutboxWorker>[0] & {
    team: Team & { hasTeamWork(): Promise<boolean> };
    uplink: TeamUplink & { setTeamDemand(wanted: boolean): void };
    isSealed: (error: unknown) => boolean;
  },
): void {
  const outbox = createTeamOutboxWorker(deps);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      deps.uplink.setTeamDemand(await deps.team.hasTeamWork());
      await outbox.run();
    })()
      .catch((error: unknown) => {
        if (!deps.isSealed(error))
          deps.log?.warn({ err: error }, 'verity: team outbox delivery failed');
      })
      .finally(() => {
        busy = false;
      });
  }, 10_000);
  timer.unref();
  app.addHook('onClose', () => clearInterval(timer));
}
