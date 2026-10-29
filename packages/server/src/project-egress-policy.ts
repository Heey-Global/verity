import { isIP } from 'node:net';
import {
  canonicalEgressTarget,
  egressGrantCovers,
  egressTargetKey,
  type EgressPolicy,
  type EgressTarget,
} from '@verity/store';
import { isForbiddenHttpMcpAddress } from './http-mcp-proxy.js';

export type EgressRoute = 'direct' | 'broker' | 'system' | 'blocked';
export type EgressDecision = 'covered' | 'ask' | 'setup_required' | 'deny';
/** Produced by trusted adapters; never deserialize this context from a sandbox request. */
export interface EgressRoutingContext {
  projectId: string;
  policyProjectId: string;
  identityCurrent: boolean;
  sponsorAuthorized: boolean;
  route: EgressRoute;
  adapterDecision?: EgressDecision;
  configured?: boolean;
}
export function isPublicEgressTarget(input: EgressTarget): boolean {
  const { host } = canonicalEgressTarget(input);
  if (isIP(host)) return !isForbiddenHttpMcpAddress(host);
  return (
    !/(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion)$/u.test(host) &&
    !/(?:^|\.)(?:metadata\.google\.internal|metadata\.aws\.internal)$/u.test(host)
  );
}
/** Policy evaluation does not resolve DNS or confer network admission. */
export function evaluateProjectEgress(
  context: EgressRoutingContext,
  policy: EgressPolicy,
  target: EgressTarget,
  now: number,
): { route: EgressRoute; decision: EgressDecision } {
  if (
    !context.identityCurrent ||
    !context.sponsorAuthorized ||
    context.projectId !== context.policyProjectId ||
    context.route === 'blocked'
  )
    return { route: 'blocked', decision: 'deny' };
  if (context.route === 'broker' || context.route === 'system')
    return {
      route: context.route,
      decision: context.configured ? (context.adapterDecision ?? 'deny') : 'setup_required',
    };
  if (!isPublicEgressTarget(target)) return { route: 'blocked', decision: 'deny' };
  if (egressGrantCovers(policy, target, now)) return { route: 'direct', decision: 'covered' };
  const request = Object.values(policy.requests).find(
    (r) => egressTargetKey(r.target) === egressTargetKey(target),
  );
  return {
    route: 'direct',
    decision:
      request &&
      (request.status !== 'pending' ||
        request.expiresAt <= now ||
        request.revision !== policy.revision)
        ? 'deny'
        : 'ask',
  };
}
