import {
  FileTailRunnerClient,
  InMemoryEventBus,
  isRunnerSupervisorBackend,
  LoopbackRunnerClient,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  type ConductorDeps,
  type EventBus,
  type RunnerClient,
  type SupervisorRunnerClientOptions,
  type SupervisorRunnerRecoveryOptions,
  transcriptPath,
} from '@verity/session';
import { TranscriptStore } from '@verity/store';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type McpGatewayTokens } from './mcp-gateway-tokens.js';
import type { TurnCredentials } from './turn-credentials.js';
import { supervisorSocketReachable } from './runner-supervisor-socket.js';
import { codexRolloutFiles, ServerCodexTranscript, ServerTranscript } from './runner-transcript.js';

/**
 * Build the runner-related Conductor wiring (ADR 0006). Three mutually exclusive
 * postures, selected by the deployment flags:
 *
 *  - `runnerSupervisor` (Stage 5c, opt-in): each PROJECT turn runs through a
 *    {@link SupervisorRunnerClient} bound to that project's runner-supervisor socket
 *    under `<dataVolumeRoot>/runners/<projectId>`, so an in-flight turn survives a
 *    Server restart on the Sandbox. The Server owns verbatim transcript render+tail
 *    over the shared runner-runtime mount ({@link ServerTranscript}), so
 *    `serverManagedTranscript` omits the per-turn `opts.transcript` (keeping the
 *    supervisor launch guard fail-closed and the server-side tail the single writer),
 *    and {@link SupervisorRunnerRecovery} lets startup recovery REATTACH a still-live
 *    turn (D7) instead of settling it `interrupted`. Project-less Claude ACP and Codex
 *    control-plane sessions (e.g. Verity Control) use the dedicated `verity-control`
 *    supervisor so their approval-gated tools retain the same boundary.
 *  - `runnerTransport` (Stage 2.2-prep, opt-in): the proven in-process
 *    {@link FileTailRunnerClient} event-file/control-socket transport, unchanged.
 *  - neither (DEFAULT): no `runner` override ⇒ the Conductor's in-process loopback,
 *    byte-for-byte the current path, and no `serverManagedTranscript`/`runnerRecovery`.
 *
 * The supervisor posture additionally requires `dataVolumeRoot` (where the provisioner
 * roots each project's runner runtime); absent it there is no socket to bind, so the
 * wiring degrades to the `runnerTransport`/default posture rather than build a broken
 * client.
 */
export function buildRunnerConductorWiring(deps: {
  runnerSupervisor: boolean;
  runnerTransport: boolean;
  dataVolumeRoot: string | undefined;
  /** Fixed project identity used by the separately supervised control-plane runner.
   *  When absent, project-less sessions retain the legacy loopback behavior. */
  controlPlaneProjectId?: string | undefined;
  isControlPlaneProject?: ((projectId: string) => Promise<boolean>) | undefined;
  hostCloneRoot?: string | undefined;
  containerProjectRoot?: string | undefined;
  store: SupervisorRunnerClientOptions['store'];
  bus: EventBus;
  transcript: TranscriptStore;
  allocateEventFile: () => string;
  allocateControlSocket: () => string;
  getSession: SupervisorRunnerRecoveryOptions['getSession'];
  onMissingSupervisorSocket?:
    ((input: { projectId: string; socketPath: string; reason: string }) => void) | undefined;
  /** ADR 0014 D1: per-turn bearer registry for the loopback MCP gateway. Only ACP
   *  turns are issued one; the supervisor client decides that from its own backend. */
  mcpGatewayTokens?: McpGatewayTokens | undefined;
  /** Per-turn sandbox credentials naming the person a turn runs for. */
  turnCredentials?: TurnCredentials | undefined;
  /** Separate audience for configured upstream MCP servers; never accepted by `/internal/mcp`. */
  mcpProxyTokens?: McpGatewayTokens | undefined;
  /** The project's enabled HTTP MCP servers usable in a turn run for `initiatedBy`. */
  listProjectHttpMcpServers?:
    | ((
        projectId: string,
        initiatedBy: { readonly userId: string } | undefined,
      ) => Promise<readonly { id: string; name: string }[]>)
    | undefined;
  /** ADR 0011 D2: resolve a standing grant before a prompt becomes a card + push.
   *  `channel` is supplied by the runner client from its own backend (ADR 0014 D3). */
  autoApprovePermission?:
    | ((
        sessionId: string,
        request: import('@verity/adapter-claude').PermissionRequest,
        channel: import('@verity/session').BrokeredGrantChannel,
      ) => Promise<boolean>)
    | undefined;
}): Pick<ConductorDeps, 'runner' | 'runnerRecovery' | 'serverManagedTranscript'> {
  if (deps.runnerSupervisor && deps.dataVolumeRoot !== undefined) {
    const dataVolumeRoot = deps.dataVolumeRoot;
    const sandboxPath = (path: string): string =>
      runnerSandboxPath(path, deps.hostCloneRoot, deps.containerProjectRoot);
    return {
      serverManagedTranscript: true,
      runnerRecovery: new SupervisorRunnerRecovery({
        dataVolumeRoot,
        getSession: async (sessionId) => {
          const session = await deps.getSession(sessionId);
          if (
            session?.projectId !== null &&
            session?.projectId !== undefined &&
            deps.controlPlaneProjectId !== undefined &&
            deps.isControlPlaneProject !== undefined &&
            (await deps.isControlPlaneProject(session.projectId))
          ) {
            return { projectId: deps.controlPlaneProjectId };
          }
          return session;
        },
        ...(deps.controlPlaneProjectId === undefined
          ? {}
          : { controlPlaneProjectId: deps.controlPlaneProjectId }),
      }),
      runner: async (backend, context) => {
        // Every supervised backend is an ACP one and vice versa (see
        // `RUNNER_SUPERVISOR_BACKENDS`), so ask the closed set rather than restating
        // its members here — a third and fourth agent were exactly the drift this
        // hand-rolled disjunction was waiting for.
        const isAcpBackend = isRunnerSupervisorBackend(backend.runnerSupervisorBackend);
        const controlPlaneTurn =
          isAcpBackend &&
          (context.projectId === null ||
            (deps.isControlPlaneProject !== undefined &&
              (await deps.isControlPlaneProject(context.projectId))));
        // Every ACP backend is runnable there, and that is a property of the container
        // rather than of this function: the control-plane Runner is a single fixed
        // container built and launched by the deployment
        // (`deploy/bin/verity-control-plane-runner-start`) rather than a Sandbox the
        // provisioner composes per project, so each backend's configuration has to be
        // put into its spec by hand. OpenCode's was, and is held there by
        // `scripts/verity-compose.test.ts`: the read-only `secrets/opencode` mount,
        // `OPENCODE_CONFIG`, `XDG_CONFIG_HOME`, and an egress leg it shares with Codex
        // (the connector routes /opencode over the Codex gateway, so the certificates
        // that reach one reach the other). Until that landed this refused
        // `opencode-acp` here, because a turn started without it spawns an agent with
        // no provider and fails somewhere inside the first prompt rather than saying
        // so — and the loopback is not an alternative for any ACP backend.
        const useControlPlaneRunner = controlPlaneTurn;
        const runnerProjectId = useControlPlaneRunner
          ? deps.controlPlaneProjectId
          : (context.projectId ?? undefined);
        // A deployment without the dedicated control-plane runner retains the
        // legacy loopback only for non-ACP backends. ACP must never start in
        // the credential-bearing Server process.
        if (runnerProjectId === undefined) {
          if (isAcpBackend) {
            throw new Error('ACP control-plane turns require the dedicated control-plane runner.');
          }
          return new LoopbackRunnerClient(backend);
        }
        // Only backends with a native worker adapter may cross this process boundary.
        // Nothing Verity ships lands here any more — OpenCode was the last backend
        // without one and now declares `opencode-acp` — so this is the fallback for a
        // backend that declares no supervisor protocol, including a test double.
        if (backend.runnerSupervisorBackend === undefined) {
          return new LoopbackRunnerClient(backend);
        }
        const runtimeDir = join(dataVolumeRoot, 'runners', runnerProjectId);
        // Provisioning can deliberately disable the Sandbox supervisor for a project
        // when its container boundary is not safe for Stage 5c. Native backends may
        // still use the legacy in-process loopback, but ACP must never do so:
        // its adapter belongs behind the Sandbox spawn broker and its MCP gateway
        // capability is minted for that boundary. Starting it in the credential-bearing
        // Server would silently undo the transport migration's isolation guarantee.
        //
        // The question is whether a turn can be STARTED through the socket, so ask
        // that — a presence check answers a different one. A retired generation leaves
        // its socket inode behind on the shared runtime volume, and the Server cannot
        // remove it: the runtime directory belongs to the Runner runtime GID and the
        // Server holds only traverse on it (that asymmetry is the ADR 0006 boundary,
        // not an oversight). A leftover inode passed `existsSync`, so every turn in
        // such a project died with `connect ECONNREFUSED` — the loopback fallback
        // right here never ran, for the exact condition it was written for.
        const supervisorSocket = join(runtimeDir, 'supervisor.sock');
        if (!(await supervisorSocketReachable(supervisorSocket))) {
          const reason = existsSync(supervisorSocket)
            ? 'the project supervisor socket is not accepting connections; its Sandbox generation was retired or its supervisor was disabled after a boundary attestation warning, leaving the socket behind'
            : 'the project supervisor socket is missing; provisioning may have disabled the supervisor after a Sandbox boundary attestation warning, or the container runtime keeps the socket inside the Sandbox (gVisor without the runsc-project registration)';
          deps.onMissingSupervisorSocket?.({
            projectId: runnerProjectId,
            socketPath: supervisorSocket,
            reason,
          });
          if (isAcpBackend) {
            throw new Error(
              `ACP requires a reachable project supervisor; ${reason}. Repair the project before sending another message.`,
            );
          }
          return new LoopbackRunnerClient(
            backend,
            `## Native Verity tools unavailable\n\nThis project is running through the loopback runner because ${reason}. Native brokered tools such as \`verity_http_request\` and \`verity_secret_run\` are unavailable for this session. Report this reason when a request needs one of those tools; do not silently claim only that the tool is absent. Check the project's provision warning for the attestation detail.`,
          );
        }
        const ephemeral = context.ephemeralEventSink !== undefined;
        const projectHttpMcpServers =
          ephemeral || context.projectId === null || deps.listProjectHttpMcpServers === undefined
            ? []
            : await deps.listProjectHttpMcpServers(context.projectId, context.initiatedBy);
        const gatewayToolContext =
          !ephemeral && context.sessionId !== null
            ? {
                // Runtime selection and authorization identity are different for a
                // persisted control-plane project: it executes on the fixed
                // `verity-control` sidecar, but grants/audit/secret bindings belong
                // to the real persisted project record.
                projectId: runnerAuthorizationProjectId(context.projectId, runnerProjectId),
                sessionId: context.sessionId,
              }
            : undefined;
        // A gateway-eligible ACP turn that has a session to attribute to must also have
        // the registry that mints its bearer. Its absence is a misassembled Server, not
        // a runtime condition the turn can recover from. Ephemeral and meta-query turns
        // legitimately have no gateway context. `opencode-acp` joined the named
        // brokered-tool backends with ADR 0014 Amendment 4 and is held to the same
        // requirement: a Server that would start it tool-less and silent is the failure
        // this closes, whichever of the three adapters runs the turn.
        if (
          gatewayToolContext !== undefined &&
          deps.mcpGatewayTokens === undefined &&
          (backend.runnerSupervisorBackend === 'claude-acp' ||
            backend.runnerSupervisorBackend === 'codex-acp' ||
            backend.runnerSupervisorBackend === 'opencode-acp')
        ) {
          throw new Error(
            'the Server was composed without mcpGatewayTokens; a brokered-tool ACP turn cannot start without the per-turn gateway bearer registry',
          );
        }
        let ephemeralSeq = 0;
        const ephemeralFrames = new Set<string>();
        const supervisorClient: SupervisorRunnerClient = new SupervisorRunnerClient(backend, {
          runtimeDir,
          // This construction used to pass no budget at all and silently inherited the
          // client's old one-second default — which is how a `start-turn` on a busy
          // host became `runner supervisor request timed out: start-turn` while the
          // worker it started was alive and well. Starts have their own two-phase
          // budget now; this governs the short control requests (`get-turn`, `cancel`,
          // `steer`) and matches the other production call sites.
          timeoutMs: 15_000,
          onTelemetry: (telemetry) => {
            // One line per start, only when it is worth reading: a start that had to be
            // reconciled or retried, one that failed, or one slow enough that the next
            // report of a "hanging" turn should be able to point at a number. A prompt
            // `terminal` is as routine as a prompt `created` — it is what a turn
            // cancelled before its worker existed looks like — so both are quiet.
            if (
              (telemetry.outcome === 'created' || telemetry.outcome === 'terminal') &&
              telemetry.startMs < 5_000 &&
              telemetry.reconciled === undefined
            ) {
              return;
            }
            console.warn(
              `verity: runner start ${telemetry.outcome} ${JSON.stringify({
                projectId: runnerProjectId,
                turnId: telemetry.turnId,
                acceptMs: telemetry.acceptMs,
                startMs: telemetry.startMs,
                artifactMs: telemetry.artifactMs,
                activeStarts: telemetry.activeStarts,
                eventLoopDelayMs: telemetry.eventLoopDelayMs,
                outcome: telemetry.outcome,
                reconciled: telemetry.reconciled,
                // The one field that says WHICH failure this was. Without it a
                // `failed` line is the same log the incident started from: a
                // timestamp and a turn id, and nothing to act on.
                error: telemetry.error,
              })}`,
            );
          },
          store: ephemeral
            ? {
                ingestRunnerFrame: (_sessionId, frame) => {
                  const key = `${frame.runnerInstanceId}\0${frame.turnId}\0${frame.frameSeq}`;
                  if (ephemeralFrames.has(key)) {
                    return Promise.resolve({ outcome: 'duplicate' as const });
                  }
                  ephemeralFrames.add(key);
                  if (frame.event !== undefined) context.ephemeralEventSink!(frame.event);
                  ephemeralSeq += 1;
                  return Promise.resolve({
                    outcome: 'accepted' as const,
                    seq: ephemeralSeq,
                    ts: Date.now(),
                  });
                },
              }
            : deps.store,
          bus: ephemeral ? new InMemoryEventBus() : deps.bus,
          transcript: ephemeral
            ? undefined
            : backend.runnerSupervisorBackend === 'claude-acp'
              ? new ServerTranscript({
                  runtimeDir,
                  transcript: deps.transcript,
                  ...(isAcpBackend && context.sessionId
                    ? { veritySessionId: context.sessionId }
                    : {}),
                })
              : backend.runnerSupervisorBackend === 'codex-acp'
                ? new ServerCodexTranscript({
                    runtimeDir,
                    transcript: deps.transcript,
                    ...(isAcpBackend && context.sessionId
                      ? { veritySessionId: context.sessionId }
                      : {}),
                  })
                : undefined,
          persistentSessionHomes: isAcpBackend && !ephemeral,
          mapAttachmentPath: sandboxPath,
          mapTurnOptions: (opts) => ({
            ...opts,
            worktree: sandboxPath(opts.worktree),
            cwd: sandboxPath(opts.cwd),
            ...(projectHttpMcpServers.length === 0
              ? {}
              : {
                  mcpServers: projectHttpMcpServers.map((server) => ({
                    name: server.name,
                    url: 'verity-internal://mcp-proxy',
                    headers: [{ name: 'X-Verity-MCP-Binding', value: server.id }],
                  })),
                }),
          }),
          ...(ephemeral || deps.autoApprovePermission === undefined
            ? {}
            : { autoApprovePermission: deps.autoApprovePermission }),
          ...(deps.mcpGatewayTokens === undefined || gatewayToolContext === undefined
            ? {}
            : {
                mcpGatewayTokens: {
                  issue: (turnId: string) =>
                    deps.mcpGatewayTokens!.issue({
                      projectId: gatewayToolContext.projectId,
                      sessionId: gatewayToolContext.sessionId,
                      turnId,
                    }),
                  release: (token: string) =>
                    deps.mcpGatewayTokens!.release({
                      projectId: gatewayToolContext.projectId,
                      token,
                    }),
                },
              }),
          // Bound to the container's own project: that is the project a sandbox
          // route sees on the calling socket, including the control-plane runner.
          ...(deps.turnCredentials === undefined || ephemeral || context.sessionId === null
            ? {}
            : {
                turnCapabilities: {
                  issue: (turnId: string) =>
                    deps.turnCredentials!.issue({
                      projectId: runnerProjectId,
                      sessionId: context.sessionId!,
                      turnId,
                      userId: context.initiatedBy?.userId ?? null,
                    }),
                  release: (token: string) => deps.turnCredentials!.release(token),
                },
              }),
          ...(deps.mcpProxyTokens === undefined || gatewayToolContext === undefined
            ? {}
            : {
                mcpProxyTokens: {
                  issue: (turnId: string) =>
                    deps.mcpProxyTokens!.issue({
                      projectId: gatewayToolContext.projectId,
                      sessionId: gatewayToolContext.sessionId,
                      turnId,
                    }),
                  release: (token: string) =>
                    deps.mcpProxyTokens!.release({
                      projectId: gatewayToolContext.projectId,
                      token,
                    }),
                },
              }),
        });
        if (!ephemeral) return supervisorClient;
        const ephemeralClient: RunnerClient = {
          startTurn: (opts, hooks) => {
            let backendSessionId: string | undefined;
            const turn = supervisorClient.startTurn(opts, {
              ...hooks,
              onSession: async (id) => {
                backendSessionId = id;
                await hooks.onSession?.(id);
              },
            });
            const cleanup = async (): Promise<void> => {
              const paths: string[] = [];
              if (opts.turnId !== undefined) paths.push(join(runtimeDir, 'turns', opts.turnId));
              if (backendSessionId !== undefined) {
                if (backend.runnerSupervisorBackend === 'claude-acp') {
                  paths.push(
                    transcriptPath({
                      cwd: sandboxPath(opts.cwd),
                      sessionId: backendSessionId,
                      claudeHome: join(runtimeDir, 'claude'),
                    }),
                  );
                } else if (backend.runnerSupervisorBackend === 'codex-acp') {
                  paths.push(...(await codexRolloutFiles(runtimeDir, backendSessionId)));
                }
              }
              await Promise.all(
                paths.map(async (path) => await rm(path, { recursive: true, force: true })),
              );
            };
            return {
              ...turn,
              result: turn.result.then(
                async (result) => {
                  await cleanup();
                  return result;
                },
                async (error: unknown) => {
                  await cleanup();
                  throw error;
                },
              ),
            };
          },
        };
        return ephemeralClient;
      },
    };
  }
  if (deps.runnerTransport) {
    return {
      runner: (backend) =>
        new FileTailRunnerClient(backend, {
          store: deps.store,
          bus: deps.bus,
          allocateEventFile: deps.allocateEventFile,
          allocateControlSocket: deps.allocateControlSocket,
          ...(deps.autoApprovePermission === undefined
            ? {}
            : { autoApprovePermission: deps.autoApprovePermission }),
        }),
    };
  }
  return {};
}

/**
 * Where a project's clone is mounted inside its Sandbox, and so the root of every path a
 * session's backend sees.
 *
 * A named constant rather than two `'/work'` literals because two different callers map
 * the same worktree through {@link runnerSandboxPath}: the runner wiring, when it launches
 * a turn, and the transcript purge plus the startup sweep, when they look for — or spare —
 * the files that turn wrote. A second literal that drifted from this one would leave the
 * sweep's live-worktree guard matching nothing, and that guard is the only thing keeping a
 * switched-away session's unreproducible `subagents/` tree from being collected.
 */
export const RUNNER_CONTAINER_PROJECT_ROOT = '/work';

/** Map a Server-visible project worktree into the single-project Runner mount.
 * The first relative component is the repository directory itself; the Runner
 * mounts that directory at `containerProjectRoot`, including for the persisted
 * `verity-control` project. Paths outside the clone root are already expressed
 * in a shared namespace (for example `/srv/verity/sessions`) and stay unchanged —
 * as is every path when there is no clone root at all, which is the same answer the
 * runner itself gets from this function, so the two cannot disagree. */
export function runnerSandboxPath(
  path: string,
  hostCloneRoot: string | undefined,
  containerProjectRoot = RUNNER_CONTAINER_PROJECT_ROOT,
): string {
  if (hostCloneRoot === undefined) return path;
  const rel = relative(hostCloneRoot, path);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return path;
  const [, ...rest] = rel.split(sep);
  return join(containerProjectRoot, ...rest);
}

/** Keep authorization bound to a persisted project even when execution is
 * multiplexed through a synthetic dedicated Runner identity. */
export function runnerAuthorizationProjectId(
  projectId: string | null,
  runnerProjectId: string,
): string {
  return projectId ?? runnerProjectId;
}
