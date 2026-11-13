import type { EventStore } from '@verity/store';
import { projectDefaultSandboxUser } from './project-sandbox.js';

/** The sandbox a turn runs in (ADR 0023 §4). */
export interface TurnSandbox {
  userId: string;
  /** The project's original sandbox, which serves its owner and turns without a person. */
  projectDefault: boolean;
}

/**
 * Which sandbox a project turn runs in: the initiator's own, or the project's
 * original one for its owner and for a turn without a person. Every place that
 * picks a container, runtime directory or credential for a turn asks this, so
 * they cannot disagree about whose sandbox the turn is in.
 */
export async function resolveTurnSandbox(
  store: Pick<EventStore, 'projectSandboxes'>,
  projectId: string,
  initiatedBy: { readonly userId: string } | undefined,
): Promise<TurnSandbox> {
  const owner = await projectDefaultSandboxUser(store, projectId);
  const userId = initiatedBy?.userId;
  return userId === undefined || userId === owner
    ? { userId: owner, projectDefault: true }
    : { userId, projectDefault: false };
}

/** Refusal for a person's turn until it can run on that person's own provider login. */
export const PERSONAL_SANDBOX_LOGIN_REQUIRED =
  "Your turns run in your own sandbox and need your own Claude, Codex or OpenCode account, which Verity cannot connect yet. The administrator's account is never used for your turns.";
