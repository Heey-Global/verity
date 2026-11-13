import {
  normalizeManagedDevServerSecretBindings,
  type ManagedDevServerSecretBinding,
} from '@verity/store';
import type { BrokeredHttpProjectBinding } from './brokered-http-tool.js';
import type { DopplerPerson } from './doppler-credential.js';

/** Fresh project-bound resolution; buffers are consumed and never retained in registration. */
export function createManagedDevServerSecretResolver(options: {
  getProjectBinding(projectId: string): Promise<BrokeredHttpProjectBinding | undefined>;
  resolveSecret(input: {
    projectId: string;
    dopplerProject: string;
    dopplerConfig: string;
    secretName: string;
    person: DopplerPerson;
  }): Promise<Uint8Array>;
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
      const binding = await options.getProjectBinding(projectId);
      if (!binding) throw new Error('missing binding');
      if (
        approvedAuthority !== undefined &&
        approvedAuthority !== JSON.stringify([binding.dopplerProject, binding.dopplerConfig])
      )
        throw new Error('provider binding changed');
      const secrets: { env: string; value: string }[] = [];
      for (const entry of normalized) {
        const raw = await options.resolveSecret({
          projectId,
          ...binding,
          secretName: entry.secretAlias,
          person: { userId: startedBy },
        });
        buffers.push(raw);
        const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (!value.length || value.includes('\0') || raw.length > 65536)
          throw new Error('invalid secret');
        secrets.push({ env: entry.env, value });
      }
      const current = await options.getProjectBinding(projectId);
      if (
        !current ||
        current.dopplerProject !== binding.dopplerProject ||
        current.dopplerConfig !== binding.dopplerConfig
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
