import {
  normalizeManagedDevServerSecretBindings,
  type ManagedDevServerSecretBinding,
} from '@verity/store';
import {
  referencedSnapshot,
  resolveReferencedSecret,
  type BrokeredHttpProjectBinding,
  type BrokeredSecretResolver,
} from './brokered-http-tool.js';
import { brokeredDopplerBindingId } from './brokered-doppler-binding.js';

/**
 * The provider authority a dev server's approval is bound to: the default
 * binding's project and config, as shown on the approval card. References to
 * other bindings are resolved with the bindings at start and checked unchanged
 * after resolution.
 */
export function managedDevServerProviderAuthority(
  bindings: readonly BrokeredHttpProjectBinding[],
): string | undefined {
  const binding = bindings.find((candidate) => candidate.isDefault);
  return binding ? JSON.stringify([binding.dopplerProject, binding.dopplerConfig]) : undefined;
}

/** Fresh project-bound resolution; buffers are consumed and never retained in registration. */
export function createManagedDevServerSecretResolver(options: {
  getProjectBindings(projectId: string): Promise<readonly BrokeredHttpProjectBinding[]>;
  resolveSecret: BrokeredSecretResolver;
}) {
  /** `startedBy` is the person whose Doppler connection resolves the secrets: who
   *  started the server, also when it is recovered later (ADR 0023 §3). */
  return async (
    projectId: string,
    bindings: readonly ManagedDevServerSecretBinding[],
    approvedAuthority: string | undefined,
    startedBy: string | null,
  ) => {
    const normalized = normalizeManagedDevServerSecretBindings(bindings);
    const buffers: Uint8Array[] = [];
    try {
      const projectBindings = await options.getProjectBindings(projectId);
      if (
        approvedAuthority !== undefined &&
        approvedAuthority !== managedDevServerProviderAuthority(projectBindings)
      )
        throw new Error('provider binding changed');
      const references = normalized.map((entry) => entry.secretAlias);
      const used = brokeredDopplerBindingId(referencedSnapshot(projectBindings, references));
      const secrets: { env: string; value: string }[] = [];
      for (const entry of normalized) {
        const raw = await resolveReferencedSecret(options.resolveSecret, projectBindings, {
          projectId,
          reference: entry.secretAlias,
          person: { userId: startedBy },
        });
        buffers.push(raw);
        const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (!value.length || value.includes('\0') || raw.length > 65536)
          throw new Error('invalid secret');
        secrets.push({ env: entry.env, value });
      }
      const current = await options.getProjectBindings(projectId);
      if (
        managedDevServerProviderAuthority(current) !==
          managedDevServerProviderAuthority(projectBindings) ||
        brokeredDopplerBindingId(referencedSnapshot(current, references)) !== used
      )
        throw new Error('provider binding changed');
      return secrets;
    } catch {
      throw new Error('Could not resolve managed server secrets. No server was started.');
    } finally {
      for (const buffer of buffers) buffer.fill(0);
    }
  };
}
