import { createHash, randomBytes } from 'node:crypto';

import {
  canonicalJson,
  secretContractIdSchema,
  secretToolInvocationSchema,
  sha256HexSchema,
  type RunGrantClaims,
  type SecretToolInvocation,
} from '@verity/secret-contracts';

import type { SecretAuditRecorder } from './secret-audit-recorder.js';
import type { SecretAuditTxn } from './secret-audit-log.js';
import {
  SecretAuthorizationRejectedError,
  type AuthenticatedApprovalActor,
  type SecretApprovalStore,
  type SecretGrantIssuer,
} from './secret-authorization.js';
import type { SecretExecutionProfileRegistry } from './secret-execution-profile-registry.js';
import type { SecretExecutionProfileAdapterRegistry } from './secret-execution-profile-adapters.js';
import type { SecretProviderCatalog } from './secret-provider-catalog.js';

function sha256(preimage: string): string {
  return createHash('sha256').update(preimage).digest('hex');
}

function requestHash(invocation: SecretToolInvocation): string {
  return sha256(`verity.secret-tool-request.v1\0${canonicalJson(invocation)}`);
}

function aliasClaims(
  aliases: Awaited<ReturnType<SecretProviderCatalog['resolveAliasesForProfile']>>,
) {
  return {
    aliases: aliases.map((alias) => ({ id: alias.id, version: alias.version })),
    providerBindings: [
      ...new Map(
        aliases.map((alias) => [
          `${alias.binding.id}:${String(alias.binding.version)}`,
          alias.binding,
        ]),
      ).values(),
    ],
  };
}

/**
 * Production authorization boundary backed by server-owned profile and provider catalogs.
 * Repository content supplies only a typed invocation; it cannot define profiles, aliases, or
 * provider bindings.
 */
export function createCatalogSecretAuthorization(options: {
  profiles: SecretExecutionProfileRegistry;
  profileAdapters: SecretExecutionProfileAdapterRegistry;
  catalog: SecretProviderCatalog;
  approvals: SecretApprovalStore;
  grants: SecretGrantIssuer;
  authorizeApproval: (approvalId: string, actor: AuthenticatedApprovalActor) => Promise<boolean>;
  authorizeCurrentClaims: (claims: RunGrantClaims) => Promise<boolean>;
  /**
   * Revalidate profile, aliases, and permissions using the issuer's transaction. Production
   * implementations must reject an absent transaction.
   */
  authorizeIssuanceClaims: (
    claims: RunGrantClaims,
    transaction: SecretAuditTxn | undefined,
  ) => Promise<boolean>;
  recorder?: SecretAuditRecorder;
  now?: () => Date;
  approvalTtlMs?: number;
  grantTtlMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const approvalTtlMs = options.approvalTtlMs ?? 15 * 60_000;
  const grantTtlMs = options.grantTtlMs ?? 60_000;

  return {
    async request(
      unparsed: SecretToolInvocation,
      requesterAuthorizationHash: string,
    ): Promise<{ approvalId: string }> {
      const invocation = secretToolInvocationSchema.parse(unparsed);
      const validatedRequesterHash = sha256HexSchema.parse(requesterAuthorizationHash);
      if (invocation.request.kind !== 'restricted') {
        throw new SecretAuthorizationRejectedError('invocation is not restricted');
      }
      const profile = await options.profiles.resolve(
        invocation.request.profile,
        invocation.context.projectId,
      );
      if (
        profile === undefined ||
        profile.trustMode !== 'restricted' ||
        profile.state !== 'active' ||
        !(await options.profileAdapters.validate(profile, invocation.request.parameters))
      ) {
        throw new SecretAuthorizationRejectedError('profile or parameters rejected');
      }
      const aliases = await options.catalog.resolveAliasesForProfile(
        invocation.request.profile,
        invocation.context.projectId,
      );
      if (aliases.length === 0) {
        throw new SecretAuthorizationRejectedError('profile has no active secret aliases');
      }
      const resolvedClaims = aliasClaims(aliases);
      const instant = now();
      const claims: RunGrantClaims = {
        protocolVersion: 1,
        grantId: `grant-${randomBytes(16).toString('hex')}`,
        requestHash: requestHash(invocation),
        projectId: invocation.context.projectId,
        sessionId: invocation.context.sessionId,
        turnId: invocation.context.turnId,
        toolCallId: invocation.context.toolCallId,
        profile: invocation.request.profile,
        executorImageDigest: profile.imageDigest,
        aliases: resolvedClaims.aliases,
        providerBindings: resolvedClaims.providerBindings,
        snapshotId: invocation.request.snapshotId,
        audience: 'verity-secret-job-executor',
        issuedAt: instant.toISOString(),
        expiresAt: new Date(instant.getTime() + approvalTtlMs).toISOString(),
        nonce: randomBytes(24).toString('base64url'),
      };
      if (!(await options.catalog.checkClaimsPermissions(claims, instant))) {
        throw new SecretAuthorizationRejectedError('secret permissions are unavailable');
      }
      const approvalId = `approval-${randomBytes(16).toString('hex')}`;
      const inserted = await options.approvals.insert(
        {
          id: approvalId,
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        validatedRequesterHash,
      );
      return inserted;
    },

    async decide(approvalId: string, actor: AuthenticatedApprovalActor, approved: boolean) {
      const validatedApprovalId = secretContractIdSchema.parse(approvalId);
      const validatedActor = {
        actorId: secretContractIdSchema.parse(actor.actorId),
        authorizationHash: sha256HexSchema.parse(actor.authorizationHash),
      };
      if (!(await options.authorizeApproval(validatedApprovalId, validatedActor))) {
        throw new SecretAuthorizationRejectedError('approval actor is not authorized');
      }
      const recorder = options.recorder;
      const pending = await options.approvals.decide(
        validatedApprovalId,
        validatedActor.actorId,
        validatedActor.authorizationHash,
        approved,
        () => now().toISOString(),
        recorder === undefined
          ? undefined
          : (txn, decided) =>
              recorder.approvalDecided(
                {
                  claims: decided.claims,
                  approvalId: validatedApprovalId,
                  actorHash: validatedActor.authorizationHash,
                  approved,
                  at: decided.approval.decidedAt,
                },
                txn,
              ),
        (claims, isApproved, finalizedAt) => {
          const decisionInstant = new Date(finalizedAt);
          if (Date.parse(claims.expiresAt) <= decisionInstant.getTime()) {
            throw new SecretAuthorizationRejectedError('approval request is expired');
          }
          if (!isApproved) return claims;
          return {
            ...claims,
            issuedAt: finalizedAt,
            expiresAt: new Date(decisionInstant.getTime() + grantTtlMs).toISOString(),
            nonce: randomBytes(24).toString('base64url'),
          };
        },
      );
      if (!approved) return { decision: 'denied' as const };
      const instant = now();
      const profile = await options.profiles.resolve(
        pending.claims.profile,
        pending.claims.projectId,
      );
      const activeAliases = await options.catalog.resolveAliasesForProfile(
        pending.claims.profile,
        pending.claims.projectId,
      );
      const activeAliasClaims = aliasClaims(activeAliases);
      if (
        profile === undefined ||
        profile.trustMode !== 'restricted' ||
        profile.state !== 'active' ||
        profile.imageDigest !== pending.claims.executorImageDigest ||
        canonicalJson(activeAliasClaims.aliases) !== canonicalJson(pending.claims.aliases) ||
        canonicalJson(activeAliasClaims.providerBindings) !==
          canonicalJson(pending.claims.providerBindings) ||
        Date.parse(pending.claims.expiresAt) <= instant.getTime() ||
        !(await options.authorizeCurrentClaims(pending.claims)) ||
        !(await options.catalog.checkClaimsPermissions(pending.claims, instant))
      ) {
        throw new SecretAuthorizationRejectedError('approved claims are no longer active');
      }
      const claims = {
        ...pending.claims,
        approval: {
          id: pending.approval.id,
          actorId: pending.approval.actorId,
          decisionHash: pending.approval.decisionHash,
        },
      };
      const issuedAt = pending.claims.issuedAt;
      let commitCompleted = false;
      const grant = await options.grants.issue(claims, async (txn) => {
        if (commitCompleted) {
          throw new SecretAuthorizationRejectedError('grant commit callback was repeated');
        }
        if (!(await options.authorizeIssuanceClaims(claims, txn))) {
          throw new SecretAuthorizationRejectedError('claims revoked during grant issuance');
        }
        await recorder?.grantIssued({ claims, approvalId: validatedApprovalId, at: issuedAt }, txn);
        await options.approvals.reserveGrantIssue(validatedApprovalId, txn);
        commitCompleted = true;
      });
      if (!commitCompleted) {
        throw new SecretAuthorizationRejectedError('grant issuer skipped atomic commit');
      }
      return {
        decision: 'approved' as const,
        ...grant,
        claims: {
          ...grant.claims,
          executorImageDigest: pending.claims.executorImageDigest,
        },
      };
    },
  };
}
