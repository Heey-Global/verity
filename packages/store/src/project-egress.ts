import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';

export interface EgressTarget {
  host: string;
  protocol: 'tcp' | 'udp';
  port: number;
}
export class ProjectEgressError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'stale' | 'missing' | 'capacity') {
    super(code);
  }
}
/** Only a destination, never a URL, payload, wildcard or caller-supplied scope. */
export function canonicalEgressTarget(target: EgressTarget): EgressTarget {
  if (
    !target ||
    typeof target.host !== 'string' ||
    !['tcp', 'udp'].includes(target.protocol) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  )
    throw new ProjectEgressError('invalid');
  let host = target.host;
  if (!host || host !== host.trim() || /[\s/@?#%\\]/u.test(host))
    throw new ProjectEgressError('invalid');
  if (isIP(host) === 6) host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  else if (isIP(host) !== 4) {
    host = domainToASCII(host).toLowerCase().replace(/\.$/u, '');
    if (
      host.length > 253 ||
      !host.includes('.') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)
    )
      throw new ProjectEgressError('invalid');
  }
  return { host, protocol: target.protocol, port: target.port };
}
export const egressTargetKey = (target: EgressTarget): string =>
  JSON.stringify(canonicalEgressTarget(target));
export interface EgressRequest {
  id: string;
  target: EgressTarget;
  revision: number;
  requestedBy: string[];
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'allowed' | 'denied';
  decidedBy?: string;
  decidedAt?: number;
}
export interface EgressGrant {
  id: string;
  target: EgressTarget;
  approvedBy: string;
  approvedAt: number;
  expiresAt: number | null;
  revokedAt?: number;
}
export interface EgressPolicy {
  revision: number;
  requests: Record<string, EgressRequest>;
  grants: EgressGrant[];
}
export function egressGrantCovers(
  policy: EgressPolicy,
  target: EgressTarget,
  now: number,
): boolean {
  const key = egressTargetKey(target);
  return policy.grants.some(
    (g) =>
      g.revokedAt === undefined &&
      (g.expiresAt === null || g.expiresAt > now) &&
      egressTargetKey(g.target) === key,
  );
}
const emptyPolicy = (): EgressPolicy => ({ revision: 0, requests: {}, grants: [] });

/** Draft policy only: persistence does not enable network enforcement. */
export class ProjectEgressStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly now = Date.now,
  ) {}

  private async authorized(
    tx: Transaction<Database>,
    projectId: string,
    userId: string,
    permission: 'read' | 'execute' | 'manage',
  ): Promise<void> {
    const row = await tx
      .selectFrom('project_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('projects as p', 'p.id', 'm.project_id')
      .select([
        'm.can_read',
        'm.can_execute',
        'm.can_manage',
        'u.status',
        'u.role',
        'p.kind',
        'p.created_by_user_id',
      ])
      .where('m.project_id', '=', projectId)
      .where('m.user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !row ||
      row.status !== 'active' ||
      !row[`can_${permission}`] ||
      (row.kind === 'control_plane' &&
        (row.role !== 'administrator' || row.created_by_user_id !== userId))
    )
      throw new ProjectEgressError('forbidden');
  }

  private async access<T>(
    projectId: string,
    userId: string,
    permission: 'read' | 'execute' | 'manage',
    operation: (state: EgressPolicy, now: number) => T,
    write = true,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      // Membership/user/project locks also serialize permission revocation with decisions.
      await this.authorized(tx, projectId, userId, permission);
      await sql`insert into project_egress_policy(project_id, state) values (${projectId}, ${JSON.stringify(emptyPolicy())}::jsonb) on conflict do nothing`.execute(
        tx,
      );
      const result = await sql<{
        state: EgressPolicy;
      }>`select state from project_egress_policy where project_id = ${projectId} for update`.execute(
        tx,
      );
      const state = result.rows[0]!.state;
      const value = operation(state, this.now());
      if (write)
        await sql`update project_egress_policy set state = ${JSON.stringify(state)}::jsonb where project_id = ${projectId}`.execute(
          tx,
        );
      return value;
    });
  }
  read(projectId: string, userId: string): Promise<EgressPolicy> {
    return this.access(projectId, userId, 'read', (state) => state, false);
  }
  request(
    projectId: string,
    userId: string,
    input: EgressTarget,
  ): Promise<EgressRequest | { covered: true }> {
    const target = canonicalEgressTarget(input),
      key = egressTargetKey(target);
    return this.access(projectId, userId, 'execute', (state, now) => {
      if (egressGrantCovers(state, target, now)) return { covered: true };
      const old = state.requests[key];
      // A denied/expired request never turns into another automatic card.
      if (old) {
        if (!old.requestedBy.includes(userId) && old.requestedBy.length < 100)
          old.requestedBy.push(userId);
        return old;
      }
      if (Object.keys(state.requests).length >= 1000) throw new ProjectEgressError('capacity');
      const request: EgressRequest = {
        id: randomUUID(),
        target,
        revision: state.revision,
        requestedBy: [userId],
        createdAt: now,
        expiresAt: now + 300_000,
        status: 'pending',
      };
      state.requests[key] = request;
      return request;
    });
  }
  decide(
    projectId: string,
    userId: string,
    requestId: string,
    revision: number,
    allow: boolean,
  ): Promise<EgressRequest> {
    return this.access(projectId, userId, 'manage', (state, now) => {
      const request = Object.values(state.requests).find((r) => r.id === requestId);
      if (!request) throw new ProjectEgressError('missing');
      if (
        state.revision !== revision ||
        request.revision !== revision ||
        request.status !== 'pending' ||
        request.expiresAt <= now
      )
        throw new ProjectEgressError('stale');
      request.status = allow ? 'allowed' : 'denied';
      request.decidedBy = userId;
      request.decidedAt = now;
      if (allow) {
        if (state.grants.length >= 1000) throw new ProjectEgressError('capacity');
        state.grants.push({
          id: randomUUID(),
          target: request.target,
          approvedBy: userId,
          approvedAt: now,
          expiresAt: now + 3_600_000,
        });
      }
      state.revision++;
      return request;
    });
  }
  reopen(
    projectId: string,
    userId: string,
    input: EgressTarget,
    revision: number,
  ): Promise<EgressRequest> {
    const target = canonicalEgressTarget(input),
      key = egressTargetKey(target);
    return this.access(projectId, userId, 'manage', (state, now) => {
      if (state.revision !== revision) throw new ProjectEgressError('stale');
      if (!state.requests[key]) throw new ProjectEgressError('missing');
      const request: EgressRequest = {
        id: randomUUID(),
        target,
        revision: ++state.revision,
        requestedBy: [userId],
        createdAt: now,
        expiresAt: now + 300_000,
        status: 'pending',
      };
      state.requests[key] = request;
      return request;
    });
  }
  /** Explicit settings action, never the default approval-card lifetime. */
  setPermanent(
    projectId: string,
    userId: string,
    input: EgressTarget,
    revision: number,
  ): Promise<EgressGrant> {
    const target = canonicalEgressTarget(input);
    return this.access(projectId, userId, 'manage', (state, now) => {
      if (state.revision !== revision) throw new ProjectEgressError('stale');
      if (state.grants.length >= 1000) throw new ProjectEgressError('capacity');
      const grant: EgressGrant = {
        id: randomUUID(),
        target,
        approvedBy: userId,
        approvedAt: now,
        expiresAt: null,
      };
      state.grants.push(grant);
      state.revision++;
      return grant;
    });
  }

  revoke(projectId: string, userId: string, grantId: string, revision: number): Promise<void> {
    return this.access(projectId, userId, 'manage', (state, now) => {
      if (state.revision !== revision) throw new ProjectEgressError('stale');
      const grant = state.grants.find((g) => g.id === grantId);
      if (!grant) throw new ProjectEgressError('missing');
      grant.revokedAt = now;
      state.revision++;
    });
  }
}
