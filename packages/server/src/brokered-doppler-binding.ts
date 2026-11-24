import { dopplerBindingGrantId } from '@verity/store';
import { z } from 'zod';

import type { ApprovedDopplerBinding, ProjectDopplerBinding } from './doppler-secret-reference.js';

const bindingSchema = z
  .object({
    connectionId: z.string().trim().min(1),
    tokenRevision: z.string().uuid().optional(),
    includesBareReference: z.literal(true).optional(),
    dopplerProject: z.string().trim().min(1),
    dopplerConfig: z.string().trim().min(1),
  })
  .strict();
const snapshotSchema = z.object({ bindings: z.array(bindingSchema).min(1).max(16) }).strict();

/** What an approval of a secret tool call is bound to (ADR 0031): the Doppler
 *  bindings that call reads from. */
export type BrokeredDopplerBinding = z.infer<typeof snapshotSchema>;

export function brokeredDopplerSnapshot(
  bindings: readonly ApprovedDopplerBinding[],
): BrokeredDopplerBinding {
  return snapshotSchema.parse({ bindings });
}

/** A snapshot from before several bindings existed no longer parses: the call
 *  is asked for again rather than approved against an unknown connection. */
export function parseBrokeredDopplerBinding(snapshot: string): BrokeredDopplerBinding {
  return snapshotSchema.parse(JSON.parse(snapshot));
}

/**
 * The id grants are kept under. A call reading one binding uses that binding's id,
 * so a grant for `API_KEY` in one config never covers `billing/dev/API_KEY` in
 * another; a call reading several uses an id for exactly that set.
 */
export function brokeredDopplerBindingId(snapshot: BrokeredDopplerBinding): string {
  const ids = [
    ...new Set(
      snapshot.bindings.map((binding) => {
        const id = dopplerBindingGrantId(binding);
        return binding.includesBareReference ? defaultDopplerGrantMember(id) : id;
      }),
    ),
  ].sort();
  if (ids.length === 1) return ids[0]!;
  return `${BINDING_SET_PREFIX}${ids.join(',')}`;
}

const BINDING_SET_PREFIX = 'project-doppler-set:';

export function defaultDopplerGrantMember(bindingId: string): string {
  return `default:${bindingId}`;
}

export function currentDopplerGrantBindingIds(
  bindings: readonly ProjectDopplerBinding[],
): ReadonlySet<string> {
  return new Set(
    bindings.flatMap((binding) => {
      const id = dopplerBindingGrantId(binding);
      return binding.isDefault ? [id, defaultDopplerGrantMember(id)] : [id];
    }),
  );
}

/**
 * Whether a grant's binding id still names bindings of the project, given the ids
 * of its current bindings. A set id lists its members, so it applies only while
 * every one of them is still bound.
 */
export function brokeredGrantBindingApplies(
  bindingId: string,
  current: ReadonlySet<string>,
): boolean {
  if (!bindingId.startsWith(BINDING_SET_PREFIX)) return current.has(bindingId);
  const members = bindingId.slice(BINDING_SET_PREFIX.length).split(',');
  return members.length > 1 && members.every((member) => current.has(member));
}

export function assertBrokeredDopplerBinding(
  current: BrokeredDopplerBinding | undefined,
  approved: BrokeredDopplerBinding | undefined,
): asserts current is BrokeredDopplerBinding {
  if (current === undefined) throw new Error('project Doppler binding is unavailable');
  if (
    approved !== undefined &&
    brokeredDopplerBindingId(current) !== brokeredDopplerBindingId(approved)
  ) {
    throw new Error('Doppler access changed after approval; submit the operation again');
  }
}

/**
 * Where an approval card says the secrets come from. One binding reads as its
 * project and config; several are listed as `project/config` with no config of
 * their own, which the card renders as the list alone.
 */
export function brokeredSecretSource(snapshot: BrokeredDopplerBinding): {
  project: string;
  config: string;
} {
  const [only, ...rest] = snapshot.bindings;
  if (only !== undefined && rest.length === 0)
    return { project: only.dopplerProject, config: only.dopplerConfig };
  return {
    project: snapshot.bindings.map((b) => `${b.dopplerProject}/${b.dopplerConfig}`).join(', '),
    config: '',
  };
}
