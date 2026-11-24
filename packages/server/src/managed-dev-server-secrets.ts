import { createHash } from 'node:crypto';
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

/** The snapshot shown during approval and checked again against the actual secret sources. */
export function managedDevServerProviderSnapshot(
  projectBindings: readonly BrokeredHttpProjectBinding[],
  secretBindings: readonly ManagedDevServerSecretBinding[],
) {
  const references = secretBindings.map((entry) => entry.secretAlias);
  const snapshot = referencedSnapshot(projectBindings, references);
  const primary =
    snapshot.bindings.find((binding) => binding.includesBareReference) ?? snapshot.bindings[0]!;
  const authority =
    'managed-doppler-v1:' + createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return {
    provider: 'doppler' as const,
    project: primary.dopplerProject,
    config: primary.dopplerConfig,
    authority,
  };
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
    approvedAuthority: string,
    startedBy: string | null,
  ) => {
    const normalized = normalizeManagedDevServerSecretBindings(bindings);
    const buffers: Uint8Array[] = [];
    try {
      const projectBindings = await options.getProjectBindings(projectId);
      const used = managedDevServerProviderSnapshot(projectBindings, normalized).authority;
      if (approvedAuthority !== used) throw new Error('provider binding changed');
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
      if (managedDevServerProviderSnapshot(current, normalized).authority !== used)
        throw new Error('provider binding changed');
      return secrets;
    } catch {
      throw new Error('Could not resolve managed server secrets. No server was started.');
    } finally {
      for (const buffer of buffers) buffer.fill(0);
    }
  };
}
