import type { Kysely } from 'kysely';
import type { ProjectPermission } from './project-team.js';
import type { Database } from './schema.js';

export class ProjectAccessStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Whether `userId` created the project (ADR 0023). */
  async isProjectCreator(userId: string, projectId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('projects')
      .select('created_by_user_id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return row?.created_by_user_id === userId;
  }

  /** Project permissions come from an active user's membership. */
  async hasProjectPermission(
    userId: string,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<boolean> {
    const membership = await this.db
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .selectAll('m')
      .select(['u.status', 'u.role', 'p.kind', 'p.created_by_user_id'])
      .where('m.user_id', '=', userId)
      .where('m.project_id', '=', projectId)
      .executeTakeFirst();
    if (membership === undefined || membership.status !== 'active') return false;
    if (
      membership.kind === 'control_plane' &&
      (membership.role !== 'administrator' || membership.created_by_user_id !== userId)
    ) {
      return false;
    }
    return membership[`can_${permission}`];
  }

  async isActiveAdministrator(userId: string): Promise<boolean> {
    const user = await this.db
      .selectFrom('users')
      .select(['role', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.role === 'administrator' && user.status === 'active';
  }

  async isActiveLocalUser(userId: string): Promise<boolean> {
    const user = await this.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.status === 'active';
  }

  /** Keep collection reads consistent with hasProjectPermission's control-plane rule. */
  async listReadableProjectIds(userId: string): Promise<string[]> {
    const memberships = await this.db
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .select([
        'm.project_id',
        'm.can_read',
        'u.status',
        'u.role',
        'p.kind',
        'p.created_by_user_id',
      ])
      .where('m.user_id', '=', userId)
      .execute();
    return memberships
      .filter(
        (membership) =>
          membership.status === 'active' &&
          membership.can_read &&
          (membership.kind !== 'control_plane' ||
            (membership.role === 'administrator' && membership.created_by_user_id === userId)),
      )
      .map((membership) => membership.project_id);
  }

  /** Delete every standing grant a person gave in a project (ADR 0023 §6). */
  async deleteUserProjectGrants(projectId: string, userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('secret_provider_permissions')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Active users holding a project permission — the notification audience
   * for project work that has no individual initiator. Same control-plane rule
   * as {@link hasProjectPermission}. */
  async listProjectUserIds(
    projectId: string,
    permission: 'read' | 'execute' | 'manage',
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .select([
        'm.user_id',
        'm.can_read',
        'm.can_execute',
        'm.can_manage',
        'u.status',
        'u.role',
        'p.kind',
        'p.created_by_user_id',
      ])
      .where('m.project_id', '=', projectId)
      .execute();
    return rows
      .filter(
        (row) =>
          row.status === 'active' &&
          row[`can_${permission}`] &&
          (row.kind !== 'control_plane' ||
            (row.role === 'administrator' && row.created_by_user_id === row.user_id)),
      )
      .map((row) => row.user_id);
  }

  async listActiveAdministratorIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'administrator')
      .where('status', '=', 'active')
      .execute();
    return rows.map((row) => row.id);
  }
}
