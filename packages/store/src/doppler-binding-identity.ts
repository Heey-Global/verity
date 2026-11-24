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
  if (binding.tokenRevision != null) hash.update('\0').update(binding.tokenRevision);
  return `project-doppler:${hash.digest('hex')}`;
}

/** The id before connections existed: project and config only. */
export function legacyDopplerBindingGrantId(dopplerProject: string, dopplerConfig: string): string {
  return `project-doppler:${createHash('sha256')
    .update(dopplerProject)
    .update('\0')
    .update(dopplerConfig)
    .digest('hex')}`;
}
