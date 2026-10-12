import {
  normalizeManagedDevServerSecretBindings,
  type ManagedDevServerSecretBinding,
} from '@verity/store';
import type { BrokeredHttpProjectBinding } from './brokered-http-tool.js';

/** Fresh project-bound resolution; buffers are consumed and never retained in registration. */
export function createManagedDevServerSecretResolver(options: {
  getProjectBinding(projectId: string): Promise<BrokeredHttpProjectBinding | undefined>;
  resolveSecret(input: {
    projectId: string;
    dopplerProject: string;
    dopplerConfig: string;
    secretName: string;
  }): Promise<Uint8Array>;
}) {
  return async (projectId: string, bindings: readonly ManagedDevServerSecretBinding[]) => {
    const normalized = normalizeManagedDevServerSecretBindings(bindings);
    const buffers: Uint8Array[] = [];
    try {
      const binding = await options.getProjectBinding(projectId);
      if (!binding) throw new Error('missing binding');
      const secrets: { env: string; value: string }[] = [];
      for (const entry of normalized) {
        const raw = await options.resolveSecret({
          projectId,
          ...binding,
          secretName: entry.secretAlias,
        });
        buffers.push(raw);
        const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (!value.length || value.includes('\0') || raw.length > 65536)
          throw new Error('invalid secret');
        secrets.push({ env: entry.env, value });
      }
      return secrets;
    } catch {
      throw new Error('Could not resolve managed server secrets. No server was started.');
    } finally {
      for (const buffer of buffers) buffer.fill(0);
    }
  };
}
