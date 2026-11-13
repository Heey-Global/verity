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

export type TurnProvider = 'claude' | 'codex' | 'opencode';

const providerName: Record<TurnProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * Why a turn in a person's own sandbox cannot start: it runs only on that
 * person's own account for the model's provider, never on anyone else's.
 */
export function personalLoginMissing(provider: TurnProvider): string {
  return `Connect your ${providerName[provider]} account in Verity to send messages with this model.`;
}

/**
 * Refusal for a turn that cannot run on its person's own login, or `undefined`
 * when it may start. The project's original sandbox keeps the instance login it
 * always had; every other sandbox runs only on its person's own account for the
 * model's provider.
 */
export async function personalTurnRefusal(
  store: Pick<EventStore, 'userProviderConnections'>,
  sandbox: TurnSandbox,
  provider: TurnProvider | undefined,
): Promise<string | undefined> {
  if (sandbox.projectDefault) return undefined;
  if (provider === undefined) return personalLoginMissing('claude');
  const own = await store.userProviderConnections.get(sandbox.userId, provider);
  return own === undefined ? personalLoginMissing(provider) : undefined;
}
