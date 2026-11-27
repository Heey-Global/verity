import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUPERVISOR_REQUEST_BYTES } from '@verity/session';
import { codexGatewayConfig } from './provisioner.js';
import {
  MAX_START_REQUEST_BYTES,
  redactTrustedCliText,
  SUPERVISED_WORKER_BACKENDS,
  installedWorkerBackends,
  supervisorWorkerEnv,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { agentLaunchSpec } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { execFileAsync, supervisorSources } from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('keeps the control-plane Codex provider config aligned with project sandboxes', async () => {
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    const projectConfig = codexGatewayConfig(47_821);
    expect(projectConfig).toContain(
      'http_headers = { "x-openai-actor-authorization" = "verity-codex-gateway-placeholder-v1" }',
    );
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
    // The bundler compiles its own graph; rebuilding every workspace here can
    // exhaust the test deadline before the bundle comparison even starts.
    await expect(
      execFileAsync(process.execPath, ['scripts/build-runner-worker.mjs', '--check']),
    ).resolves.toBeDefined();
  }, 60_000);

  it('opens the supervisor transport for every ACP adapter', async () => {
    expect(SUPERVISED_WORKER_BACKENDS).not.toContain('claude');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('claude-acp');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('codex-acp');
    expect(SUPERVISED_WORKER_BACKENDS).toContain('opencode-acp');
    // `opencode` is the retired native HTTP transport, not a backend name any more.
    expect(SUPERVISED_WORKER_BACKENDS).not.toContain('opencode');
    // The production main block must launch from the constant — through the
    // installed-adapter filter, never a bare literal — so re-narrowing to
    // ['claude'] can never silently regress the gate again.
    const source = await supervisorSources();
    expect(source).toContain('workerBackends: installedWorkerBackends()');
    expect(source).not.toContain("workerBackends: ['claude']");
    // Same reasoning for the worker env: the production entry must build it from the
    // container env through the shared helper, never from an inline literal that only
    // names the broker socket. See the two tests below for what that helper owes.
    expect(source).toContain('workerEnv: supervisorWorkerEnv(process.env)');
    // Admitted to the brokered Verity tools — all three since ADR 0014 Amendment 4.
    // The two sets stay separate on purpose (ADR 0014 D1): being an ACP transport
    // says what an agent can speak, not whose secrets it may spend, and a fourth
    // adapter joins `SUPERVISED_WORKER_BACKENDS` without joining this one. Asserted
    // on the source because `ACP_WORKER_BACKENDS` is module-private — the gate reads
    // it, nothing exports it — and a one-word edit here is exactly the drift worth
    // catching. Matched loosely on purpose: the point is the membership, not the
    // formatting, and a tripwire that fires on Prettier's rewrap would read as a
    // style failure rather than the policy change it is.
    expect(source).toMatch(
      /ACP_WORKER_BACKENDS = new Set\(\[\s*'claude-acp',\s*'codex-acp',\s*'opencode-acp',?\s*\]/,
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

  it('forwards Control memory configuration without leaking a turn bearer from the container', () => {
    expect(
      supervisorWorkerEnv({
        VERITY_CONTROL_MEMORY_URL: 'http://verity/internal/control-plane/memory',
        VERITY_CONTROL_MEMORY_TOKEN: 'stale-container-token',
      }),
    ).toEqual({ VERITY_CONTROL_MEMORY_URL: 'http://verity/internal/control-plane/memory' });
    expect(supervisorWorkerEnv({ VERITY_CONTROL_MEMORY_URL: '' })).toEqual({});
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
          VERITY_CONTROL_MEMORY_URL: 'http://verity/internal/control-plane/memory',
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
    expect(baseCompose).not.toContain('VERITY_OPENCODE_ENABLED');
    expect(baseCompose).not.toContain('VERITY_EXTRA_MODELS');
    expect(baseCompose).not.toContain('OPENCODE_BASE_URL');
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
});
