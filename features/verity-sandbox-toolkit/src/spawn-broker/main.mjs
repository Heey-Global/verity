export { capacityLeaseRequest } from './capacity-leases.mjs';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONTROL_DIR,
  DEFAULT_RUNTIME_DIR,
  SHARED_SESSION_ROOT,
  resolveDockerGid,
} from './request.mjs';
import { packageCacheLeafMain, packageCacheMaintenanceMain } from './session-home.mjs';
import { probeAgentSpawnBroker, runAgentSpawnBroker } from './process.mjs';

// The spawn broker's entry: the public API it has always exported, and the
// command-line start below. Built into bin/verity-agent-spawn-broker.mjs by
// scripts/build-toolkit-bundles.mjs; edit these sources, not the bundle.
export {
  AGENT_SPAWN_PROTOCOL_VERSION,
  DEFAULT_CONTROL_DIR,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  DEFAULT_WORKTREE_ROOT,
  PRIVILEGE_DROP_FLAGS,
  SHARED_SESSION_ROOT,
  privilegeDropFlags,
  resolveAgentWorktreeRoots,
  resolveDockerGid,
  runnerEgressReadiness,
  runnerStackHealth,
  sessionHomePath,
  validateTrustedCliExecutable,
  withinAgentWorktreeRoots,
} from './request.mjs';
export {
  acquirePackageCacheLease,
  acquireRuntimeAdmissionLease,
  agentSignalTraceSeconds,
  materializeKnowledgeIsolation,
  materializeManagedAgentHome,
  prepareSessionHome,
  reclaimPackageCaches,
  reclaimPackageCachesOffline,
  restrictedCodexModelCatalog,
  restrictedOpenCodePermissions,
  restrictedOpenCodePolicies,
  validateAgentSignalTraceLease,
} from './session-home.mjs';
export {
  LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX,
  PROCESS_TREE_KILL_GRACE_MS,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  TRUSTED_CLI_ARGV_POLICY_SUFFIX,
  agentLaunchSpec,
  loadTrustedCliArgvPolicy,
  matchesTrustedCliArgvPolicy,
  materializeTrustedCliEntryScript,
  probeScriptSandbox,
  trustedCliLaunchSpec,
  validateTrustedCliArguments,
} from './launch.mjs';
export {
  brokerSocketOwnership,
  collectEscapedProcessTree,
  killExitedTrustedCliProcessGroup,
  probeAgentSpawnBroker,
  resetProcessTreeWarnings,
  runAgentSpawnBroker,
  stopAgentProcessGroup,
  validateRunnerRuntimeStats,
} from './process.mjs';

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const controlDir = process.env.VERITY_AGENT_BROKER_RUNTIME ?? DEFAULT_CONTROL_DIR;
  // A flag, not a path: the control-plane Runner launcher sets it because that
  // container mounts `verity-data:sessions` at SHARED_SESSION_ROOT. Project
  // Sandboxes leave it unset and keep the single `/work` tree they have always
  // had. Nothing here reads a directory name from the environment, so no value
  // this variable can carry widens the guard beyond that one literal root.
  const sharedSessionRoot =
    process.env.VERITY_AGENT_SHARED_SESSION_ROOT === '1' ||
    process.env.VERITY_AGENT_SHARED_SESSION_ROOT === 'true'
      ? SHARED_SESSION_ROOT
      : undefined;
  const launch =
    process.argv[2] === '--reclaim-package-caches-maintenance'
      ? packageCacheMaintenanceMain(runtimeDir)
      : process.argv[2] === '--package-cache-leaf'
        ? packageCacheLeafMain()
        : process.argv[2] === '--probe'
          ? probeAgentSpawnBroker(controlDir)
          : runAgentSpawnBroker({
              runtimeDir,
              controlDir,
              ...(sharedSessionRoot === undefined ? {} : { sharedSessionRoot }),
              agentUid: Number(process.env.VERITY_AGENT_UID ?? 1000),
              agentGid: Number(process.env.VERITY_AGENT_GID ?? 1000),
              runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
              runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101),
              // ADR 0006 Amendment 1. Set by `verity-control-plane-runner-start` and
              // by nothing else — but a project image CAN declare the same name, so
              // the value is re-checked against the mounted inode here rather than
              // trusted. See {@link resolveDockerGid}: no socket owned by the claimed
              // group, no grant, which is every project Sandbox.
              ...(() => {
                const dockerGid = resolveDockerGid(process.env, (path) => statSync(path).gid);
                return dockerGid === undefined ? {} : { dockerGid };
              })(),
              // Thread the broker's own (container-provided) environment into the
              // Claude child through the `childEnvironment` allowlist. The container
              // sets CLAUDE_CONFIG_DIR=/run/verity-runner/claude on the
              // runner-supervisor path; without this the allowlisted copy() has no
              // source and Claude never sees the config dir, so its transcript would
              // land off the shared mount. The allowlist bounds exposure to the
              // vetted keys only — inherited OAuth/API/egress secrets never cross
              // (see the "passes only the local Claude connector coordinates" test).
              env: process.env,
            });
  launch
    .then((broker) => {
      if (typeof broker === 'boolean') {
        process.exitCode = broker ? 0 : 1;
        return;
      }
      const shutdown = () => void broker.close().finally(() => process.exit(0));
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => {
      if (process.argv[2] === '--reclaim-package-caches-maintenance') {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code:
              error?.message === 'runner runtime is in use' ? 'runtime-busy' : 'maintenance-failed',
          }),
        );
      } else {
        process.stderr.write(
          `verity-agent-spawn-broker: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      process.exitCode = 1;
    });
}
