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
