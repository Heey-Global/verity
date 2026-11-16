import type { EventStore } from '@verity/store';

import { originalSandboxUser } from './project-sandbox.js';

/** Shown to the agent and in the transcript when work without a person is refused. */
export const PERSONLESS_TURN_REFUSAL =
  'This work was started without a person, and this project is shared with other ' +
  "members, so no one's credentials can be used for it. Send the message again from " +
  'your own account in Verity.';

export class PersonlessTurnRefusedError extends Error {
  constructor() {
    super(PERSONLESS_TURN_REFUSAL);
    this.name = 'PersonlessTurnRefusedError';
  }
}

type Store = Pick<EventStore, 'projectSandboxes' | 'projectTeam'>;

/**
 * Whether work without a person may run on the instance's credentials in a
 * project (ADR 0023 §3). Such work only exists from before projects had people:
 * a pre-multi-user session, an administrator's legacy device or an automation
 * nobody sponsored. It runs in the project's original sandbox, whose person's
 * credentials the instance's always were. That stays true only while no one
 * else is in the project: once members share it, nobody can tell whose work it
 * is, and it must not borrow the owner's credentials for them.
 */
export async function personlessWorkAllowed(store: Store, projectId: string): Promise<boolean> {
  const owner = await originalSandboxUser(store, projectId);
  return (await store.projectTeam.listMembers(projectId)).every(
    (member) => member.userId === owner,
  );
}

/**
 * The one rule for whose credentials serve work in a project: its person's, or
 * for work without one, the original sandbox's person — only where
 * `personlessWorkAllowed` holds. Otherwise the work is refused, never served
 * with someone's credentials by default.
 */
export async function personForCredential(
  store: Store,
  projectId: string,
  userId: string | null | undefined,
): Promise<string> {
  if (userId !== null && userId !== undefined) return userId;
  if (!(await personlessWorkAllowed(store, projectId))) throw new PersonlessTurnRefusedError();
  return originalSandboxUser(store, projectId);
}
