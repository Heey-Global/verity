import { sandboxNotReadyError } from '@verity/events';
import type { ProjectRecord } from '@verity/store';

/**
 * Project states a turn simply arrived too early for: the Sandbox is on its way
 * in or out, and a later turn finds it ready without anybody repairing anything.
 * A failure on one of these is reported as the transient class, so it settles
 * the turn without badging the session `crashed` (see `sandbox-lifecycle.ts`).
 *
 * `failed` and `absent` are deliberately absent: those need the operator, and a
 * red badge is the correct answer for them.
 *
 * The rule is the state, not `canWait`: whether the caller could afford to wait
 * says nothing about whether the Sandbox heals on its own. `embedded.ts` looks
 * at `canWait` on the gateway-relay path for a different reason — there it
 * separates "the rebuild ran and failed" (operator's problem) from "no rebuild
 * was attempted", which is the same distinction this set draws by state.
 */
const TRANSIENT_PROJECT_STATES: ReadonlySet<ProjectRecord['state']> = new Set([
  'cloning',
  'container_starting',
  'sleeping_starting',
  'sleeping',
  'waking',
]);

/** The turn cannot run in this state — transient (settles as `idle`) or not. */
function projectSandboxStateError(message: string, state: ProjectRecord['state']): Error {
  return TRANSIENT_PROJECT_STATES.has(state) ? sandboxNotReadyError(message) : new Error(message);
}

/** Keep foreground work queued while a sleeping project is brought back online. */
export async function ensureProjectSandboxReadyForTurn(input: {
  project: ProjectRecord;
  getProject: (projectId: string) => Promise<ProjectRecord | undefined>;
  canWait: boolean;
  waitingOn: (message: string) => void;
  ensureAwake?: (
    projectId: string,
    requestingSessionIds?: ReadonlySet<string>,
  ) => Promise<ProjectRecord>;
  requestingSessionIds?: ReadonlySet<string>;
}): Promise<ProjectRecord> {
  const current = (await input.getProject(input.project.id)) ?? input.project;
  if (current.state === 'active') return current;
  if (current.state !== 'sleeping' && current.state !== 'waking') {
    throw projectSandboxStateError(`project Sandbox is ${current.state}`, current.state);
  }
  if (!input.canWait || input.ensureAwake === undefined) {
    throw sandboxNotReadyError(`project Sandbox is ${current.state}`);
  }
  input.waitingOn(
    'The project Sandbox is sleeping. Keeping the turn queued while Verity wakes it securely.',
  );
  const awake = await input.ensureAwake(current.id, input.requestingSessionIds);
  if (awake.state !== 'active') {
    throw projectSandboxStateError(`project Sandbox wake ended in ${awake.state}`, awake.state);
  }
  return awake;
}
