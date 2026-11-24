import { BROKERED_SECRET_REFERENCE } from '@verity/secret-contracts';

import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';

/** One Doppler project and config a Verity project reads secrets from (ADR 0031). */
export interface ProjectDopplerBinding {
  readonly id: string;
  readonly connectionId: string;
  readonly tokenRevision?: string;
  readonly dopplerProject: string;
  readonly dopplerConfig: string;
  readonly isDefault: boolean;
}

/** A secret reference resolved to the binding that holds it. */
export interface ResolvedSecretReference {
  readonly binding: ProjectDopplerBinding;
  /** The secret's name inside that binding's config. */
  readonly name: string;
}

export function bindingLabel(
  binding: Pick<ProjectDopplerBinding, 'dopplerProject' | 'dopplerConfig'>,
) {
  return `${binding.dopplerProject}/${binding.dopplerConfig}`;
}

/**
 * The message is relayed to the agent as is (phase `Doppler binding`), so it is
 * built only from a reference that matched {@link BROKERED_SECRET_REFERENCE} and
 * from Doppler slugs of the project's bindings — never from free text.
 */
function unresolvable(message: string): DopplerSecretResolutionError {
  return new DopplerSecretResolutionError(
    `${message} No secret value was exposed.`,
    'Doppler binding',
  );
}

/**
 * `NAME` names the default binding, `project/config/NAME` the binding of exactly
 * that Doppler project and config. A binding that is gone — removed from the
 * project or with its connection deleted — is named in the error, together with
 * what is connected, so the agent can correct the reference.
 */
export function resolveSecretReference(
  bindings: readonly ProjectDopplerBinding[],
  reference: string,
): ResolvedSecretReference {
  const match = BROKERED_SECRET_REFERENCE.exec(reference);
  if (match === null) throw unresolvable('A secret reference is not valid.');
  const [, project, config, name] = match as unknown as [
    string,
    string | undefined,
    string | undefined,
    string,
  ];
  if (project === undefined || config === undefined) {
    const binding = bindings.find((candidate) => candidate.isDefault);
    if (binding === undefined) throw unresolvable('This project has no Doppler binding.');
    return { binding, name };
  }
  const binding = bindings.find(
    (candidate) => candidate.dopplerProject === project && candidate.dopplerConfig === config,
  );
  if (binding === undefined) {
    const connected = bindings.map(bindingLabel).join(', ');
    throw unresolvable(
      `Doppler binding \`${project}/${config}\` is no longer connected to this project` +
        (connected === '' ? '.' : ` (connected: ${connected}).`),
    );
  }
  return { binding, name };
}

/** The identity an approval is bound to: connection, project and config. */
export interface ApprovedDopplerBinding {
  readonly bindingId: string;
  readonly connectionId: string;
  readonly tokenRevision?: string;
  readonly includesBareReference?: boolean;
  readonly dopplerProject: string;
  readonly dopplerConfig: string;
}

/**
 * The bindings one request reads from, deduplicated and in a stable order. This is
 * what an approval is for: a change to any of them invalidates it, a change to
 * any other binding of the project does not.
 */
export function referencedBindings(
  bindings: readonly ProjectDopplerBinding[],
  references: readonly string[],
): ApprovedDopplerBinding[] {
  const byKey = new Map<string, ApprovedDopplerBinding>();
  const resolved = references.map((reference) => ({
    reference,
    ...resolveSecretReference(bindings, reference),
  }));
  for (const { reference, binding } of resolved) {
    const key = `${binding.connectionId}\0${binding.dopplerProject}\0${binding.dopplerConfig}`;
    const usesDefault = !reference.includes('/') || byKey.get(key)?.includesBareReference;
    byKey.set(key, {
      bindingId: binding.id,
      connectionId: binding.connectionId,
      ...(binding.tokenRevision === undefined ? {} : { tokenRevision: binding.tokenRevision }),
      ...(usesDefault ? { includesBareReference: true } : {}),
      dopplerProject: binding.dopplerProject,
      dopplerConfig: binding.dopplerConfig,
    });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, binding]) => binding);
}

/**
 * The names the agent may use, per binding: bare in the default, in full elsewhere.
 * Names are the input, values never are.
 */
export function secretReferenceNames(
  entries: readonly { binding: ProjectDopplerBinding; names: readonly string[] }[],
): string[] {
  const out: string[] = [];
  for (const { binding, names } of [...entries].sort(
    (a, b) => Number(b.binding.isDefault) - Number(a.binding.isDefault),
  )) {
    for (const name of names) {
      out.push(binding.isDefault ? name : `${bindingLabel(binding)}/${name}`);
    }
  }
  return out;
}
