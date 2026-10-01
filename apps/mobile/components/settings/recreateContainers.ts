// Recreating running project containers so they pick up saved settings.
//
// Git identity, signing material and credentials are baked into a container
// when it is created, so a saved change only lands after a recreate. Both the
// banner that follows a save and the standing entry on the Server update screen
// start the same run, held in the settings store so only one is ever in flight.
import { VerityApiError, reprovisionActiveProjects } from '@verity/mobile';

import { createVerityClient } from '../../lib/client';
import {
  type ApplyRun,
  applyPendingGeneration,
  applyRunScope,
  clearApplyPending,
  setApplyRun,
  setVeritySettingsError,
  veritySettingsSnapshot,
} from '../../lib/settingsStore';

/** Recreate every active project container, unless a run or save is underway. */
export function startRecreateRun(): void {
  const client = createVerityClient();
  // Read from the store, not a render: another screen may have started a run
  // since, and two runs would recreate each container twice.
  const current = veritySettingsSnapshot();
  if (client === null || current.applyRun.phase === 'running' || current.saving > 0) return;
  setVeritySettingsError(undefined);
  const generation = applyPendingGeneration();
  const scope = applyRunScope();
  setApplyRun({ phase: 'running', total: 0, done: 0 }, scope);
  void (async () => {
    try {
      const projects = await client.listProjects();
      const result = await reprovisionActiveProjects(
        projects,
        (projectId) => client.recreateProjectContainer(projectId),
        (progress) => setApplyRun({ phase: 'running', ...progress }, scope),
      );
      // A save during the run missed the containers recreated before it, so
      // every container needs another pass and a clean result is moot. A
      // failure still names a container the operator may need to look at.
      if (generation !== applyPendingGeneration()) {
        setApplyRun(
          result.failed.length === 0
            ? { phase: 'idle' }
            : { phase: 'done', total: result.total, failed: result.failed },
          scope,
        );
        return;
      }
      setApplyRun({ phase: 'done', total: result.total, failed: result.failed }, scope);
      // A container that failed to come back still runs the old settings, so
      // the prompt stays until every one of them has been recreated.
      if (result.failed.length === 0) clearApplyPending(generation);
    } catch (caught) {
      if (scope !== applyRunScope()) return;
      setVeritySettingsError(
        caught instanceof VerityApiError ? caught.message : 'Could not recreate containers',
      );
      setApplyRun({ phase: 'idle' }, scope);
    }
  })();
}

/** What a run in progress, or just finished, has to say; null when idle. */
export function recreateRunMessage(run: ApplyRun): string | null {
  if (run.phase === 'idle') return null;
  if (run.phase === 'running') {
    return run.total === 0
      ? 'Recreating running containers…'
      : `Recreating running containers… ${String(run.done)}/${String(run.total)}`;
  }
  if (run.failed.length > 0) return `Could not recreate ${run.failed.join(', ')}.`;
  return run.total === 0
    ? 'No running containers — new ones start with these settings.'
    : `Recreated ${String(run.total)} running container${run.total === 1 ? '' : 's'}.`;
}
