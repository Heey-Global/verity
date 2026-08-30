import { randomUUID } from 'node:crypto';

import type { BrokeredGrantChannel } from '@verity/events';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';

const PROJECT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * How long an approval on the ACP channel keeps auto-approving matching prompts
 * (ADR 0014 D3). The operator set this ceiling deliberately: on ACP a grant is a
 * bounded delegation to anything that can reach the loopback endpoint, not a
 * per-call human check, because that channel cannot prove an MCP call is the ACP
 * tool call it claims to be. A day bounds how long a stolen endpoint keeps
 * redeeming a grant without ever showing a card.
 *
 * The native relay has no equivalent ceiling because it does not need one: it
 * attests each call, so a grant there answers only calls the agent actually made.
 */
const ACP_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * `issuer` value marking the rows this store owns in `secret_provider_permissions`. The
 * table is shared with the catalog authorization path, and a `tool_id` prefix cannot tell
 * the two apart: a catalog tool id is `<profileId>@<version>:<policyHash>` and a profile id
 * may itself contain `:`, so `verity_http_request:x` is a legal profile id whose row would
 * otherwise look exactly like a grant. Every read path here filters on this — most of all
 * {@link createBrokeredHttpGrantStore.check}, where a foreign row would mean a permission
 * prompt auto-approved by something the operator never granted.
 */
const GRANT_ISSUER = 'brokered-prompt';
const TRUSTED_CLI_GRANT_TARGET = /^v1:\/[^#]+#[a-f0-9]{64}$/u;

function validGrantTarget(toolName: BrokeredGrantToolName, target: string): boolean {
  return toolName !== 'verity_secret_run' || TRUSTED_CLI_GRANT_TARGET.test(target);
}

/** Tools whose permission prompt a standing grant may answer. The tool name is the
 * `tool_id` prefix, so grants for different tools never collide on the same target. */
export type BrokeredGrantToolName = 'verity_http_request' | 'verity_secret_run';

/**
 * Grant reach, in the operator's terms. `once` is deliberately absent: it is answered by
 * the prompt itself and never persisted, so it cannot be revoked later either.
 */
export type BrokeredGrantScope = 'session' | 'project' | 'forever';

/**
 * The transport a decision was made on, or is being redeemed on (ADR 0014 D3). The
 * conductor derives it from the backend the turn runs through — server-side state only.
 * Nothing reaching this store may take the value from a request: a workspace process
 * that reached the loopback MCP endpoint would otherwise call itself `native` and
 * inherit the attested channel's unbounded grants.
 */
export type { BrokeredGrantChannel } from '@verity/events';

/**
 * One standing grant as the operator sees it. `target` is the grant key's readable half —
 * a destination host, or an executable label plus the digest of the approved invocation.
 * It carries no secret material: the alias NAME is already operator-visible by ADR 0011 D3.
 *
 * `appliesNow` is false for a grant that would not auto-approve anything today because it
 * names a provider binding the project has since replaced. Such a grant is still listed, and
 * still revocable, precisely because it is not permanently dead: binding ids are derived
 * deterministically, so restoring the earlier binding brings the grant back into force.
 */
export interface BrokeredGrantRecord {
  id: string;
  secretAlias: string;
  toolName: BrokeredGrantToolName;
  target: string;
  scope: BrokeredGrantScope;
  sessionId: string | null;
  appliesNow: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Scoped operator grants for the brokered secret tools (ADR 0011 D2), persisted in the
 * `secret_provider_permissions` table keyed by (project, alias, tool, target). The target is
 * the destination host for `verity_http_request`, or the hash-bound command descriptor for
 * an explicitly attested trusted-CLI entry script.
 * `session` scope binds to one session; `project` covers the whole project across sessions
 * for 30 days; `forever` is the same reach without an expiry. Because `forever` never ages
 * out, `list`/`revoke` are the only way it ends — they are part of the feature, not an
 * afterthought. A matching active grant auto-approves the permission prompt.
 *
 * Grants are additionally keyed by the CHANNEL they were approved on (ADR 0014 D3),
 * recorded in `brokered_grant_approvals` rather than on the grant row so the two
 * channels cannot refresh each other's windows. On ACP a grant auto-approves only
 * while its own approval is under 24 hours old, and `forever` is refused outright.
 * The former native channel is retired and cannot reach this API.
 */
export function createBrokeredHttpGrantStore(db: Kysely<Database>) {
  const inFlightGrants = new Map<string, Promise<void>>();
  return {
    async grant(input: {
      projectId: string;
      bindingId: string;
      sessionId: string;
      secretAlias: string;
      toolName: BrokeredGrantToolName;
      target: string;
      scope: BrokeredGrantScope;
      channel: BrokeredGrantChannel;
    }): Promise<void> {
      if (!validGrantTarget(input.toolName, input.target)) {
        throw new Error('invalid hash-bound trusted CLI grant target');
      }
      // ADR 0014 D3: `forever` is not available on ACP. Refusing it here is the
      // server-side half of that rule — the ACP approval card not offering the choice
      // is the other, and a card is not a boundary. A permanent grant is the one shape
      // the 24-hour ceiling could not bound, so an ACP decision must never mint one,
      // including for the native path: the row it would create outlives every channel.
      if (input.channel === 'acp' && input.scope === 'forever') {
        throw new Error('a permanent grant cannot be approved on the ACP channel');
      }
      const toolId = `${input.toolName}:${input.target}`;
      const sessionId = input.scope === 'session' ? input.sessionId : null;
      const key = [
        input.projectId,
        input.bindingId,
        input.secretAlias,
        toolId,
        input.scope,
        sessionId ?? '',
      ].join('\0');
      const activeGrantId = async (tx: Kysely<Database>): Promise<string | undefined> =>
        (
          await tx
            .selectFrom('secret_provider_permissions')
            .select('id')
            .where('project_id', '=', input.projectId)
            .where('binding_id', '=', input.bindingId)
            .where('secret_name', '=', input.secretAlias)
            .where('tool_id', '=', toolId)
            .where('scope', '=', input.scope)
            .where('session_id', sessionId === null ? 'is' : '=', sessionId)
            .where('state', '=', 'active')
            .where('issuer', '=', GRANT_ISSUER)
            .executeTakeFirst()
        )?.id;
      /** Stamp this channel's approval on the grant, replacing any earlier one for the
       *  same channel. The other channel's row is untouched — that separation IS the
       *  rule (ADR 0014 D3): a native approval must not refresh the ACP window, and an
       *  ACP approval must not silently extend anything on the attested path. */
      const recordApproval = async (tx: Kysely<Database>, grantId: string): Promise<void> => {
        await tx
          .insertInto('brokered_grant_approvals')
          .values({
            grant_id: grantId,
            channel: input.channel,
            approved_at: new Date().toISOString(),
          })
          .onConflict((conflict) =>
            conflict
              .columns(['grant_id', 'channel'])
              .doUpdateSet({ approved_at: new Date().toISOString() }),
          )
          .execute();
      };
      const previous = inFlightGrants.get(key) ?? Promise.resolve();
      /**
       * The grant row and its channel approval are one decision, so they commit or
       * roll back together. Split across two statements, a failure or crash between
       * them leaves a grant that `grant()` reported as failed but that is live and
       * redeemable — and redeemable specifically on the native channel, which never
       * consults an approval record. The ACP ceiling would then be enforced against a
       * row nobody believes exists.
       */
      const operation = previous
        .catch(() => undefined)
        .then(() =>
          db.transaction().execute(async (tx) => {
            // Expired rows remain historically active until renewal. Revoke matching
            // expired rows first so the partial unique index permits one replacement.
            await tx
              .updateTable('secret_provider_permissions')
              .set({ state: 'revoked', updated_at: new Date().toISOString() })
              .where('project_id', '=', input.projectId)
              .where('binding_id', '=', input.bindingId)
              .where('secret_name', '=', input.secretAlias)
              .where('tool_id', '=', toolId)
              .where('scope', '=', input.scope)
              .where('session_id', sessionId === null ? 'is' : '=', sessionId)
              .where('state', '=', 'active')
              .where('issuer', '=', GRANT_ISSUER)
              .where('expires_at', '<=', new Date())
              .execute();
            const existing = await activeGrantId(tx);
            if (existing !== undefined) {
              if (input.scope === 'project') {
                await tx
                  .updateTable('secret_provider_permissions')
                  .set({
                    expires_at: new Date(Date.now() + PROJECT_GRANT_TTL_MS).toISOString(),
                    updated_at: new Date().toISOString(),
                  })
                  .where('id', '=', existing)
                  .execute();
              }
              // Every scope records the approval, including the two that write nothing to
              // the grant row itself. Skipping it here would make an ACP re-approval of a
              // live `session` grant a no-op, so the grant would go on ageing out of its
              // 24-hour window while the operator kept answering the card.
              await recordApproval(tx, existing);
              return;
            }
            await tx
              .insertInto('secret_provider_permissions')
              .values({
                id: randomUUID(),
                project_id: input.projectId,
                binding_id: input.bindingId,
                binding_version: 1,
                secret_name: input.secretAlias,
                tool_id: toolId,
                scope: input.scope,
                session_id: sessionId,
                // `session` expires with its session and `forever` never expires, so both
                // store a NULL expiry; only `project` carries the rolling 30-day window.
                expires_at:
                  input.scope === 'project'
                    ? new Date(Date.now() + PROJECT_GRANT_TTL_MS).toISOString()
                    : null,
                remaining_uses: null,
                granted_by: 'operator',
                issuer: GRANT_ISSUER,
                state: 'active',
              })
              .onConflict((conflict) => conflict.doNothing())
              .execute();
            // Read the id back rather than trusting the one just generated: the insert is
            // `doNothing`, so a grant racing in from another Server process (the in-flight
            // map only serializes this one) leaves the row — and the id the approval must
            // attach to — belonging to that writer. The insert blocks until that writer
            // commits, so this re-read sees the winning row either way. A grant with no
            // approval row would be dead on ACP, which is the failure this exists to avoid.
            const inserted = await activeGrantId(tx);
            // No active row after our own insert means the row we conflicted with was
            // revoked or deleted in the moment between the two statements. Nothing was
            // saved, so say so: returning normally would put a "scope saved" card in
            // front of the operator for a grant that does not exist, and the next call
            // would prompt again with no explanation. The rollback costs nothing — the
            // insert already did nothing — and re-approving retries it.
            if (inserted === undefined) {
              throw new Error('the grant was revoked while it was being approved');
            }
            await recordApproval(tx, inserted);
          }),
        );
      inFlightGrants.set(key, operation);
      try {
        await operation;
      } finally {
        if (inFlightGrants.get(key) === operation) inFlightGrants.delete(key);
      }
    },
    /**
     * Standing grants this store issued for a project, newest first, for the operator's
     * review-and-revoke surface. Every row it owns is listed — including ones that do not
     * currently apply, flagged with `appliesNow: false` rather than hidden. Hiding them
     * would be worse than noisy: a grant the operator cannot see is one they cannot revoke,
     * and binding ids are derived deterministically, so re-creating an earlier binding would
     * silently wake a hidden `forever` grant back up.
     *
     * `appliesNow` is false when the grant names a provider binding other than the one the
     * caller passes as current, mirroring {@link check}, which matches on that binding.
     * `currentBindingId` is required and takes `null` for "this project has no binding right
     * now", which makes every grant dormant — the two cases must not collapse into one
     * argument, or a project whose binding is gone would report its grants as live.
     * Expired rows are the one exception and stay unlisted: nothing can bring them back,
     * since renewal revokes them outright.
     *
     * A `session` grant IS listed for a session that is not currently running: like `check`,
     * it stays valid for that session id, which a resumed session presents again.
     */
    async list(projectId: string, currentBindingId: string | null): Promise<BrokeredGrantRecord[]> {
      const rows = await db
        .selectFrom('secret_provider_permissions')
        .select([
          'id',
          'secret_name',
          'tool_id',
          'scope',
          'session_id',
          'binding_id',
          'expires_at',
          'created_at',
        ])
        .where('project_id', '=', projectId)
        .where('state', '=', 'active')
        .where('issuer', '=', GRANT_ISSUER)
        .where('scope', 'in', ['session', 'project', 'forever'] satisfies BrokeredGrantScope[])
        .orderBy('created_at', 'desc')
        .execute();
      const now = Date.now();
      return rows.flatMap((row) => {
        if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now) return [];
        const separator = row.tool_id.indexOf(':');
        if (separator <= 0) return [];
        const toolName = row.tool_id.slice(0, separator);
        if (toolName !== 'verity_http_request' && toolName !== 'verity_secret_run') return [];
        const scope = row.scope;
        if (scope !== 'session' && scope !== 'project' && scope !== 'forever') return [];
        return [
          {
            id: row.id,
            secretAlias: row.secret_name,
            toolName,
            target: row.tool_id.slice(separator + 1),
            scope,
            sessionId: row.session_id,
            appliesNow: row.binding_id === currentBindingId,
            expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
            createdAt: new Date(row.created_at).toISOString(),
          },
        ];
      });
    },
    /**
     * End one standing grant. The filters are the same ownership boundary {@link list}
     * draws, for the same reason: `secret_provider_permissions` is shared with the catalog
     * authorization path, so an id alone must not be enough to revoke a row this store did
     * not issue. Scoped by project as well, so a grant id from another project can never be
     * revoked through a project's own route. Returns false when nothing matched, which the
     * route turns into a 404 rather than a silent success.
     *
     * Like `list`, this ignores the current provider binding: a grant marked `appliesNow:
     * false` is exactly the kind an operator should be able to end before a restored binding
     * puts it back in force.
     */
    async revoke(projectId: string, grantId: string): Promise<boolean> {
      const result = await db
        .updateTable('secret_provider_permissions')
        .set({ state: 'revoked', updated_at: new Date().toISOString() })
        .where('project_id', '=', projectId)
        .where('id', '=', grantId)
        .where('state', '=', 'active')
        .where('issuer', '=', GRANT_ISSUER)
        .where('scope', 'in', ['session', 'project', 'forever'] satisfies BrokeredGrantScope[])
        .where((eb) =>
          eb.or([
            eb('tool_id', 'like', 'verity_http_request:%'),
            eb('tool_id', 'like', 'verity_secret_run:%'),
          ]),
        )
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    },
    /**
     * Does a standing grant answer this prompt on this channel (ADR 0011 D2, ADR 0014 D3)?
     *
     * `channel` is where the ceiling bites. On `native` the answer is the scope match
     * alone, as it has always been: that channel attests each call, so a grant there
     * covers only calls the agent actually made. On `acp` the same scope match must
     * ALSO carry an ACP approval under 24 hours old — because that channel cannot tell
     * the model's call from a repository process replaying the stolen loopback
     * endpoint, so an unbounded grant there is an unbounded delegation to the whole
     * workspace. `channel` must come from the resolved backend, never from the request.
     */
    async check(input: {
      projectId: string;
      bindingId: string;
      sessionId: string;
      secretAlias: string;
      toolName: BrokeredGrantToolName;
      target: string;
      channel: BrokeredGrantChannel;
    }): Promise<boolean> {
      // Legacy generic-argv rows remain visible and revocable, but can never be
      // redeemed. Only the versioned descriptor produced from an isolated,
      // hash-bound entry script crosses this boundary.
      if (!validGrantTarget(input.toolName, input.target)) return false;
      const rows = await db
        .selectFrom('secret_provider_permissions')
        .select(['id', 'scope', 'session_id', 'expires_at'])
        .where('project_id', '=', input.projectId)
        .where('binding_id', '=', input.bindingId)
        .where('secret_name', '=', input.secretAlias)
        .where('tool_id', '=', `${input.toolName}:${input.target}`)
        .where('state', '=', 'active')
        .where('issuer', '=', GRANT_ISSUER)
        .execute();
      const now = Date.now();
      const covering = rows.filter(
        (row) =>
          (row.expires_at === null || new Date(row.expires_at).getTime() > now) &&
          (row.scope === 'project' ||
            row.scope === 'forever' ||
            (row.scope === 'session' && row.session_id === input.sessionId)),
      );
      if (covering.length === 0) return false;
      // `forever` is unreachable by construction — `grant` refuses to mint one
      // there, so no ACP approval row can exist for it. Dropping it here as well keeps
      // that true of rows this store did not write, since a permanent auto-approval is
      // exactly what the ceiling exists to rule out on this channel.
      const eligible = covering.filter((row) => row.scope !== 'forever');
      if (eligible.length === 0) return false;
      const approvals = await db
        .selectFrom('brokered_grant_approvals')
        .select('grant_id')
        .where(
          'grant_id',
          'in',
          eligible.map((row) => row.id),
        )
        .where('channel', '=', input.channel)
        .where('approved_at', '>', new Date(now - ACP_APPROVAL_TTL_MS))
        .execute();
      return approvals.length > 0;
    },
  };
}
