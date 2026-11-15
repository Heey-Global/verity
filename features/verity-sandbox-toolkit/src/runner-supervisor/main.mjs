import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME_DIR, installedWorkerBackends, supervisorWorkerEnv } from './protocol.mjs';
import { responseForError } from './turns.mjs';
import { probeSupervisor, runSupervisor } from './requests.mjs';

// The Runner supervisor's entry: the public API it has always exported, and the
// command-line start below. Built into bin/verity-runner-supervisor.mjs by
// scripts/build-toolkit-bundles.mjs; edit these sources, not the bundle.
export {
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  MAX_START_REQUEST_BYTES,
  MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  SUPERVISED_WORKER_BACKENDS,
  SUPERVISOR_PROTOCOL_VERSION,
  installedSkillsManifestHash,
  installedSkillsVersion,
  installedWorkerBackends,
  probeScriptSandbox,
  redactTrustedCliText,
  runTrustedCliViaBroker,
  supervisorWorkerEnv,
  writeSyntheticTerminalFrame,
} from './protocol.mjs';
export {
  acquireSingleton,
  claimTurn,
  readTurnState,
  supervisorRequestTimeoutMs,
  validateImageReferences,
  validateRuntimeDirectory,
  validateRuntimeStats,
  validateStartTurnRequest,
} from './turn-state.mjs';
export { createTurnAdopter, createTurnStarter, listTurns } from './turns.mjs';
export { handleSupervisorRequest, probeSupervisor, runSupervisor } from './requests.mjs';

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const command = process.argv[2];
  const brokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  const launch =
    command === '--probe'
      ? probeSupervisor(runtimeDir)
      : runSupervisor(
          brokerSocket === undefined
            ? undefined
            : {
                runtimeDir,
                workerCommand:
                  process.env.VERITY_RUNNER_WORKER ?? '/usr/local/bin/verity-runner-worker',
                workerBackends: installedWorkerBackends(),
                workerEnv: supervisorWorkerEnv(process.env),
              },
        );
  launch
    .then((supervisor) => {
      if (typeof supervisor === 'boolean') {
        process.exitCode = supervisor ? 0 : 1;
        return;
      }
      const shutdown = () => {
        void supervisor.close().finally(() => process.exit(0));
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => {
      process.stderr.write(`verity-runner-supervisor: ${responseForError(error).error}\n`);
      process.exitCode = 1;
    });
}
