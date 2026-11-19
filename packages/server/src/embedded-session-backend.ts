import type { EventStore, ProjectRecord } from '@verity/store';
import { sandboxNotReadyError } from '@verity/events';
import {
  isCodexModel,
  isRunnerSupervisorBackend,
  runnerSupervisorBackendLabel,
  type ConductorDeps,
  type RunnerSupervisorBackend,
} from '@verity/session';
import type { FastifyBaseLogger } from 'fastify';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { DockerClient } from './docker.js';
import { projectClonePath, type ProvisionerImpl } from './provisioner.js';
import type { createEmbeddedSandboxTurnPreparation } from './embedded-sandbox-turn-preparation.js';
import type { createEmbeddedAgentGatewayReadiness } from './embedded-agent-gateway-routing.js';
import { personalTurnRefusal, resolveTurnSandbox } from './turn-sandbox.js';
import { sandboxIdentity, sandboxRunnerDir } from './sandbox-identity.js';
import {
  isProjectSettingsReader,
  materializeControlPlaneAgentEnv,
  withControlPlaneAgentCredentials,
  prepareControlPlaneRunnerForTurn,
  acpSupervisorWiringRefusal,
} from './embedded-support.js';
import {
  agentGatewayUnavailableMessage,
  type AgentGatewayRepairFailure,
  claudeEgressAgentEnv,
  claudeEgressRouteEnabled,
  claudeProjectEgressRefusal,
  claudeTransportRefusal,
} from './claude-egress-agent-env.js';
import { ensureProjectSandboxReadyForTurn } from './project-auto-wake.js';
import { waitForSandboxTurnReadiness, type SandboxEgressProbe } from './sandbox-turn-readiness.js';
import { DockerExecBackend } from './project-backend.js';
import { projectSettingsEnv } from './project-settings-env.js';

type IdentityOptions = Parameters<typeof prepareControlPlaneRunnerForTurn>[0];
type Dependencies = ReturnType<typeof createEmbeddedSandboxTurnPreparation> & {
  config: Pick<
    EmbeddedServerConfig,
    | 'controlPlaneRunner'
    | 'dataVolumeRoot'
    | 'runnerSupervisor'
    | 'dockerBaseUrl'
    | 'hostCloneRoot'
    | 'claudeConnectorPort'
  >;
  createStore: () => EventStore;
  secretRoot: string;
  dataVolumeRoot: string | undefined;
  agentGatewayUrl: URL | undefined;
  projectRelayEnabled: boolean;
  refreshProjectToken: ((project: ProjectRecord) => Promise<void>) | undefined;
  refreshAgentGatewayCredential: () => Promise<void>;
  synchronizeAgentGatewayForTurn: () => Promise<void>;
  agentGatewayReady: ReturnType<typeof createEmbeddedAgentGatewayReadiness>['agentGatewayReady'];
  probeSandboxEgressReadiness: (
    volumeRoot: string,
    runnerDir: string,
  ) => Promise<SandboxEgressProbe>;
  runtime: {
    readonly log: FastifyBaseLogger;
    readonly docker: Pick<DockerClient, 'inspectContainer'> | undefined;
    readonly provisioner:
      Pick<ProvisionerImpl, 'ensureProjectSandboxAwake' | 'ensurePersonalSandbox'> | undefined;
    readonly claudeEgressActive: boolean;
    readonly refreshControlPlaneRunnerIdentity: IdentityOptions['refreshIdentity'];
    readonly awaitControlPlaneRunnerIdentity: IdentityOptions['awaitIdentity'];
  };
};

/** Select a session's isolation boundary and prepare its Runner before a turn. */
export function createEmbeddedSessionBackend(
  deps: Dependencies,
): NonNullable<ConductorDeps['sessionBackend']> {
  const {
    config,
    createStore,
    secretRoot,
    dataVolumeRoot,
    agentGatewayUrl,
    projectRelayEnabled,
    refreshProjectToken,
    refreshAgentGatewayCredential,
    synchronizeAgentGatewayForTurn,
    agentGatewayReady,
    probeSandboxEgressReadiness,
    runtime,
    repairPersonalSandboxForAgentTurn,
    repairSandboxForAgentTurn,
    serializeProjectTurnPreparation,
  } = deps;
  return async (session, selected, preparation) => {
    const isClaudeSession = !isCodexModel(session.model) && !session.model?.includes('/');
    const isCodexSession = isCodexModel(session.model);
    const isOpenCodeSession = selected.runnerSupervisorBackend === 'opencode-acp';
    // Every branch below assumes a Claude turn is an ACP turn: none of them
    // fetches an access token, and no agent process is handed
    // `CLAUDE_CODE_OAUTH_TOKEN` except the non-secret egress placeholder. The
    // refusal that makes that assumption safe is a tested pure decision.
    const transportRefusal = claudeTransportRefusal({
      isClaudeSession,
      runnerSupervisorBackend: selected.runnerSupervisorBackend,
    });
    if (transportRefusal !== undefined) throw new Error(transportRefusal);
    const prepareControlPlaneRunner = (): Promise<boolean> =>
      prepareControlPlaneRunnerForTurn({
        enabled: config.controlPlaneRunner === true,
        dataVolumeRoot: config.dataVolumeRoot,
        refreshIdentity: runtime.refreshControlPlaneRunnerIdentity,
        awaitIdentity: runtime.awaitControlPlaneRunnerIdentity,
      });
    // Keep Claude ACP selected even when the pre-preparation socket snapshot is
    // absent: serializeProjectTurnPreparation below may recreate the Sandbox and
    // restore its supervisor. The runner performs the authoritative reachability
    // check after that repair and fails Claude ACP closed instead of falling back.
    // Project-less control-plane sessions resolve the fixed dedicated runtime
    // above. Every other ACP backend uses the same fail-closed boundary.
    const sessionSelected = selected;
    // Ask the closed set of supervised backends rather than listing today's three:
    // each of them runs in the dedicated Runner, needs it prepared, and needs the
    // gateway synchronized before the turn — and the per-backend disjunction this
    // replaces had already been written twice, once here and once for projects
    // below, so a fourth backend would have had to be remembered in four places.
    // The label only names the backend in the refusal; it decides nothing.
    const controlPlaneRunnerTurn = async (
      backend: RunnerSupervisorBackend,
    ): Promise<typeof sessionSelected> => {
      if (!(await prepareControlPlaneRunner())) {
        throw new Error(
          `${runnerSupervisorBackendLabel(backend)} control-plane turns require the dedicated control-plane runner.`,
        );
      }
      await synchronizeAgentGatewayForTurn();
      return sessionSelected;
    };
    const acpControlPlaneBackend = isRunnerSupervisorBackend(selected.runnerSupervisorBackend)
      ? selected.runnerSupervisorBackend
      : undefined;
    if (session.projectId === null) {
      if (acpControlPlaneBackend !== undefined) {
        return await controlPlaneRunnerTurn(acpControlPlaneBackend);
      }
      // Whatever is left is a loopback backend with no Verity-held provider
      // credential of its own, so it inherits the control-plane agent
      // environment and nothing else.
      return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
        materializeControlPlaneAgentEnv(secretRoot, inherited),
      );
    }
    const store = createStore();
    const project = await store.getProject(session.projectId);
    if (project === undefined) {
      if (isClaudeSession) {
        throw new Error('Claude ACP cannot verify its project isolation boundary.');
      }
      return undefined;
    }
    if (project.kind === 'control_plane') {
      if (acpControlPlaneBackend !== undefined) {
        return await controlPlaneRunnerTurn(acpControlPlaneBackend);
      }
      return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
        materializeControlPlaneAgentEnv(secretRoot, inherited),
      );
    }
    // A person's turn runs in their own sandbox (ADR 0023 §4), on their own
    // provider login: the gateway serves that sandbox with nobody else's. Without
    // one the turn is refused here, before anything is prepared, rather than
    // failing inside the agent.
    const turnSandbox = await resolveTurnSandbox(store, project.id, preparation.initiatedBy);
    const turnProvider = isClaudeSession
      ? 'claude'
      : isCodexSession
        ? 'codex'
        : isOpenCodeSession
          ? 'opencode'
          : undefined;
    const loginRefusal = await personalTurnRefusal(store, turnSandbox, turnProvider);
    if (loginRefusal !== undefined) throw new Error(loginRefusal);
    if (!turnSandbox.projectDefault && runtime.provisioner?.ensurePersonalSandbox === undefined)
      throw new Error('Personal sandboxes need the project provisioner.');
    const supervisorRefusal = acpSupervisorWiringRefusal({
      runnerSupervisorBackend: selected.runnerSupervisorBackend,
      runnerSupervisor: config.runnerSupervisor === true,
      dataVolumeRootAvailable: config.dataVolumeRoot !== undefined,
      dockerAvailable: config.dockerBaseUrl !== undefined,
      cloneRootAvailable: config.hostCloneRoot !== undefined,
    });
    if (supervisorRefusal !== undefined) throw new Error(supervisorRefusal);
    // Refused BEFORE `serializeProjectTurnPreparation`, so a pure configuration
    // error leaves no half-prepared turn behind. Both operands are assigned once
    // during start-up (`claudeEgressIdentity` above; nothing in a turn creates the
    // service), so the answer cannot change inside the preparation below.
    //
    // Two operands, not three: the routed env also needs the gateway itself, but a
    // deployment that can serve project turns at all already refuses to START
    // without it ('Project Docker provisioning requires the Agent Gateway'), so
    // `routed` can never point an agent at a connector that was never provisioned.
    const claudeEgressActive = runtime.claudeEgressActive;
    const egressRefusal = claudeProjectEgressRefusal({
      isClaudeSession,
      egressActive: claudeEgressActive,
    });
    if (egressRefusal !== undefined) throw new Error(egressRefusal);
    if (config.dockerBaseUrl === undefined || config.hostCloneRoot === undefined) {
      return undefined;
    }
    const dockerBaseUrl = config.dockerBaseUrl;
    const hostCloneRoot = config.hostCloneRoot;
    return serializeProjectTurnPreparation(
      project.id,
      preparation.sessionId,
      preparation.canWait,
      async (queuedSessionIds) => {
        await ensureProjectSandboxReadyForTurn({
          project,
          getProject: (projectId) => store.getProject(projectId),
          canWait: preparation.canWait,
          waitingOn: (message) => preparation.waitingOn(message),
          requestingSessionIds: queuedSessionIds,
          ...(runtime.provisioner?.ensureProjectSandboxAwake === undefined
            ? {}
            : {
                ensureAwake: runtime.provisioner.ensureProjectSandboxAwake.bind(
                  runtime.provisioner,
                ),
              }),
        });
        // The person's own sandbox reuses the clone and image the project's
        // original sandbox prepared above; starting it is idempotent.
        const sandbox = turnSandbox.projectDefault
          ? sandboxIdentity(project, turnSandbox)
          : await runtime.provisioner!.ensurePersonalSandbox(project.id, turnSandbox.userId);
        await refreshProjectToken?.(project);
        const settings = isProjectSettingsReader(store)
          ? await store.getProjectSettings(project.id)
          : undefined;
        // A sandbox is single-homed on its own project network and reaches Claude
        // only through its generation-matched relay, so the target stamped on it
        // is that relay (`provisioner.ts`: claudeGatewayUrl(relayActivation)) —
        // never the gateway origin. Comparing the stamp against the gateway URL
        // therefore never matched and failed every Claude turn closed; the relay,
        // not the sandbox, is what forwards to the gateway.
        if (
          (isClaudeSession || isCodexSession || isOpenCodeSession) &&
          claudeEgressActive &&
          agentGatewayUrl !== undefined
        ) {
          if (runtime.docker === undefined) {
            throw new Error('Claude egress routing target cannot be verified');
          }
          let gatewayReady: boolean;
          let repairFailure: AgentGatewayRepairFailure | undefined;
          try {
            const inspected = await runtime.docker.inspectContainer(sandbox.containerName);
            gatewayReady = await agentGatewayReady(sandbox, inspected);
          } catch (error) {
            runtime.log.warn(
              { err: error, projectId: project.id },
              'Could not verify agent gateway relay provisioning',
            );
            throw new Error('Claude egress routing target cannot be verified', {
              cause: error,
            });
          }
          if (!gatewayReady) {
            // The Sandbox cannot serve this turn — but that is a repairable state,
            // not a reason to end the turn. Failing here surfaced as a red
            // `run_failed` the operator had to resolve by hand, and the periodic
            // reconciler could not resolve it either: it defers around in-flight
            // turns, and the turn waiting on the repair is what keeps the project
            // busy. So rebuild now, tell the operator it is happening, and continue
            // the turn on the fresh Sandbox once it is up. Background resolutions
            // (auto-title, reattach) don't wait — they keep failing fast.
            const repair = turnSandbox.projectDefault
              ? await repairSandboxForAgentTurn(project, preparation, queuedSessionIds)
              : await repairPersonalSandboxForAgentTurn(project, turnSandbox.userId, preparation);
            gatewayReady = repair.ready;
            repairFailure = repair.ready ? undefined : repair.failure;
          }
          if (!gatewayReady) {
            const message = agentGatewayUnavailableMessage(repairFailure);
            // A background resolution never attempted the rebuild above, so its
            // failure says nothing about whether the Sandbox is repairable — only
            // that this resolution would not wait for one. Reporting it as the
            // transient class keeps it from freezing the session on `crashed` (the
            // badge outlives the turn; the Sandbox usually does not). A foreground
            // turn, whose repair genuinely ran and failed, keeps the red badge and
            // the operator-facing instruction above.
            throw preparation.canWait ? new Error(message) : sandboxNotReadyError(message);
          }
          // Binding issuance and revocation keep the routed set current: read the
          // latest rotating credential and wait for the gateway to acknowledge
          // that exact cached identity configuration.
          // A person's own login may have been refreshed or connected just now;
          // project it before the gateway snapshot this turn waits for.
          if (!turnSandbox.projectDefault) await refreshAgentGatewayCredential();
          await synchronizeAgentGatewayForTurn();
          // The checks above trust Docker's `running`, which a relay reaches
          // before its process listens. Confirm from inside the Sandbox that
          // the connections this agent needs accept connects before launching
          // it; until then the turn waits visibly instead of failing on a
          // refused connection.
          if (dataVolumeRoot !== undefined) {
            await waitForSandboxTurnReadiness({
              projectId: project.id,
              sessionId: preparation.sessionId,
              agent: isClaudeSession ? 'claude' : isCodexSession ? 'codex' : 'opencode',
              relayed: projectRelayEnabled,
              canWait: preparation.canWait,
              waitingOn: (message) => preparation.waitingOn(message),
              probe: () =>
                probeSandboxEgressReadiness(
                  dataVolumeRoot,
                  sandboxRunnerDir(project.id, turnSandbox),
                ),
              log: runtime.log,
            });
          }
        }
        // A Claude project agent is pointed at the sandbox connector with only the
        // placeholder, so the real token never enters the untrusted sandbox.
        // Non-Claude sessions never route.
        const egressRouted = claudeEgressRouteEnabled({
          isClaudeSession,
          egressActive: claudeEgressActive,
        });
        return new DockerExecBackend({
          containerName: sandbox.containerName,
          hostProjectRoot: projectClonePath(hostCloneRoot, project),
          dockerBaseUrl,
          backend: sessionSelected,
          containerEnv: {
            ...projectSettingsEnv(settings),
            ...claudeEgressAgentEnv({
              routed: egressRouted,
              connectorPort: config.claudeConnectorPort,
            }),
          },
        });
      },
    );
  };
}
