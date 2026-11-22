import { join } from 'node:path';
import type { EventStore } from '@verity/store';
import { AGENT_SKILL_MANIFEST_HASH } from '@verity/events';
import { AcpClaudeBackend, requestRunnerSupervisor, type ConductorDeps } from '@verity/session';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { SessionStorage } from './session-storage.js';
import type { createEmbeddedBranches } from './embedded-branches.js';
import type { createEmbeddedRunnerConductorWiring } from './embedded-runner-conductor.js';
import type { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import type { createRunnerArtifactPurge } from './runner-artifact-purge.js';
import { resolveAgentContext } from './agent-context.js';
import { readOrMigrateProjectOverview } from './project-overview-file.js';
import { projectDecisionDirectory } from './knowledge-decisions.js';
import { branchRenameAppliesToSession } from './embedded-support.js';
import { personForCredential } from './personless-credential.js';
import { resolveTurnSandbox } from './turn-sandbox.js';
import { sandboxPersonTag } from './sandbox-identity.js';

type RunnerContext = Parameters<typeof createEmbeddedRunnerConductorWiring>[0];

export function createEmbeddedConductorBindings(ctx: {
  config: Pick<EmbeddedServerConfig, 'dataVolumeRoot' | 'runnerSupervisor'>;
  eventStore: EventStore;
  sessionStorage: Pick<SessionStorage, 'ensureWorkspace'> | undefined;
  transcriptStore: ConductorDeps['transcript'];
  brokeredSecretAliases: ConductorDeps['brokeredSecretAliases'];
  brokeredGrantBindingId: RunnerContext['brokeredGrantBindingId'];
  brokeredHttpGrants: Pick<ReturnType<typeof createBrokeredHttpGrantStore>, 'check' | 'grant'>;
  branches: ReturnType<typeof createEmbeddedBranches>;
  purgeRunnerArtifacts: ReturnType<typeof createRunnerArtifactPurge> | undefined;
}): Pick<
  ConductorDeps,
  | 'ensureWorkspace'
  | 'backend'
  | 'permissionControl'
  | 'transcript'
  | 'agentContext'
  | 'projectOverview'
  | 'projectDecisionDirectory'
  | 'brokeredSecretAliases'
  | 'checkBrokeredHttpGrant'
  | 'persistBrokeredHttpGrant'
  | 'autoTitle'
  | 'purgeBackendArtifacts'
  | 'backendStateScope'
> {
  const {
    config,
    eventStore,
    sessionStorage,
    transcriptStore,
    brokeredSecretAliases,
    brokeredGrantBindingId,
    brokeredHttpGrants,
    branches,
    purgeRunnerArtifacts,
  } = ctx;
  return {
    ensureWorkspace: (session) => sessionStorage?.ensureWorkspace(session) ?? Promise.resolve(),
    // Stable ACP v1 is the only Claude transport (ADR 0012); the native
    // stream-json backend it replaced has been removed, rollback included.
    backend: new AcpClaudeBackend(),
    // ACP delegates every approval decision to its client. Keep Verity's
    // durable permission card/decision channel authoritative for those calls.
    permissionControl: true,
    // Capture each session's verbatim .jsonl so it survives + is resumable.
    transcript: transcriptStore,
    ...(config.dataVolumeRoot !== undefined
      ? {
          agentContext: async (session, initiatedBy) => {
            const status =
              session.projectId && config.runnerSupervisor === true
                ? await requestRunnerSupervisor(
                    join(config.dataVolumeRoot!, 'runners', session.projectId, 'supervisor.sock'),
                    { kind: 'status' },
                  ).catch(() => undefined)
                : undefined;
            return resolveAgentContext(
              eventStore,
              config.dataVolumeRoot!,
              session,
              (projectId) =>
                readOrMigrateProjectOverview(config.dataVolumeRoot!, projectId, async () => {
                  const approved = await eventStore.knowledge.getProjectOverview(projectId);
                  return (
                    approved?.bodyMarkdown ??
                    (await eventStore.getProjectSettingsRaw(projectId))?.memory ??
                    undefined
                  );
                }),
              status?.['builtInSkillsVersion'] === 1 &&
                status['builtInSkillsManifestHash'] === AGENT_SKILL_MANIFEST_HASH,
              initiatedBy,
            );
          },
          projectOverview: async (projectId: string) => {
            return readOrMigrateProjectOverview(config.dataVolumeRoot!, projectId, async () => {
              const approved = await eventStore.knowledge.getProjectOverview(projectId);
              if (approved !== null) return approved.bodyMarkdown;
              return (await eventStore.getProjectSettingsRaw(projectId))?.memory ?? undefined;
            });
          },
          projectDecisionDirectory: (projectId: string) =>
            projectDecisionDirectory(config.dataVolumeRoot!, projectId),
        }
      : {}),
    // ADR 0011 D3: expose the project's secret alias names to every turn whose
    // transport carries the brokered tools — ACP included, not just codex.
    brokeredSecretAliases,
    // ADR 0011 D2: scoped operator grants auto-approve matching brokered-secret prompts.
    checkBrokeredHttpGrant: async (input) => {
      const bindingId = await brokeredGrantBindingId(input.projectId);
      return bindingId === undefined ||
        (input.bindingId !== undefined && input.bindingId !== bindingId)
        ? false
        : brokeredHttpGrants.check({
            ...input,
            // Work without a person holds the original sandbox's person's grants,
            // only where personless-credential.ts allows it at all.
            userId: await personForCredential(eventStore, input.projectId, input.userId),
            bindingId: input.bindingId ?? bindingId,
          });
    },
    persistBrokeredHttpGrant: async (input) => {
      const bindingId = await brokeredGrantBindingId(input.projectId);
      if (
        bindingId === undefined ||
        (input.bindingId !== undefined && input.bindingId !== bindingId)
      ) {
        throw new Error('Doppler access changed before saving approval');
      }
      await brokeredHttpGrants.grant({ ...input, bindingId: input.bindingId ?? bindingId });
    },
    // Auto-name an unnamed session from its opening turn: the conductor derives a
    // 2–3 word title from the first chat using the session's OWN model (routed via
    // the same backend its turns run on). `afterTurns: 1` names off the very first
    // exchange, and the attempt fires at turn START — concurrently with the turn, off
    // the operator's prompt — so the name lands in seconds rather than waiting for the
    // reply to stream or the turn to settle. Best-effort — a failure just leaves the
    // branch label. When a title lands, also ask the same model for a short
    // English branch candidate and let the branch service rename only fresh,
    // unpublished Verity-created branches in place.
    autoTitle: {
      afterTurns: 1,
      ...(branches !== undefined
        ? {
            onBranchName: async (session, branchName) => {
              if (
                !(await branchRenameAppliesToSession(session, (id) => eventStore.getProject(id)))
              ) {
                return;
              }
              await branches.autoRename(session.worktree, branchName);
            },
          }
        : {}),
    },
    // Switching a session to another backend drops the previous backend's
    // `session_backend_state` row, and that row was the only thing naming its files
    // on the runner runtime. Purging here is the one chance to reach them; otherwise
    // they survive even the eventual delete of the session that wrote them. The
    // `backend-switch` scope keeps what the session still needs while it lives —
    // claude's `subagents/` tree has no other copy — and the startup sweep collects
    // that remainder once the displaced id is no longer live.
    ...(purgeRunnerArtifacts === undefined
      ? {}
      : {
          purgeBackendArtifacts: async (
            sessionId: string,
            bindings: readonly { backend: string; backendSessionId: string }[],
          ): Promise<void> => {
            // A person's own thread (`backend#tag`) lives in their sandbox's runtime.
            const byPerson = new Map<string | undefined, typeof bindings>();
            for (const binding of bindings) {
              const [backend = binding.backend, tag] = binding.backend.split('#');
              byPerson.set(tag, [...(byPerson.get(tag) ?? []), { ...binding, backend }]);
            }
            for (const [tag, scoped] of byPerson)
              await purgeRunnerArtifacts(sessionId, scoped, 'backend-switch', tag);
          },
        }),
    // Each person resumes only their own backend thread (ADR 0023 §3–4).
    backendStateScope: async (session, initiatedBy) => {
      if (session.projectId === null) return undefined;
      const sandbox = await resolveTurnSandbox(eventStore, session.projectId, initiatedBy);
      return sandbox.projectDefault ? undefined : sandboxPersonTag(sandbox.userId);
    },
  };
}
