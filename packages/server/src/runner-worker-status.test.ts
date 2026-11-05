import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  claimTurn,
  createTurnStarter,
  handleSupervisorRequest,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';

it('reports uncertain for stale running state until the worker has been authoritatively adopted', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'worker-status-'));
  const adoptedTurns = new Set<string>();
  const starter = createTurnStarter(runtime, 'new-supervisor', { adoptedTurns });
  try {
    await claimTurn(
      runtime,
      {
        turnId: 'old-turn',
        startCommandId: 'old-start',
      },
      'old-supervisor',
    );
    const statePath = join(runtime, 'turns', 'old-turn', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify({ ...state, status: 'running', workerLock: true }));
    const request = { protocolVersion: 1, kind: 'get-turn', turnId: 'old-turn' };
    // The durable row outlives the worker; serving it alone must not certify life.
    await expect(
      handleSupervisorRequest(runtime, 'new-supervisor', request, starter),
    ).resolves.toMatchObject({ state: { status: 'running' }, workerStatus: 'uncertain' });
    adoptedTurns.add('old-turn');
    await expect(
      handleSupervisorRequest(runtime, 'new-supervisor', request, starter),
    ).resolves.toMatchObject({ workerStatus: 'live' });
    adoptedTurns.delete('old-turn');
    await expect(
      handleSupervisorRequest(runtime, 'new-supervisor', request, starter),
    ).resolves.toMatchObject({ workerStatus: 'uncertain' });
  } finally {
    await starter.close();
    await rm(runtime, { recursive: true, force: true });
  }
});
