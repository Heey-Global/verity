import { createHash } from 'node:crypto';

export function projectSocketBindingName(identity: {
  projectId: string;
  containerGeneration: string;
}): string {
  const bindingHash = createHash('sha256')
    .update(`${identity.projectId}\0${identity.containerGeneration}`)
    .digest('hex')
    .slice(0, 32);
  return `project-${bindingHash}`;
}

/** Fixed, generation-labelled relay container name, without exposing project
 *  slugs. Kept here, free of Docker dependencies, so callers that only need
 *  the name do not pull the relay adapter into their module graph. */
export function projectRelayContainerName(identity: {
  projectId: string;
  containerGeneration: string;
}): string {
  const digest = createHash('sha256')
    .update(`verity-relay:${identity.projectId}\0${identity.containerGeneration}`)
    .digest('hex')
    .slice(0, 24);
  return `verity-relay-${digest}`;
}
