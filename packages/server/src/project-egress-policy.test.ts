import { expect, it } from 'vitest';
import {
  evaluateProjectEgress,
  isPublicEgressTarget,
  type EgressRoutingContext,
} from './project-egress-policy.js';
import type { EgressPolicy } from '@verity/store';
const target = { host: 'downloads.example.com', protocol: 'tcp' as const, port: 443 };
const context: EgressRoutingContext = {
  projectId: 'a',
  policyProjectId: 'a',
  identityCurrent: true,
  sponsorAuthorized: true,
  route: 'direct',
};
const policy: EgressPolicy = { revision: 0, grants: [], requests: {} };
it('separates network grants from trusted broker and system decisions', () => {
  expect(evaluateProjectEgress(context, policy, target, 0)).toEqual({
    route: 'direct',
    decision: 'ask',
  });
  for (const route of ['broker', 'system'] as const) {
    expect(evaluateProjectEgress({ ...context, route }, policy, target, 0).decision).toBe(
      'setup_required',
    );
    expect(
      evaluateProjectEgress({ ...context, route, configured: true }, policy, target, 0).decision,
    ).toBe('deny');
    expect(
      evaluateProjectEgress(
        { ...context, route, configured: true, adapterDecision: 'covered' },
        policy,
        target,
        0,
      ),
    ).toEqual({ route, decision: 'covered' });
  }
  for (const patch of [
    { projectId: 'b' },
    { identityCurrent: false },
    { sponsorAuthorized: false },
    { route: 'blocked' as const },
  ])
    expect(evaluateProjectEgress({ ...context, ...patch }, policy, target, 0).decision).toBe(
      'deny',
    );
});
it('denies nonpublic addresses including mapped IPv6 before any DNS request', () => {
  for (const host of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'metadata.google.internal',
    'service.local',
  ])
    expect(isPublicEgressTarget({ ...target, host }), host).toBe(false);
  expect(isPublicEgressTarget({ ...target, host: '8.8.8.8' })).toBe(true);
});
