import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from './schema.js';

/** An invitation is valid for 7 days by default and at most (Uplink team contract). */
export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A team operation is retried for 7 days before it is given up. */
export const TEAM_OUTBOX_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationState = 'creating' | 'open' | 'redeemed' | 'revoked' | 'expired';

export interface ProjectInvitation {
  id: string;
  projectId: string;
  inviterUserId: string;
  inviteeName: string;
  /** "Can edit": read and send messages. Without it the person can read. */
  canExecute: boolean;
  /** Uplink's invitation id, once Uplink created the invitation. */
  invitationId: string | null;
  state: InvitationState;
  expiresAt: Date;
  createdAt: Date;
  redeemedByUserId: string | null;
}

export interface ProjectMember {
  userId: string;
  displayName: string | null;
  canRead: boolean;
  canExecute: boolean;
  canManage: boolean;
  /** The project's creator, whose membership nobody can change or remove. */
  creator: boolean;
  joinedAt: Date;
}

export interface TeamOutboxEntry {
  operationId: string;
  kind: string;
  payload: unknown;
  attempts: number;
}

/** Why an invitation or membership change was refused. */
export class ProjectTeamError extends Error {
  constructor(
    readonly code:
      | 'project_not_shareable'
      | 'invitation_unavailable'
      | 'member_not_found'
      | 'creator_unchangeable',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTeamError';
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');

type Row = {
  id: string;
  project_id: string;
  inviter_user_id: string;
  invitee_name: string;
  can_execute: boolean;
  invitation_id: string | null;
  state: 'creating' | 'open' | 'redeemed' | 'revoked';
  expires_at: Date;
  created_at: Date;
  redeemed_by_user_id: string | null;
};

function invitation(row: Row, now: Date): ProjectInvitation {
  const lapsed =
    (row.state === 'creating' || row.state === 'open') && row.expires_at.getTime() <= now.getTime();
  return {
    id: row.id,
    projectId: row.project_id,
    inviterUserId: row.inviter_user_id,
    inviteeName: row.invitee_name,
    canExecute: row.can_execute,
    invitationId: row.invitation_id,
    state: lapsed ? 'expired' : row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    redeemedByUserId: row.redeemed_by_user_id,
  };
}

/**
 * A project's team (ADR 0023 §1, §6, §7): its members and the invitations that
 * bring new ones in. Core is the source of truth (Uplink team contract D8);
 * every change Uplink has to learn about is queued in the same transaction in
 * the team outbox, so it is delivered even after a restart.
 */
export class ProjectTeamStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create an invitation and return it with its link secret, which is never
   * stored and cannot be read again. An invitation grants reading, or reading
   * and sending messages; never management.
   */
  async createInvitation(input: {
    projectId: string;
    inviterUserId: string;
    inviteeName: string;
    canExecute: boolean;
    ttlMs?: number;
    now?: Date;
  }): Promise<{ invitation: ProjectInvitation; secret: string }> {
    const now = input.now ?? new Date();
    const ttl = Math.min(input.ttlMs ?? INVITATION_MAX_TTL_MS, INVITATION_MAX_TTL_MS);
    const expiresAt = new Date(now.getTime() + ttl);
    const secret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      await this.requireShareable(tx, input.projectId);
      const row = await tx
        .insertInto('project_invitations')
        .values({
          id,
          project_id: input.projectId,
          inviter_user_id: input.inviterUserId,
          invitee_name: input.inviteeName.trim(),
          can_execute: input.canExecute,
          secret_hash: sha256(secret),
          state: 'creating',
          expires_at: expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.enqueue(
        tx,
        'team.invite.create',
        {
          localInviteId: id,
          projectId: input.projectId,
          permissions: input.canExecute ? ['read', 'execute'] : ['read'],
          expiresAt: Math.floor(expiresAt.getTime() / 1000),
          bootstrapCommitment: sha256(secret),
        },
        now,
      );
      return { invitation: invitation(row, now), secret };
    });
  }

  /** Uplink created the invitation: it becomes usable under Uplink's id and deadline. */
  async markInvitationCreated(
    id: string,
    invitationId: string,
    expiresAt: Date,
  ): Promise<ProjectInvitation | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('project_invitations')
        .select('expires_at')
        .where('id', '=', id)
        .where('state', '=', 'creating')
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) return undefined;
      // The returned deadline wins, but never extends the one Core chose.
      const deadline =
        expiresAt.getTime() < current.expires_at.getTime() ? expiresAt : current.expires_at;
      const row = await tx
        .updateTable('project_invitations')
        .set({ invitation_id: invitationId, state: 'open' })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (deadline !== current.expires_at)
        await sql`update project_invitations set expires_at = ${deadline} where id = ${id}`.execute(
          tx,
        );
      return invitation({ ...row, expires_at: deadline }, new Date());
    });
  }

  async listInvitations(projectId: string, now = new Date()): Promise<ProjectInvitation[]> {
    const rows = await this.db
      .selectFrom('project_invitations')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('state', 'in', ['creating', 'open'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => invitation(row, now));
  }

  /** Revoke an invitation that is still usable; tells Uplink through the outbox. */
  async revokeInvitation(projectId: string, id: string, now = new Date()): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('project_invitations')
        .set({ state: 'revoked', revoked_at: now })
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .where('state', 'in', ['creating', 'open'])
        .returning(['id', 'invitation_id'])
        .executeTakeFirst();
      if (row === undefined) return false;
      await this.enqueue(
        tx,
        'team.invite.cancel',
        { localInviteId: row.id, invitationId: row.invitation_id },
        now,
      );
      return true;
    });
  }

  /**
   * Redeem an invitation exactly once: recheck it, create the person and their
   * membership, and bind the redemption. A replay of the same redemption
   * returns the same person and changes nothing; any other use is refused.
   */
  async redeemInvitation(input: {
    invitationId: string;
    secret: string;
    redemptionId: string;
    displayName: string;
    now?: Date;
  }): Promise<{ userId: string; projectId: string; replay: boolean }> {
    const now = input.now ?? new Date();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('project_invitations')
        .selectAll()
        .where('invitation_id', '=', input.invitationId)
        .forUpdate()
        .executeTakeFirst();
      const unavailable = () =>
        new ProjectTeamError('invitation_unavailable', 'This invitation can no longer be used.');
      if (row === undefined || row.secret_hash !== sha256(input.secret)) throw unavailable();
      if (row.state === 'redeemed') {
        if (row.redemption_id === input.redemptionId && row.redeemed_by_user_id !== null)
          return { userId: row.redeemed_by_user_id, projectId: row.project_id, replay: true };
        throw unavailable();
      }
      if (row.state !== 'open' || row.expires_at.getTime() <= now.getTime()) throw unavailable();
      await this.requireShareable(tx, row.project_id);
      // The inviter must still be allowed to manage the project.
      if (!(await this.managesProject(tx, row.project_id, row.inviter_user_id)))
        throw unavailable();
      const userId = randomUUID();
      await tx
        .insertInto('users')
        .values({
          id: userId,
          role: 'member',
          status: 'active',
          display_name: input.displayName.trim() || null,
        })
        .execute();
      await tx
        .insertInto('project_memberships')
        .values({
          project_id: row.project_id,
          user_id: userId,
          can_read: true,
          can_execute: row.can_execute,
          can_manage: false,
        })
        .execute();
      await tx
        .updateTable('project_invitations')
        .set({
          state: 'redeemed',
          redemption_id: input.redemptionId,
          redeemed_by_user_id: userId,
          redeemed_at: now,
        })
        .where('id', '=', row.id)
        .execute();
      return { userId, projectId: row.project_id, replay: false };
    });
  }

  async listMembers(projectId: string, db: Kysely<Database> = this.db): Promise<ProjectMember[]> {
    const rows = await db
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .select([
        'm.user_id',
        'u.display_name',
        'm.can_read',
        'm.can_execute',
        'm.can_manage',
        'm.created_at',
        'p.created_by_user_id',
      ])
      .where('m.project_id', '=', projectId)
      .where('u.status', '=', 'active')
      .orderBy('m.created_at')
      .execute();
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      canRead: row.can_read,
      canExecute: row.can_execute,
      canManage: row.can_manage,
      creator: row.user_id === row.created_by_user_id,
      joinedAt: row.created_at,
    }));
  }

  /** Change a member's rights; reading always stays. The creator's never change. */
  async setMemberRights(
    projectId: string,
    userId: string,
    rights: { canExecute: boolean; canManage: boolean },
  ): Promise<ProjectMember> {
    return this.db.transaction().execute(async (tx) => {
      await this.requireChangeable(tx, projectId, userId);
      await tx
        .updateTable('project_memberships')
        .set({ can_read: true, can_execute: rights.canExecute, can_manage: rights.canManage })
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .execute();
      const member = (await this.listMembers(projectId, tx)).find(
        (entry) => entry.userId === userId,
      );
      if (member === undefined)
        throw new ProjectTeamError('member_not_found', 'This person is not on the project.');
      return member;
    });
  }

  /**
   * Remove a member from the project. When it was their last project, Uplink is
   * told they left the team (D6), through the outbox and without waiting.
   */
  async removeMember(
    projectId: string,
    userId: string,
    now = new Date(),
  ): Promise<{ lastProject: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      await this.requireChangeable(tx, projectId, userId);
      await tx
        .deleteFrom('project_memberships')
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .execute();
      const remaining = await tx
        .selectFrom('project_memberships')
        .select('project_id')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      const lastProject = remaining === undefined;
      if (lastProject) await this.enqueue(tx, 'team.membership.remove', { userId }, now);
      return { lastProject };
    });
  }

  /** Team operations due for delivery to Uplink, oldest first. */
  async dueOperations(now = new Date(), limit = 20): Promise<TeamOutboxEntry[]> {
    const rows = await this.db
      .selectFrom('team_outbox')
      .select(['operation_id', 'kind', 'payload', 'attempts'])
      .where('done_at', 'is', null)
      .where('next_attempt_at', '<=', now)
      .where('give_up_at', '>', now)
      .orderBy('created_at')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      operationId: row.operation_id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async completeOperation(operationId: string, now = new Date()): Promise<void> {
    await this.db
      .updateTable('team_outbox')
      .set({ done_at: now })
      .where('operation_id', '=', operationId)
      .execute();
  }

  async retryOperation(operationId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('team_outbox')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), next_attempt_at: at }))
      .where('operation_id', '=', operationId)
      .execute();
  }

  private async enqueue(
    tx: Transaction<Database>,
    kind: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const operationId = randomUUID();
    await tx
      .insertInto('team_outbox')
      .values({
        operation_id: operationId,
        kind,
        payload: JSON.stringify({ operationId, ...payload }),
        next_attempt_at: now,
        give_up_at: new Date(now.getTime() + TEAM_OUTBOX_RETRY_MS),
      })
      .execute();
  }

  /** The control-plane project is never shared (ADR 0023 §1). */
  private async requireShareable(tx: Transaction<Database>, projectId: string): Promise<void> {
    const project = await tx
      .selectFrom('projects')
      .select(['kind'])
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (project === undefined || project.kind === 'control_plane')
      throw new ProjectTeamError('project_not_shareable', 'This project cannot be shared.');
  }

  private async managesProject(
    tx: Transaction<Database>,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const row = await tx
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.can_manage', 'u.status', 'u.role'])
      .where('m.project_id', '=', projectId)
      .where('m.user_id', '=', userId)
      .executeTakeFirst();
    return row !== undefined && row.status === 'active' && row.can_manage;
  }

  private async requireChangeable(
    tx: Transaction<Database>,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const row = await tx
      .selectFrom('project_memberships as m')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .select(['p.created_by_user_id'])
      .where('m.project_id', '=', projectId)
      .where('m.user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined)
      throw new ProjectTeamError('member_not_found', 'This person is not on the project.');
    if (row.created_by_user_id === userId)
      throw new ProjectTeamError('creator_unchangeable', "The project's creator stays on it.");
  }
}
