import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectEscapedProcessTree,
  frameBodyHash,
  InMemoryEventBus,
  MAX_SUPERVISOR_REQUEST_BYTES,
  PROCESS_TREE_KILL_GRACE_MS,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  runnerFrameIngestEnvelope,
  tailFrames,
  type Backend,
  type RunnerAttachTarget,
  type RunnerFrame,
  type RunnerFrameBody,
} from '@verity/session';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import { startRunnerSupervisorReconciler } from './embedded.js';
import { codexGatewayConfig } from './provisioner.js';
import {
  acquireSingleton,
  claimTurn,
  handleSupervisorRequest,
  listTurns,
  MAX_START_REQUEST_BYTES,
  MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_PROTOCOL_VERSION,
  readTurnState,
  redactTrustedCliText,
  runTrustedCliViaBroker,
  runSupervisor as runSupervisorRuntime,
  supervisorRequestTimeoutMs,
  probeSupervisor,
  validateRuntimeDirectory,
  validateRuntimeStats,
  validateStartTurnRequest,
  SUPERVISED_WORKER_BACKENDS,
  installedWorkerBackends,
  supervisorWorkerEnv,
  writeSyntheticTerminalFrame,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  agentLaunchSpec,
  brokerSocketOwnership,
  killExitedTrustedCliProcessGroup,
  materializeTrustedCliEntryScript,
  probeAgentSpawnBroker,
  resetProcessTreeWarnings,
  runAgentSpawnBroker as runAgentSpawnBrokerRuntime,
  stopAgentProcessGroup,
  collectEscapedProcessTree as brokerCollectEscapedProcessTree,
  PROCESS_TREE_KILL_GRACE_MS as BROKER_PROCESS_TREE_KILL_GRACE_MS,
  trustedCliLaunchSpec,
  validateTrustedCliArguments as validateTrustedCliArgumentsRuntime,
  validateRunnerRuntimeStats,
  validateTrustedCliExecutable,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

let runtimeDir: string;
const execFileAsync = promisify(execFile);
const connectorLauncher = resolve(
  'features/verity-sandbox-toolkit/bin/verity-egress-connector-start',
);
const NATIVE_WORKER_SETTLE_TIMEOUT_MS = 5_000;
// Keep broker fixtures independent of the host image's runner-writable
// /usr/local/bin; dedicated tests below still cover mutable PATH rejection.
const IMMUTABLE_EXECUTABLE_PATH = '/usr/bin:/bin';

const validateTrustedCliArguments: typeof validateTrustedCliArgumentsRuntime = (
  command,
  args,
  cwd,
  executablePath = IMMUTABLE_EXECUTABLE_PATH,
  ...rest
) => validateTrustedCliArgumentsRuntime(command, args, cwd, executablePath, ...rest);

function runAgentSpawnBroker(options: Parameters<typeof runAgentSpawnBrokerRuntime>[0]) {
  const testIdentity =
    options.enforceRoot === false
      ? { agentUid: process.getuid?.() ?? 0, agentGid: process.getgid?.() ?? 0 }
      : {};
  return runAgentSpawnBrokerRuntime({
    ...options,
    ...testIdentity,
    env: { ...options.env, PATH: options.env?.PATH ?? IMMUTABLE_EXECUTABLE_PATH },
  });
}

type RunSupervisorOptions = Parameters<typeof runSupervisorRuntime>[0];

function runSupervisor(options: RunSupervisorOptions = {}) {
  return runSupervisorRuntime({
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    ...options,
  });
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

async function supervisorRequest(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frames = await supervisorRequestFrames(socketPath, payload);
  return frames.at(-1) ?? {};
}

async function supervisorRequestFrames(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  return await new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.once('error', rejectReply);
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      const frames = response
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolveReply(frames);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
  });
}

/**
 * Send several requests that must be IN FLIGHT TOGETHER.
 *
 * `Promise.all` over independent connect-then-write round trips does not give that:
 * on a host that schedules unkindly, each request can be answered before the next
 * socket even connects, and a test about a full queue quietly becomes a test about
 * six starts in a row. Connecting everything first and only then writing removes the
 * scheduling from the question — the frames land while the first start is still
 * awaiting its own filesystem work.
 */
async function supervisorRequestsTogether(
  socketPath: string,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const frames = await supervisorRequestFramesTogether(socketPath, payloads);
  return frames.map((lines) => lines.at(-1) ?? {});
}

/**
 * The same burst, keeping EVERY frame each connection received.
 *
 * What a two-phase reply refuses to say matters as much as what it says: a refusal
 * that arrives on its own proves the supervisor never acknowledged the start, which
 * is the difference between a turn the Server may retry and one it has to fence.
 * Collapsing each connection to its last frame hides exactly that.
 */
async function supervisorRequestFramesTogether(
  socketPath: string,
  payloads: Record<string, unknown>[],
): Promise<Record<string, unknown>[][]> {
  const pending = payloads.map(async (payload) => {
    const socket = createConnection(socketPath);
    let response = '';
    const connected = new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('connect', () => resolveConnect());
      socket.once('error', rejectConnect);
    });
    const replied = new Promise<Record<string, unknown>[]>((resolveReply, rejectReply) => {
      socket.once('error', rejectReply);
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });
      socket.once('end', () => {
        resolveReply(
          response
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
      });
    });
    await connected;
    return { payload, socket, replied };
  });
  const ready = await Promise.all(pending);
  for (const { socket, payload } of ready) socket.write(`${JSON.stringify(payload)}\n`);
  return await Promise.all(ready.map(async ({ replied }) => await replied));
}

describe('verity-runner supervisor runtime', () => {
  it('keeps the control-plane Codex provider config aligned with project sandboxes', async () => {
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    const projectConfig = codexGatewayConfig(47_821);
    for (const line of projectConfig.split('\n').filter((value) => !value.startsWith('base_url'))) {
      expect(launcher).toContain(line);
    }
    expect(launcher).toContain(
      'base_url = \\"http://127.0.0.1:${VERITY_CLAUDE_CONNECTOR_PORT}/codex\\"',
    );
  });

  // The request cap is stated twice — once in the supervisor that enforces it,
  // once in the Server that checks it before writing — because the two ship in
  // separate artifacts (ADR 0006 D9) and neither can import the other at
  // runtime. Only the Server copy being no larger keeps the check meaningful: a
  // Server that allowed more would go back to discovering the bound mid-write,
  // which is the `write EPIPE` this pair exists to prevent.
  it('keeps the Server request cap identical to the bound the supervisor reads', () => {
    expect(MAX_SUPERVISOR_REQUEST_BYTES).toBe(MAX_START_REQUEST_BYTES);
  });

  it('keeps the committed worker bundle reproducible', async () => {
    await expect(execFileAsync('npm', ['run', 'check:runner-worker'])).resolves.toBeDefined();
  }, 60_000);

  it('opens the supervisor transport for every ACP adapter', async () => {
    expect(SUPERVISED_WORKER_BACKENDS).not.toContain('claude');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('claude-acp');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('codex-acp');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('opencode-acp');
    // `opencode` is the retired native HTTP transport, not a backend name any more;
    // `pi` has no worker adapter yet and stays on the loopback path.
    expect(SUPERVISED_WORKER_BACKENDS).not.toContain('opencode');
    expect(SUPERVISED_WORKER_BACKENDS).not.toContain('pi');
    // The production main block must launch from the constant — through the
    // installed-adapter filter, never a bare literal — so re-narrowing to
    // ['claude'] can never silently regress the gate again.
    const source = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      'utf8',
    );
    expect(source).toContain('workerBackends: installedWorkerBackends()');
    expect(source).not.toContain("workerBackends: ['claude']");
    // Same reasoning for the worker env: the production entry must build it from the
    // container env through the shared helper, never from an inline literal that only
    // names the broker socket. See the two tests below for what that helper owes.
    expect(source).toContain('workerEnv: supervisorWorkerEnv(process.env)');
    // Launched, but NOT admitted to the brokered Verity tools. The two sets are
    // separate on purpose (ADR 0014 D1): being an ACP transport says what an agent
    // can speak, not whose secrets it may spend. Asserted on the source because
    // `ACP_WORKER_BACKENDS` is module-private — the gate reads it, nothing exports
    // it — and a one-word edit here is exactly the drift worth catching.
    // Matched loosely on purpose: the point is the membership, not the formatting.
    // Prettier rewraps this literal the moment a third member is added, and a
    // tripwire that fires on the rewrap would read as a style failure rather than
    // the policy change it is.
    expect(source).toMatch(
      /ACP_WORKER_BACKENDS = new Set\(\[\s*'claude-acp',\s*'codex-acp',?\s*\]/,
    );
  });

  it('advertises only the adapters the image actually installed', () => {
    // `SUPERVISED_WORKER_BACKENDS` is a property of this Feature's source; the agent
    // CLIs are opt-in at build time (`INSTALL_OPENCODE` and friends). On an image
    // built without one, advertising it anyway costs the clear refusal: the turn is
    // claimed, the worker starts, and the broker's `setpriv` dies with "failed to
    // execute /usr/local/bin/opencode-acp" — which reads like a broken image rather
    // than one built to a narrower spec.
    const missing = new Set(['/usr/local/bin/opencode-acp']);
    expect(installedWorkerBackends((path) => !missing.has(path))).toEqual([
      'claude-acp',
      'codex-acp',
    ]);
    // The full image keeps the full list — the filter must not become the gate.
    expect(installedWorkerBackends(() => true)).toEqual([...SUPERVISED_WORKER_BACKENDS]);
    // The paths it probes are the ones the broker execs; a disagreement would refuse
    // turns the image could have run. Checked for ALL THREE rather than the one this
    // migration added: the supervisor's map and the broker's map are separate literals
    // in separate files, so any of the three can drift, and the two names differ for
    // Claude — supervisor backend `claude-acp`, broker command `claude-agent-acp` —
    // which is exactly the kind of seam a single-entry check leaves unguarded.
    const brokerCommands = {
      'claude-acp': 'claude-agent-acp',
      'codex-acp': 'codex-acp',
      'opencode-acp': 'opencode-acp',
    } as const;
    for (const backend of SUPERVISED_WORKER_BACKENDS) {
      // A backend the supervisor advertises and this map has no entry for is drift of
      // the same kind, so make it a failure rather than an `undefined` command.
      const command = brokerCommands[backend as keyof typeof brokerCommands];
      expect(command, backend).toBeDefined();
      const spec = agentLaunchSpec(
        { command, args: [], cwd: '/work/project' },
        { agentUid: 1000, agentGid: 1000, connectorUrl: 'http://127.0.0.1:47821', env: {} },
      );
      // The broker execs the last argv entry (the request carries no arguments), and
      // the supervisor's own map is private — so ask it the question instead: with
      // exactly that path absent, the backend must drop off the advertised list. If
      // the two literals ever diverge, this backend stays advertised and the check
      // fails here rather than at a turn.
      const execPath = spec.args[spec.args.length - 1];
      expect(execPath).toBe(`/usr/local/bin/${command}`);
      expect(installedWorkerBackends((path) => path !== execPath)).not.toContain(backend);
    }
  });

  it('carries the MCP gateway URL from the container env to the worker', () => {
    // ADR 0014 D1. The Server mints a per-turn bearer for every ACP turn, but the URL
    // it belongs to exists only as a container env var the provisioner sets. The worker
    // reads it from its own process env and offers the gateway ONLY when it has both
    // (packages/session/src/runner-worker-entry.ts) — so a supervisor that drops the URL
    // hands the agent an empty mcpServers list, and the brokered Verity tools are absent
    // from the session with no error anywhere. That was the live failure this pins.
    expect(
      supervisorWorkerEnv({
        VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/verity-runner-broker/agent-spawn-broker.sock',
        VERITY_MCP_GATEWAY_URL: 'http://relay.internal/internal/mcp',
      }),
    ).toEqual({
      VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/verity-runner-broker/agent-spawn-broker.sock',
      VERITY_MCP_GATEWAY_URL: 'http://relay.internal/internal/mcp',
    });
    // A deployment with no broker URL has no gateway to offer. Absent and blank are the
    // same answer: an empty URL would be handed to the agent as a server it can never
    // reach, which is worse than not offering the tools at all.
    for (const environment of [
      { VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/broker.sock' },
      { VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/broker.sock', VERITY_MCP_GATEWAY_URL: '' },
    ]) {
      expect(supervisorWorkerEnv(environment)).toEqual({
        VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/broker.sock',
      });
    }
  });

  it('supplies every env var the worker bundle reads from its own process env', async () => {
    // The supervisor spawns the worker with an EXPLICIT env — process.env is deliberately
    // not spread across that boundary — so a variable the worker reads and the supervisor
    // does not pass is silently undefined at runtime. Nothing failed loudly the last time
    // that happened; the gateway just went missing. Read the two sides against each other
    // instead of trusting that the next added variable gets wired by hand.
    const workerSource = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs',
      'utf8',
    );
    const read = new Set(
      [
        ...workerSource.matchAll(
          /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g,
        ),
      ].map((match) => (match[1] ?? match[2])!),
    );
    // Destructuring hides the names from any reader, this one included, so the bundle
    // must not reach the env that way — the alternative is a check that quietly passes.
    expect(workerSource).not.toMatch(/}\s*=\s*process\.env/);
    const supplied = new Set([
      ...Object.keys(
        supervisorWorkerEnv({
          VERITY_AGENT_SPAWN_BROKER_SOCKET: '/run/broker.sock',
          VERITY_MCP_GATEWAY_URL: 'http://relay.internal/internal/mcp',
        }),
      ),
      // Per-turn coordinates the supervisor computes itself for each spawn.
      'VERITY_RUNNER_TURN_DIR',
      'VERITY_RUNNER_EVENT_FILE',
      'VERITY_RUNNER_CONTROL_SOCKET',
      'PATH',
      // Read only as a fallback: every caller inside the worker passes the agent env it
      // built for the launch explicitly (packages/session/src/codex-backend.ts), so the
      // process-level value is never the one that decides where Codex state lives.
      'CODEX_HOME',
    ]);
    expect([...read].filter((name) => !supplied.has(name))).toEqual([]);
  });

  it('redacts raw and common encoded trusted CLI secret echoes', () => {
    const secret = 'private key/+';
    const output = Buffer.from(
      `raw=${secret} base64=${Buffer.from(secret).toString('base64')} url=${encodeURIComponent(secret)}`,
    );
    const redacted = redactTrustedCliText(output, secret);
    expect(redacted).toBe('raw=[REDACTED] base64=[REDACTED] url=[REDACTED]');
    expect(redacted).not.toContain(secret);
  });

  it('wires an external lifecycle reconciler and private launcher log', async () => {
    const [launcher, stackLauncher, connectorLauncher, installer, baseCompose, overlay] =
      await Promise.all([
        readFile('features/verity-sandbox-toolkit/bin/verity-runner-supervisor-start', 'utf8'),
        readFile('features/verity-sandbox-toolkit/bin/verity-runner-stack-start', 'utf8'),
        readFile('features/verity-sandbox-toolkit/bin/verity-egress-connector-start', 'utf8'),
        readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
        readFile('deploy/docker-compose.yml', 'utf8'),
        readFile('deploy/docker-compose.runner-supervisor.yml', 'utf8'),
      ]);
    expect(launcher).toContain('umask 0007');
    expect(launcher).toContain('chmod 0660 "$LOG"');
    expect(installer).toContain('/usr/local/bin/verity-runner-worker');
    expect(installer).toContain('/usr/local/bin/verity-agent-spawn-broker');
    expect(installer).toContain('/usr/local/bin/verity-egress-connector');
    expect(installer).toContain('/usr/local/bin/verity-egress-connector-start');
    expect(launcher).not.toContain('verity-agent-spawn-broker');
    expect(installer).toContain('/usr/local/bin/verity-runner-stack-start');
    expect(stackLauncher).toContain('verity-agent-spawn-broker --probe');
    expect(stackLauncher).toContain("stat -c '%u'");
    expect(stackLauncher).toContain('8#$BROKER_MODE & 022');
    expect(stackLauncher).toContain('sed -n');
    expect(stackLauncher).toContain('chmod 0711 "$BROKER_RUNTIME"');
    expect(stackLauncher).toContain('BROKER_RUNTIME=/run/verity-runner-broker');
    expect(stackLauncher).toContain('--bounding-set=-all');
    expect(stackLauncher).toContain('/usr/local/bin/verity-runner-supervisor-start');
    expect(stackLauncher).toContain('VERITY_RUNNER_FOREGROUND');
    expect(stackLauncher).toContain('connector-reconcile.failed');
    expect(stackLauncher).toContain('connector reconcile interval must be positive');
    expect(stackLauncher).toContain('/generation');
    expect(stackLauncher).toContain('claude-egress-generation');
    expect(stackLauncher).toContain('/usr/local/bin/verity-egress-connector-start');
    expect(baseCompose).toContain('VERITY_OPENCODE_ENABLED: ${VERITY_OPENCODE_ENABLED:-}');
    expect(baseCompose).toContain('VERITY_EXTRA_MODELS: ${VERITY_EXTRA_MODELS:-}');
    expect(baseCompose).toContain('OPENCODE_BASE_URL: ${OPENCODE_BASE_URL:-}');
    expect(stackLauncher).toContain('incomplete Sandbox egress connector configuration');
    // Stage-5b Slice 2b: root pass creates the Claude transcript dir on the
    // shared runner-runtime mount and hands it to the agent uid so the worker
    // can write its session .jsonl where the server-side tail persists it.
    expect(stackLauncher).toContain('CLAUDE_DIR="$RUNTIME_DIR/claude"');
    expect(stackLauncher).toContain('mkdir -p "$CLAUDE_DIR"');
    expect(stackLauncher).toContain('chown "$AGENT_UID:$AGENT_GID" "$CLAUDE_DIR"');
    expect(stackLauncher).toContain('invalid Claude transcript directory');
    // The sandbox runs cap-drop ALL plus only RUNNER_BROKER_CAPABILITIES, so root
    // holds NO CAP_DAC_OVERRIDE, and CODEX_DIR is never root-owned (install.sh
    // ships /run/verity to the remote user at 0755 uid 1000). A root `ln -s` into
    // it therefore fails with EACCES and tore down every runner-supervisor project
    // ("Runner supervisor failed to start: ln: failed to create symbolic link
    // '/run/verity/codex/sessions': Permission denied"). Every mutation of that
    // directory must run as the agent that owns it, so assert no bare root write
    // sneaks back in.
    expect(stackLauncher).toContain(
      'setpriv --reuid="$AGENT_UID" --regid="$AGENT_GID" --clear-groups "$@"',
    );
    expect(stackLauncher).toContain('as_agent ln -sfn "$CODEX_SESSIONS_DIR" "$CODEX_DIR/sessions"');
    for (const rootWrite of [
      '\nln -s "$CODEX_SESSIONS_DIR"',
      '\n  ln -s "$CODEX_SESSIONS_DIR"',
      '\n  mv "$CODEX_DIR/sessions"',
      '\n  cp -an "$CODEX_LEGACY_DIR/."',
    ]) {
      expect(stackLauncher).not.toContain(rootWrite);
    }
    // Root cannot traverse the agent-owned 0700 CODEX_DIR without CAP_DAC_OVERRIDE,
    // so a test evaluated as root in there is silently false and sends every restart
    // down the branch that recreates an existing symlink. Inspection must run as the
    // agent for the same reason mutation does.
    for (const agentTest of [
      'if as_agent test -L "$CODEX_DIR/sessions"; then',
      'elif as_agent test -e "$CODEX_DIR/sessions"; then',
      'as_agent readlink "$CODEX_DIR/sessions"',
    ]) {
      expect(stackLauncher).toContain(agentTest);
    }
    for (const blindTest of [
      '\nif [ -L "$CODEX_DIR/sessions" ]',
      '\nelif [ -e "$CODEX_DIR/sessions" ]',
      '$(readlink "$CODEX_DIR/sessions")',
    ]) {
      expect(stackLauncher).not.toContain(blindTest);
    }
    // The Runner mount is 0170, so the agent cannot create CODEX_SESSIONS_DIR
    // itself — that mkdir and the ownership handoff stay root-side, ahead of the
    // agent writes.
    const codexChown = stackLauncher.indexOf('chown "$AGENT_UID:$AGENT_GID" "$CODEX_DIR"');
    const firstAgentWrite = stackLauncher.indexOf('as_agent ');
    expect(codexChown).toBeGreaterThan(-1);
    expect(firstAgentWrite).toBeGreaterThan(-1);
    expect(codexChown).toBeLessThan(firstAgentWrite);
    expect(stackLauncher).toContain('egress-connector.url');
    expect(stackLauncher).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(connectorLauncher).toContain("stat -c '%u:%g'");
    expect(connectorLauncher).toContain('8#$CONTROL_MODE & 022');
    expect(connectorLauncher).toContain('egress-connector.pid');
    expect(connectorLauncher).toContain('process_start_time');
    expect(connectorLauncher).toContain('identity_valid');
    expect(connectorLauncher).toContain('print_connector_log');
    expect(connectorLauncher).toContain('kill -KILL "$STALE_PID"');
    expect(connectorLauncher).toContain('--bounding-set=-all');
    expect(connectorLauncher).toContain('8#$KEY_MODE & 007');
    expect(connectorLauncher).toContain('flock --exclusive --nonblock 9');
    expect(connectorLauncher).toContain('9>&- &');
    // The launcher must resolve an absolute node interpreter and prepend its
    // directory to the sanitized launch PATH — devcontainer images (nvm
    // Feature) carry node outside /usr/local/bin:/usr/bin:/bin.
    expect(connectorLauncher).toContain('/usr/local/share/nvm/current/bin/node');
    expect(connectorLauncher).toContain('"PATH=$(dirname "$NODE_BIN")');
    // The supervisor's extra CAPABILITY is scoped to the opt-in overlay: only it
    // hands a runtime directory to the Runner UID, and changing an owning UID always
    // requires CAP_CHOWN. The Runner GROUP membership is base, because the Claude
    // egress client key is handed to that group and every Claude project turn goes
    // through the gateway; changing a file group to a group the process already
    // belongs to needs no capability, and without it that chown fails EPERM and
    // takes every project sandbox creation and repair with it.
    // (was: the base carries no standing CAP_CHOWN / runtime GID
    // grant — only an explanatory comment pointing at the overlay).
    expect(baseCompose).toContain("'${VERITY_RUNNER_RUNTIME_GID:-1101}'");
    expect(baseCompose).not.toContain('CODEX_TRANSPORT');
    expect(baseCompose).not.toMatch(/cap_add:\s*\n\s*- CHOWN/);
    // Do not repeat it on the Server service: compose merges that service's
    // `group_add` additively. The dedicated sidecar has its own required group.
    const serverOverlay = overlay.slice(
      overlay.indexOf('  verity:\n'),
      overlay.indexOf('  verity-control-runner-init:\n'),
    );
    expect(serverOverlay).not.toContain("'${VERITY_RUNNER_RUNTIME_GID:-1101}'");
    expect(overlay).toMatch(/cap_add:\s*\n\s*- CHOWN/);
  });

  it('isolates the Claude ACP control-plane runner from Server credentials', async () => {
    const [overlay, launcher, dockerfile] = await Promise.all([
      readFile('deploy/docker-compose.runner-supervisor.yml', 'utf8'),
      readFile('deploy/bin/verity-control-plane-runner-start', 'utf8'),
      readFile('deploy/Dockerfile', 'utf8'),
    ]);

    expect(overlay).toMatch(/^ {2}verity-control-runner:\s*$/m);
    expect(overlay).toContain("VERITY_RUNNER_SUPERVISOR: '1'");
    expect(overlay).toContain('verity-control-runner-runtime:/run/verity-runner');
    expect(overlay).toContain('verity-control-runner-identity:/run/verity-control-identity:ro');
    expect(overlay).toContain('subpath: workspaces/verity-control');
    expect(overlay).toContain('subpath: sessions');
    expect(overlay).toContain('mem_limit: ${VERITY_CONTROL_PLANE_RUNNER_MEMORY:-4g}');
    expect(overlay).toContain('memswap_limit: ${VERITY_CONTROL_PLANE_RUNNER_MEMORY_SWAP:-4g}');
    expect(overlay).toContain('cpus: ${VERITY_CONTROL_PLANE_RUNNER_CPUS:-4}');
    expect(overlay).toContain('pids_limit: ${VERITY_CONTROL_PLANE_RUNNER_PIDS_LIMIT:-512}');
    // The daemon socket IS mounted here now — ADR 0006 Amendment 1, a deliberate operator
    // decision restoring the fleet-diagnostics capability this container lost
    // when control-plane turns left the Server process (#1478). It is the one
    // property in this list that was traded away rather than kept, so assert it
    // POSITIVELY rather than deleting the line: a silently vanished assertion
    // would leave nothing recording that the mount is meant to be here, and this
    // test is where a future reader looks to find out what this container is and
    // is not allowed to reach.
    expect(overlay).toContain(
      '${VERITY_DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock',
    );
    // Everything else it is kept away from still holds — Server credentials in
    // particular do not ride along with the socket.
    expect(overlay).not.toContain('/srv/verity/secrets');
    expect(overlay).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(launcher).toContain('VERITY_MCP_GATEWAY_URL');
    expect(launcher).toContain('VERITY_RUNNER_FOREGROUND=1');
    expect(launcher).toContain('client.key generation');
    expect(launcher).toContain('verity-runner-stack-start');
    expect(dockerfile).toContain('/usr/local/bin/verity-control-plane-runner-start');
  });

  it('passes only the local Claude connector coordinates through the root broker', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          PATH: '/usr/bin',
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
          VERITY_CLAUDE_EGRESS_KEY: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
      // The CLI strips the placeholder from its own children, so an in-Sandbox
      // helper that must re-supply it needs this to say so unambiguously.
      VERITY_CLAUDE_EGRESS: '1',
    });
    expect(spec.spawnOptions.detached).toBe(true);
    expect(spec.spawnOptions.env).not.toHaveProperty('VERITY_CLAUDE_EGRESS_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('launches Claude ACP through its fixed binary with the same secret-free connector env', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
          CLAUDE_CODE_EXECUTABLE: '/work/project/attacker-controlled',
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('/usr/local/bin/claude-agent-acp');
    expect(spec.spawnOptions.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
      CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
      // Both Claude transports are marked, so an in-Sandbox helper never has to
      // fall back to probing the connector on one of them.
      VERITY_CLAUDE_EGRESS: '1',
    });
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  // The command→binary map is the last check before a privileged `setpriv` exec, and
  // it replaced a chain that fell back to the native `claude` binary (ADR 0012). An
  // unmapped command must fail there — including the inherited object keys a plain
  // literal would have resolved to a truthy function, sailing past the guard.
  // `opencode` is in that family twice over: it is the retired native transport's
  // name AND a multi-purpose CLI, so a request that reached it would choose the
  // subcommand. Only the `opencode-acp` wrapper is spawnable.
  it.each(['claude', 'opencode', 'constructor', 'valueOf', 'toString', '__proto__'])(
    'refuses to launch the unmapped agent command %p',
    (command) => {
      expect(() =>
        agentLaunchSpec(
          // The typed union is exactly what this guard has to hold up without: the
          // request crossed a socket, so the cast reproduces a caller that bypassed it.
          { command, args: [], cwd: '/work/project' } as Parameters<typeof agentLaunchSpec>[0],
          { agentUid: 1000, agentGid: 1000, connectorUrl: 'http://127.0.0.1:47821', env: {} },
        ),
      ).toThrow('unsupported agent command');
    },
  );

  it('launches Codex ACP through its fixed binary, pinned to the image Codex and free of secrets', () => {
    const spec = agentLaunchSpec(
      { command: 'codex-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          CODEX_HOME: '/run/verity-runner/codex',
          // A request that could pick these would run an attacker's Codex, log
          // into a browser flow, or downgrade the sandbox posture.
          CODEX_PATH: '/work/project/attacker-controlled',
          NO_BROWSER: '0',
          INITIAL_AGENT_MODE: 'read-only',
          OPENAI_API_KEY: 'must-not-cross',
          VERITY_CODEX_PLACEHOLDER: 'attacker-controlled',
          DOPPLER_TOKEN: 'must-not-cross',
          GITHUB_TOKEN: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('/usr/local/bin/codex-acp');
    expect(spec.args).not.toContain('/work/project/attacker-controlled');
    expect(spec.spawnOptions.env).toMatchObject({
      CODEX_HOME: '/run/verity-runner/codex',
      // codex-acp bundles its own @openai/codex; without this pin two Codex
      // versions run in the same image.
      CODEX_PATH: '/usr/local/bin/codex',
      NO_BROWSER: '1',
      // Reproduces the native transport's posture, never taken from the request.
      INITIAL_AGENT_MODE: 'agent-full-access',
      VERITY_CODEX_PLACEHOLDER: 'verity-codex-gateway-placeholder-v1',
    });
    expect(spec.spawnOptions.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('DOPPLER_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    // The Claude connector coordinates belong to the Claude transports only.
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('VERITY_CLAUDE_EGRESS');
  });

  it('launches OpenCode ACP through the fixed wrapper, with XDG_CONFIG_HOME and no secrets', () => {
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          XDG_CONFIG_HOME: '/run/verity/xdg',
          OPENAI_API_KEY: 'must-not-cross',
          DOPPLER_TOKEN: 'must-not-cross',
          GITHUB_TOKEN: 'must-not-cross',
        },
      },
    );
    // The wrapper, never the `opencode` binary: that CLI is multi-purpose, so a
    // command name reaching it would let the request's argv pick the subcommand.
    expect(spec.args).toContain('/usr/local/bin/opencode-acp');
    expect(spec.args).not.toContain('/usr/local/bin/opencode');
    // OpenCode reads plain XDG and its provider config lives in the mounted volume
    // under it; without this the child finds an empty config dir and the turn dies
    // on the first prompt with no provider.
    expect(spec.spawnOptions.env).toMatchObject({ XDG_CONFIG_HOME: '/run/verity/xdg' });
    expect(spec.spawnOptions.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('DOPPLER_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    // Claude's and Codex's per-command env belong to those commands alone.
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('CODEX_PATH');
    expect(spec.spawnOptions.env).not.toHaveProperty('INITIAL_AGENT_MODE');
  });

  it('leaves the home-mode image on the HOME fallback OpenCode resolves itself', () => {
    // The forward above is the devcontainer half. On a Verity base image the
    // provisioner uses `home` path mode: it mounts the config volume at
    // `/home/dev/.config/opencode` and sets no `XDG_CONFIG_HOME` at all, leaving
    // OpenCode's own `$HOME/.config` fallback to find it. That only works because
    // the broker pins `HOME` to `/home/dev` rather than to the per-turn runtime
    // directory — pointing it at the latter would start every OpenCode turn on
    // those images with no provider configured, and the failure would surface as a
    // model error on the first prompt rather than as a missing mount.
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: { PATH: '/usr/bin' },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({ HOME: '/home/dev' });
    // Not invented when the container has none: an XDG root the image never set
    // would point the child at a directory nothing mounts.
    expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CONFIG_HOME');
  });

  it('gives OpenCode a writable home for the state it keeps outside its config', async () => {
    // Config is only one of the four XDG roots opencode 1.18.21 uses: session
    // storage and logs go to `$XDG_DATA_HOME/opencode`, locks to
    // `$XDG_STATE_HOME/opencode`, downloaded helper binaries to
    // `$XDG_CACHE_HOME/opencode`. The container sets none of those, so all three
    // fall back to `$HOME` — pinned to `/home/dev`, which a project's own
    // devcontainer image generally does not have. Measured: the child then dies at
    // spawn with `EACCES … mkdir '/home/dev'` before answering `initialize`, so it
    // is every OpenCode turn on those images, not a degraded one. Pinned rather
    // than copied, because there is nothing in the container to copy.
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      { agentUid: 1000, agentGid: 1000, env: { XDG_CONFIG_HOME: '/run/verity/xdg' } },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      XDG_DATA_HOME: '/run/verity/opencode/data',
      XDG_STATE_HOME: '/run/verity/opencode/state',
      XDG_CACHE_HOME: '/run/verity/opencode/cache',
    });
    // Handed to the agent by the same pass that prepares Claude's and Codex's
    // directories. The owner of `/run/verity` differs by image — root on some, the
    // agent (uid 1000) on a project sandbox whose ownership pass shipped it to the
    // remote user. Because this supervisor holds CAP_CHOWN but not CAP_DAC_OVERRIDE,
    // root cannot create the directory when the agent owns the parent, so the launcher
    // must create it as whoever owns `/run/verity`. A blind root `mkdir` there died
    // with EACCES and took the whole Runner supervisor down on those images.
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    expect(launcher).toContain('OPENCODE_STATE_DIR=/run/verity/opencode');
    // Create as the agent when it owns /run/verity, else as root — never a blind
    // root mkdir that assumes CAP_DAC_OVERRIDE.
    expect(launcher).toMatch(/stat -c '%u' \/run\/verity/);
    expect(launcher).toMatch(/as_agent mkdir -p "\$OPENCODE_STATE_DIR"/);
    expect(launcher).toMatch(/chown "\$AGENT_UID:\$AGENT_GID" "\$OPENCODE_STATE_DIR"/);
    // Deliberately NOT under the runner runtime: that directory outlives the
    // container, and `session-artifacts.ts` names no OpenCode files to delete on
    // the basis that this storage does not.
    expect(launcher).not.toContain('$RUNTIME_DIR/opencode');
  });

  it('keeps every XDG root to the one command that reads them', () => {
    // A shared config root reaching every agent would widen what a compromised one
    // can read, and only opencode-acp has a config there in the first place. The
    // state roots are pinned for it alone for the same reason — Claude and Codex
    // have their own directory variables and no business in OpenCode's.
    for (const command of ['claude-agent-acp', 'codex-acp'] as const) {
      const spec = agentLaunchSpec(
        { command, args: [], cwd: '/work/project' },
        {
          agentUid: 1000,
          agentGid: 1000,
          connectorUrl: 'http://127.0.0.1:47821',
          env: { XDG_CONFIG_HOME: '/run/verity/xdg' },
        },
      );
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CONFIG_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_DATA_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_STATE_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CACHE_HOME');
    }
  });

  it('starts the broker with the container environment it forwards XDG_CONFIG_HOME from', async () => {
    // The two tests above inject `env` directly, which proves the forward but not
    // that production has anything to forward. That chain is: the provisioner puts
    // `XDG_CONFIG_HOME` in the container `Env` (provisioner.ts, neutral path mode),
    // and the stack launcher starts the broker as an ordinary child so it inherits
    // it. The egress connector next to it is deliberately started under an `env -i`
    // allowlist; the broker under the same treatment would silently drop the
    // variable and leave every OpenCode turn without a provider. Assert the
    // difference rather than trusting a comment to survive the next edit.
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    const brokerStart = launcher
      .split('\n')
      .find((line) => line.includes('nohup') && line.includes('verity-agent-spawn-broker'));
    expect(brokerStart).toBeDefined();
    expect(brokerStart).not.toContain('env -i');
  });

  // Without file injection a tool that wants its secret as a file — example-cli's
  // EXAMPLE_CONFIG, `example-cli up --secret=file:…` — is unreachable: there is no
  // shell, and a script in the worktree is refused because the executable must be
  // root-owned. Agents then build a wrapper, which is exactly what that rule
  // exists to stop. Verity writing the file removes the reason to try.
  it('hands a file-injected secret to the command as a path, never as the value', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/example-cli',
        args: ['get', 'items'],
        cwd: '/work/project',
        secrets: [{ name: 'EXAMPLE_CONFIG', value: 'apiVersion: v1', injection: 'file' }],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.EXAMPLE_CONFIG).toBe('/run/verity-runner/secrets/EXAMPLE_CONFIG');
    expect(JSON.stringify(spec)).not.toContain('apiVersion');
  });

  it('still passes an env-injected secret by value', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/fastlane',
        args: [],
        cwd: '/work/project',
        secrets: [{ name: 'ASC_KEY', value: 'value-marker', injection: 'env' }],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.ASC_KEY).toBe('value-marker');
  });

  // The executable rule used to cover argv[0] alone, so
  // `/usr/bin/timeout … /work/…/script.sh` slipped through: timeout is
  // root-owned while the payload is a script the agent can rewrite between one
  // approved run and the next.
  it('refuses an agent-owned executable hidden in the arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-argv-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-owned symlink even when it currently targets root-owned code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-argv-symlink-'));
    const link = join(root, 'payload');
    await symlink('/bin/sh', link);
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', link], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // The approval card already warns that a trusted process may disclose its
  // secret, so inline code the operator read before approving stays legitimate.
  // What must not pass is a path: it shows a name, never the bytes behind it.
  it('allows inline code the operator could read in the prompt', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', ['-c', 'echo hi'], '/'),
    ).resolves.toBeUndefined();
  });

  it('refuses a mutable script handed to an interpreter, execute bit or not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/bin/sh', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('allows a worktree entry script only under its approved content hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-hashed-interp-'));
    const script = join(root, 'payload.sh');
    const contents = 'echo hi\n';
    await writeFile(script, contents, { mode: 0o644 });
    const approved = {
      path: script,
      projectPath: 'payload.sh',
      sha256: createHash('sha256').update(contents).digest('hex'),
      loading: 'isolated' as const,
    };
    await expect(
      validateTrustedCliArguments('/bin/sh', [script], root, undefined, [], approved),
    ).resolves.toBeUndefined();
    await writeFile(script, 'echo changed\n', { mode: 0o644 });
    // The outer broker performs this comparison immediately before validation;
    // focused validator calls still prove the mutable-file exception is scoped
    // to the one attested path rather than every interpreter operand.
    await expect(
      validateTrustedCliArguments(
        '/bin/sh',
        [join(root, 'other.sh')],
        root,
        undefined,
        [],
        approved,
      ),
    ).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('executes an immutable broker snapshot rather than reopening mutable worktree bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-snapshot-'));
    const script = join(root, 'payload.sh');
    const contents = 'echo approved\n';
    await writeFile(script, contents, { mode: 0o644 });
    const materialized = await materializeTrustedCliEntryScript(
      {
        args: [script, '--apply'],
        cwd: root,
        entryScript: {
          path: script,
          projectPath: 'payload.sh',
          sha256: createHash('sha256').update(contents).digest('hex'),
          loading: 'isolated',
          worktreeRoot: root,
        },
      },
      { trustedCliEntryScriptDir: join(root, 'snapshots') },
    );
    await writeFile(script, 'echo attacker replacement\n', { mode: 0o644 });
    expect(materialized.args[0]).not.toBe(script);
    expect(materialized.entrySandbox).toMatchObject({ loading: 'isolated' });
    await expect(readFile(materialized.args[0]!, 'utf8')).resolves.toBe(contents);
    await expect(materialized.cleanup()).resolves.toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('preserves nested parent-relative resources for one-time dynamic scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-dynamic-tree-'));
    const scripts = join(root, 'commands', 'nested');
    await mkdir(scripts, { recursive: true });
    await mkdir(join(root, 'lib'));
    const script = join(scripts, 'deploy.js');
    const contents = 'require("../../lib/config.js")\n';
    await writeFile(script, contents);
    await writeFile(join(root, 'lib', 'config.js'), 'module.exports = true\n');
    const materialized = await materializeTrustedCliEntryScript(
      {
        args: [script],
        cwd: root,
        entryScript: {
          path: script,
          projectPath: 'commands/nested/deploy.js',
          sha256: createHash('sha256').update(contents).digest('hex'),
          loading: 'dynamic',
          worktreeRoot: root,
        },
      },
      { trustedCliEntryScriptDir: join(root, 'snapshots') },
    );
    const parentResource = resolve(materialized.args[0]!, '..', '..', '..', 'lib', 'config.js');
    await expect(readFile(parentResource, 'utf8')).resolves.toBe('module.exports = true\n');
    await expect(materialized.cleanup()).resolves.toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('denies mutable worktree reads for reusable scripts but permits one-time dynamic loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-script-landlock-'));
    const helper = join(root, 'verity-script-sandbox');
    const snapshotRoot = join(root, 'snapshot');
    const worktree = join(root, 'worktree');
    await mkdir(snapshotRoot);
    await mkdir(worktree);
    await writeFile(join(worktree, 'dependency'), 'mutable\n');
    const allowedSecret = join(root, 'secret-allowed');
    const otherSecret = join(root, 'secret-other');
    await writeFile(allowedSecret, 'allowed\n');
    await writeFile(otherSecret, 'other\n');
    const sharedMemoryDependency = `/dev/shm/verity-landlock-${String(process.pid)}`;
    await writeFile(sharedMemoryDependency, 'mutable\n');
    await execFileAsync('cc', [
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      resolve('features/verity-sandbox-toolkit/bin/verity-script-sandbox.c'),
      '-o',
      helper,
    ]);
    await expect(execFileAsync(helper, ['--probe'])).resolves.toBeDefined();
    const command = ['--root', snapshotRoot, '--cwd', snapshotRoot, '--loading'];
    await expect(
      execFileAsync(helper, [
        ...command,
        'isolated',
        '--',
        '/usr/bin/cat',
        join(worktree, 'dependency'),
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(helper, [
        ...command,
        'isolated',
        '--secret',
        allowedSecret,
        '--',
        '/usr/bin/cat',
        allowedSecret,
      ]),
    ).resolves.toMatchObject({ stdout: 'allowed\n' });
    await expect(
      execFileAsync(helper, [
        ...command,
        'isolated',
        '--secret',
        allowedSecret,
        '--',
        '/usr/bin/cat',
        otherSecret,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(helper, [
        ...command,
        'isolated',
        '--',
        '/usr/bin/cat',
        `/proc/self/root${join(worktree, 'dependency')}`,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(helper, [...command, 'isolated', '--', '/usr/bin/cat', sharedMemoryDependency]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(helper, [
        ...command,
        'dynamic',
        '--',
        '/usr/bin/cat',
        join(worktree, 'dependency'),
      ]),
    ).resolves.toBeDefined();
    await rm(sharedMemoryDependency, { force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('follows wrappers to a non-executable script handed to an interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-wrapped-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', '/usr/bin/env', 'sh', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('activates an absolute interpreter nested behind a wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-absolute-interp-'));
    const script = join(root, 'payload.sh');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/timeout', ['240s', '/bin/sh', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a relative script handed directly to an interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-relative-interp-'));
    await writeFile(join(root, 'payload.sh'), 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/bin/sh', ['./payload.sh'], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('recognizes an interpreter through an executable alias', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-interpreter-alias-'));
    const alias = join(root, 'rbash');
    const script = join(root, 'payload.sh');
    await symlink('/bin/bash', alias);
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments(alias, ['payload.sh'], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('fails closed when an interpreter script operand does not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-missing-interp-'));
    await expect(validateTrustedCliArguments('/bin/sh', ['./payload.sh'], root)).rejects.toThrow(
      /operand does not exist/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('follows wrappers to a relative interpreter script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-relative-wrapper-'));
    await writeFile(join(root, 'payload.sh'), 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/timeout',
        ['240s', '/usr/bin/env', 'sh', 'payload.sh'],
        root,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-owned executable resolved through an env PATH assignment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-env-path-'));
    const payload = join(root, 'payload');
    await writeFile(payload, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        [`PATH=${root}`, 'payload'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an agent-writable inherited PATH used by an unrecognized dispatcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-dispatcher-path-'));
    const payload = join(root, 'payload');
    await writeFile(payload, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments('/usr/bin/xargs', ['payload'], '/', root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a bare nested interpreter through the effective PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-bare-interpreter-'));
    const python = join(root, 'python3');
    await writeFile(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        [`PATH=${root}`, 'python3', 'script.py'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects env split-string because it hides executed argv in one token', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/env', ['-S', 'sh /work/payload.sh'], '/work'),
    ).rejects.toThrow(/env option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/timeout',
        ['240s', '/usr/bin/env', '--split-string', 'sh /work/payload.sh'],
        '/work',
      ),
    ).rejects.toThrow(/env option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['--chdir=/work/subdir', 'sh', 'payload.sh'],
        '/work',
      ),
    ).rejects.toThrow(/env option execution is not immutable/u);
  });

  it('stops parsing env before ordinary command options begin', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['EXAMPLE_CONFIG=/etc/passwd', '/usr/bin/printf', '--namespace', 'default'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  it('validates an existing cwd-relative operand even when it is a bare value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-bare-data-'));
    await writeFile(join(root, 'items'), 'mutable ordinary value collision\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments('/usr/local/bin/example-cli', ['get', 'items'], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // Inline code may hand the materialized secret on — the operator read that
  // code before approving it — but it relabels nothing else: every other
  // mutable file stays refused, whatever the inline code would do with it.
  // The bound is the path, which is why both spellings now decide alike; the
  // spelling never bound anything, since `"${1#file:}"` undoes it in the code.
  it('does not let inline interpreter code relabel a mutable file as data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-inline-data-'));
    const secret = join(root, 'EXAMPLE_CONFIG');
    const other = join(root, 'OTHER');
    await writeFile(secret, 'apiVersion: v1\n', { mode: 0o600 });
    await writeFile(other, 'apiVersion: v1\n', { mode: 0o600 });
    for (const operand of [secret, `file:${secret}`]) {
      await expect(
        validateTrustedCliArguments(
          '/bin/sh',
          ['-c', 'example-cli --config "${1#file:}"', 'sh', operand],
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [secret],
        ),
      ).resolves.toBeUndefined();
    }
    for (const operand of [other, `file:${other}`]) {
      await expect(
        validateTrustedCliArguments(
          '/bin/sh',
          ['-c', 'example-cli --config "${1#file:}"', 'sh', operand],
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [secret],
        ),
      ).rejects.toThrow(/root-owned and immutable/u);
    }
    await rm(root, { recursive: true, force: true });
  });

  it('rejects interpreter module lookup because it cannot bind the module bytes', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/python3', ['-m', 'mutable_module'], '/work'),
    ).rejects.toThrow(/module execution is not immutable/u);
    await expect(
      validateTrustedCliArguments('/usr/bin/python3', ['-mmutable_module'], '/work'),
    ).rejects.toThrow(/module execution is not immutable/u);
  });

  it('allows combined shell inline flags as visible one-time code', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', ['-ec', 'echo hi'], '/work'),
    ).resolves.toBeUndefined();
  });

  it('rejects interpreter preload options that name mutable code', async () => {
    await expect(
      validateTrustedCliArguments('/usr/bin/node', ['--require=./mutable.js'], '/work'),
    ).rejects.toThrow(/interpreter option execution is not immutable/u);
    await expect(
      validateTrustedCliArguments('/usr/bin/ruby', ['-r./mutable.rb'], '/work'),
    ).rejects.toThrow(/interpreter option execution is not immutable/u);
  });

  it('recognizes versioned, awk, and busybox interpreters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-loader-families-'));
    const script = join(root, 'payload');
    await writeFile(script, 'echo hi\n', { mode: 0o644 });
    await expect(
      validateTrustedCliArguments('/usr/bin/python3.12', [script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await expect(validateTrustedCliArguments('/usr/bin/ruby3.3', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await expect(validateTrustedCliArguments('/usr/bin/awk', ['-f', script], root)).rejects.toThrow(
      /interpreter option execution is not immutable/u,
    );
    await expect(
      validateTrustedCliArguments('/usr/bin/busybox', ['ash', script], root),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('validates mutable file arguments without knowing the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-unknown-loader-'));
    const script = join(root, 'payload.lua');
    await writeFile(script, 'print("hi")\n', { mode: 0o644 });
    await expect(validateTrustedCliArguments('/usr/bin/lua', [script], root)).rejects.toThrow(
      /root-owned and immutable/u,
    );
    await expect(
      validateTrustedCliArguments('/usr/bin/env', [`LD_PRELOAD=${script}`, '/usr/bin/curl'], root),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects code-loading env and unresolved path assignments', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['NODE_OPTIONS=--require=./mutable.js', 'node'],
        '/work',
      ),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['LD_LIBRARY_PATH=/work/lib:/usr/lib', '/usr/bin/curl'],
        '/work',
      ),
    ).rejects.toThrow(/code-loading environment is not immutable/u);
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/env',
        ['EXAMPLE_CONFIG=/run/config', '/usr/local/bin/example-cli', 'get', 'items'],
        '/work',
      ),
    ).rejects.toThrow(/file operand does not exist/u);
  });

  it('rejects a missing path that could be created after validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-missing-file-'));
    await expect(
      validateTrustedCliArguments('/usr/bin/xargs', ['./payload'], root),
    ).rejects.toThrow(/file operand does not exist/u);
    await rm(root, { recursive: true, force: true });
  });

  it('does not confuse URLs or slash-bearing resource identifiers with file operands', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/printf',
        ['https://api.example.com/v1', 'items/name'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  // Verity created this exact path from the server-side provider value for this
  // launch, so it is the one mutable file whose provenance is trustworthy.
  it('allows the exact Verity-materialized secret file in an explicit file operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-data-'));
    const data = join(root, 'EXAMPLE_CONFIG');
    await writeFile(data, 'apiVersion: v1\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', `--secret=file:${data}`],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [data],
      ),
    ).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  // What a flag calls its file operand is the tool's choice, not the agent's:
  // `--secret=file:<path>` and `--secret-file <path>` reach the same entry.
  // Deciding on the spelling locked file injection to tools offering the first.
  it('allows the materialized secret however the flag spells its path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-plain-'));
    const data = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await writeFile(data, 'tskey-auth-example\n', { mode: 0o600 });
    for (const args of [
      ['up', '--secret-file', data],
      ['up', `--secret-file=${data}`],
      ['get', 'items', `--config=${data}`],
    ]) {
      await expect(
        validateTrustedCliArguments(
          '/usr/local/bin/example-cli',
          args,
          root,
          IMMUTABLE_EXECUTABLE_PATH,
          [data],
        ),
      ).resolves.toBeUndefined();
    }
    await rm(root, { recursive: true, force: true });
  });

  // The secret is written after validation, so the path it will occupy is
  // absent exactly when it is checked. Nothing else absent becomes admissible.
  it('allows the secret path before it is written, and nothing else absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-pending-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret-file', pending],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret-file', join(root, 'OTHER')],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      ),
    ).rejects.toThrow(/file operand does not exist/u);
    await rm(root, { recursive: true, force: true });
  });

  // Naming the path is the whole point; executing what lands there is not.
  it('refuses the materialized secret as an interpreter script operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-secret-script-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    await expect(
      validateTrustedCliArguments('/usr/bin/sh', [pending], root, '/usr/bin:/bin', [pending]),
    ).rejects.toThrow(/interpreter operand does not exist/u);
    await writeFile(pending, 'echo hi\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments('/usr/bin/sh', [pending], root, '/usr/bin:/bin', [pending]),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  // The refusal has to carry what the next attempt needs, or the agent retries
  // the same argv: the token that failed, and the path that would have passed.
  it('names the failing operand and the admissible secret path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-message-'));
    const pending = join(root, 'EXAMPLE_NETWORK_AUTH_FILE');
    // No shell expands argv here, so `$VAR` reaches the broker literally.
    const unexpanded = () =>
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['up', '--secret=file:$EXAMPLE_NETWORK_AUTH_FILE'],
        root,
        IMMUTABLE_EXECUTABLE_PATH,
        [pending],
      );
    await expect(unexpanded()).rejects.toThrow(/file:\$EXAMPLE_NETWORK_AUTH_FILE/u);
    await expect(unexpanded()).rejects.toThrow(pending);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects ordinary mutable data because configuration can activate code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-mutable-config-'));
    const config = join(root, 'EXAMPLE_CONFIG');
    await writeFile(config, 'users: [{ exec: { command: ./payload } }]\n', { mode: 0o600 });
    await expect(
      validateTrustedCliArguments(
        '/usr/local/bin/example-cli',
        ['--config', config, 'get', 'items'],
        root,
      ),
    ).rejects.toThrow(/root-owned and immutable/u);
    await rm(root, { recursive: true, force: true });
  });

  it('allows root-owned immutable non-executable data', async () => {
    await expect(
      validateTrustedCliArguments(
        '/usr/bin/curl',
        ['--cacert', '/etc/ssl/certs/ca-certificates.crt'],
        '/work',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a special-file interpreter operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-special-file-'));
    const fifo = join(root, 'payload');
    await new Promise<void>((resolvePromise, reject) => {
      execFile('/usr/bin/mkfifo', [fifo], (error) =>
        error ? reject(new Error(error.message, { cause: error })) : resolvePromise(),
      );
    });
    await expect(validateTrustedCliArguments('/bin/sh', [fifo], root)).rejects.toThrow(
      /regular file/u,
    );
    await rm(root, { recursive: true, force: true });
  });

  // A socket is not content. What sits behind the name is a live peer, decided
  // when the node was bound — and only root can bind one in a directory the rule
  // already requires to be root-owned and unwritable. Refusing it for its node
  // type put every CLI whose flag names a daemon endpoint out of reach, starting
  // with `example-cli --socket=…`, which is where this was found.
  //
  // So it answers to ownership like any other operand, and an agent-owned socket
  // is still refused — what moved is the reason, and that is the whole of the
  // change. Asserting the reason is the only way to see it here: the accepting
  // half needs a root-owned socket, which no unprivileged test process can
  // create. `scripts/probes/trusted-cli-socket-operand.mjs` measures that half.
  it('judges a socket operand by ownership rather than by its node type', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verity-trusted-socket-'));
    const socketPath = join(root, 'example-daemon.sock');
    const daemon = createServer();
    await new Promise<void>((listening) => daemon.listen(socketPath, listening));
    try {
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/example-cli',
          [`--socket=${socketPath}`, 'status'],
          root,
        ),
      ).rejects.toThrow(/root-owned and immutable/u);
      // Except in the one position where a script belongs: an interpreter reads
      // its operand for bytes, so a special file there stays refused outright,
      // exactly as the FIFO above is.
      await expect(validateTrustedCliArguments('/bin/sh', [socketPath], root)).rejects.toThrow(
        /regular file/u,
      );
    } finally {
      daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('launches trusted CLI commands as the agent with a minimal secret-bearing environment', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/fastlane',
        args: ['deliver'],
        cwd: '/work/project',
        secrets: [{ name: 'ASC_PRIVATE_KEY', value: 'private-key-marker' }],
      },
      {
        agentUid: 1000,
        agentGid: 1000,
        env: {
          PATH: '/usr/bin',
          DOPPLER_TOKEN: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('--reuid=1000');
    expect(spec.args).toContain('/usr/local/bin/fastlane');
    expect(spec.spawnOptions.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      LANG: 'C.UTF-8',
      ASC_PRIVATE_KEY: 'private-key-marker',
    });
    expect(spec.spawnOptions.detached).toBe(true);
    for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG']) {
      expect(() =>
        trustedCliLaunchSpec(
          {
            kind: 'trusted-cli',
            command: '/usr/local/bin/fastlane',
            args: ['deliver'],
            cwd: '/work/project',
            secrets: [{ name, value: 'attacker-value' }],
          },
          { agentUid: 1000, agentGid: 1000 },
        ),
      ).toThrow(/unsafe trusted CLI environment variable/u);
    }
  });

  it('kills surviving trusted CLI descendants after the direct child exits', () => {
    const kill = vi.fn();
    killExitedTrustedCliProcessGroup({ pid: 4321 }, kill);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('signals agent descendants that left the process group, then escalates them', () => {
    // The tool trees an agent starts through `setsid` are outside its process group, so
    // `kill(-pid)` alone never reaches them — and they are exactly the ones holding the
    // sandbox's memory. Synthetic /proc: agent 100 → shell 200 → vitest 300.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      // Both escaped descendants, and the group itself.
      expect(kill.mock.calls).toEqual([
        [300, 'SIGTERM'],
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
      kill.mockClear();
      // The agent keeps its caller's grace; only the escaped subtree is escalated.
      vi.advanceTimersByTime(2_000);
      expect(kill.mock.calls).toEqual([
        [300, 'SIGKILL'],
        [200, 'SIGKILL'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to signal a process group recycled while its descendants are walked', () => {
    let rootReads = 0;
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat') {
        rootReads += 1;
        const startTime = rootReads === 1 ? '100' : '999';
        return `100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
      }
      if (path === '/proc/100/task/100/children') return '';
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };

    stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });

    expect(kill).not.toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retains the process-group fallback when root identity is unreadable from the outset', () => {
    const readProc = (path: string): string => {
      if (path === '/proc/100/task/100/children') return '';
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };

    stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });

    expect(kill).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('refuses to signal a pid the kernel recycled between the walk and the escalation', () => {
    // `starttime` (field 22) is the fence: a descendant that exits and whose pid is
    // reused must not be signalled on the strength of the earlier walk.
    let startTime = '111';
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat')
        return '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0';
      if (path === '/proc/100/task/100/children') return '200\n';
      if (path === '/proc/200/task/200/children') return '';
      if (path === '/proc/200/stat')
        return `200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
      throw new Error(`ENOENT: ${path}`);
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill).toHaveBeenCalledWith(200, 'SIGTERM');
      kill.mockClear();
      startTime = '999'; // pid 200 is now somebody else.
      vi.advanceTimersByTime(2_000);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves descendants inside the agent group to the group signal', () => {
    // Parity with `collectEscapedProcessTree` in @verity/session: a helper that stayed in
    // the agent's group (pgrp 100) is already reached by `kill(-100)` and is entitled to
    // the agent's own grace, not to the short one an escaped tree is escalated on.
    // Agent 100 → in-group helper 150, and separately the `setsid` shell 200.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
      kill.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(kill.mock.calls).toEqual([[200, 'SIGKILL']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('descends through an in-group child to reach an escaped grandchild', () => {
    // Dropping the in-group helper from the RESULT must not stop the walk at it: the
    // escape usually sits one level below something that never left the group.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150\n',
      '/proc/150/task/150/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/300/stat': '300 (node (v24)) R 150 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [300, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the escalation it had to perform, and stays quiet when it did not', () => {
    // The count `signalProcessTree` returns is the only observability this design has;
    // it is worth nothing if the line never reaches the broker's log.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('SIGKILLed 1 agent tool process(es) that outlived SIGTERM'),
        expect.any(Function),
      );
      stderr.mockClear();
      // A tree that went down on SIGTERM leaves nothing to escalate, and nothing to say.
      delete proc['/proc/200/stat'];
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      vi.advanceTimersByTime(2_000);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
    }
  });

  it('says so when the kernel has no /proc children API to walk', () => {
    // Without CONFIG_CHECKPOINT_RESTORE the walk finds nothing and every teardown looks
    // like a sandbox that had no escaped tool trees — the one failure this whole
    // mechanism cannot otherwise distinguish from success.
    const readProc = (path: string): string => {
      if (path === '/proc/100/stat')
        return '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0';
      throw new Error(`ENOENT: ${path}`);
    };
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // The tell is latched to once per process, so it is order-dependent across a file
    // that tears many synthetic trees down. Start from a known state instead of from
    // whichever test ran first.
    resetProcessTreeWarnings();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('no /proc/<pid>/task/<pid>/children on this kernel'),
        expect.any(Function),
      );
      // ...and only once: a broker on such a kernel tears a tree down every turn.
      stderr.mockClear();
      stopAgentProcessGroup(child, 'SIGTERM', { kill: vi.fn(), readProc });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      resetProcessTreeWarnings();
    }
  });

  it('schedules no escalation when the teardown signal is already SIGKILL', () => {
    // Nothing survives SIGKILL, so a follow-up timer would be a pure leak — and one
    // holding a captured tree of pids the kernel is free to recycle.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGKILL', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGKILL'],
        [-100, 'SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(kill.mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a descendant whose stat line carries no start time', () => {
    // Parity with @verity/session: an empty capture would compare equal to the equally
    // empty read at signal time, so the pid-reuse fence would pass for precisely the
    // process whose identity could not be established.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '200\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      expect(kill.mock.calls).toEqual([
        [200, 'SIGTERM'],
        [-100, 'SIGTERM'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks /proc exactly like @verity/session does, on the same fixture', () => {
    // The broker cannot import the workspace, so the /proc walk exists twice on purpose.
    // This is the tripwire against the two copies drifting: not the constant alone, but
    // the BEHAVIOUR — which pids each considers escaped, in which order. The fixture is
    // BEHAVIOUR as the broker actually applies it — the walk's result reaching `kill`,
    // in order, with the group signal around it. The walks themselves are compared
    // fixture by fixture in the test below.
    const proc: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '400\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/400/task/400/children': '',
      '/proc/100/stat': '100 (agent) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
      '/proc/400/stat': '400 (tsc --build) R 150 400 400 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 333 0 0',
    };
    const readProc = (path: string): string => {
      const content = proc[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };
    const kill = vi.fn();
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn() };
    vi.useFakeTimers();
    try {
      stopAgentProcessGroup(child, 'SIGTERM', { kill, readProc });
      // Drop the group signal the broker adds around the walk's own result.
      const brokerOrder = kill.mock.calls
        .map((call) => call[0] as number)
        .filter((pid) => pid !== -100);
      expect(brokerOrder).toEqual([...collectEscapedProcessTree(100, { readProc }).keys()]);
      expect(brokerOrder).toEqual([400, 300, 200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agrees with @verity/session on every edge the two walks could drift on', () => {
    // The walk itself, compared directly rather than through what the broker signalled:
    // pids AND the start times each recorded, over one fixture per axis on which a
    // hand-synced copy realistically diverges. Each fixture also pins the answer, so a
    // change made identically in both copies still has to be argued for rather than
    // just agreed with itself.
    const base: Record<string, string> = {
      '/proc/100/task/100/children': '150 200\n',
      '/proc/150/task/150/children': '400\n',
      '/proc/200/task/200/children': '300\n',
      '/proc/300/task/300/children': '',
      '/proc/400/task/400/children': '',
      '/proc/100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
      '/proc/150/stat': '150 (mcp-server) S 100 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
      '/proc/200/stat': '200 (bash) S 100 200 200 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0',
      '/proc/300/stat': '300 (node (v24)) R 200 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 222 0 0',
      '/proc/400/stat': '400 (tsc --build) R 150 400 400 0 -1 0 0 0 0 0 0 0 0 0 20 0 9 0 333 0 0',
    };
    const withoutRootStat = { ...base };
    delete withoutRootStat['/proc/100/stat'];
    const fixtures: Array<{
      name: string;
      proc: Record<string, string>;
      expected: [number, string][];
    }> = [
      {
        // A `comm` with a space and parentheses (the `lastIndexOf(')')` parse), an
        // in-group helper skipped but descended through, a grandchild recorded before
        // its parent (post-order).
        name: 'the full tree',
        expected: [
          [400, '333'],
          [300, '222'],
          [200, '111'],
        ],
        proc: base,
      },
      {
        // Without the root's identity, neither copy may trust that its children files
        // still belong to the process whose teardown authorized the walk.
        name: 'no root stat',
        expected: [],
        proc: withoutRootStat,
      },
      {
        // A root that never led its group. `kill(-100)` then reaches nothing at all, so
        // 150 — which merely inherited group 42 — is escaped like the rest and has to be
        // signalled here rather than left to a group signal that will miss it.
        name: 'a root whose group is not its own pid',
        expected: [
          [400, '333'],
          [150, '150'],
          [300, '222'],
          [200, '111'],
        ],
        proc: {
          ...base,
          '/proc/100/stat': '100 (claude) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 100 0 0',
          '/proc/150/stat': '150 (mcp-server) S 100 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 150 0 0',
        },
      },
      {
        // Neither a short line nor an empty one may yield a fenceable descendant.
        name: 'a truncated stat line (no start time, no comm terminator)',
        expected: [[200, '111']],
        proc: { ...base, '/proc/300/stat': '300 (node (v24)) R 200 300 300', '/proc/400/stat': '' },
      },
      {
        name: 'a root with no children file at all',
        expected: [],
        proc: { '/proc/100/stat': base['/proc/100/stat'] as string },
      },
      { name: 'no /proc at all', expected: [], proc: {} },
    ];
    for (const fixture of fixtures) {
      const readProc = (path: string): string => {
        const content = fixture.proc[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      };
      const broker = [...brokerCollectEscapedProcessTree(100, readProc)];
      expect(broker, `broker vs @verity/session on ${fixture.name}`).toEqual([
        ...collectEscapedProcessTree(100, { readProc }),
      ]);
      expect(broker, `escaped set on ${fixture.name}`).toEqual(fixture.expected);
    }
  });

  it('escalates the escaped subtree on the same grace as @verity/session', () => {
    // The other half of the same tripwire: how long an escaped tree gets before SIGKILL.
    expect(BROKER_PROCESS_TREE_KILL_GRACE_MS).toBe(PROCESS_TREE_KILL_GRACE_MS);
  });

  it('allows only immutable root-owned trusted CLI executables', async () => {
    await expect(validateTrustedCliExecutable('/usr/bin/env')).resolves.toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), 'verity-trusted-cli-'));
    const executable = join(directory, 'tool');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(validateTrustedCliExecutable(executable)).rejects.toThrow(
      /root-owned and immutable/u,
    );
  });

  it('installs the trusted CLIs it ships root-owned, as its own broker demands', async () => {
    // Release tarballs carry their publisher's CI ownership (gh and doppler both record
    // uid/gid 1001), and tar restores it when the Feature runs as root. Shipped that
    // way, every `verity_secret_run` against those binaries is refused by the validator
    // above — the toolkit would hand the broker executables the broker exists to reject.
    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    const extractions = installer
      .split('\n')
      .filter((line) => /\btar\b/u.test(line) && line.includes('-xz'));
    expect(extractions.length).toBeGreaterThan(0);
    for (const extraction of extractions) expect(extraction).toContain('--no-same-owner');
    expect(installer).toMatch(/install_trusted_cli_ownership\(\)\s*\{\s*\n\s*chown root:root/u);
    expect(installer).toContain('install_trusted_cli_ownership /usr/local/bin/doppler');
    expect(installer).toContain('install_trusted_cli_ownership /usr/local/lib/verity/gh-real');
  });

  it('writes the opencode-acp wrapper root-owned and keeps it out of the dev chown', async () => {
    // The wrapper is what turns one fixed command name into one fixed executable
    // for OpenCode (ADR 0012 Amendment 4, security invariant 1) — the broker execs
    // `/usr/local/bin/opencode-acp` and passes no shell, so the `acp` subcommand
    // has to be baked in on this side. Three properties carry that, and each is one
    // careless edit from silently regressing: the wrapper's own content, its root
    // ownership, and its deliberate absence from `WRITTEN_PATHS`, whose only
    // protection today is a comment — that array drives the F11 chown to the dev
    // user, and handing the file to the identity the agent runs as would let an
    // agent turn choose which binary the next one starts.
    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(installer).toContain(
      `printf '#!/bin/sh\\nexec %s acp "$@"\\n' "$OPENCODE_BIN" > "$OPENCODE_ACP_TMP"`,
    );
    expect(installer).toContain(
      'install -o root -g root -m 0755 "$OPENCODE_ACP_TMP" /usr/local/bin/opencode-acp',
    );
    const written = installer
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => line.includes('WRITTEN_PATHS+='));
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) expect(line).not.toContain('opencode-acp');
    // Fail the build, not the first turn: nothing has a fallback for a missing
    // executable, so an image that requested opencode and cannot find it must stop
    // here rather than ship looking complete and ENOENT at spawn.
    const wrapperBlock = installer.slice(
      installer.indexOf('if [ "$INSTALL_OPENCODE" = \'true\' ]; then'),
      installer.indexOf('install -d /usr/local/share/verity-sandbox-toolkit/lifecycle'),
    );
    expect(wrapperBlock).toContain('cannot build opencode-acp');
    expect(wrapperBlock).toContain('exit 1');
  });

  it('installs no bubblewrap, in the Feature or in the image that bakes it', async () => {
    // The package is absent on purpose, and the reason is the opposite of the
    // obvious one: Codex logs "Codex could not find bubblewrap on PATH." at ERROR
    // level on every start, which reads like an unmet prerequisite and is not one
    // — Verity always bypasses Codex's own sandbox. Installing bwrap to silence
    // that line switches ON Claude's inner sandbox, which is redundant with this
    // container and loses its injected /etc/resolv.conf, taking DNS with it
    // (packages/session/src/codex-backend.ts). The rationale is a comment block
    // in install.sh; this is what makes it survive a hurried package addition.
    //
    // Both files are checked because either can install it and only one carries
    // the rationale. The Dockerfile installs no packages today, so it contributes
    // no lines — the point is that the moment it does, they are covered.
    const [installer, dockerfile] = await Promise.all([
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
      readFile('deploy/verity-sandbox.Dockerfile', 'utf8'),
    ]);
    const uncommented = (source: string): string[] =>
      source.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    // Scoped to the lines that actually name packages rather than to the file
    // text: the rationale above the list says "bubblewrap" several times, and a
    // future `command -v bwrap` guard would be legitimate. Neither should decide
    // this test.
    const packageLines = [
      ...uncommented(installer).filter((line) => /APT_PACKAGES=\(|apt(-get)? install/u.test(line)),
      ...uncommented(dockerfile).filter((line) => /apt(-get)? install|apk add/u.test(line)),
    ];
    for (const line of packageLines) expect(line).not.toMatch(/\bbubblewrap\b|\bbwrap\b/u);
    // Guards the guard: the extraction must still find the list it is filtering,
    // or every assertion above passes by reading nothing at all.
    expect(packageLines.filter((line) => line.includes('APT_PACKAGES=('))).toHaveLength(1);
  });

  it('stages every release download before it unpacks it', async () => {
    // `curl … | tar -xz` cannot be retried. A transfer that dies mid-body has
    // already fed the decompressor the truncated prefix, so curl restarting from
    // byte zero puts a second copy behind it and the pipeline dies on
    // "unexpected end of file" with attempts to spare — one dropped connection
    // to a release CDN failing the whole image build. Observed in CI, and
    // invisible in review because the retry flags are right there in the line.
    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(installer).not.toMatch(/\|\s*tar\b/u);
    const extractions = installer
      .split('\n')
      .filter((line) => /\btar\b/u.test(line) && line.includes('-xz'));
    expect(extractions.length).toBeGreaterThan(0);
    // Every unpack reads a file that was downloaded in full first.
    for (const extraction of extractions) expect(extraction).toContain('-xzf "$DOWNLOAD_DIR/');
    expect(installer).toContain('--retry-all-errors');
  });

  it('forwards CLAUDE_CONFIG_DIR through the broker so the transcript lands on the mount', () => {
    // Stage-5b Slice 2b: the container sets CLAUDE_CONFIG_DIR to the shared
    // runner-runtime mount; the broker must thread its own env through the
    // allowlist so Claude honours it and writes its session .jsonl where the
    // server-side tail persists it. The CLI entry supplies `env: process.env`.
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
        },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
    });
  });

  it('does not project Claude credentials for an invalid connector URL', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'https://attacker.example',
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
        },
      },
    );
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('validates readable, canonical Runner-owned connector TLS material', async () => {
    const env = await connectorValidationEnv();
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], { env }),
    ).resolves.toBeDefined();
  });

  it('rejects root identities and world-readable connector private keys', async () => {
    const env = await connectorValidationEnv();
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], {
        env: { ...env, VERITY_RUNNER_RUNTIME_UID: '0' },
      }),
    ).rejects.toThrow(/non-root/u);
    await chmod(env.VERITY_CLAUDE_EGRESS_KEY, 0o644);
    await expect(execFileAsync(connectorLauncher, ['--validate-config'], { env })).rejects.toThrow(
      /other users/u,
    );
  });

  it('rejects connector TLS paths that traverse a symlink', async () => {
    const env = await connectorValidationEnv();
    const alias = join(runtimeDir, 'client-key-alias.pem');
    await symlink(env.VERITY_CLAUDE_EGRESS_KEY, alias);
    await expect(
      execFileAsync(connectorLauncher, ['--validate-config'], {
        env: { ...env, VERITY_CLAUDE_EGRESS_KEY: alias },
      }),
    ).rejects.toThrow(/TLS material/u);
  });

  it('changes the desired connector identity when TLS material rotates', async () => {
    const env = await connectorValidationEnv();
    const first = await execFileAsync(connectorLauncher, ['--config-fingerprint'], { env });
    await writeFile(env.VERITY_CLAUDE_EGRESS_KEY, 'rotated-test-key', { mode: 0o640 });
    const second = await execFileAsync(connectorLauncher, ['--config-fingerprint'], { env });
    expect(first.stdout).toMatch(/^[a-f0-9]{64}\n$/u);
    expect(second.stdout).toMatch(/^[a-f0-9]{64}\n$/u);
    expect(second.stdout).not.toBe(first.stdout);
  });

  it('starts the standalone connector with node resolved off the launch PATH', async () => {
    const env = await connectorValidationEnv();
    const controlDir = join(runtimeDir, 'connector-control');
    const nodeOnlyBin = join(runtimeDir, 'node-only-bin');
    await mkdir(nodeOnlyBin);
    await symlink(process.execPath, join(nodeOnlyBin, 'node'));
    const port = String(43000 + (process.pid % 20000));
    const startEnv = {
      ...env,
      // The interpreter is reachable ONLY via this extra PATH entry, mirroring
      // devcontainer images whose node lives outside the launcher's sanitized
      // /usr/local/bin:/usr/bin:/bin (the nvm Feature layout).
      PATH: `${nodeOnlyBin}:/usr/bin:/bin`,
      VERITY_CLAUDE_CONNECTOR_PORT: port,
      VERITY_CLAUDE_CONNECTOR_AUTHORITY: `127.0.0.1:${port}`,
      VERITY_CLAUDE_CONNECTOR_CONTROL_DIR: controlDir,
      VERITY_CLAUDE_CONNECTOR_BIN: resolve(
        'features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs',
      ),
    };
    try {
      await execFileAsync(connectorLauncher, ['--standalone'], { env: startEnv });
      const ready = await fetch(`http://127.0.0.1:${port}/__verity/ready`);
      expect(((await ready.json()) as { ready?: boolean }).ready).toBe(true);
    } finally {
      const pidLine = await readFile(join(controlDir, 'egress-connector.pid'), 'utf8').catch(
        () => '',
      );
      const pid = Number(pidLine.split(' ')[0]);
      if (Number.isInteger(pid) && pid > 1) process.kill(pid);
    }
  });

  // The launcher hands the connector a sanitized environment (env -i plus an
  // explicit allowlist), so a variable the Sandbox carries reaches the process
  // only if this list names it. Both Codex variables were missing from it: the
  // Sandbox was provisioned with a Codex gateway, the connector came up without
  // one, and every Codex turn was answered with "Codex egress is not configured
  // for this Sandbox". No recreate could repair that, because the Sandbox env
  // was never the thing at fault.
  it('passes the Codex gateway through the sanitized launch environment', async () => {
    const env = await connectorValidationEnv();
    const controlDir = join(runtimeDir, 'codex-connector-control');
    // Below the default ephemeral range (32768–60999) so the listener cannot
    // collide with a socket the test host handed out on its own.
    const port = String(21000 + (process.pid % 10000));
    const startEnv = {
      ...env,
      VERITY_CLAUDE_CONNECTOR_PORT: port,
      VERITY_CLAUDE_CONNECTOR_AUTHORITY: `127.0.0.1:${port}`,
      VERITY_CLAUDE_CONNECTOR_CONTROL_DIR: controlDir,
      VERITY_CLAUDE_CONNECTOR_BIN: resolve(
        'features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs',
      ),
      // Closed port rather than a hostname: the assertion is about which leg the
      // connector believes it has, so the failure has to be the gateway refusing
      // rather than a resolver the test host may or may not have.
      VERITY_CODEX_EGRESS_URL: 'https://127.0.0.1:1',
      VERITY_CODEX_EGRESS_AUTHORITY: 'codex-gateway.internal:8444',
    };
    try {
      await execFileAsync(connectorLauncher, ['--standalone'], { env: startEnv });
      const response = await fetch(`http://127.0.0.1:${port}/codex/responses`, {
        method: 'POST',
        body: '{}',
      });
      const body = await response.text();
      expect(response.status).toBe(502);
      // A configured leg fails at the gateway. An unconfigured one refuses before
      // it ever gets there, and that is the regression.
      expect(body).toContain('Codex egress unavailable');
      expect(body).not.toContain('not configured for this Sandbox');
    } finally {
      const pidLine = await readFile(join(controlDir, 'egress-connector.pid'), 'utf8').catch(
        () => '',
      );
      const pid = Number(pidLine.split(' ')[0]);
      // Cleanup must not mask a failed assertion: the process may already be
      // gone if the launcher never got it running.
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid);
        } catch {
          /* already exited */
        }
      }
    }
  });

  it('probes the privileged spawn broker without starting an agent', async () => {
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
    });
    await expect(probeAgentSpawnBroker(runtimeDir)).resolves.toBe(true);
    await broker.close();
    await expect(probeAgentSpawnBroker(runtimeDir, 50)).resolves.toBe(false);
  });

  it('executes trusted CLI requests through the agent broker and returns only redacted output', async () => {
    const turnId = 'trusted-cli-turn';
    const secretDir = join(runtimeDir, 'trusted-cli-secrets');
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      // The real directory is root-owned under /run/verity-runner; the test runs
      // unprivileged, so file injection needs a writable one.
      secretDir,
      spawnChild: (_command, args, options) => spawn(args[7]!, args.slice(8), options),
    });
    const previousBrokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    const spawned = vi.fn();
    const run = async (request: unknown) => {
      try {
        return {
          ok: true,
          ...(await runTrustedCliViaBroker(
            request as Parameters<typeof runTrustedCliViaBroker>[0],
            { runtimeDir, onSpawned: spawned },
          )),
        };
      } catch (error) {
        const trustedCliFailure = (error as Error & { trustedCliFailure?: unknown })
          .trustedCliFailure;
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(trustedCliFailure === undefined ? {} : { trustedCliFailure }),
        };
      }
    };
    try {
      const result = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret/value' }],
        command: [
          '/bin/sh',
          '-c',
          'printf "raw=%s base64=%s url=secret%%2Fvalue" "$CLI_SECRET" "$(printf %s "$CLI_SECRET" | base64)"; printf " err=%s" "$CLI_SECRET" >&2',
        ],
      });
      expect(result).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: 'raw=[REDACTED] base64=[REDACTED] url=[REDACTED]',
        stderr: ' err=[REDACTED]',
      });
      expect(JSON.stringify(result)).not.toContain('secret/value');
      expect(JSON.stringify(result)).not.toContain(Buffer.from('secret/value').toString('base64'));
      expect(spawned).toHaveBeenCalledOnce();
      // The case the single-secret contract could not express: a key id, an
      // issuer id and a private key in one process, the key as a file. No
      // sequence of single-secret runs composes into this, which is why agents
      // kept asking for one combined JSON alias instead.
      const multi = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'ASC_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
          { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID', secret: 'key-id-marker' },
          { secretAlias: 'ASC_API_ISSUER_ID', env: 'ASC_ISSUER_ID', secret: 'issuer-id-marker' },
        ],
        command: [
          '/bin/sh',
          '-c',
          'printf "id=%s issuer=%s file=%s key=%s" "$ASC_KEY_ID" "$ASC_ISSUER_ID" "$ASC_KEY_FILE" "$(cat "$ASC_KEY_FILE")"',
        ],
      });
      expect(multi).toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: `id=[REDACTED] issuer=[REDACTED] file=${secretDir}/ASC_KEY_FILE key=[REDACTED]`,
      });
      // Every value is redacted, not just the first one.
      for (const value of ['private-key-marker', 'key-id-marker', 'issuer-id-marker']) {
        expect(JSON.stringify(multi)).not.toContain(value);
      }
      // The file is removed once the run settles; a second run must not be
      // refused by the `wx` guard tripping over its own leftover.
      await expect(readFile(`${secretDir}/ASC_KEY_FILE`)).rejects.toThrow(/ENOENT/u);
      // Naming the injected path as its own argv token, rather than reaching it
      // through the variable: that is the form argument validation actually
      // inspects, and it has to grant the same exception materialization uses.
      const named = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'ASC_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
        ],
        command: ['/bin/cat', `${secretDir}/ASC_KEY_FILE`],
      });
      expect(named).toMatchObject({ ok: true, exitCode: 0, stdout: '[REDACTED]' });
      // Removal can fail, and the file it leaves behind is a live credential at a
      // path the agent already knows. Take the directory's write bit away mid-run
      // so the unlink hits EACCES: the run has to come back as a failure naming
      // that, because reporting the command's own clean exit is what would let a
      // readable secret sit in the sandbox unnoticed and unrotated.
      const stranded = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'LEAK_KEY_FILE',
            injection: 'file',
            secret: 'private-key-marker',
          },
        ],
        command: ['/bin/sh', '-c', `chmod 0500 ${JSON.stringify(secretDir)}`],
      });
      expect(stranded).toMatchObject({
        ok: false,
        error: expect.stringContaining('trusted CLI secret file could not be removed'),
      });
      expect(JSON.stringify(stranded)).not.toContain('private-key-marker');
      await chmod(secretDir, 0o700);
      await rm(`${secretDir}/LEAK_KEY_FILE`, { force: true });
      // Materialization can also die part-way, and what it already wrote is just
      // as live as what a finished run leaves behind. Plant a leftover so the
      // second secret trips the `wx` guard: the run fails, but the first secret's
      // file has to be gone, or the next run trips over that one instead.
      await writeFile(`${secretDir}/PARTIAL_SECOND`, 'stale', { mode: 0o600 });
      const partial = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          {
            secretAlias: 'ASC_API_KEY_P8',
            env: 'PARTIAL_FIRST',
            injection: 'file',
            secret: 'first-file-marker',
          },
          {
            secretAlias: 'ASC_API_KEY_ID',
            env: 'PARTIAL_SECOND',
            injection: 'file',
            secret: 'second-file-marker',
          },
        ],
        command: ['/bin/sh', '-c', 'true'],
      });
      expect(partial).toMatchObject({ ok: false, error: expect.stringContaining('EEXIST') });
      expect(partial).toMatchObject({
        trustedCliFailure: { phase: 'materialization', cause: 'materialization failed' },
      });
      // Containment worked here, so the caller hears the materialization error
      // itself — the leak wording is reserved for the case that needs a rotation.
      expect(partial).not.toMatchObject({
        error: expect.stringContaining('trusted CLI secret file could not be removed'),
      });
      for (const value of ['first-file-marker', 'second-file-marker']) {
        expect(JSON.stringify(partial)).not.toContain(value);
      }
      await expect(readFile(`${secretDir}/PARTIAL_FIRST`)).rejects.toThrow(/ENOENT/u);
      await rm(`${secretDir}/PARTIAL_SECOND`, { force: true });
      // The server and this image deploy separately, so a rollout always has a
      // window where an older server still sends the flat single-secret shape.
      // Rejecting it would make "ship the image first" unserviceable in both
      // directions, so the supervisor keeps reading it for now.
      const legacy = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secretAlias: 'API_KEY',
        env: 'CLI_SECRET',
        secret: 'legacy-shape-value',
        command: ['/bin/sh', '-c', 'printf "raw=%s" "$CLI_SECRET"'],
      });
      expect(legacy).toMatchObject({ ok: true, exitCode: 0, stdout: 'raw=[REDACTED]' });
      expect(JSON.stringify(legacy)).not.toContain('legacy-shape-value');
      const truncated = await run({
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId,
        secrets: [
          { secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
        ],
        command: ['/bin/sh', '-c', 'head -c 30000 /dev/zero | tr "\\0" x'],
      });
      expect(truncated).toMatchObject({
        ok: true,
        stdout: '[output withheld: truncated]',
        stderr: '[output withheld: truncated]',
        truncated: true,
      });
      expect(JSON.stringify(truncated)).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      await expect(
        run({
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'LD_PRELOAD', secret: 'attacker-library' }],
          command: ['/bin/sh', '-c', 'exit 0'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI broker rejected execution: invalid trusted CLI spawn request',
        trustedCliFailure: { phase: 'validation', cause: 'validation failed' },
      });
    } finally {
      await broker.close();
      if (previousBrokerSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
      else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousBrokerSocket;
    }
  });

  it('refuses a persisted trusted CLI capability when no live worker owns the turn', async () => {
    const turnId = 'trusted-cli-retired-turn';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'never-forwarded' }],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI turn capability is no longer active',
      });
    } finally {
      await supervisor.close();
    }
  });

  it('executes through the supervisor only while its ACP worker is live', async () => {
    const turnId = 'trusted-cli-live-acp-turn';
    const secretDir = join(runtimeDir, 'live-acp-secrets');
    const workerReadyPath = join(runtimeDir, 'live-acp-worker-ready');
    const cancelSeenPath = join(runtimeDir, 'live-acp-cancel-seen');
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      secretDir,
      spawnChild: (_command, args, options) => spawn(args[7]!, args.slice(8), options),
    });
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(workerReadyPath)},'ready');process.once('SIGTERM',()=>{writeFileSync(${JSON.stringify(cancelSeenPath)},'seen');setTimeout(()=>process.exit(0),250)});setInterval(()=>{},1000);`,
      ],
      brokerSocket: broker.socketPath,
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId,
          startCommandId: 'start-trusted-cli-live-acp-turn',
          sessionId: 'session-trusted-cli-live-acp-turn',
          backend: 'codex-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'stay live',
          trustedCliExecution: true,
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(async () => {
        await expect(readFile(workerReadyPath, 'utf8')).resolves.toBe('ready');
      });
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'live-secret' }],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({ ok: true, exitCode: 0, stdout: '', stderr: '' });
      const cancellation = supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'cancel-turn',
        turnId,
      });
      await vi.waitFor(async () => {
        await expect(readFile(cancelSeenPath, 'utf8')).resolves.toBe('seen');
      });
      // The worker still exists during its SIGTERM grace period, but cancellation has
      // already revoked the execution capability.
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId,
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'retired-secret' }],
          command: ['/bin/true'],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: 'trusted CLI turn capability is no longer active',
      });
      await expect(cancellation).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
    } finally {
      await supervisor.close();
      await broker.close();
    }
  });

  it('reports the stranded secret, not the spawn error, when a trusted CLI child never starts', async () => {
    const turnId = 'trusted-cli-spawn-failure';
    const secretDir = join(runtimeDir, 'spawn-failure-secrets');
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    // Both spawn failures are handled apart from the child-exit path, and each
    // once discarded the containment result: the caller heard "spawn refused"
    // and never learned a readable credential had been left in the sandbox.
    let asynchronous = false;
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      worktreeRoot: runtimeDir,
      secretDir,
      spawnChild: () => {
        // Strand the file the way a failing unlink would. The test runs
        // unprivileged, so the broker cannot chown it back either and
        // containment genuinely fails rather than being simulated.
        chmodSync(secretDir, 0o500);
        if (!asynchronous) throw new Error('spawn refused');
        // Only the handful of members the broker touches on a child that never
        // reached `spawn`: the event surface, and `kill` for shutdown.
        const child = Object.assign(new EventEmitter(), {
          kill: () => true,
          exitCode: null,
          signalCode: null,
        }) as unknown as ChildProcess;
        queueMicrotask(() => {
          child.emit('error', new Error('spawn refused'));
          // A child that errored still closes, and the broker waits on that
          // before it will shut down. Omitting it hangs teardown, not the run.
          child.emit('close', 1, null);
        });
        return child;
      },
    });
    const previousBrokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = broker.socketPath;
    try {
      for (const env of ['SPAWN_KEY_SYNC', 'SPAWN_KEY_ASYNC']) {
        const result = runTrustedCliViaBroker(
          {
            turnId,
            secrets: [
              {
                secretAlias: 'ASC_API_KEY_P8',
                env,
                injection: 'file',
                secret: 'private-key-marker',
              },
            ],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir },
        );
        await expect(result).rejects.toThrow(/trusted CLI secret file could not be removed/u);
        // The spawn error still rides along, so the failure stays diagnosable.
        await expect(result).rejects.toThrow(/spawn refused/u);
        await chmod(secretDir, 0o700);
        await rm(`${secretDir}/${env}`, { force: true });
        asynchronous = true;
      }
    } finally {
      await broker.close();
      if (previousBrokerSocket === undefined) delete process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
      else process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET = previousBrokerSocket;
    }
  });

  it('rejects when the trusted CLI broker does not settle after SIGKILL', async () => {
    const turnId = 'trusted-cli-hung-broker';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const socketPath = join(runtimeDir, 'hung-broker.sock');
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write(`${JSON.stringify({ ok: true, kind: 'spawned' })}\n`);
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      await expect(
        runTrustedCliViaBroker(
          {
            turnId,
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret-value' }],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir, brokerSocket: socketPath, timeoutMs: 10, killGraceMs: 10 },
        ),
      ).rejects.toThrow(/did not settle after SIGKILL/u);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('kills a trusted CLI that reports spawned after its timeout', async () => {
    const turnId = 'trusted-cli-late-spawn';
    const turnDir = join(runtimeDir, 'turns', turnId);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'request.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId,
        cwd: runtimeDir,
        trustedCliExecution: true,
      })}\n`,
    );
    const socketPath = join(runtimeDir, 'late-spawn-broker.sock');
    let receivedKill = false;
    const server = createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const frame = JSON.parse(buffered.slice(0, newline)) as { kind?: string };
          buffered = buffered.slice(newline + 1);
          if (frame.kind === 'spawn-trusted-cli') {
            setTimeout(
              () => socket.write(`${JSON.stringify({ ok: true, kind: 'spawned' })}\n`),
              20,
            );
          } else if (frame.kind === 'signal') {
            receivedKill = true;
            socket.write(`${JSON.stringify({ ok: true, kind: 'exit', code: 137 })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
    try {
      await expect(
        runTrustedCliViaBroker(
          {
            turnId,
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'secret-value' }],
            command: ['/bin/sh', '-c', 'exit 0'],
          },
          { runtimeDir, brokerSocket: socketPath, timeoutMs: 5, killGraceMs: 100 },
        ),
      ).resolves.toMatchObject({ exitCode: 137, timedOut: true });
      expect(receivedKill).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('keeps bounded request deadlines after reading a supervisor frame', () => {
    const regular = supervisorRequestTimeoutMs({ kind: 'status' });
    const trustedCli = supervisorRequestTimeoutMs({ kind: 'run-trusted-cli' });
    expect(regular).toBeGreaterThan(0);
    expect(trustedCli).toBeGreaterThan(regular);
    expect(trustedCli).toBeLessThanOrEqual(31 * 60 * 1_000);
  });

  it('forwards the broker start acknowledgement before returning the trusted CLI result', async () => {
    const started = vi.fn();
    const runTrustedCli = vi.fn(async (_request: unknown, onSpawned: (() => void) | undefined) => {
      onSpawned?.();
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    await expect(
      handleSupervisorRequest(
        runtimeDir,
        'runner-1',
        { protocolVersion: 1, kind: 'run-trusted-cli' },
        { runTrustedCli } as never,
        started,
      ),
    ).resolves.toEqual({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' });
    expect(started).toHaveBeenCalledOnce();
    expect(runTrustedCli).toHaveBeenCalledOnce();
  });

  it('accepts a server-owned runner runtime only through the runner group', () => {
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040070 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    // Server-owned with a bare owner traverse bit (0170, --x) is accepted so the
    // same-uid sandbox agent can descend to its transcript dir under claude/.
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040170 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1101, gid: 1101, mode: 0o040770 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040770 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).toThrow(/ownership mismatch/u);
    // Owner read (0570) exposes the Runner's control files to the same-uid agent —
    // still rejected; only a bare traverse bit is tolerated.
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040570 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).toThrow(/ownership mismatch/u);
  });

  it('keeps the root broker socket root-owned and runner-group writable', () => {
    expect(brokerSocketOwnership({ runnerUid: 1101, runnerGid: 1101 })).toEqual({
      uid: 0,
      gid: 1101,
      mode: 0o660,
    });
    expect(brokerSocketOwnership({ runnerUid: 1101, runnerGid: 1101, enforceRoot: false })).toEqual(
      {
        uid: 1101,
        gid: 1101,
        mode: 0o600,
      },
    );
  });

  it('reconciles on a fixed interval without overlapping slow passes', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reconcile = vi.fn(async () => await new Promise<void>((resolve) => (release = resolve)));
    const stop = startRunnerSupervisorReconciler(reconcile, 10);
    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(reconcile).toHaveBeenCalledTimes(1);
      release?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(reconcile).toHaveBeenCalledTimes(2);
      const stopped = stop();
      release?.();
      await stopped;
      await vi.advanceTimersByTimeAsync(30);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });

  it('rate-limits watchdog failure reports', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const reconcile = vi.fn(async () => await Promise.reject(new Error('docker unavailable')));
    const stop = startRunnerSupervisorReconciler(reconcile, 10, report, 60);
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(reconcile).toHaveBeenCalledTimes(5);
      expect(report).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(report).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });

  it('validates owner/group-only runtime permissions', async () => {
    await expect(validateRuntimeDirectory(runtimeDir)).resolves.toBeUndefined();
    await chmod(runtimeDir, 0o777);
    await expect(validateRuntimeDirectory(runtimeDir)).rejects.toThrow(/group-only/);
  });

  it('accepts a server-owned supervisor runtime through the runner group', () => {
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040070 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    // Server-owned with a bare owner traverse bit (0170, --x) is accepted so the
    // same-uid sandbox agent can descend to its transcript dir under claude/.
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040170 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1101, gid: 1101, mode: 0o040770 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040770 },
        { uid: 1101, gid: 1101 },
      ),
    ).toThrow(/uid mismatch/u);
    // Owner read (0570) would expose the Runner's control files to the same-uid
    // agent — still rejected; only a bare traverse bit is tolerated.
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040570 },
        { uid: 1101, gid: 1101 },
      ),
    ).toThrow(/uid mismatch/u);
  });

  it('replays a start only within the same supervisor instance', async () => {
    const first = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(first.outcome).toBe('created');

    const replay = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(replay.outcome).toBe('already-running');
    expect(replay.state?.runnerInstanceId).toBe('runner-1');

    const restarted = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-2',
    );
    expect(restarted).toMatchObject({
      outcome: 'ambiguous',
      reason: 'runner-instance-mismatch',
    });
  });

  it('rejects a different start command for an existing turn', async () => {
    await claimTurn(runtimeDir, { turnId: 'turn-1', startCommandId: 'start-1' }, 'runner-1');
    const conflict = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-2' },
      'runner-1',
    );
    expect(conflict.outcome).toBe('conflict');
    expect((await readTurnState(runtimeDir, 'turn-1'))?.startCommandId).toBe('start-1');
  });

  it('normalizes and bounds inline image attachments on the start request', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    // A valid image is carried through, reduced to exactly the fields the worker
    // hands its backend (kind/mediaType/data), dropping anything extra.
    expect(
      validateStartTurnRequest({
        ...base,
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=', extra: 'x' }],
      }).attachments,
    ).toEqual([{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }]);
    // A turn without attachments never gains the field (byte-identical to today).
    expect(validateStartTurnRequest(base)).not.toHaveProperty('attachments');
    // File-kind uploads never reach here (materialized server-side); reject them.
    expect(() =>
      validateStartTurnRequest({
        ...base,
        attachments: [{ kind: 'file', mediaType: 'application/pdf', fileName: 'a.pdf', data: 'x' }],
      }),
    ).toThrow(/invalid attachment/u);
    // An unknown image media type and an empty data string are both rejected.
    expect(() =>
      validateStartTurnRequest({
        ...base,
        attachments: [{ kind: 'image', mediaType: 'image/tiff', data: 'x' }],
      }),
    ).toThrow(/invalid attachment/u);
    expect(() =>
      validateStartTurnRequest({
        ...base,
        attachments: [{ kind: 'image', mediaType: 'image/png', data: '' }],
      }),
    ).toThrow(/invalid attachment/u);
    // More than the per-turn cap is rejected as a batch.
    expect(() =>
      validateStartTurnRequest({
        ...base,
        attachments: Array.from({ length: 9 }, () => ({
          kind: 'image',
          mediaType: 'image/png',
          data: 'aGk=',
        })),
      }),
    ).toThrow(/invalid attachments/u);
  });

  it('ignores request fields it does not know', () => {
    // The rollout contract behind the two-phase start (ADR 0006 D9). The Server and
    // the Sandbox image roll independently, so a Server that has learned a new start
    // field will send it to a supervisor that has never heard of it — `startAck` is
    // the first, and this change is what introduces it. That is safe for exactly one
    // reason: this validator builds an ALLOW-LISTED result instead of refusing a
    // frame with surplus keys, so an unknown field is dropped and the start runs as
    // it did before. Turn that into a rejection and every Sandbox still on the old
    // image fails every turn the moment the Server ships — so it is pinned here,
    // where the next person to add a strict-shape check will see it.
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    const withFuture = validateStartTurnRequest({
      ...base,
      startAck: true,
      // Stand-ins for whatever the Server learns to send next.
      someFieldFromALaterServer: { nested: ['x'] },
    });
    expect(withFuture).not.toHaveProperty('startAck');
    expect(withFuture).not.toHaveProperty('someFieldFromALaterServer');
    // And the known fields survive it untouched — the unknown keys are dropped, not
    // treated as a reason to fall back to some reduced request.
    expect(withFuture).toEqual(validateStartTurnRequest(base));
  });

  it('rejects an oversize inline image instead of truncating it', () => {
    // A single image whose base64 alone exceeds the 4 MB start-request cap must be
    // rejected outright — no silent truncation. Sized just past the whole-request limit.
    const oversize = 'A'.repeat(4 * 1024 * 1024 + 1);
    expect(() =>
      validateStartTurnRequest({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        sessionId: 'session-1',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'look',
        attachments: [{ kind: 'image', mediaType: 'image/png', data: oversize }],
      }),
    ).toThrow(/exceeds supervisor limit/u);
  });

  it('validates and forwards the per-turn Verity session environment', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    expect(
      validateStartTurnRequest({
        ...base,
        sessionEnv: { VERITY_SESSION_BACKEND: 'claude', VERITY_SESSION_MODEL: 'sonnet' },
      }).sessionEnv,
    ).toEqual({ VERITY_SESSION_BACKEND: 'claude', VERITY_SESSION_MODEL: 'sonnet' });
    expect(() => validateStartTurnRequest({ ...base, sessionEnv: { PATH: '/tmp/bin' } })).toThrow(
      /invalid sessionEnv/u,
    );
    expect(() =>
      validateStartTurnRequest({ ...base, sessionEnv: { VERITY_SESSION_SECRET: 'nope' } }),
    ).toThrow(/invalid sessionEnv/u);
    expect(() =>
      validateStartTurnRequest({
        ...base,
        sessionEnv: { VERITY_SESSION_MODEL: 'x'.repeat(257) },
      }),
    ).toThrow(/invalid sessionEnv/u);
  });

  // ADR 0014 D1: only an ACP turn is handed a gateway bearer, and the supervisor
  // re-derives that from the backend it was asked to start rather than trusting
  // the Server to have paired the two correctly.
  it('accepts the MCP gateway bearer only on an ACP backend', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    expect(validateStartTurnRequest({ ...base, mcpGatewayToken: 'bearer-1' }).mcpGatewayToken).toBe(
      'bearer-1',
    );
    expect(
      validateStartTurnRequest({ ...base, backend: 'codex-acp', mcpGatewayToken: 'bearer-2' })
        .mcpGatewayToken,
    ).toBe('bearer-2');
    // A turn without a bearer never gains the field.
    expect(validateStartTurnRequest(base)).not.toHaveProperty('mcpGatewayToken');
    // An empty or oversize bearer is a wiring bug, not an absent one.
    expect(() => validateStartTurnRequest({ ...base, mcpGatewayToken: '' })).toThrow(
      /invalid mcpGatewayToken/u,
    );
    expect(() => validateStartTurnRequest({ ...base, mcpGatewayToken: 'x'.repeat(513) })).toThrow(
      /invalid mcpGatewayToken/u,
    );
  });

  it('reports a pre-existing directory without state as ambiguous', async () => {
    await mkdir(join(runtimeDir, 'turns', 'turn-1'), { recursive: true, mode: 0o770 });
    const outcome = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(outcome).toEqual({ outcome: 'ambiguous', reason: 'turn-directory-without-state' });
  });

  it('keeps corrupt turn directories visible as ambiguous', async () => {
    await claimTurn(runtimeDir, { turnId: 'turn-b', startCommandId: 'start-b' }, 'runner-1');
    await claimTurn(runtimeDir, { turnId: 'turn-a', startCommandId: 'start-a' }, 'runner-1');
    await mkdir(join(runtimeDir, 'turns', 'broken'), { mode: 0o770 });
    await writeFile(join(runtimeDir, 'turns', 'broken', 'state.json'), 'not json');
    expect(await listTurns(runtimeDir)).toEqual([
      expect.objectContaining({ turnId: 'broken', status: 'ambiguous', reason: 'invalid-state' }),
      expect.objectContaining({ turnId: 'turn-a', status: 'claimed' }),
      expect.objectContaining({ turnId: 'turn-b', status: 'claimed' }),
    ]);
  });

  it('refuses a second live singleton claim', async () => {
    const first = await acquireSingleton(runtimeDir, 'runner-1');
    await expect(acquireSingleton(runtimeDir, 'runner-2')).rejects.toThrow(/already claimed/);
    await first.release();
    const second = await acquireSingleton(runtimeDir, 'runner-2');
    expect(second.instanceId).toBe('runner-2');
    await second.release();
  });

  it('reclaims after a dead holder: the freed flock gates ownership, not the leftover owner file', async () => {
    // A crashed supervisor leaves supervisor.lock.json behind but no longer holds
    // the flock. The owner file is diagnostic only and is never consulted for
    // ownership, so a fresh process reclaims the singleton purely because the
    // kernel lock on supervisor.lock is free.
    await writeFile(join(runtimeDir, 'supervisor.lock'), '', { mode: 0o660 });
    await writeFile(
      join(runtimeDir, 'supervisor.lock.json'),
      `${JSON.stringify({ pid: 2_147_483_647, instanceId: 'dead-runner' })}\n`,
      { mode: 0o660 },
    );
    const recovered = await acquireSingleton(runtimeDir, 'runner-new');
    expect(recovered.instanceId).toBe('runner-new');
    await recovered.release();
  });

  it('treats the owner metadata as diagnostic only, even when it names this live pid', async () => {
    // Guards against anyone later reintroducing pid/start-time "trust": an owner
    // file naming the CURRENT live process must not fool the next claim into
    // believing the singleton is held. acquireSingleton reads nothing from the
    // file — it only re-acquires the (currently free) flock — so the claim
    // succeeds regardless of what the leftover metadata says.
    await writeFile(join(runtimeDir, 'supervisor.lock'), '', { mode: 0o660 });
    await writeFile(
      join(runtimeDir, 'supervisor.lock.json'),
      `${JSON.stringify({
        pid: process.pid,
        processStartTime: 'not-this-process',
        instanceId: 'old-container',
      })}\n`,
      { mode: 0o660 },
    );
    const recovered = await acquireSingleton(runtimeDir, 'new-container');
    expect(recovered.instanceId).toBe('new-container');
    await recovered.release();
  });

  it('fences a separate process through the shared runtime file lock', async () => {
    const first = await acquireSingleton(runtimeDir, 'runner-parent');
    const moduleUrl = new URL(
      '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      import.meta.url,
    ).href;
    const script = `
      import { acquireSingleton } from ${JSON.stringify(moduleUrl)};
      try {
        await acquireSingleton(process.argv[1], 'runner-child');
        process.exitCode = 2;
      } catch (error) {
        if (!String(error).includes('already claimed')) throw error;
        process.stdout.write('fenced');
      }
    `;
    try {
      await expect(
        execFileAsync(process.execPath, ['--input-type=module', '--eval', script, runtimeDir]),
      ).resolves.toMatchObject({ stdout: 'fenced' });
    } finally {
      await first.release();
    }
  });

  it('atomically elects exactly one singleton under concurrent startup', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        acquireSingleton(runtimeDir, `runner-${String(index)}`),
      ),
    );
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSingleton>>> =>
        attempt.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    expect(
      attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'),
    ).toHaveLength(11);
    await winners[0]?.value.release();
  });

  it('serves discovery and idempotent claims over the supervisor socket', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
      const request = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
        await new Promise((resolve, reject) => {
          const socket = createConnection(supervisor.socketPath);
          let response = '';
          socket.once('error', reject);
          socket.on('data', (chunk) => {
            response += chunk.toString('utf8');
          });
          socket.once('end', () => resolve(JSON.parse(response) as Record<string, unknown>));
          socket.once('connect', () => {
            socket.write(`${JSON.stringify(payload)}\n`);
          });
        });

      await expect(request({ protocolVersion: 1, kind: 'status' })).resolves.toMatchObject({
        ok: true,
        runnerInstanceId: supervisor.instanceId,
      });
      await expect(
        request({
          protocolVersion: 1,
          kind: 'claim-turn',
          turnId: 'turn-socket',
          startCommandId: 'start-socket',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await expect(request({ protocolVersion: 1, kind: 'list-turns' })).resolves.toMatchObject({
        ok: true,
        turns: [{ turnId: 'turn-socket' }],
      });
    } finally {
      await supervisor.close();
    }
  });

  it('starts one supervisor-owned worker and replays StartTurn idempotently', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'worker-started.json'),JSON.stringify(request));process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
    });
    const request = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
      await new Promise((resolveReply, rejectReply) => {
        const socket = createConnection(supervisor.socketPath);
        let response = '';
        socket.once('error', rejectReply);
        socket.on('data', (chunk) => {
          response += chunk.toString('utf8');
        });
        socket.once('end', () => resolveReply(JSON.parse(response) as Record<string, unknown>));
        socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
      });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-worker',
      startCommandId: 'start-worker',
      sessionId: 'session-worker',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'hello',
      appendSystemPrompt: 'policy',
      resumeSessionId: 'claude-session-1',
      permissionControl: true,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Bash(git *)'],
      disallowedTools: ['WebFetch'],
      timeoutMs: 30_000,
    };
    try {
      await expect(request(start)).resolves.toMatchObject({
        ok: true,
        outcome: 'created',
        state: { status: 'running' },
      });
      await expect(request(start)).resolves.toMatchObject({
        ok: true,
        outcome: 'already-running',
      });
      await expect(request({ ...start, startCommandId: 'different-start' })).resolves.toMatchObject(
        { ok: true, outcome: 'conflict' },
      );
      await vi.waitFor(async () => {
        expect(
          JSON.parse(
            await readFile(join(runtimeDir, 'turns/turn-worker/worker-started.json'), 'utf8'),
          ),
        ).toMatchObject({
          turnId: 'turn-worker',
          prompt: 'hello',
          appendSystemPrompt: 'policy',
          resumeSessionId: 'claude-session-1',
          permissionControl: true,
          permissionMode: 'plan',
          allowedTools: ['Read', 'Bash(git *)'],
          disallowedTools: ['WebFetch'],
          timeoutMs: 30_000,
        });
      });
      await expect(
        request({
          ...start,
          turnId: 'turn-invalid-timeout',
          startCommandId: 'start-invalid-timeout',
          timeoutMs: 0,
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/timeoutMs/) });
    } finally {
      await supervisor.close();
    }
    await expect(readTurnState(runtimeDir, 'turn-worker')).resolves.toMatchObject({
      status: 'settled',
      workerExitCode: 0,
    });
  });

  it('returns the same worker when the StartTurn ACK is lost and retried', async () => {
    const startedPath = join(runtimeDir, 'worker-starts.jsonl');
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {appendFile,readFile} from 'node:fs/promises';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await appendFile(${JSON.stringify(startedPath)},JSON.stringify({pid:process.pid,turnId:request.turnId,startCommandId:request.startCommandId})+'\\n');process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-lost-start-ack',
      startCommandId: 'start-lost-start-ack',
      sessionId: 'session-lost-start-ack',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'start exactly once',
    };
    try {
      // Deliver the complete request, then destroy the peer before reading the reply.
      // The durable worker artifact below proves the Supervisor processed the request.
      await new Promise<void>((resolveSent, rejectSent) => {
        const socket = createConnection(supervisor.socketPath);
        socket.once('error', rejectSent);
        socket.once('connect', () => {
          socket.write(`${JSON.stringify(start)}\n`, (error) => {
            if (error) {
              rejectSent(error);
              return;
            }
            socket.destroy();
            resolveSent();
          });
        });
      });

      await vi.waitFor(async () => {
        expect((await readFile(startedPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      });
      const [workerRecord] = (await readFile(startedPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const stateAfterLostAck = await readTurnState(runtimeDir, start.turnId);
      expect(stateAfterLostAck).toMatchObject({
        runnerInstanceId: supervisor.instanceId,
        startCommandId: start.startCommandId,
        status: 'running',
        workerPid: expect.any(Number),
      });
      expect(workerRecord).toEqual({
        pid: stateAfterLostAck?.workerPid,
        turnId: start.turnId,
        startCommandId: start.startCommandId,
      });
      expect(workerStarts).toBe(1);

      await expect(supervisorRequest(supervisor.socketPath, start)).resolves.toMatchObject({
        ok: true,
        outcome: 'already-running',
        state: {
          runnerInstanceId: supervisor.instanceId,
          startCommandId: start.startCommandId,
          status: 'running',
          workerPid: stateAfterLostAck?.workerPid,
        },
      });
      expect(workerStarts).toBe(1);
      expect((await readFile(startedPath, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  // The two-phase reply the Server's start budget now rests on: the supervisor says
  // "heard you, claiming" before the fsyncs and the two forks, and the real outcome
  // afterwards. Only then can a slow start be told apart from a wedged supervisor.
  it('acknowledges an opted-in start before the worker is up', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-ack',
      startCommandId: 'start-ack',
      sessionId: 'session-ack',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'acknowledge me',
    };
    try {
      const frames = await supervisorRequestFrames(supervisor.socketPath, {
        ...start,
        startAck: true,
      });
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({
        ok: true,
        kind: 'start-accepted',
        turnId: 'turn-ack',
        startCommandId: 'start-ack',
      });
      expect(frames[1]).toMatchObject({
        ok: true,
        outcome: 'created',
        state: { status: 'running' },
      });

      // ADR 0006 D9, from the other side: a Server that predates the flag reads
      // exactly one frame, so a supervisor must never volunteer the acknowledgement.
      const legacy = await supervisorRequestFrames(supervisor.socketPath, {
        ...start,
        turnId: 'turn-legacy-ack',
        startCommandId: 'start-legacy-ack',
      });
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ ok: true, outcome: 'created' });
    } finally {
      await supervisor.close();
    }
  });

  // A refusal must not arrive AFTER an acknowledgement that the start was accepted:
  // the Server would already have re-armed to the long start budget and would wait
  // out a turn that will never exist.
  it('refuses an invalid start without acknowledging it first', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'setInterval(()=>{},1000)'],
    });
    try {
      const frames = await supervisorRequestFrames(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-invalid-ack',
        startCommandId: 'start-invalid-ack',
        sessionId: 'session-invalid-ack',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'nope',
        timeoutMs: 0,
        startAck: true,
      });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ ok: false, error: expect.stringMatching(/timeoutMs/) });
    } finally {
      await supervisor.close();
    }
  });

  // The duplicate-worker half of the incident. Retries of the SAME start command
  // that arrive while the first is still mid-spawn used to race `claimTurn`; they
  // now collapse onto the one start in flight, so the worktree only ever sees one
  // worker no matter how often the Server re-sends.
  it('spawns one worker for concurrent retries of the same start command', async () => {
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-retry-storm',
      startCommandId: 'start-retry-storm',
      sessionId: 'session-retry-storm',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'exactly once',
      startAck: true,
    };
    try {
      // Together, so the retries genuinely overlap the first start: five requests that
      // merely follow one another would each find a running turn and test the ordinary
      // idempotent path instead of the collapse.
      const replies = await supervisorRequestsTogether(
        supervisor.socketPath,
        Array.from({ length: 5 }, () => start),
      );
      expect(workerStarts).toBe(1);
      // Every retry is answered, and answered identically — a collapsed retry must
      // not be left hanging on a promise nobody resolves, and the same start command
      // has exactly one truthful outcome however many sockets asked for it.
      for (const reply of replies) {
        expect(reply).toMatchObject({ ok: true, outcome: 'created', state: { status: 'running' } });
        expect(reply).toEqual(replies[0]);
      }
      const state = await readTurnState(runtimeDir, start.turnId);
      expect(state).toMatchObject({ startCommandId: start.startCommandId, status: 'running' });
    } finally {
      await supervisor.close();
    }
  });

  // The other side of that collapse, and the reason it is keyed on the start command
  // rather than on the turn alone: two DIFFERENT commands for one turn are not one
  // piece of work. Adopting the second onto the first would report a stranger's
  // outcome as its own, and letting it through would put a second worker on the same
  // worktree. It is refused synchronously instead — which also keeps the global queue
  // cap honest, since conflicts chained onto one turn would otherwise bypass it.
  it('refuses a second start command for a turn that is already starting', async () => {
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    const start = (commandId: string): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-two-commands',
      startCommandId: commandId,
      sessionId: 'session-two-commands',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'only one of these may run',
    });
    try {
      // Together, or the test proves nothing: a second command that arrives after the
      // first has finished is an ordinary conflict on a running turn, not the race
      // this is about.
      const replies = await supervisorRequestsTogether(supervisor.socketPath, [
        start('start-two-commands-a'),
        start('start-two-commands-b'),
      ]);
      // Whichever reached `start()` first owns the turn; the other is told so rather
      // than being queued behind it or silently adopted onto it.
      expect(replies.filter((reply) => reply.ok === true)).toHaveLength(1);
      expect(replies.filter((reply) => reply.ok === false)).toEqual([
        expect.objectContaining({
          error: 'turn turn-two-commands is already starting under another command',
        }),
      ]);
      expect(workerStarts).toBe(1);
      const state = await readTurnState(runtimeDir, 'turn-two-commands');
      expect(state).toMatchObject({ status: 'running' });
      // And the winner is the one the Server was told about, not merely one of them.
      expect(replies.find((reply) => reply.ok === true)).toMatchObject({
        state: { startCommandId: (state as { startCommandId: string }).startCommandId },
      });
    } finally {
      await supervisor.close();
    }
  });

  // Overload has to be a refusal the Server can read, not a silence it has to time
  // out on — the failure mode this whole change exists to remove.
  it('refuses a start once the bounded start queue is full', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      maxConcurrentStarts: 1,
      maxQueuedStarts: 1,
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-queue-${String(n)}`,
      startCommandId: `start-queue-${String(n)}`,
      sessionId: `session-queue-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued',
      // Asking for the acknowledgement is what makes the ORDER observable below.
      startAck: true,
    });
    try {
      const frames = await supervisorRequestFramesTogether(
        supervisor.socketPath,
        Array.from({ length: 6 }, (_unused, n) => start(n)),
      );
      const replies = frames.map((lines) => lines.at(-1) ?? {});
      // Every one of the six is accounted for, in one of exactly two ways: there is no
      // third outcome — no silence, no other error, and no half-state where the Server
      // cannot tell whether a worker exists.
      const refused = replies.filter((reply) => reply.ok === false);
      const accepted = replies.filter((reply) => reply.ok === true);
      expect(refused.length + accepted.length).toBe(replies.length);
      // Bounded, and bounded on BOTH sides: the cap refuses work it cannot hold
      // without also refusing the work it can. A supervisor that answered all six
      // would not be bounded; one that answered none would be the wedge this replaces.
      // With all six in flight together the split is the configuration, not the host:
      // one slot plus one queue place is exactly two, and the remaining four bounce.
      // Admission is synchronous on frame arrival — `start()` queues or refuses before
      // it awaits anything — so no slot can be freed part-way through the burst.
      expect(accepted.length).toBe(2);
      expect(refused.length).toBe(4);
      for (const reply of refused) {
        expect(reply.error).toBe('runner supervisor start queue is full');
      }
      for (const reply of accepted) {
        expect(reply).toMatchObject({ outcome: 'created', state: { status: 'running' } });
      }
      // The ordering the Server's whole retry decision rests on: a full queue is
      // refused BEFORE the acknowledgement, never after it. The Server treats a
      // refusal it hears as decided — nothing spawned, safe to retry under the same
      // id — and reserves reconciliation and the cancel fence for answers it never
      // got. Were this refusal to arrive after `start-accepted`, that classification
      // would send a queued-then-refused start down the decided path and a worker
      // could be spawned with nobody tailing it. So: one frame for a refusal, two
      // for an acceptance, and every acknowledgement echoing its own request's ids.
      for (const lines of frames) {
        const isRefusal = lines.at(-1)?.ok === false;
        expect(lines).toHaveLength(isRefusal ? 1 : 2);
        if (isRefusal) continue;
        expect(lines[0]).toMatchObject({ ok: true, kind: 'start-accepted' });
      }
      for (const [n, lines] of frames.entries()) {
        if (lines.length < 2) continue;
        expect(lines[0]).toMatchObject({
          turnId: `turn-queue-${String(n)}`,
          startCommandId: `start-queue-${String(n)}`,
        });
      }
      // A refusal is a refusal: nothing was claimed, so the Server may safely start
      // that turn again later under the same id. An accepted one did claim, and its
      // worker is the reason the queue was full in the first place.
      for (const [n, reply] of replies.entries()) {
        const state = await readTurnState(runtimeDir, `turn-queue-${String(n)}`);
        if (reply.ok === false) expect(state).toBeUndefined();
        else expect(state).toMatchObject({ status: 'running', workerPid: expect.any(Number) });
      }
      // And the cap is a back-pressure signal, not a latch: once the burst has been
      // answered the supervisor takes work again, under a refused turn's own id.
      const readmitted = replies.findIndex((reply) => reply.ok === false);
      await expect(
        supervisorRequest(supervisor.socketPath, start(readmitted)),
      ).resolves.toMatchObject({ ok: true, outcome: 'created', state: { status: 'running' } });
    } finally {
      await supervisor.close();
    }
  });

  // Bounding the starts introduced a gap that did not exist when every start ran
  // immediately: a request can be accepted while the supervisor is healthy and reach
  // its slot after `close()` has begun. Spawning there leaves a worker behind that no
  // supervisor owns and no Server can settle — the orphan this whole change exists to
  // stop making.
  it('refuses a queued start that reaches its slot after shutdown began', async () => {
    const spawnedTurns: string[] = [];
    let shutdown: Promise<void> | undefined;
    // Annotated so the closure below may name it: `spawnWorker` only ever runs after
    // this has been assigned, but the inference would otherwise be circular.
    const supervisor: Awaited<ReturnType<typeof runSupervisor>> = await runSupervisor({
      runtimeDir,
      // A shell rather than a Node stand-in: six of these would cost more memory than
      // the sandbox has spare, and nothing here needs the worker to do anything.
      workerCommand: '/bin/sh',
      workerArgs: ['-c', 'sleep 5'],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        spawnedTurns.push(String(options.env?.VERITY_RUNNER_TURN_DIR));
        // Shutdown begins from inside the FIRST spawn, while this callback still
        // holds the only slot — so every other request is provably still waiting for
        // one. `close()` sets its flag synchronously and only then starts awaiting,
        // which is what makes the re-check the thing under test rather than a race.
        shutdown ??= supervisor.close();
        return spawn(command, args, options);
      },
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-shutdown-${String(n)}`,
      startCommandId: `start-shutdown-${String(n)}`,
      sessionId: `session-shutdown-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued into a shutdown',
    });
    try {
      // Connected before any of them is written: `close()` stops the listener, so a
      // socket that only dials after the first spawn would be refused by the OS rather
      // than answered by the supervisor — a connection error, not the refusal under
      // test. Six live sockets first, then six frames, removes that race entirely.
      const replies = await supervisorRequestsTogether(
        supervisor.socketPath,
        Array.from({ length: 6 }, (_unused, n) => start(n)),
      );
      // One worker, not six. This is the property: the flag is re-read at the slot,
      // so a queue that was legal when it formed does not drain into a dying process.
      expect(spawnedTurns).toHaveLength(1);
      const refused = replies.filter((reply) => reply.ok === false);
      expect(refused).toHaveLength(5);
      for (const reply of refused) {
        expect(reply.error).toBe('runner supervisor is shutting down');
      }
      // And refused before the claim, not after: the re-check sits above `claimTurn`,
      // so a turn turned away here was never durably owned and the Server may start
      // it again — against the next supervisor — under the very same id.
      for (const [n, reply] of replies.entries()) {
        if (reply.ok === false) {
          expect(await readTurnState(runtimeDir, `turn-shutdown-${String(n)}`)).toBeUndefined();
        }
      }
    } finally {
      await shutdown;
      await supervisor.close();
    }
  });

  // A cancel is an operator action on a short control budget. It may wait for the one
  // start that could be mid-claim, and for nothing else — least of all for a queue of
  // unrelated spawns to drain, which is how bounding the starts could have turned
  // "stop this" into a second timeout.
  it('cancels a queued start without waiting for the queue to drain', async () => {
    const spawnedTurns: string[] = [];
    const supervisor = await runSupervisor({
      runtimeDir,
      // A shell rather than the usual Node stand-in: this test needs a deep queue,
      // and fifteen live Node processes cost more memory than the sandbox has spare.
      workerCommand: '/bin/sh',
      workerArgs: ['-c', 'sleep 3'],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        spawnedTurns.push(String(options.env?.VERITY_RUNNER_TURN_DIR));
        return spawn(command, args, options);
      },
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-drain-${String(n)}`,
      startCommandId: `start-drain-${String(n)}`,
      sessionId: `session-drain-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued behind others',
    });
    try {
      const starts = Array.from({ length: 16 }, (_unused, n) =>
        supervisorRequest(supervisor.socketPath, start(n)),
      );
      const last = 15;
      const cancelled = supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'cancel-turn',
        turnId: `turn-drain-${String(last)}`,
      });
      // The property, not a timing preference: the cancel resolves while the start it
      // cancels is still queued behind fifteen others.
      await expect(
        Promise.race([cancelled.then(() => 'cancel'), starts[last]!.then(() => 'start')]),
      ).resolves.toBe('cancel');
      await expect(cancelled).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
      await Promise.all(starts);
      // And the durable tombstone still did its job: the queued start settled itself
      // when it was finally admitted, rather than spawning a worker after the cancel.
      expect(spawnedTurns).not.toContain(join(runtimeDir, 'turns', `turn-drain-${String(last)}`));
      expect(await readTurnState(runtimeDir, `turn-drain-${String(last)}`)).toMatchObject({
        status: 'settled',
      });
      // A cancel the operator asked for, reported as one: a settled turn with an
      // empty stream is a crash to the Server, so even the no-worker path owes it a
      // terminal frame.
      const frame = JSON.parse(
        await readFile(
          join(runtimeDir, 'turns', `turn-drain-${String(last)}`, 'events.jsonl'),
          'utf8',
        ),
      ) as { kind: string; result: { aborted: boolean } };
      expect(frame).toMatchObject({ kind: 'result', result: { aborted: true } });
    } finally {
      await supervisor.close();
    }
  });

  // The privilege boundary the synthetic frame crosses. The turn directory is
  // worker-writable and the supervisor is not confined the way the worker is, so a
  // worker that replaced its own event file with a link would otherwise have the
  // supervisor write this frame wherever the link points — arbitrary file creation
  // outside the worker's reach, triggered by dying. A link is refused outright
  // rather than resolved, which is what `lstat` plus `O_NOFOLLOW` buy.
  it('refuses to write a synthetic terminal frame through a symlinked event stream', async () => {
    const turnDir = join(runtimeDir, 'turns', 'turn-symlinked-stream');
    const outside = join(runtimeDir, 'outside-the-turn.jsonl');
    await mkdir(turnDir, { recursive: true });
    await symlink(outside, join(turnDir, 'events.jsonl'));

    await expect(
      writeSyntheticTerminalFrame(turnDir, {
        turnId: 'turn-symlinked-stream',
        runnerInstanceId: 'runner-1',
        workerExitCode: 1,
        workerSignal: null,
      }),
    ).resolves.toBe(false);
    // Not written, not created, not even truncated: the link target is untouched.
    expect(existsSync(outside)).toBe(false);
  });

  // The same hole in the form neither `isFile()` nor `O_NOFOLLOW` can see. A hardlink
  // to an existing empty file passes every check a symlink fails — it IS a regular
  // file, of size zero — and appending to it writes the frame into that file. Only
  // the link count tells them apart.
  it('refuses to write a synthetic terminal frame through a hardlinked event stream', async () => {
    const turnDir = join(runtimeDir, 'turns', 'turn-hardlinked-stream');
    const outside = join(runtimeDir, 'outside-the-turn-hardlink.jsonl');
    await mkdir(turnDir, { recursive: true });
    await writeFile(outside, '');
    await link(outside, join(turnDir, 'events.jsonl'));

    await expect(
      writeSyntheticTerminalFrame(turnDir, {
        turnId: 'turn-hardlinked-stream',
        runnerInstanceId: 'runner-1',
        workerExitCode: 1,
        workerSignal: null,
      }),
    ).resolves.toBe(false);
    // Still empty: the frame went nowhere rather than into a file outside the turn.
    expect(await readFile(outside, 'utf8')).toBe('');
  });

  // The cancellation tombstone is read on the way into a spawn and again on the way
  // out of one, and the read can fail for reasons other than "absent". Letting it
  // throw aborted whichever path was running — including, on the way in, before the
  // turn was settled at all, which left it `claimed` forever with no worker and no
  // frame: the never-finishes symptom this whole change exists to remove. On the way
  // in the unreadable answer stops the worker, because running a turn the operator
  // cancelled is the one outcome that cannot be taken back.
  it('settles a turn whose cancellation tombstone cannot be read, without spawning', async () => {
    // A directory where the tombstone file belongs: `readFile` answers EISDIR, which
    // is neither "cancelled" nor the ENOENT that means "not cancelled".
    await mkdir(join(runtimeDir, 'cancellations', 'turn-unreadable-tombstone.json'), {
      recursive: true,
    });
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-unreadable-tombstone',
          startCommandId: 'start-unreadable-tombstone',
          sessionId: 'session-unreadable-tombstone',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'never runs',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'terminal' });
      expect(workerStarts).toBe(0);
      // Decided, not stranded — and owed a terminal frame all the same, because a
      // settled turn behind an empty stream is a crash to the Server.
      expect(await readTurnState(runtimeDir, 'turn-unreadable-tombstone')).toMatchObject({
        status: 'settled',
      });
      const frame = JSON.parse(
        await readFile(
          join(runtimeDir, 'turns', 'turn-unreadable-tombstone', 'events.jsonl'),
          'utf8',
        ),
      ) as { kind: string; result: { aborted: boolean; stderr: string } };
      // Refused, but NOT reported as cancelled: the operator did not cancel this turn,
      // a filesystem fault stopped it, and `aborted` is what tells the session which of
      // those it is looking at. Blocking the start on an unreadable tombstone is a
      // safety choice; describing it as the operator's own doing would be a false one.
      expect(frame).toMatchObject({
        kind: 'result',
        result: {
          aborted: false,
          stderr: 'runner turn could not start: its cancellation record was unreadable',
        },
      });
    } finally {
      await supervisor.close();
    }
  });

  // The other half of that catch block. It writes a terminal frame — a claim that
  // nothing is running under this turn any more — but the guards it runs for can
  // reject a worker that really did start. Declaring a live agent dead is worse than
  // the failure being reported, so the child has to go with the frame.
  it('kills a worker it rejects after spawn rather than declaring it dead while it runs', async () => {
    let child: ChildProcess | undefined;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      // Ignores SIGTERM, so only a SIGKILL ends it: a graceful shutdown at the end of
      // this test would otherwise mask the very kill under test.
      workerArgs: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      spawnWorker: (command, args, options) => {
        // A worker with no attestation pipe: spawned and alive, then refused by the
        // guard that requires one.
        const stdio = [...(options.stdio as unknown[])];
        stdio[1] = 'ignore';
        child = spawn(command, args, { ...options, stdio } as typeof options);
        return child;
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-rejected-after-spawn',
          startCommandId: 'start-rejected-after-spawn',
          sessionId: 'session-rejected-after-spawn',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'never observed',
        }),
      ).resolves.toMatchObject({ ok: false });
      const spawned = child;
      if (spawned === undefined) throw new Error('expected the worker to have been spawned');
      await vi.waitFor(() => {
        expect(spawned.killed || spawned.exitCode !== null || spawned.signalCode !== null).toBe(
          true,
        );
      });
      expect(await readTurnState(runtimeDir, 'turn-rejected-after-spawn')).toMatchObject({
        status: 'settled',
      });
    } finally {
      await supervisor.close();
    }
  });

  it('gives a worker that died before its first event a terminal frame of its own', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.stderr.write('codex: connection refused');process.exit(3)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-early-death',
        startCommandId: 'start-early-death',
        sessionId: 'session-early-death',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'die early',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-early-death')).toMatchObject({
          status: 'settled',
        });
      });
      const lines = (
        await readFile(join(runtimeDir, 'turns/turn-early-death/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const frame = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(frame).toMatchObject({
        kind: 'result',
        // D3: contiguous from 1, and bound to the instance that wrote it — the
        // supervisor's own, because no worker ever opened this stream.
        frameSeq: 1,
        turnId: 'turn-early-death',
        runnerInstanceId: supervisor.instanceId,
        result: {
          exitCode: 3,
          // The same allow-listed diagnostic the turn state gets: the frame reaches
          // the operator, so it may not carry raw worker stderr either.
          stderr: 'worker stderr reported a connection failure',
          aborted: false,
        },
      });
      // No agent session id, because this worker never learned one. The Server
      // persists a failed turn's `result.sessionId` as the session's resume pointer,
      // so echoing the store's id here would pin the next turn to a thread the agent
      // never opened.
      expect(Object.keys(frame.result as Record<string, unknown>)).not.toContain('sessionId');
      // The Server stores this hash on first claim and compares it on replay, so a
      // synthetic frame has to be hashed exactly like a worker's.
      const { protocolVersion, runnerInstanceId, turnId, frameSeq, payloadHash, ...body } = frame;
      expect(payloadHash).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
      expect(protocolVersion).toBe(1);
      expect([runnerInstanceId, turnId, frameSeq]).toEqual([
        supervisor.instanceId,
        'turn-early-death',
        1,
      ]);
    } finally {
      await supervisor.close();
    }
  });

  // The frame above is hand-built in the Sandbox toolkit, against a schema whose
  // reader lives in another package — protocol version, envelope shape and hash
  // algorithm all restated by hand on the writing side. So read it with the actual
  // reader: `tailFrames` is the code the Server runs against a live turn, and it
  // rejects an unknown `kind` or a malformed envelope outright rather than dropping
  // the frame. If the two ends ever drift, this fails here instead of in production
  // as a turn that never ends.
  it('produces a synthetic frame the Server-side tail accepts and settles on', async () => {
    let ctx: TestDb | undefined;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(3)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-cross-package',
        startCommandId: 'start-cross-package',
        sessionId: 'session-cross-package',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'die early',
      });
      const frames: RunnerFrame[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10_000);
      try {
        // Resolves only when a `result` frame is delivered — the tail's own
        // definition of a turn that ended, which is precisely what an early death
        // used to leave it waiting for forever.
        await tailFrames(
          join(runtimeDir, 'turns/turn-cross-package/events.jsonl'),
          (frame) => {
            frames.push(frame);
          },
          { pollMs: 20, signal: abort.signal },
        );
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
      expect(frames).toHaveLength(1);
      const [frame] = frames as [RunnerFrame & { result: Record<string, unknown> }];
      expect(frame.kind).toBe('result');
      expect(frame.result).toMatchObject({ exitCode: 3, aborted: false });
      // And the hash the Server will store and compare on replay is the one the
      // Server's own function computes over the body it parsed — the algorithm lives
      // in @verity/session and is only mirrored in the toolkit.
      const { protocolVersion, runnerInstanceId, turnId, frameSeq, payloadHash, ...body } = frame;
      expect(payloadHash).toBe(frameBodyHash(body as RunnerFrameBody));
      expect({ protocolVersion, runnerInstanceId, turnId, frameSeq }).toEqual({
        // The Store's constant, not a literal: the supervisor mirrors this number by
        // hand, and the Store refuses a frame whose version it does not ingest. A bump
        // on one side has to fail here rather than in a turn that never ends.
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        runnerInstanceId: supervisor.instanceId,
        turnId: 'turn-cross-package',
        frameSeq: 1,
      });
      // Finally through the REAL ingester, by the REAL mapping. Everything above
      // proves the frame parses; only this proves the Store takes it — and the Store
      // is what actually ends the turn. It validates the protocol version, the seq,
      // the reserved fence hash and the terminal/event exclusivity, and a frame it
      // throws on leaves the running marker in place, which is the very "session stuck
      // forever" symptom this branch exists to remove. Asserting it against a
      // hand-built copy of the envelope would only prove the copy.
      //
      // The store is built HERE rather than in a file-level hook: this is the only
      // test in the file that needs one, and a `beforeAll` would pay for a migrated
      // database in every run of the other hundred and forty.
      //
      // Isolated rather than shared, and not by preference: other tests in this file
      // drive fake timers, and the shared harness resolves to one socket-backed
      // PostgreSQL in CI, which `advanceTimersByTimeAsync` cannot flush. The guard in
      // `scripts/test-db-harness.test.ts` enforces that pairing per FILE — by grepping
      // for the shared factory's NAME, so do not write it here even in prose — which
      // makes the choice the file's, not this test's. A private pglite costs a WASM
      // boot; correctness in CI is worth it.
      ctx = await createIsolatedTestDb();
      await ctx.store.createSession({
        sessionId: 'session-cross-package',
        worktree: runtimeDir,
        model: 'claude-opus-4-8',
      });
      await ctx.store.markTurnRunning({ sessionId: 'session-cross-package', promptSeq: 1 });
      await ctx.store.bindTurnIdentity('session-cross-package', {
        turnId: 'turn-cross-package',
        startCommandId: 'start-cross-package',
      });
      await expect(
        ctx.store.ingestRunnerFrame('session-cross-package', runnerFrameIngestEnvelope(frame)),
      ).resolves.toEqual({ outcome: 'accepted' });
      // The marker is gone, so the session is usable again rather than waiting on a
      // Runner that died three hundred milliseconds ago.
      expect(await ctx.store.listRunningTurns()).toEqual([]);
    } finally {
      await supervisor.close();
      await ctx?.close();
    }
  });

  // A clean exit with nothing in the stream is still a failed turn: the Server's
  // terminal-marker safety net ignores exit 0, so reporting the process's own code
  // would leave the session badged running with no event that ever ends it.
  it('reports an empty stream after a clean worker exit as a failed turn', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(0)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-silent-success',
        startCommandId: 'start-silent-success',
        sessionId: 'session-silent-success',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'say nothing',
      });
      await vi.waitFor(
        async () => {
          expect(await readTurnState(runtimeDir, 'turn-silent-success')).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      const frame = JSON.parse(
        (await readFile(join(runtimeDir, 'turns/turn-silent-success/events.jsonl'), 'utf8')).trim(),
      ) as { result: { exitCode: number; stderr: string } };
      // The process's own 0 stays in the turn state; the frame carries the turn's
      // verdict, which is that nothing was produced.
      expect(frame.result.exitCode).toBe(1);
      expect(frame.result.stderr).toMatch(/before producing any event/u);
    } finally {
      await supervisor.close();
    }
  });

  // The invariant that makes the synthetic frame safe: a worker that wrote even one
  // frame owns `turnId` → its own `runnerInstanceId` and the sequence after it, so
  // the supervisor must never append under a second instance id (ADR 0006 D3).
  it('never appends to an event stream a worker already owns', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'events.jsonl'),JSON.stringify({protocolVersion:1,runnerInstanceId:'worker-owned',turnId:'turn-owned-stream',frameSeq:1,payloadHash:'x',kind:'session',id:'session-owned'})+'\\n');process.exit(4);`,
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-owned-stream',
        startCommandId: 'start-owned-stream',
        sessionId: 'session-owned',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'write then die',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-owned-stream')).toMatchObject({
          status: 'settled',
          workerExitCode: 4,
        });
      });
      const lines = (
        await readFile(join(runtimeDir, 'turns/turn-owned-stream/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        runnerInstanceId: 'worker-owned',
        kind: 'session',
      });
    } finally {
      await supervisor.close();
    }
  });

  // A turn the operator cancelled is not a crash. The SIGKILL that ends the grace
  // window would otherwise reach the session as `agent exited with code 137`.
  it('marks the synthetic frame of a cancelled turn as aborted', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-cancel-frame',
        startCommandId: 'start-cancel-frame',
        sessionId: 'session-cancel-frame',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'wait to be cancelled',
      });
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancel-frame',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
      const frame = JSON.parse(
        (await readFile(join(runtimeDir, 'turns/turn-cancel-frame/events.jsonl'), 'utf8')).trim(),
      ) as { kind: string; result: { aborted: boolean } };
      expect(frame.kind).toBe('result');
      expect(frame.result.aborted).toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  it('delivers inline image attachments to the worker over start-turn', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      // Pin runtime ownership to this process (self-owned mkdtemp) so the check passes
      // without depending on the container's VERITY_RUNNER_RUNTIME_UID/GID (1101).
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'worker-started.json'),JSON.stringify(request));process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
    });
    try {
      const imageResponse = await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-image',
        startCommandId: 'start-image',
        sessionId: 'session-image',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'describe this',
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      });
      expect(imageResponse).toMatchObject({ ok: true, outcome: 'created' });
      // The worker receives the SAME normalized image block the in-process runner
      // hands its backend, persisted verbatim in request.json.
      await vi.waitFor(async () => {
        expect(
          JSON.parse(
            await readFile(join(runtimeDir, 'turns/turn-image/worker-started.json'), 'utf8'),
          ),
        ).toMatchObject({
          turnId: 'turn-image',
          prompt: 'describe this',
          attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
        });
      });
    } finally {
      await supervisor.close();
    }
  });

  it('settles a worker that exits immediately without missing its exit event', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(0)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-fast',
        startCommandId: 'start-fast',
        sessionId: 'session-fast',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fast',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-fast')).toMatchObject({
          status: 'settled',
          workerExitCode: 0,
        });
      });
      const terminal = JSON.parse(
        await readFile(join(runtimeDir, 'turns', 'turn-fast', 'events.jsonl'), 'utf8'),
      ) as { kind: string; result: { exitCode: number; stderr: string } };
      expect(terminal).toMatchObject({
        kind: 'result',
        result: {
          exitCode: 1,
          stderr: 'runner worker exited successfully before producing any event',
        },
      });
    } finally {
      await supervisor.close();
    }
  });

  it('does not persist raw details from a worker spawn exception', async () => {
    const secret = ['unknown', 'credential', 'value'].join('-');
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      spawnWorker: () => {
        throw new Error(`connector spawn rejected token: ${secret}`);
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-spawn-error',
          startCommandId: 'start-spawn-error',
          sessionId: 'session-spawn-error',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'fail safely',
        }),
      ).resolves.toMatchObject({ ok: false, error: 'runner worker spawn failed' });
      await expect(readTurnState(runtimeDir, 'turn-spawn-error')).resolves.toMatchObject({
        status: 'settled',
        workerError: 'runner worker spawn failed',
      });
      const state = await readTurnState(runtimeDir, 'turn-spawn-error');
      expect(state?.workerError).not.toContain(secret);
    } finally {
      await supervisor.close();
    }
  });

  it('persists bounded private stderr only when the worker fails', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        "process.stderr.write('x'.repeat(32*1024)+'\\nspecific failure');process.exit(7)",
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-failure',
        startCommandId: 'start-stderr-failure',
        sessionId: 'session-stderr-failure',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-failure');
        expect(state).toMatchObject({
          status: 'settled',
          workerExitCode: 7,
          workerError: 'worker stderr reported an unrecognized failure',
        });
        expect(Buffer.byteLength(state?.workerError ?? '')).toBeLessThanOrEqual(16 * 1024);
      });
    } finally {
      await supervisor.close();
    }
  });

  it('does not persist stderr from a successful worker', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.stderr.write('successful diagnostic');process.exit(0)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-success',
        startCommandId: 'start-stderr-success',
        sessionId: 'session-stderr-success',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'succeed',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-success');
        expect(state).toMatchObject({ status: 'settled', workerExitCode: 0 });
        expect(state).not.toHaveProperty('workerError');
      });
    } finally {
      await supervisor.close();
    }
  });

  it('redacts credentials from persisted worker stderr', async () => {
    const secret = ['sk', 'ant', 'api03', 'abcDEF123', '456789ghiJKL'].join('-');
    const privateKeyBegin = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const privateKeyEnd = ['-----END ', 'PRIVATE KEY-----'].join('');
    const databaseUrl = ['postgres://user:', 'password', '@host/db'].join('');
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        [
          `process.stderr.write('x'.repeat(16*1024-10)+'${secret}\\n');`,
          `process.stderr.write('${privateKeyBegin}'+'x'.repeat(17*1024)+'\\nsensitivePemBody\\n${privateKeyEnd}\\n');`,
          `process.stderr.write('{\\"authorization\\":\\"Bearer structured-secret\\"} DATABASE_URL=${databaseUrl} token=lowercase-secret --api-key cli-secret authentication failed');`,
          'process.exit(8);',
        ].join(''),
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-secret',
        startCommandId: 'start-stderr-secret',
        sessionId: 'session-stderr-secret',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail safely',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-secret');
        expect(state).toMatchObject({
          status: 'settled',
          workerExitCode: 8,
          workerError: 'worker stderr reported an authentication failure',
        });
        expect(state?.workerError).not.toContain(secret);
        expect(state?.workerError).not.toContain('sensitivePemBody');
        expect(state?.workerError).not.toContain('structured-secret');
        expect(state?.workerError).not.toContain('user:password');
        expect(state?.workerError).not.toContain('lowercase-secret');
        expect(state?.workerError).not.toContain('cli-secret');
      });
    } finally {
      await supervisor.close();
    }
  });

  it('settles when a worker descendant keeps the stderr pipe open', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "spawn(process.execPath,['-e','setTimeout(()=>{},10_000)'],{stdio:['ignore','ignore',2]});",
          "process.stderr.write('worker failed before descendant exit');",
          'process.exit(9);',
        ].join(''),
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-descendant',
        startCommandId: 'start-stderr-descendant',
        sessionId: 'session-stderr-descendant',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail with inherited stderr',
      });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-stderr-descendant');
          expect(state).toMatchObject({
            status: 'settled',
            workerExitCode: 9,
            workerError: 'worker stderr reported an unrecognized failure',
          });
        },
        { timeout: 2_000 },
      );
    } finally {
      await supervisor.close();
    }
  });

  it('escalates a SIGTERM-resistant worker to SIGKILL during shutdown', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.VERITY_RUNNER_TURN_DIR+'/ready','');setInterval(()=>{},1000)",
      ],
      shutdownGraceMs: 10,
    });
    await supervisorRequest(supervisor.socketPath, {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-stubborn',
      startCommandId: 'start-stubborn',
      sessionId: 'session-stubborn',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'stubborn',
    });
    await vi.waitFor(async () => {
      await expect(readFile(join(runtimeDir, 'turns/turn-stubborn/ready'))).resolves.toBeDefined();
    });
    await supervisor.close();
    await expect(readTurnState(runtimeDir, 'turn-stubborn')).resolves.toMatchObject({
      status: 'settled',
      workerSignal: 'SIGKILL',
    });
  });

  it('runs bundled ACP workers end-to-end', async () => {
    const binDir = join(runtimeDir, 'bin');
    await mkdir(binDir);
    const codex = join(binDir, 'codex');
    await writeFile(
      codex,
      `#!/bin/sh
if [ "$1" = 'app-server' ]; then
  read initialize
  printf '%s\\n' '{"id":1,"result":{}}'
  read initialized
  read thread_start
  printf '%s\\n' '{"id":2,"result":{"thread":{"id":"codex-app-s1"}}}'
  read turn_start
  printf '%s\\n' '{"id":3,"result":{"turn":{"id":"codex-app-turn"}}}'
	  printf '%s\\n' '{"id":99,"method":"item/tool/call","params":{"threadId":"codex-app-s1","turnId":"codex-app-turn","callId":"secret-call-1","namespace":null,"tool":"verity_secret_job","arguments":{"kind":"restricted","profile":{"id":"profile-1","version":1,"policyHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"parameters":{"operation":"list"},"snapshotId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}}'
	  read tool_result
	  printf '%s\\n' '{"method":"item/completed","params":{"threadId":"codex-app-s1","turnId":"codex-app-turn","completedAtMs":1,"item":{"type":"dynamicToolCall","id":"secret-call-1","tool":"verity_secret_job","arguments":{},"status":"completed","success":true}}}'
	  sleep 1
	  printf '%s\\n' '{"method":"item/agentMessage/delta","params":{"delta":"approval received"}}'
  printf '%s\\n' '{"method":"turn/completed","params":{"threadId":"codex-app-s1","turn":{"id":"codex-app-turn","status":"completed","error":null}}}'
  exit 0
fi
all_args="$*"
# The supervisor's turn timeout is backend-agnostic; Codex carries it now that the
# native Claude worker is gone.
case "$*" in
  *timeout-codex*) sleep 2; exit 0 ;;
esac
require_image=''
case "$*" in
  *'image through native Codex worker'*) require_image=1 ;;
esac
image=''
saw_exec=''
saw_resume=''
saw_session=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = 'exec' ]; then saw_exec=1; fi
  if [ "$1" = 'resume' ]; then
    if [ -z "$saw_exec" ]; then exit 42; fi
    saw_resume=1
  fi
  if [ "$1" = 'codex-native-s1' ]; then
    if [ -z "$saw_resume" ]; then exit 42; fi
    saw_session=1
  fi
  if [ "$1" = '--image' ]; then shift; image="$1"; fi
  shift
done
if [ -n "$require_image" ] && [ -z "$image" ]; then exit 40; fi
if [ -n "$image" ] && [ "$(cat "$image")" != 'hi' ]; then exit 41; fi
case "$all_args" in
  *'resume native Codex worker'*)
    if [ -z "$saw_exec" ] || [ -z "$saw_resume" ] || [ -z "$saw_session" ]; then exit 42; fi
    ;;
esac
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-native-s1"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`,
    );
    await chmod(codex, 0o755);
    const codexAcp = join(binDir, 'codex-acp');
    await writeFile(
      codexAcp,
      `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let sessionId = 'codex-acp-bundled-s1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
    } });
  } else if (message.method === 'session/new') {
    writeFileSync(join(message.params.cwd, '.acp-mcp-capture.json'), JSON.stringify(message.params.mcpServers));
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      modes: { currentModeId: 'agent-full-access', availableModes: [
        { id: 'agent-full-access', name: 'Agent Full Access' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from bundled codex-acp' } },
    } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.id !== undefined) {
    appendFileSync(join(process.cwd(), '.acp-unexpected.jsonl'), JSON.stringify(message) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
    );
    await chmod(codexAcp, 0o755);
    // The Claude arm of the same end-to-end path. Since ADR 0012 removed the native
    // transport, `claude-acp` is Claude's ONLY transport — so without this the real
    // bundled worker is never once exercised for the backend every Claude session in
    // the fleet now runs on, and the composition that would break (this bundle, that
    // profile, the broker's `claude-agent-acp` mapping) is covered nowhere.
    //
    // Deliberately NOT a copy of the Codex fake with the name swapped: it answers
    // `session/set_mode`, which is the part of the handshake the two profiles do
    // differently. Codex pins its mode to a constant, while Claude's derives from the
    // caller's `permissionMode` — so the mode reaching the agent is worth asserting
    // for Claude and meaningless for Codex.
    const claudeAcp = join(binDir, 'claude-agent-acp');
    await writeFile(
      claudeAcp,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const sessionId = 'claude-acp-bundled-s1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
    } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId,
      modes: { currentModeId: 'default', availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
        { id: 'acceptEdits', name: 'Accept Edits' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/load') {
    writeFileSync(join(process.cwd(), '.acp-claude-load.json'), JSON.stringify(message.params));
    send({ jsonrpc: '2.0', id: message.id, result: {
      modes: { currentModeId: 'default', availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'default', name: 'Default' },
      ] },
      configOptions: [],
    } });
  } else if (message.method === 'session/set_mode') {
    writeFileSync(join(process.cwd(), '.acp-claude-mode.json'), JSON.stringify(message.params));
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from bundled claude-agent-acp' } },
    } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
    );
    await chmod(claudeAcp, 0o755);
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      codexPath: codex,
      codexAcpPath: codexAcp,
      claudeAcpPath: claudeAcp,
      worktreeRoot: runtimeDir,
      // Both ACP fakes are Node scripts, so they run under THIS node rather than
      // whatever `#!/usr/bin/env node` resolves to on the runner. The native Codex
      // fake is `/bin/sh` and is executed directly, as before.
      spawnChild: (_command, args, options) =>
        args[7] === codexAcp || args[7] === claudeAcp
          ? spawn(process.execPath, [args[7], ...args.slice(8)], options)
          : spawn(args[7]!, args.slice(8), options),
    });
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [resolve('features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs')],
      workerBackends: ['codex-acp', 'claude-acp'],
      workerEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        // Derive the rest exactly the way the production entry does, from a stand-in
        // container env. Naming VERITY_MCP_GATEWAY_URL here directly is what let this
        // test pass while the supervisor never forwarded it: the gateway reached the
        // ACP worker in the test harness and nowhere else.
        ...supervisorWorkerEnv({
          VERITY_AGENT_SPAWN_BROKER_SOCKET: broker.socketPath,
          VERITY_MCP_GATEWAY_URL: 'http://relay.internal/internal/mcp',
        }),
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-unsupported',
          startCommandId: 'start-unsupported',
          sessionId: 'session-unsupported',
          // A backend the request validator parses but this supervisor was not
          // launched for — the gate under test. `opencode` used to play that part
          // and cannot any more: since the ACP migration it is not a parseable
          // backend name at all, so it would be refused one step earlier and prove
          // nothing about `workerBackends`.
          backend: 'pi',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'must not be claimed',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/does not support backend/),
      });
      await expect(readTurnState(runtimeDir, 'turn-unsupported')).resolves.toBeUndefined();

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-codex-acp',
          startCommandId: 'start-codex-acp',
          sessionId: 'session-codex-acp',
          backend: 'codex-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'hello through bundled Codex ACP worker',
          steerable: true,
          permissionControl: true,
          mcpGatewayToken: 'turn-bound-gateway-bearer',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-codex-acp');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      await expect(
        readFile(join(runtimeDir, '.acp-mcp-capture.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toEqual([
        {
          name: 'verity',
          type: 'http',
          url: 'http://relay.internal/internal/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer turn-bound-gateway-bearer' }],
        },
      ]);
      const acpFrames = (
        await readFile(join(runtimeDir, 'turns/turn-codex-acp/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(acpFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'session', id: 'codex-acp-bundled-s1' }),
          expect.objectContaining({
            kind: 'event',
            event: {
              t: 'text',
              delta: 'hello from bundled codex-acp',
            },
          }),
        ]),
      );

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-claude-acp',
          startCommandId: 'start-claude-acp',
          sessionId: 'session-claude-acp',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'hello through bundled Claude ACP worker',
          permissionMode: 'plan',
          steerable: true,
          permissionControl: true,
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-claude-acp');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      // The requested posture reached the agent as a real `session/set_mode`. This is
      // the §5b invariant observed from the far end of the whole chain — supervisor,
      // bundled worker, ACP client, Claude profile — rather than at the seam that
      // asserts it, and it is what the profile's `permissionModes` vocabulary bounds.
      await expect(
        readFile(join(runtimeDir, '.acp-claude-mode.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toMatchObject({ sessionId: 'claude-acp-bundled-s1', modeId: 'plan' });
      const claudeFrames = (
        await readFile(join(runtimeDir, 'turns/turn-claude-acp/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(claudeFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'session', id: 'claude-acp-bundled-s1' }),
          expect.objectContaining({
            kind: 'event',
            event: { t: 'text', delta: 'hello from bundled claude-agent-acp' },
          }),
        ]),
      );

      // Resume through the bundled worker. The deleted native `turn-native-resume`
      // case was the only end-to-end exercise of `resumeSessionId`, and Codex cannot
      // take its place — its profile declares `loadSessionUnsupported`, so `session/load`
      // is reachable through Claude alone. Everything between the supervisor request
      // and the agent is the real bundle.
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-claude-acp-resume',
          startCommandId: 'start-claude-acp-resume',
          sessionId: 'session-claude-acp',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'resume through bundled Claude ACP worker',
          resumeSessionId: 'claude-acp-bundled-s1',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-claude-acp-resume');
          expect(state, JSON.stringify(state)).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      // It resumed rather than starting over: the agent saw `session/load` carrying the
      // id from the first turn, in this worktree.
      await expect(
        readFile(join(runtimeDir, '.acp-claude-load.json'), 'utf8').then(
          (value) => JSON.parse(value) as unknown,
        ),
      ).resolves.toMatchObject({ sessionId: 'claude-acp-bundled-s1', cwd: runtimeDir });
    } finally {
      await supervisor.close();
      await broker.close();
    }
  });

  it('rejects pipelined and oversized frames without applying a claim', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    const rawRequest = async (payload: string): Promise<Record<string, unknown>> =>
      await new Promise((resolve, reject) => {
        const socket = createConnection(supervisor.socketPath);
        let response = '';
        socket.once('error', reject);
        socket.on('data', (chunk) => {
          response += chunk.toString('utf8');
        });
        socket.once('end', () => resolve(JSON.parse(response) as Record<string, unknown>));
        socket.once('connect', () => socket.write(payload));
      });
    try {
      const claim = JSON.stringify({
        protocolVersion: 1,
        kind: 'claim-turn',
        turnId: 'pipelined',
        startCommandId: 'start-pipelined',
      });
      await expect(rawRequest(`${claim}\n${claim}\n`)).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/exactly one request/),
      });
      expect(await listTurns(runtimeDir)).toEqual([]);

      await expect(rawRequest(`${'x'.repeat(4 * 1024 * 1024 + 2)}\n`)).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/frame too large/),
      });
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  // The refusal used to be destroyed along with the connection: `socket.end(frame,
  // () => socket.destroy())` cuts off a peer that is still streaming, so the
  // Server's remaining write died with EPIPE and the frame naming the cause never
  // landed. That is what an operator sending two phone photos saw — `write EPIPE`,
  // naming neither the size nor the attachments. Keep answering a peer mid-write.
  it('answers an oversize frame to a peer that is still writing it', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      const socket = createConnection(supervisor.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      let response = '';
      let unanswered: Error | undefined;
      // Only a failure that beats the refusal is the one this test is about.
      // Once the answer has landed the supervisor is entitled to close, and the
      // writes still queued here then fail for the ordinary reason — the
      // incident was a peer that got `write EPIPE` *instead of* an answer.
      const noteWriteError = (error: Error): void => {
        if (response.length === 0) unanswered ??= error;
      };
      socket.removeAllListeners('error');
      socket.on('error', noteWriteError);
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
      });
      // Attached before the first write, not after the loop: the refusal can be
      // answered and the connection closed while this loop is still turning, and
      // a listener added afterwards waits for an event that has already fired.
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const megabyte = 'x'.repeat(1024 * 1024);
      // Eight separate writes with the event loop turning in between: the cap is
      // crossed early and several more writes are still to come.
      for (let index = 0; index < 8; index += 1) {
        socket.write(megabyte, (error) => {
          if (error !== undefined && error !== null) noteWriteError(error);
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Tell the supervisor that the request stream is complete. It deliberately
      // drains an oversized peer rather than resetting it, so its refusal cannot
      // be lost behind an RST, and this half-close is what lets that drain
      // finish instead of running down the grace timer.
      socket.end();
      await closed;

      expect(JSON.parse(response.trim())).toMatchObject({
        ok: false,
        error: expect.stringMatching(/frame too large/),
      });
      expect(unanswered).toBeUndefined();
      // Draining a refused payload must not cost the supervisor its next request.
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  it('destroys an idle connection during shutdown', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    const idle = createConnection(supervisor.socketPath);
    await new Promise<void>((resolve, reject) => {
      idle.once('connect', resolve);
      idle.once('error', reject);
    });
    await expect(supervisor.close()).resolves.toBeUndefined();
    expect(idle.destroyed).toBe(true);
  });
});

async function connectorValidationEnv(): Promise<
  NodeJS.ProcessEnv & {
    VERITY_CLAUDE_EGRESS_KEY: string;
  }
> {
  const ca = join(runtimeDir, 'ca.pem');
  const cert = join(runtimeDir, 'client-cert.pem');
  const key = join(runtimeDir, 'client-key.pem');
  await Promise.all([
    writeFile(ca, 'test-ca'),
    writeFile(cert, 'test-cert'),
    writeFile(key, 'test-key', { mode: 0o640 }),
  ]);
  await chmod(key, 0o640);
  return {
    PATH: process.env.PATH,
    VERITY_RUNNER_RUNTIME_UID: String(process.getuid?.() ?? 1000),
    VERITY_RUNNER_RUNTIME_GID: String(process.getgid?.() ?? 1000),
    VERITY_CLAUDE_CONNECTOR_PORT: '47821',
    VERITY_CLAUDE_CONNECTOR_AUTHORITY: '127.0.0.1:47821',
    VERITY_CLAUDE_EGRESS_URL: 'https://gateway.internal:8443',
    VERITY_CLAUDE_EGRESS_AUTHORITY: 'gateway.internal:8443',
    VERITY_CLAUDE_EGRESS_CA: ca,
    VERITY_CLAUDE_EGRESS_CERT: cert,
    VERITY_CLAUDE_EGRESS_KEY: key,
  };
}

/**
 * S7 — supervisor crash-safety (ADR 0006), real process, NO Docker. The runtime dir is
 * a self-owned `mkdtemp` (chmod 0o770) so `validateRuntimeDirectory` defaults the
 * expected uid to `process.getuid()` and passes without depending on UID 1101 or the
 * privileged launchers. Two net-new properties:
 *   - a worker SIGKILLed MID-TURN (out of band) is durably settled with its signal;
 *   - a fresh supervisor reclaims the SAME runtimeDir, adopts the lock-owning worker,
 *     and observes its later exit without being that worker's parent.
 * The genuine crash-time flock reclaim (process death drops the OFD lock) is already
 * proven by the `acquireSingleton` dead-holder / cross-process fence tests above; this
 * block covers the full-`runSupervisor` restart path those do not.
 */
describe('supervisor crash-safety: worker death + restart (S7)', () => {
  // A long-lived worker: writes a `ready` sentinel, then idles until it is killed.
  const longLivedWorker = [
    '-e',
    "require('fs').writeFileSync(process.env.VERITY_RUNNER_TURN_DIR+'/ready','');setInterval(()=>{},1000)",
  ];

  // Pin the expected runtime ownership to THIS process's own uid/gid so the self-owned
  // `mkdtemp` dir validates cleanly, overriding the container's VERITY_RUNNER_RUNTIME_UID/GID
  // (1101) which would otherwise make `validateRuntimeDirectory` reject our 1000-owned dir.
  const selfOwned = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const startTurn = (turnId: string): Record<string, unknown> => ({
    protocolVersion: 1,
    kind: 'start-turn',
    turnId,
    startCommandId: `start-${turnId}`,
    sessionId: `session-${turnId}`,
    backend: 'claude-acp',
    worktree: runtimeDir,
    cwd: runtimeDir,
    prompt: 'work',
  });

  const markWorkerLockProtocol = async (turnId: string): Promise<void> => {
    const state = await readTurnState(runtimeDir, turnId);
    await writeFile(
      join(runtimeDir, 'turns', turnId, 'state.json'),
      `${JSON.stringify({ ...state, workerLock: true })}\n`,
    );
  };

  it('durably records terminal settlement when the worker is SIGKILLed mid-turn', async () => {
    const runnerRuntime = join(runtimeDir, 'runners', 'project-crash');
    await mkdir(runnerRuntime, { recursive: true });
    await chmod(runnerRuntime, 0o770);
    const supervisor = await runSupervisor({
      runtimeDir: runnerRuntime,
      ...selfOwned,
      workerCommand: process.execPath,
      workerArgs: longLivedWorker,
    });
    try {
      const request = {
        ...startTurn('turn-killed'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      };
      await supervisorRequest(supervisor.socketPath, request);

      // The turn is durably running; capture the live worker's PID from state.json.
      let workerPid = 0;
      await vi.waitFor(async () => {
        const state = (await readTurnState(runnerRuntime, 'turn-killed')) as {
          status: string;
          workerPid?: number;
        };
        expect(state.status).toBe('running');
        expect(typeof state.workerPid).toBe('number');
        workerPid = state.workerPid ?? 0;
      });

      // Kill the worker MID-TURN, out of band (models the worker process crashing).
      process.kill(workerPid, 'SIGKILL');

      // The supervisor observes the exit and durably settles the turn WITH its signal —
      // the terminal exit/signal record survives on disk.
      await vi.waitFor(async () => {
        expect(await readTurnState(runnerRuntime, 'turn-killed')).toMatchObject({
          status: 'settled',
          workerSignal: 'SIGKILL',
        });
      });

      const recovery = new SupervisorRunnerRecovery({
        dataVolumeRoot: runtimeDir,
        getSession: async () => ({ projectId: 'project-crash' }),
      });
      const outcome = await recovery.discover({
        sessionId: 'session-turn-killed',
        turnId: 'turn-killed',
        startCommandId: 'start-turn-killed',
      });
      // `live`, where a SIGKILLed worker used to be `dead`. The supervisor left a
      // terminal frame behind, so recovery has something to replay: it tails the
      // event stream, reads that frame and settles the turn with the real cause.
      // `dead` was the outcome for a stream with nothing in it, and the control
      // socket recovery would otherwise need is only demanded of a `running` turn.
      expect(outcome).toMatchObject({ status: 'live' });
      const terminal = JSON.parse(
        await readFile(join(runnerRuntime, 'turns', 'turn-killed', 'events.jsonl'), 'utf8'),
      ) as {
        kind: string;
        turnId: string;
        result: { exitCode: number; stderr: string };
      };
      expect(terminal).toMatchObject({
        kind: 'result',
        turnId: 'turn-killed',
        result: {
          // POSIX `128 + signum`, the encoding the Server's own exit-code checks read.
          exitCode: 137,
          stderr: 'runner worker terminated by signal SIGKILL before producing any event',
        },
      });
      // And `live` has to mean recoverable, not merely discoverable. The Conductor's
      // only move on this verdict is `runner.attach(target)`, so make that move: the
      // turn must settle from the stream alone. This worker was SIGKILLed and left no
      // `control.sock` behind — a reattach that waited for one would hang exactly
      // where the old `dead` verdict at least ended the turn.
      if (outcome.status !== 'live') throw new Error(`expected a live turn, got ${outcome.status}`);
      const target: RunnerAttachTarget = outcome.target;
      expect(existsSync(target.controlSocketPath)).toBe(false);
      const attachClient = new SupervisorRunnerClient(
        { runnerSupervisorBackend: 'claude-acp' } as Backend,
        {
          runtimeDir: runnerRuntime,
          store: { ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }) },
          bus: new InMemoryEventBus(),
        },
      );
      await expect(attachClient.attach(target, {}).result).resolves.toMatchObject({
        exitCode: 137,
        aborted: false,
      });
    } finally {
      await supervisor.close();
    }
  });

  it('cancels a running worker through the supervisor control plane', async () => {
    const runnerRuntime = join(runtimeDir, 'runners', 'project-cancel');
    await mkdir(runnerRuntime, { recursive: true });
    await chmod(runnerRuntime, 0o770);
    const supervisor = await runSupervisor({
      runtimeDir: runnerRuntime,
      ...selfOwned,
      workerCommand: process.execPath,
      workerArgs: longLivedWorker,
      shutdownGraceMs: 100,
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        ...startTurn('turn-cancelled'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      });
      await supervisorRequest(supervisor.socketPath, {
        ...startTurn('turn-unrelated'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      });
      await vi.waitFor(async () => {
        await expect(readTurnState(runnerRuntime, 'turn-cancelled')).resolves.toMatchObject({
          status: 'running',
        });
        await expect(readTurnState(runnerRuntime, 'turn-unrelated')).resolves.toMatchObject({
          status: 'running',
        });
      });

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancelled',
        }),
      ).resolves.toMatchObject({ outcome: 'cancelled' });
      await expect(readTurnState(runnerRuntime, 'turn-cancelled')).resolves.toMatchObject({
        status: 'settled',
        workerSignal: 'SIGTERM',
      });
      await expect(readTurnState(runnerRuntime, 'turn-unrelated')).resolves.toMatchObject({
        status: 'running',
      });

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancelled',
        }),
      ).resolves.toMatchObject({ outcome: 'terminal' });
    } finally {
      await supervisor.close();
    }
  });

  it('adopts a worker across a real supervisor SIGKILL and observes its later exit', async () => {
    const moduleUrl = new URL(
      '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      import.meta.url,
    ).href;
    const script = `
      import { runSupervisor } from ${JSON.stringify(moduleUrl)};
      await runSupervisor({
        runtimeDir: process.argv[1],
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        workerCommand: process.execPath,
        workerArgs: ['-e', 'setInterval(()=>{},1000)'],
      });
      process.stdout.write('ready\\n');
      setInterval(()=>{},1000);
    `;
    const supAProcess = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script, runtimeDir],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let workerPid = 0;
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const cleanup = (): void => {
          supAProcess.removeListener('error', onError);
          supAProcess.removeListener('exit', onExit);
          supAProcess.stdout?.removeListener('data', onData);
        };
        const onError = (error: Error): void => {
          cleanup();
          rejectReady(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          cleanup();
          rejectReady(new Error(`supervisor A exited before ready (${signal ?? String(code)})`));
        };
        const onData = (): void => {
          cleanup();
          resolveReady();
        };
        supAProcess.once('error', onError);
        supAProcess.once('exit', onExit);
        supAProcess.stdout?.once('data', onData);
      });
      await supervisorRequest(join(runtimeDir, 'supervisor.sock'), {
        ...startTurn('turn-persist'),
        backend: 'codex-acp',
        trustedCliExecution: true,
      });
      const running = await readTurnState(runtimeDir, 'turn-persist');
      expect(running).toMatchObject({ status: 'running', workerPid: expect.any(Number) });
      workerPid = Number(running?.workerPid);

      // Kill ONLY supervisor A. The worker retains worker.lock fd 3 and survives.
      supAProcess.kill('SIGKILL');
      await new Promise<void>((resolveExit) => supAProcess.once('exit', () => resolveExit()));
      expect(() => process.kill(workerPid, 0)).not.toThrow();

      const broker = await runAgentSpawnBroker({
        runtimeDir,
        enforceRoot: false,
        agentUid: 1000,
        agentGid: 1000,
        worktreeRoot: runtimeDir,
        secretDir: join(runtimeDir, 'adopted-worker-secrets'),
        spawnChild: (_command, args, options) => spawn(args[7]!, args.slice(8), options),
      });
      const supB = await runSupervisor({
        runtimeDir,
        ...selfOwned,
        workerCommand: process.execPath,
        workerArgs: longLivedWorker,
        adoptionPollMs: 60_000,
        brokerSocket: broker.socketPath,
      });
      try {
        await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
        await expect(readTurnState(runtimeDir, 'turn-persist')).resolves.toMatchObject({
          status: 'running',
          workerPid,
        });
        const trustedCliFrames = await supervisorRequestFrames(supB.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId: 'turn-persist',
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'adopted-secret' }],
          command: ['/bin/true'],
        });
        expect(trustedCliFrames).toEqual([
          { ok: true, kind: 'trusted-cli-started' },
          expect.objectContaining({ ok: true, exitCode: 0 }),
        ]);

        // Supervisor B is not the worker's parent, but lock release is an authoritative
        // exit signal. PID is used only by this test to trigger the exit.
        process.kill(workerPid, 'SIGKILL');
        workerPid = 0;
        await vi.waitFor(() => {
          expect(() => process.kill(Number(running?.workerPid), 0)).toThrow();
        });
        // Do not wait for the adopter poll: authorization checks worker.lock itself,
        // so a cached adopted id cannot forward secrets after the worker exits.
        await expect(
          supervisorRequest(supB.socketPath, {
            protocolVersion: 1,
            kind: 'run-trusted-cli',
            turnId: 'turn-persist',
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'post-exit-secret' }],
            command: ['/bin/true'],
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: 'trusted CLI turn capability is no longer active',
        });
        await vi.waitFor(
          async () => {
            expect(await readTurnState(runtimeDir, 'turn-persist')).toMatchObject({
              status: 'settled',
              workerError: 'worker missing during supervisor recovery',
            });
          },
          { timeout: 4_000 },
        );
      } finally {
        await supB.close();
        await broker.close();
      }
    } finally {
      if (workerPid > 0) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // Best-effort cleanup after an earlier assertion failure.
        }
      }
      if (supAProcess.exitCode === null && supAProcess.signalCode === null) {
        supAProcess.kill('SIGKILL');
      }
    }
  });

  it('settles a claimed turn whose worker never acquired its lock', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-never-spawned', startCommandId: 'start-turn-never-spawned' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-never-spawned');
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-never-spawned')).resolves.toMatchObject({
        status: 'settled',
        workerError: 'worker missing during supervisor recovery',
      });
      // Recovery is the last door left to a settled turn behind an empty stream,
      // which is the Server's definition of `agent exited without a terminal event`.
      // It owes the same frame the start path now always leaves — stamped with the
      // instance that owned the turn, not with this supervisor's.
      const frame = JSON.parse(
        await readFile(join(runtimeDir, 'turns/turn-never-spawned/events.jsonl'), 'utf8'),
      ) as { runnerInstanceId: string; kind: string; result: { stderr: string } };
      expect(frame).toMatchObject({
        kind: 'result',
        runnerInstanceId: 'dead-supervisor',
        result: { stderr: 'worker missing during supervisor recovery' },
      });
    } finally {
      await supervisor.close();
    }
  });

  // The same recovery, for a turn the operator had already stopped. The worker is
  // equally missing, but "the system lost your worker" and "you cancelled this" are
  // different things to be told, and the durable tombstone is the only thing left
  // that knows which happened — the supervisor that handled the cancel is gone.
  it('settles a cancelled turn whose worker is missing as a cancellation, not a crash', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-cancelled-recovery', startCommandId: 'start-cancelled-recovery' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-cancelled-recovery');
    await mkdir(join(runtimeDir, 'cancellations'), { recursive: true, mode: 0o770 });
    await writeFile(
      join(runtimeDir, 'cancellations/turn-cancelled-recovery.json'),
      JSON.stringify({ turnId: 'turn-cancelled-recovery' }),
    );
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-cancelled-recovery')).resolves.toMatchObject({
        status: 'settled',
        workerSignal: 'SIGTERM',
      });
      const frame = JSON.parse(
        await readFile(join(runtimeDir, 'turns/turn-cancelled-recovery/events.jsonl'), 'utf8'),
      ) as { result: { aborted: boolean; exitCode: number; stderr: string } };
      // `aborted` is what keeps the session from badging a failure, and 143 is the
      // exit code the Server reads as an interruption rather than a crash.
      expect(frame.result).toMatchObject({
        aborted: true,
        exitCode: 143,
        stderr: 'runner turn was cancelled; its worker did not survive the supervisor restart',
      });
    } finally {
      await supervisor.close();
    }
  });

  // The other end of that path, and the one place it deliberately does nothing. A turn
  // whose state file is gone cannot be settled truthfully — there is no start command
  // to attribute it to and no instance to stamp — and a state invented here would tell
  // the Server a turn failed that it can in fact simply start again.
  it('leaves a turn whose state file has vanished for the Server to reclaim', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-state-vanished', startCommandId: 'start-turn-state-vanished' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-state-vanished');
    await rm(join(runtimeDir, 'turns/turn-state-vanished/state.json'), { force: true });
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      // Long enough for the adopter to have polled this turn several times over.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(readTurnState(runtimeDir, 'turn-state-vanished')).resolves.toBeUndefined();
      // And no frame either: a stream with a verdict in it and no state to match is
      // the same unreadable turn by another route.
      expect(existsSync(join(runtimeDir, 'turns/turn-state-vanished/events.jsonl'))).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  it('leaves a claimed turn uncertain when worker.lock is a symlink', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-lock-symlink', startCommandId: 'start-turn-lock-symlink' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-lock-symlink');
    const outside = join(runtimeDir, 'outside-worker-lock');
    await writeFile(outside, '');
    await symlink(outside, join(runtimeDir, 'turns/turn-lock-symlink/worker.lock'));
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-lock-symlink')).resolves.toMatchObject({
        status: 'claimed',
      });
    } finally {
      await supervisor.close();
    }
  });

  it('keeps a pre-worker-lock legacy turn uncertain during adoption', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-legacy', startCommandId: 'start-turn-legacy' },
      'old-supervisor',
    );
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-legacy')).resolves.toMatchObject({
        status: 'claimed',
      });
      await expect(lstat(join(runtimeDir, 'turns/turn-legacy/worker.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await supervisor.close();
    }
  });
});

// ADR 0006 D9: a Server of version N routinely talks to a Sandbox from N−1. The
// Server writes its requests at its own floor, because every supervisor already
// deployed compares the version for equality; a supervisor must read the range in
// return, or the first bump breaks the pair from whichever side moved first.
describe('supervisor protocol range (ADR 0006 D9)', () => {
  const status = (protocolVersion: unknown) =>
    handleSupervisorRequest('/run/verity-runner', 'runner-1', { protocolVersion, kind: 'status' });

  it('answers a request written at the oldest dialect it supports', async () => {
    await expect(status(MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION)).resolves.toMatchObject({
      ok: true,
      runnerInstanceId: 'runner-1',
    });
  });

  it.each([
    ['newer than it knows', SUPERVISOR_PROTOCOL_VERSION + 1],
    ['older than it supports', MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION - 1],
    ['not a version at all', '1'],
  ])('refuses a request %s', async (_label, version) => {
    await expect(status(version)).rejects.toThrow(/unsupported supervisor protocol/u);
  });
});
