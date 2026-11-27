import { createHash } from 'node:crypto';

/** The Doppler connection, project and config a binding reads from. */
export interface DopplerBindingIdentity {
  connectionId: string;
  tokenRevision?: string | null | undefined;
  dopplerProject: string;
  dopplerConfig: string;
}

/**
 * The stable id grants and approvals are keyed by (ADR 0031). It is derived, not
 * stored, so a grant applies again when the same connection, project and config
 * are bound again, and never to the same project and config of another workplace.
 */
export function dopplerBindingGrantId(binding: DopplerBindingIdentity): string {
  const hash = createHash('sha256')
    .update(binding.connectionId)
    .update('\0')
    .update(binding.dopplerProject)
    .update('\0')
    .update(binding.dopplerConfig);
  const id = `project-doppler:${hash.digest('hex')}`;
  if (binding.tokenRevision == null) return id;
  const revision = createHash('sha256').update(binding.tokenRevision).digest('hex');
  return `${id}@${revision}`;
}

/** The id before connections existed: project and config only. */
export function legacyDopplerBindingGrantId(dopplerProject: string, dopplerConfig: string): string {
  return `project-doppler:${createHash('sha256')
    .update(dopplerProject)
    .update('\0')
    .update(dopplerConfig)
    .digest('hex')}`;
}

/** Whether a single-binding or composite grant reads from a binding at any revision. */
export function dopplerGrantUsesBinding(grantId: string, stableBindingId: string): boolean {
  const prefix = 'project-doppler-set:';
  const members = grantId.startsWith(prefix) ? grantId.slice(prefix.length).split(',') : [grantId];
  return members.some((member) => {
    const identity = member.startsWith('default:') ? member.slice('default:'.length) : member;
    return identity === stableBindingId || identity.startsWith(`${stableBindingId}@`);
  });
}
