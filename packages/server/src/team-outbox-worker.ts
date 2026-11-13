import { createHash } from 'node:crypto';

import type { ProjectTeamStore, TeamOutboxEntry } from '@verity/store';

type Team = Pick<
  ProjectTeamStore,
  | 'dueOperations'
  | 'completeOperation'
  | 'retryOperation'
  | 'markInvitationCreated'
  | 'confirmJoin'
  | 'failJoin'
  | 'failInvitation'
>;

export interface TeamUplink {
  teamNegotiated(): boolean;
  teamRequest(
    type: string,
    fields: Record<string, unknown>,
    responses: readonly string[],
  ): Promise<Record<string, unknown>>;
}

/** `sha256-` + base64url SHA-256 of the Core identity key (SPKI, base64url). */
export function installationKeyFingerprint(identityKey: string): string {
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
    if (operation.kind === 'team.join.commit' && typeof answer.redemptionId === 'string')
      await deps.team.confirmJoin(answer.redemptionId);
    await deps.team.completeOperation(operation.operationId);
  };

  const tick = async (): Promise<void> => {
    if (!deps.uplink.teamNegotiated()) return;
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
