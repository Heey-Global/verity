import type { ProjectRecord } from '@verity/store';

/** Keep foreground work queued while a sleeping project is brought back online. */
export async function ensureProjectSandboxReadyForTurn(input: {
  project: ProjectRecord;
  getProject: (projectId: string) => Promise<ProjectRecord | undefined>;
  canWait: boolean;
  waitingOn: (message: string) => void;
  ensureAwake?: (projectId: string) => Promise<ProjectRecord>;
}): Promise<ProjectRecord> {
  const current = (await input.getProject(input.project.id)) ?? input.project;
  if (current.state === 'active') return current;
  if (current.state !== 'sleeping' && current.state !== 'waking') {
    throw new Error(`project Sandbox is ${current.state}`);
  }
  if (!input.canWait || input.ensureAwake === undefined) {
    throw new Error(`project Sandbox is ${current.state}`);
  }
  input.waitingOn(
    'The project Sandbox is sleeping. Keeping the turn queued while Verity wakes it securely.',
  );
  const awake = await input.ensureAwake(current.id);
  if (awake.state !== 'active') throw new Error(`project Sandbox wake ended in ${awake.state}`);
  return awake;
}
