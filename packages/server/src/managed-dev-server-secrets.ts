import type { CreatePreviewShareInput } from './preview-share-types.js';
import { PreviewShareConflictError } from './preview-network-policy.js';
import { createHash } from 'node:crypto';
import type { ManagedServerProviderSnapshot } from '@verity/events';
import type { ManagedDevServerManagerOptions } from './managed-dev-server-manager.js';
import {
  normalizeManagedDevServerSecretBindings,
  type ManagedDevServerSecretBinding,
  type ManagedDevServerInstanceRecord,
  type ManagedDevServerRecord,
  type EventStore,
} from '@verity/store';
import {
  referencedSnapshot,
  resolveReferencedSecret,
  type BrokeredHttpProjectBinding,
  type BrokeredSecretResolver,
} from './brokered-http-tool.js';

type DisplayableDopplerBinding = BrokeredHttpProjectBinding & {
  connectionLabel?: string;
  workplaceSlug?: string;
};

function displayText(text: string, limit: number): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, limit);
}

/** The snapshot shown during approval and checked again against the actual secret sources. */
export function managedDevServerProviderSnapshot(
  projectBindings: readonly DisplayableDopplerBinding[],
  secretBindings: readonly ManagedDevServerSecretBinding[],
) {
  const references = secretBindings.map((entry) => entry.secretAlias);
  const snapshot = referencedSnapshot(projectBindings, references);
  const primary =
    snapshot.bindings.find((binding) => binding.includesBareReference) ?? snapshot.bindings[0]!;
  const authority =
    'managed-doppler-v1:' + createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const details = new Map(projectBindings.map((binding) => [binding.id, binding]));
  const sources = snapshot.bindings.map((binding) => {
    const connected = details.get(binding.bindingId);
    const label = displayText(connected?.connectionLabel ?? '', 80);
    const workplace = displayText(connected?.workplaceSlug ?? '', 200);
    return {
      project: displayText(binding.dopplerProject, 200) || '(unnamed)',
      config: displayText(binding.dopplerConfig, 200) || '(unnamed)',
      connectionId: binding.connectionId,
      ...(label ? { connectionLabel: label } : {}),
      ...(workplace ? { workplaceSlug: workplace } : {}),
    };
  });
  return {
    sources,
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

/** A running process may expose only the authority used to resolve its own secrets. */
export async function managedRunProviderCurrent(
  store: Pick<EventStore, 'projectDopplerBindings' | 'managedDevServers'>,
  instance: ManagedDevServerInstanceRecord,
): Promise<boolean | undefined> {
  if (instance.lastRunSecretBindings.length === 0) return true;
  const authority = instance.lastRunProviderAuthority;
  if (!authority) return false;
  let bindings;
  try {
    if (authority !== (await store.managedDevServers.approvedProviderAuthority(instance.serverId)))
      return false;
    bindings = await store.projectDopplerBindings.list(instance.projectId);
  } catch {
    return undefined;
  }
  try {
    return (
      authority ===
      managedDevServerProviderSnapshot(bindings, instance.lastRunSecretBindings).authority
    );
  } catch {
    return false;
  }
}

export class ManagedPreviewAuthorityError extends PreviewShareConflictError {}

export async function managedPreviewInstance(
  store: EventStore,
  input: Pick<CreatePreviewShareInput, 'managedInstanceId' | 'sessionId'>,
) {
  if (!input.managedInstanceId) return undefined;
  const instance = await store.managedDevServers.getInstance(input.managedInstanceId);
  if (!instance || instance.sessionId !== input.sessionId || instance.state !== 'running')
    throw new ManagedPreviewAuthorityError('managed server is not running in this session');
  const current = await managedRunProviderCurrent(store, instance);
  if (current === undefined)
    throw new ManagedPreviewAuthorityError('Doppler access could not be verified. Try again.');
  if (!current)
    throw new ManagedPreviewAuthorityError(
      'Doppler access changed. Review and restart the managed server.',
    );
  return instance;
}

export async function managedRunApproved(
  store: Pick<EventStore, 'projectDopplerBindings' | 'managedDevServers'>,
  instance: ManagedDevServerInstanceRecord,
): Promise<boolean> {
  return !!(
    instance.state === 'running' &&
    instance.lastRunCommand &&
    instance.lastRunWorkdir &&
    (await store.managedDevServers
      .isApproved(
        instance.serverId,
        instance.lastRunCommand,
        instance.lastRunWorkdir,
        instance.lastRunSecretBindings,
      )
      .catch(() => false)) &&
    (await managedRunProviderCurrent(store, instance))
  );
}

export async function currentManagedProviderSnapshot(
  options: Pick<ManagedDevServerManagerOptions, 'providerSnapshot'>,
  projectId: string,
  bindings: readonly ManagedDevServerSecretBinding[],
): Promise<ManagedServerProviderSnapshot | null> {
  if (bindings.length === 0) return null;
  try {
    return (await options.providerSnapshot?.(projectId, bindings)) ?? null;
  } catch {
    return null;
  }
}

export async function managedProviderApproved(
  options: Pick<ManagedDevServerManagerOptions, 'providerSnapshot' | 'store'>,
  entry: ManagedDevServerRecord,
  snapshot?: ManagedServerProviderSnapshot | null,
): Promise<boolean> {
  if (entry.secretBindings.length === 0) return true;
  const current =
    snapshot === undefined
      ? await currentManagedProviderSnapshot(options, entry.projectId, entry.secretBindings)
      : snapshot;
  return (
    current?.authority !== undefined &&
    current.authority ===
      (await options.store.managedDevServers
        .approvedProviderAuthority(entry.id)
        .catch(() => undefined))
  );
}

export async function approvedManagedRunAuthority(
  store: Pick<EventStore, 'managedDevServers'>,
  instance: ManagedDevServerInstanceRecord,
  queued: boolean,
  person: string | null,
): Promise<string | undefined> {
  const approval = await store.managedDevServers.approvedProviderAuthority(instance.serverId);
  if (!queued) return approval;
  if (approval !== instance.lastRunProviderAuthority) return undefined;
  return person === null ||
    (await store.managedDevServers.get(instance.serverId))?.approvedBy === person
    ? approval
    : undefined;
}
