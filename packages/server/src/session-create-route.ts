import { parseSpawnRequestBody, type SpawnBody } from './session-create-schema.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DeletedProjectError, type ProjectRecord } from '@verity/store';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseOwnerRepo } from './canonical.js';
import {
  CONTROL_PLANE_PROJECT_OWNER,
  CONTROL_PLANE_PROJECT_REPO,
} from './control-plane-project.js';
import { createGitWorktreeProvisioner, type WorktreeProvisioner } from './worktree.js';
import { projectClonePath } from './provisioner.js';
import {
  isModelAllowedForProject,
  NoAllowedAgentError,
  ProjectAgentNotAllowedError,
  resolveProjectDefaultModel,
} from './project-agent-policy.js';
import type {
  ServerDeps,
  SpawnResult,
  ProjectSettingsRecord,
  PublicProjectRecord,
} from './server.js';

export interface SessionCreateRouteDeps extends Pick<
  ServerDeps,
  | 'eventStore'
  | 'provisioner'
  | 'projectCloneRoot'
  | 'projectBackend'
  | 'secretCipher'
  | 'projectWorktrees'
  | 'refreshProjectToken'
> {
  projectSettingsStore: () => {
    getProjectSettings: (id: string) => Promise<ProjectSettingsRecord | undefined>;
  };
  worktrees: WorktreeProvisioner;
  isConfiguredProjectSessionModel: (model: string | undefined) => Promise<boolean>;
  advancedModeEnabled: () => Promise<boolean>;
  ensureVerityControlProject: () => Promise<ProjectRecord>;
  projectsBeingDeleted: ReadonlySet<string>;
  beginProjectSpawn: (id: string) => () => void;
  settleBackgroundProvision: (
    id: string,
    provision: Promise<unknown>,
    onError: (error: unknown) => void,
  ) => void;
  makeBranch: (name: string | undefined, issue?: number) => string;
  isProjectSessionModel: (model: string | undefined) => boolean;
  availableModels: (options: {
    allowLegacyCodexFallback?: boolean;
  }) => Promise<{ models: string[]; default?: string | undefined }>;
  deleteSessionEverywhere: (id: string) => Promise<boolean>;
  PROJECT_MODEL_ERROR: string;
  isSleepLifecycleState: (state: ProjectRecord['state']) => boolean;
  publicProject: (project: ProjectRecord) => PublicProjectRecord;
  defaultModel: string;
}

export function registerSessionCreateRoute(
  app: FastifyInstance,
  deps: SessionCreateRouteDeps,
): void {
  // Create a NEW session (concept §7 "Parallel-Agent-Spawn", §8): provision a
  // worktree and persist the Verity session row immediately so the client can
  // open `/session/:id`. No agent process starts until the first turn is sent.
  //
  // Wrapped so that a spawn admitted against a project is released on EVERY exit
  // path — a project delete that starts mid-spawn waits for this to settle
  // before it purges the clone root out from under the worktree being created.
  const spawnSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    body: SpawnBody,
  ): Promise<SpawnResult> => {
    const admitted: { release?: () => void } = {};
    try {
      return await spawnSessionAdmitted(request, reply, body, admitted);
    } finally {
      admitted.release?.();
    }
  };

  const spawnSessionAdmitted = async (
    request: FastifyRequest,
    reply: FastifyReply,
    body: SpawnBody,
    admitted: { release?: () => void },
  ): Promise<SpawnResult> => {
    // Multi-repo fleet-registry (concept §19.6, #174): if the caller
    // specified a `project`, look up the cached row and either:
    //   - state === 'active' → create the session bound to it;
    //   - state !== 'active' → fire the provisioner async, return 202 +
    //     `awaitingProvisioning: true` (the operator polls GET /projects/:id
    //     for the transition to 'active', then re-issues this POST).
    // A malformed `project` (parseOwnerRepo returns undefined) was already
    // rejected by the Zod refine above → 400 before this branch.
    let projectId: string | undefined;
    let projectWorktree: string | undefined;
    let projectSettings: ProjectSettingsRecord | undefined;
    let projectWorktrees: WorktreeProvisioner | undefined;
    let effectiveModel = body.model;
    if (
      body.project === undefined &&
      body.projectId === undefined &&
      body.model?.startsWith('verity/')
    ) {
      reply.code(400);
      return { error: 'OpenCode sessions require a project sandbox' };
    }
    if (body.project !== undefined || body.projectId !== undefined) {
      if (body.model !== undefined && !(await deps.isConfiguredProjectSessionModel(body.model))) {
        reply.code(400);
        return { error: deps.PROJECT_MODEL_ERROR };
      }
      const parsed = body.project === undefined ? undefined : parseOwnerRepo(body.project);
      // The Zod `.refine` already guaranteed `parsed` is non-undefined here,
      // but TS doesn't know that. Re-cover defensively.
      if (body.project !== undefined && parsed === undefined) {
        reply.code(400);
        return { error: 'invalid project' };
      }
      if (
        parsed !== undefined &&
        parsed.owner.toLowerCase() === CONTROL_PLANE_PROJECT_OWNER &&
        parsed.repo.toLowerCase() === CONTROL_PLANE_PROJECT_REPO
      ) {
        if (!(await deps.advancedModeEnabled())) {
          reply.code(404);
          return { error: `project ${body.project} is not in the fleet registry` };
        }
        const project = await deps.ensureVerityControlProject();
        projectId = project.id;
        projectWorktrees = deps.worktrees;
        projectWorktree = await projectWorktrees.add(
          deps.makeBranch(body.name ?? 'verity-control'),
        );
        effectiveModel = body.model;
      } else {
        if (!deps.provisioner || !deps.projectCloneRoot || !deps.projectBackend) {
          reply.code(503);
          return { error: 'multi-repo provisioning is not configured' };
        }
        const project =
          body.projectId !== undefined
            ? await deps.eventStore.getProject(body.projectId)
            : await deps.eventStore.getProjectByOwnerRepo(parsed!.owner, parsed!.repo);
        // A soft-deleted project is gone as far as every caller is concerned:
        // `getProject` still returns the row (the hide keeps it so the
        // installation sync can't resurrect it), but spawning against it would
        // both re-provision a project the operator deleted — `state='absent'`
        // sends the branch below straight into the provisioner — and leave a
        // session bound to a project no `GET /projects` lists. Same answer as an
        // id that was never in the registry.
        // `hiddenAt` only covers a delete that already got past its
        // deprovision. Between the first quiesce pass and that hide, the row is
        // still visible and still `active`, and a spawn admitted there would
        // create its worktree inside a clone root the purge is removing. Answer
        // it as the deleted project it is about to be.
        if (
          project === undefined ||
          project.hiddenAt !== null ||
          deps.projectsBeingDeleted.has(project.id)
        ) {
          reply.code(404);
          return {
            error: `project ${body.projectId ?? body.project ?? ''} is not in the fleet registry`,
          };
        }
        // Admitted. Registered synchronously with the check above — a delete
        // that raises the flag from here on finds this spawn in the pending set
        // and waits for it, instead of purging the clone root while the
        // worktree below is being created.
        admitted.release = deps.beginProjectSpawn(project.id);
        const projectStore = deps.projectSettingsStore();
        projectSettings = await projectStore.getProjectSettings(project.id);
        // A stored default the project's agent rule excludes falls through to the
        // resolver below rather than failing every spawn.
        const storedDefault = projectSettings?.defaultModel ?? undefined;
        effectiveModel =
          body.model ??
          (storedDefault !== undefined && isModelAllowedForProject(storedDefault, projectSettings)
            ? storedDefault
            : undefined);
        if (!(await deps.isConfiguredProjectSessionModel(effectiveModel))) {
          reply.code(400);
          return { error: deps.PROJECT_MODEL_ERROR };
        }
        if (
          effectiveModel !== undefined &&
          !isModelAllowedForProject(effectiveModel, projectSettings)
        ) {
          reply.code(400);
          return { error: new ProjectAgentNotAllowedError(effectiveModel).message };
        }
        // A restricted project resolves its model before any worktree exists, so a
        // project whose allowed agents are all disconnected fails cleanly instead of
        // silently starting on an agent the operator excluded.
        const allowedAgents = projectSettings?.allowedAgents ?? null;
        if (effectiveModel === undefined && allowedAgents !== null) {
          const available = await deps.availableModels({ allowLegacyCodexFallback: true });
          const remembered = await deps.eventStore.getLastCreatedSessionModel(project.id);
          effectiveModel =
            remembered !== undefined &&
            available.models.includes(remembered) &&
            deps.isProjectSessionModel(remembered) &&
            isModelAllowedForProject(remembered, projectSettings)
              ? remembered
              : resolveProjectDefaultModel(available, projectSettings, deps.isProjectSessionModel);
          if (effectiveModel === undefined) {
            reply.code(400);
            return { error: new NoAllowedAgentError(allowedAgents).message };
          }
        }
        // A Sandbox in a sleep lifecycle state is provisioned, not missing: its
        // clone and deps.worktrees sit on the host, and the first turn brings the
        // container back through `ensureProjectSandboxReadyForTurn`. Only states
        // that have no usable Sandbox belong in the provisioning branch below —
        // sending a sleeping project there claims its row for CLONING and rebuilds
        // exactly the container the sleep was retaining.
        //
        // `sleeping_starting` is included deliberately, mid-transition and all: the
        // sleep routine revokes authority and stops the container, and touches
        // neither the clone nor the session deps.worktrees, so the host-side `worktree
        // add` below is independent of it. The turn that follows re-reads the state
        // and either waits out the wake or reports the transition — where a spawn
        // routed to the provisioner would instead re-clone the project out from
        // under a sleep that is still finalizing.
        if (project.state !== 'active' && !deps.isSleepLifecycleState(project.state)) {
          if (deps.secretCipher?.isSealed() === true) {
            reply.code(503);
            return { error: 'secret store is sealed', status: 'sealed' as const };
          }
          if (
            body.confirmProvisionWarnings !== true &&
            deps.provisioner.provisionWarnings !== undefined
          ) {
            const warnings = await deps.provisioner.provisionWarnings(project.id);
            if (warnings.length > 0) {
              reply.code(409);
              return { requiresConfirmation: true, warnings };
            }
          }
          // Fire the provisioner asynchronously — do NOT await it (the worker
          // does the long clone + docker build, and the operator polls for the
          // state transition). We log a failed background attempt via the same
          // `app.log` the conductor uses (the operator sees `provision_error`
          // on the project row when the worker lands it).
          deps.settleBackgroundProvision(
            project.id,
            deps.provisioner.provision(project.id, {
              confirmWarnings: body.confirmProvisionWarnings === true,
            }),
            (error) =>
              request.log.error(
                { err: error, projectId: project.id },
                'verity: background provisioning failed',
              ),
          );
          reply.code(202);
          // Same wire shape every other project payload uses: the raw row carries
          // internal fields and lifecycle states no client schema accepts, and a
          // client that cannot parse this answer reports a schema dump instead of
          // "provisioning, try again".
          //
          // Release and Sandbox-update fields are the placeholders the sleep and
          // wake actions hand out for the same reason: the clone this answer
          // announces has no Sandbox to inspect and no release resolved yet. A
          // client that wants those reads them from the project once it exists.
          return {
            project: deps.publicProject(project),
            awaitingProvisioning: true,
          };
        }
        projectId = project.id;
        const projectClone = projectClonePath(deps.projectCloneRoot, project);
        // Every spawn refreshes its base from origin first so the new session
        // starts on the latest integration tip (fleet-wide, all projects).
        const worktreeOpts = {
          refreshBase: true,
          ...(projectSettings?.defaultBranch !== undefined && projectSettings.defaultBranch !== null
            ? { baseBranch: projectSettings.defaultBranch }
            : {}),
        };
        projectWorktrees =
          deps.projectWorktrees?.(project, projectClone, worktreeOpts) ??
          createGitWorktreeProvisioner({
            repoDir: projectClone,
            worktreeRoot: join(projectClone, '.verity-sessions'),
            ...worktreeOpts,
          });
        await deps.refreshProjectToken?.(project);
        projectWorktree = await projectWorktrees.add(deps.makeBranch(body.name, body.issue));
      }
    }

    // Default spawns are isolated git deps.worktrees. Project spawns run in the
    // provisioned project clone path instead; allocating from the server repo
    // here would silently edit Verity while the UI says another repo is selected.
    let allocatedWorktree: WorktreeProvisioner | undefined;
    const worktree =
      projectWorktree ??
      (await (async () => {
        allocatedWorktree = deps.worktrees;
        return deps.worktrees.add(deps.makeBranch(body.name, body.issue));
      })());
    if (projectWorktree !== undefined && projectWorktrees !== undefined) {
      allocatedWorktree = projectWorktrees;
    }
    if (effectiveModel === undefined) {
      const available = await deps.availableModels({ allowLegacyCodexFallback: true });
      const remembered = await deps.eventStore.getLastCreatedSessionModel(projectId ?? null);
      const lastUsed =
        remembered !== undefined && available.models.includes(remembered) ? remembered : undefined;
      const candidate = lastUsed ?? available.default;
      if (
        candidate !== undefined &&
        (projectId === undefined || deps.isProjectSessionModel(candidate))
      ) {
        effectiveModel = candidate;
      }
    }
    // A client-minted id (see `spawnBody.sessionId`) is used verbatim — the app has
    // already opened the chat on it. That it cannot clash with an existing session
    // is enforced by the route below, before this ever runs.
    const sessionId = body.sessionId ?? randomUUID();
    const displayName = body.name?.trim();
    try {
      await deps.eventStore.createSession({
        sessionId,
        worktree,
        model: effectiveModel ?? deps.defaultModel,
        ...(displayName ? { name: displayName } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    } catch (error) {
      await deps.deleteSessionEverywhere(sessionId).catch(() => false);
      if (allocatedWorktree !== undefined) {
        await allocatedWorktree.remove(worktree).catch(() => undefined);
      }
      // The project was deleted while this spawn was still provisioning, which
      // the check at the top of the route could not have seen — it read the
      // project a worktree ago. `createSession` is where the two orders are
      // decided against each other, so the answer is the same 404 that check
      // gives: the project is not in the fleet registry any more. The cleanup
      // above already removed the worktree DELETE /projects/:id would otherwise
      // have left behind.
      if (error instanceof DeletedProjectError) {
        reply.code(404);
        return { error: `project ${error.projectId} is not in the fleet registry` };
      }
      throw error;
    }
    reply.code(201);
    return { sessionId };
  };

  // Creations of a client-minted id that are still provisioning, so a retry of the
  // same id waits for the original instead of adding a second worktree. Entries
  // live only for the duration of one request.
  const spawnsInFlight = new Map<string, Promise<SpawnResult>>();

  app.post('/sessions', async (request, reply): Promise<SpawnResult> => {
    const body = parseSpawnRequestBody(request.body);
    const requestedId = body.sessionId;
    // A server-minted id cannot collide, so there is nothing to reconcile.
    if (requestedId === undefined) return spawnSession(request, reply, body);

    // Idempotent on the client's id. The app opens the chat before this request
    // answers, which makes a repeat far likelier than it used to be: a reconnect, a
    // re-mounted screen, or a client timeout on the ~1.5s of `git fetch` + `worktree
    // add` all re-issue the same create. Wait out a run that is still in flight, then
    // hand back whatever session exists — provisioning twice for one id would strand a
    // worktree and leave the app watching the wrong session. A failed run leaves no
    // row behind, so a retry after one provisions normally.
    //
    // The claim has to be taken in the same tick as the lookup that found the id
    // unclaimed, which is why the "does it exist" check sits INSIDE the run rather
    // than in front of it: `getSession` awaits, and two requests that both got past
    // it before either had registered would each provision a worktree — then the
    // loser's cleanup, keyed on the id they share, would delete the winner's session
    // out from under a 201 the app already acted on.
    for (;;) {
      const claimed = spawnsInFlight.get(requestedId);
      if (claimed === undefined) break;
      await claimed.catch(() => undefined);
    }

    const run = (async (): Promise<SpawnResult> => {
      const existing = await deps.eventStore.getSession(requestedId);
      if (existing !== undefined) {
        reply.code(200);
        return { sessionId: existing.sessionId, existing: true };
      }
      return spawnSession(request, reply, body);
    })();
    // Released as the run settles, not in this request's `finally`: a waiter above
    // resumes on this promise, and must never find the claim it just waited out
    // still in the map.
    const tracked = run.finally(() => spawnsInFlight.delete(requestedId));
    // Waiters attach their own handler; without this a create nobody retried would
    // surface as an unhandled rejection.
    void tracked.catch(() => undefined);
    spawnsInFlight.set(requestedId, tracked);
    return await run;
  });
}
