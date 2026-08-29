import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema.js';

export type WorkflowState =
  | 'draft'
  | 'awaiting_authorization'
  | 'running'
  | 'awaiting_decision'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type WorkflowStepState =
  | 'pending'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'result_submitted'
  | 'waiting_for_gate'
  | 'completed'
  | 'retryable_failed'
  | 'permanently_failed'
  | 'cancelled';

export interface WorkflowServiceDeployment {
  projectId: string;
  repository: string;
  manifestPath: string;
  argoApplication: string;
}

export interface WorkflowServiceInput {
  id: string;
  sourceProjectId: string;
  sourceRepository: string;
  imageRepository: string;
  deployments: Record<string, WorkflowServiceDeployment>;
}

export interface CreateWorkflowInput {
  idempotencyKey: string;
  controlProjectId: string;
  rootSessionId?: string | null;
  actorId: string;
  objective: string;
  environment: string;
  serviceId: string;
}

export interface WorkflowView {
  id: string;
  version: number;
  state: WorkflowState;
  objective: string;
  environment: string;
  serviceId: string;
  steps: Array<{
    id: string;
    ordinal: number;
    kind: string;
    state: WorkflowStepState;
    attempt: number;
    maxAttempts: number;
    targetProjectId: string | null;
    completionGate: string;
  }>;
}

export interface HandoffResultInput {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled';
  summary: string;
  outputs: Record<string, unknown>;
  evidence: unknown[];
  blocker?: unknown;
}

export interface WorkflowGateCandidate {
  workflowId: string;
  workflowVersion: number;
  stepId: string;
  stepKind: string;
  completionGate: string;
  expectedEvidence: unknown;
  attempt: number;
}

export interface WorkflowOutboxItem {
  id: string;
  workflowId: string;
  stepId: string;
  attempt: number;
  kind: string;
  actorId: string;
}

export interface WorkflowMergeOutboxItem {
  id: string;
  workflowId: string;
  stepId: string;
  pullRequest: number;
  sessionId: string;
  actorId: string;
  headSha: string;
}

export class WorkflowConflictError extends Error {}
export class WorkflowNotFoundError extends Error {}
export class WorkflowAuthorizationError extends Error {}

const SERIAL_TEMPLATE = [
  { kind: 'source.change.v1', gate: 'session.result', target: 'source' },
  { kind: 'source.pr-ci.v1', gate: 'pull_request.ci_passed', target: null },
  { kind: 'image.publish.v1', gate: 'oci.provenance_verified', target: null },
  { kind: 'gitops.image-update.v1', gate: 'session.result', target: 'deployment' },
  { kind: 'gitops.pr-ci.v1', gate: 'pull_request.ci_passed', target: null },
  { kind: 'merge.decision.v1', gate: 'user.decision', target: null },
  { kind: 'argocd.reconcile.v1', gate: 'argocd.synced_healthy', target: null },
  { kind: 'workload.verify.v1', gate: 'application.health', target: null },
] as const;

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function capabilityHash(value: string): string {
  return createHash('sha256').update(`workflow-handoff:${value}`).digest('hex');
}

type WorkflowDb = Kysely<Database> | Transaction<Database>;

export class WorkflowStore {
  constructor(private readonly db: Kysely<Database>) {}

  async registerService(input: WorkflowServiceInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('workflow_services')
        .selectAll()
        .where('id', '=', input.id)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined) {
        const changed =
          existing.source_project_id !== input.sourceProjectId ||
          existing.source_repository !== input.sourceRepository.toLowerCase() ||
          existing.image_repository !== input.imageRepository.toLowerCase() ||
          requestHash(existing.deployments) !== requestHash(input.deployments);
        if (changed) {
          const active = await tx
            .selectFrom('workflows')
            .select('id')
            .where('service_id', '=', input.id)
            .where('state', 'not in', ['succeeded', 'failed', 'cancelled', 'rolled_back'])
            .executeTakeFirst();
          if (active !== undefined)
            throw new WorkflowConflictError(
              'service registry cannot change during an active workflow',
            );
        }
      }
      await tx
        .insertInto('workflow_services')
        .values({
          id: input.id,
          source_project_id: input.sourceProjectId,
          source_repository: input.sourceRepository.toLowerCase(),
          image_repository: input.imageRepository.toLowerCase(),
          deployments: input.deployments,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            source_project_id: input.sourceProjectId,
            source_repository: input.sourceRepository.toLowerCase(),
            image_repository: input.imageRepository.toLowerCase(),
            deployments: input.deployments,
            updated_at: new Date().toISOString(),
          }),
        )
        .execute();
    });
  }

  /** First-use registration from an explicitly approved Control-plane call.
   * Existing relationships are immutable through this path. */
  async ensureService(
    input: WorkflowServiceInput,
    transaction?: Transaction<Database>,
  ): Promise<void> {
    const execute = async (tx: Transaction<Database>): Promise<void> => {
      await tx
        .insertInto('workflow_services')
        .values({
          id: input.id,
          source_project_id: input.sourceProjectId,
          source_repository: input.sourceRepository.toLowerCase(),
          image_repository: input.imageRepository.toLowerCase(),
          deployments: input.deployments,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      const stored = await tx
        .selectFrom('workflow_services')
        .selectAll()
        .where('id', '=', input.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const sameIdentity =
        stored.source_project_id === input.sourceProjectId &&
        stored.source_repository === input.sourceRepository.toLowerCase() &&
        stored.image_repository === input.imageRepository.toLowerCase();
      if (!sameIdentity)
        throw new WorkflowConflictError(`service ${input.id} is already registered differently`);
      const deployments = stored.deployments as Record<string, WorkflowServiceDeployment>;
      for (const [environment, deployment] of Object.entries(input.deployments)) {
        const existing = deployments[environment];
        if (existing !== undefined && requestHash(existing) !== requestHash(deployment))
          throw new WorkflowConflictError(
            `service ${input.id} ${environment} deployment is already registered differently`,
          );
      }
      const merged = { ...deployments, ...input.deployments };
      if (requestHash(merged) !== requestHash(deployments)) {
        await tx
          .updateTable('workflow_services')
          .set({ deployments: merged, updated_at: new Date().toISOString() })
          .where('id', '=', input.id)
          .execute();
      }
    };
    return transaction === undefined
      ? this.db.transaction().execute(execute)
      : execute(transaction);
  }

  async createWorkflow(
    input: CreateWorkflowInput,
    transaction?: Transaction<Database>,
    commandRequestHash?: string,
  ): Promise<WorkflowView> {
    const hash = commandRequestHash ?? requestHash(input);
    const execute = async (tx: Transaction<Database>): Promise<WorkflowView> => {
      const replay = await tx
        .selectFrom('workflow_commands')
        .select(['request_hash', 'response'])
        .where('actor_id', '=', input.actorId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_hash !== hash) {
          throw new WorkflowConflictError('idempotency key was reused with another request');
        }
        return replay.response as WorkflowView;
      }

      const service = await tx
        .selectFrom('workflow_services')
        .selectAll()
        .where('id', '=', input.serviceId)
        .executeTakeFirst();
      if (service === undefined)
        throw new WorkflowNotFoundError(`service ${input.serviceId} not found`);
      const deployments = service.deployments as Record<string, WorkflowServiceDeployment>;
      const deployment = deployments[input.environment];
      if (deployment === undefined) {
        throw new WorkflowAuthorizationError(
          `service ${input.serviceId} has no registered ${input.environment} deployment`,
        );
      }
      const workflowId = `wf_${randomUUID()}`;
      await tx
        .insertInto('workflows')
        .values({
          id: workflowId,
          version: 1,
          template_kind: 'image-delivery.v1',
          template_version: 1,
          control_project_id: input.controlProjectId,
          root_session_id: input.rootSessionId ?? null,
          created_by_actor_id: input.actorId,
          objective: input.objective,
          environment: input.environment,
          service_id: input.serviceId,
          state: 'awaiting_authorization',
          blocker: null,
        })
        .execute();
      const stepIds = SERIAL_TEMPLATE.map(() => `step_${randomUUID()}`);
      await tx
        .insertInto('workflow_steps')
        .values(
          SERIAL_TEMPLATE.map((definition, ordinal) => ({
            id: stepIds[ordinal]!,
            workflow_id: workflowId,
            ordinal,
            kind: definition.kind,
            target_project_id:
              definition.target === 'source'
                ? service.source_project_id
                : definition.target === 'deployment'
                  ? deployment.projectId
                  : null,
            depends_on: ordinal === 0 ? [] : [stepIds[ordinal - 1]!],
            state: 'pending',
            attempt: 0,
            max_attempts: 2,
            input_artifact_refs: [],
            completion_gate: definition.gate,
            lease_expires_at: null,
            next_reconcile_at: null,
            expected_evidence: {},
          })),
        )
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'workflow.created',
        'user',
        input.actorId,
        null,
        'awaiting_authorization',
        {
          serviceId: input.serviceId,
          environment: input.environment,
        },
      );
      const view = await this.getWorkflowFrom(tx, workflowId);
      await tx
        .insertInto('workflow_commands')
        .values({
          actor_id: input.actorId,
          idempotency_key: input.idempotencyKey,
          workflow_id: workflowId,
          command_kind: 'workflow.create',
          request_hash: hash,
          response: view,
        })
        .execute();
      return view;
    };
    return transaction === undefined
      ? this.db.transaction().execute(execute)
      : execute(transaction);
  }

  async authorizeWorkflow(
    workflowId: string,
    expectedVersion: number,
    actor: { id: string; authorizationHash: string },
    transaction?: Transaction<Database>,
  ): Promise<WorkflowView> {
    const execute = async (tx: Transaction<Database>): Promise<WorkflowView> => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['state', 'version'])
        .where('id', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow === undefined)
        throw new WorkflowNotFoundError(`workflow ${workflowId} not found`);
      if (workflow.version !== expectedVersion || workflow.state !== 'awaiting_authorization') {
        throw new WorkflowConflictError('workflow version or state changed');
      }
      const decisionId = `pol_${randomUUID()}`;
      await tx
        .insertInto('workflow_policy_decisions')
        .values({
          id: decisionId,
          workflow_id: workflowId,
          transition: 'workflow.authorize',
          actor_id: actor.id,
          authorization_hash: actor.authorizationHash,
          decision: 'allowed',
          reason: 'explicit transition authorization',
        })
        .execute();
      await tx
        .updateTable('workflows')
        .set({
          state: 'running',
          version: expectedVersion + 1,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', workflowId)
        .execute();
      await tx
        .updateTable('workflow_steps')
        .set({ state: 'dispatching', attempt: 1, updated_at: new Date().toISOString() })
        .where('workflow_id', '=', workflowId)
        .where('ordinal', '=', 0)
        .execute();
      const firstStep = await tx
        .selectFrom('workflow_steps')
        .select('id')
        .where('workflow_id', '=', workflowId)
        .where('ordinal', '=', 0)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('workflow_dispatch_outbox')
        .values({
          id: `out_${randomUUID()}`,
          workflow_id: workflowId,
          step_id: firstStep.id,
          attempt: 1,
          kind: 'session.dispatch',
          payload: { workflowId, stepId: firstStep.id, attempt: 1, actorId: actor.id },
          available_at: new Date().toISOString(),
          claimed_until: null,
          completed_at: null,
          attempts: 0,
          last_error: null,
        })
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'workflow.authorized',
        'user',
        actor.id,
        workflow.state,
        'running',
        {},
        decisionId,
      );
      return this.getWorkflowFrom(tx, workflowId);
    };
    return transaction === undefined
      ? this.db.transaction().execute(execute)
      : execute(transaction);
  }

  async createAuthorizedWorkflowWithService(
    service: WorkflowServiceInput,
    input: CreateWorkflowInput,
    actor: { id: string; authorizationHash: string },
  ): Promise<WorkflowView> {
    return this.db.transaction().execute(async (tx) => {
      const atomicRequestHash = requestHash({ service, input });
      const replay = await tx
        .selectFrom('workflow_commands')
        .select(['request_hash', 'workflow_id'])
        .where('actor_id', '=', input.actorId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_hash !== atomicRequestHash)
          throw new WorkflowConflictError('idempotency key was reused with another request');
        if (replay.workflow_id === null)
          throw new WorkflowConflictError('delivery replay has no workflow binding');
        return this.getWorkflowFrom(tx, replay.workflow_id);
      }
      await this.ensureService(service, tx);
      const created = await this.createWorkflow(input, tx, atomicRequestHash);
      if (created.state !== 'awaiting_authorization') return created;
      try {
        return await this.authorizeWorkflow(created.id, created.version, actor, tx);
      } catch (error) {
        if (!(error instanceof WorkflowConflictError)) throw error;
        const current = await this.getWorkflowFrom(tx, created.id);
        if (current.state === 'awaiting_authorization') throw error;
        return current;
      }
    });
  }

  async queueDispatch(
    workflowId: string,
    stepId: string,
    expectedVersion: number,
    actor: string | { id: string; authorizationHash: string } = 'workflow-service',
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['state', 'version'])
        .where('id', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      const step = await tx
        .selectFrom('workflow_steps')
        .selectAll()
        .where('id', '=', stepId)
        .where('workflow_id', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow === undefined || step === undefined)
        throw new WorkflowNotFoundError('workflow or step not found');
      if (
        workflow.version === expectedVersion &&
        workflow.state === 'running' &&
        step.state === 'dispatching'
      ) {
        const existing = await tx
          .selectFrom('workflow_dispatch_outbox')
          .select('id')
          .where('workflow_id', '=', workflowId)
          .where('step_id', '=', stepId)
          .where('attempt', '=', step.attempt)
          .where('completed_at', 'is', null)
          .executeTakeFirst();
        if (existing !== undefined) return;
      }
      if (
        workflow.version !== expectedVersion ||
        workflow.state !== 'running' ||
        step.state !== 'ready'
      )
        throw new WorkflowConflictError('step is not dispatchable');
      const attempt = step.attempt + 1;
      const actorId = typeof actor === 'string' ? actor : actor.id;
      const policyDecisionId = typeof actor === 'string' ? null : `pol_${randomUUID()}`;
      if (typeof actor !== 'string' && policyDecisionId !== null)
        await tx
          .insertInto('workflow_policy_decisions')
          .values({
            id: policyDecisionId,
            workflow_id: workflowId,
            transition: 'step:dispatch',
            actor_id: actor.id,
            authorization_hash: actor.authorizationHash,
            decision: 'allowed',
            reason: 'dispatch authorized at transition time',
          })
          .execute();
      await tx
        .updateTable('workflow_steps')
        .set({ state: 'dispatching', attempt, updated_at: new Date().toISOString() })
        .where('id', '=', stepId)
        .execute();
      await tx
        .updateTable('workflows')
        .set({ version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .where('id', '=', workflowId)
        .execute();
      await tx
        .insertInto('workflow_dispatch_outbox')
        .values({
          id: `out_${randomUUID()}`,
          workflow_id: workflowId,
          step_id: stepId,
          attempt,
          kind: 'session.dispatch',
          payload: { workflowId, stepId, attempt, actorId },
          available_at: new Date().toISOString(),
          claimed_until: null,
          completed_at: null,
          attempts: 0,
          last_error: null,
        })
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'step.dispatch_queued',
        'system',
        'workflow-service',
        'ready',
        'dispatching',
        { stepId, attempt },
        policyDecisionId,
      );
    });
  }

  async issueHandoff(
    outboxId: string,
    ttlMs = 30 * 60_000,
  ): Promise<{ handoffId: string; capability: string; payload: unknown; sessionId?: string }> {
    return this.db.transaction().execute(async (tx) => {
      const outbox = await tx
        .selectFrom('workflow_dispatch_outbox')
        .selectAll()
        .where('id', '=', outboxId)
        .forUpdate()
        .executeTakeFirst();
      if (outbox === undefined) throw new WorkflowNotFoundError(`outbox ${outboxId} not found`);
      if (outbox.completed_at !== null)
        throw new WorkflowConflictError('dispatch outbox is already complete');
      const existing = await tx
        .selectFrom('workflow_handoffs')
        .select(['id', 'payload', 'session_id'])
        .where('step_id', '=', outbox.step_id)
        .where('attempt', '=', outbox.attempt)
        .executeTakeFirst();
      const step = await tx
        .selectFrom('workflow_steps')
        .selectAll()
        .where('id', '=', outbox.step_id)
        .executeTakeFirstOrThrow();
      const workflowState = await tx
        .selectFrom('workflows')
        .select('state')
        .where('id', '=', outbox.workflow_id)
        .executeTakeFirstOrThrow();
      if (
        workflowState.state !== 'running' ||
        step.state !== 'dispatching' ||
        step.attempt !== outbox.attempt
      )
        throw new WorkflowConflictError('dispatch is no longer active');
      if (step.target_project_id === null)
        throw new WorkflowConflictError('provider gates are reconciled, not session-dispatched');
      const workflow = await tx
        .selectFrom('workflows as workflow')
        .innerJoin('workflow_services as service', 'service.id', 'workflow.service_id')
        .select([
          'workflow.environment as environment',
          'service.source_repository as source_repository',
          'service.image_repository as image_repository',
          'service.deployments as deployments',
        ])
        .where('workflow.id', '=', outbox.workflow_id)
        .executeTakeFirstOrThrow();
      const deployment = (workflow.deployments as Record<string, WorkflowServiceDeployment>)[
        workflow.environment
      ];
      if (deployment === undefined)
        throw new WorkflowAuthorizationError('registered deployment no longer exists');
      const allowedRepository =
        step.kind === 'source.change.v1'
          ? workflow.source_repository
          : deployment.repository.toLowerCase();
      const capability = randomBytes(32).toString('base64url');
      if (existing !== undefined) {
        await tx
          .updateTable('workflow_handoffs')
          .set({
            capability_hash: capabilityHash(capability),
            expires_at: new Date(Date.now() + ttlMs).toISOString(),
          })
          .where('id', '=', existing.id)
          .execute();
        return {
          handoffId: existing.id,
          capability,
          payload: existing.payload,
          ...(existing.session_id !== null ? { sessionId: existing.session_id } : {}),
        };
      }
      const handoffId = `hof_${randomUUID()}`;
      const payload = {
        schemaVersion: 1,
        handoffId,
        workflowId: outbox.workflow_id,
        stepId: outbox.step_id,
        attempt: outbox.attempt,
        targetProjectId: step.target_project_id,
        kind: step.kind,
        inputs: {
          imageRepository: workflow.image_repository,
          evidence: step.expected_evidence,
          ...(step.kind === 'gitops.image-update.v1'
            ? { manifestPath: deployment.manifestPath }
            : {}),
        },
        constraints: {
          allowedRepository,
          ...(step.kind === 'gitops.image-update.v1'
            ? { allowedPathPrefixes: [`${deployment.manifestPath.replace(/\/+$/, '')}/`] }
            : {}),
          mayMerge: false,
          mayDeploy: false,
        },
      };
      await tx
        .insertInto('workflow_handoffs')
        .values({
          id: handoffId,
          workflow_id: outbox.workflow_id,
          step_id: outbox.step_id,
          attempt: outbox.attempt,
          target_project_id: step.target_project_id,
          kind: step.kind,
          payload,
          capability_hash: capabilityHash(capability),
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
          session_id: null,
          previous_handoff_id: null,
          dispatched_at: null,
        })
        .execute();
      return { handoffId, capability, payload };
    });
  }

  async claimDueOutbox(
    now = new Date(),
    leaseMs = 60_000,
    scope?: { workflowId: string; stepId: string },
  ): Promise<WorkflowOutboxItem | undefined> {
    return this.db.transaction().execute(async (tx) => {
      let query = tx
        .selectFrom('workflow_dispatch_outbox as outbox')
        .innerJoin('workflows as workflow', 'workflow.id', 'outbox.workflow_id')
        .innerJoin('workflow_steps as step', 'step.id', 'outbox.step_id')
        .select([
          'outbox.id',
          'outbox.workflow_id',
          'outbox.step_id',
          'outbox.attempt',
          'outbox.kind',
          'outbox.payload',
        ])
        .where('outbox.completed_at', 'is', null)
        .where('outbox.available_at', '<=', now)
        .where('workflow.state', '=', 'running')
        .where('step.state', '=', 'dispatching')
        .where('outbox.kind', '=', 'session.dispatch')
        .where((eb) =>
          eb.or([eb('outbox.claimed_until', 'is', null), eb('outbox.claimed_until', '<=', now)]),
        )
        .orderBy('outbox.available_at')
        .forUpdate()
        .skipLocked();
      if (scope !== undefined) {
        query = query
          .where('outbox.workflow_id', '=', scope.workflowId)
          .where('outbox.step_id', '=', scope.stepId);
      }
      const row = await query.executeTakeFirst();
      if (row === undefined) return undefined;
      await tx
        .updateTable('workflow_dispatch_outbox')
        .set({
          claimed_until: new Date(now.getTime() + leaseMs).toISOString(),
          attempts: (eb) => eb('attempts', '+', 1),
        })
        .where('id', '=', row.id)
        .execute();
      return {
        id: row.id,
        workflowId: row.workflow_id,
        stepId: row.step_id,
        attempt: row.attempt,
        kind: row.kind,
        actorId:
          typeof row.payload === 'object' &&
          row.payload !== null &&
          'actorId' in row.payload &&
          typeof row.payload.actorId === 'string'
            ? row.payload.actorId
            : 'workflow-service',
      };
    });
  }

  async claimDueMergeOutbox(
    now = new Date(),
    leaseMs = 60_000,
  ): Promise<WorkflowMergeOutboxItem | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('workflow_dispatch_outbox as outbox')
        .innerJoin('workflow_steps as step', 'step.id', 'outbox.step_id')
        .innerJoin('workflows as workflow', 'workflow.id', 'outbox.workflow_id')
        .select(['outbox.id', 'outbox.workflow_id', 'outbox.step_id', 'outbox.payload'])
        .where('outbox.kind', '=', 'github.merge')
        .where('outbox.completed_at', 'is', null)
        .where('outbox.available_at', '<=', now)
        .where('workflow.state', '=', 'running')
        .where('step.state', '=', 'waiting_for_gate')
        .where('step.completion_gate', '=', 'pull_request.merged')
        .where((eb) =>
          eb.or([eb('outbox.claimed_until', 'is', null), eb('outbox.claimed_until', '<=', now)]),
        )
        .orderBy('outbox.available_at')
        .forUpdate('outbox')
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const payload = row.payload as Record<string, unknown>;
      if (!Number.isInteger(payload.pullRequest) || typeof payload.sessionId !== 'string') {
        throw new WorkflowConflictError('merge outbox payload is invalid');
      }
      if (typeof payload.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(payload.headSha))
        throw new WorkflowConflictError('merge outbox head SHA is invalid');
      await tx
        .updateTable('workflow_dispatch_outbox')
        .set({
          claimed_until: new Date(now.getTime() + leaseMs).toISOString(),
          attempts: (eb) => eb('attempts', '+', 1),
        })
        .where('id', '=', row.id)
        .execute();
      return {
        id: row.id,
        workflowId: row.workflow_id,
        stepId: row.step_id,
        pullRequest: payload.pullRequest as number,
        sessionId: payload.sessionId,
        actorId: typeof payload.actorId === 'string' ? payload.actorId : 'workflow-service',
        headSha: payload.headSha,
      };
    });
  }

  async completeMergeOutbox(outboxId: string): Promise<void> {
    await this.db
      .updateTable('workflow_dispatch_outbox')
      .set({ completed_at: new Date().toISOString(), claimed_until: null, last_error: null })
      .where('id', '=', outboxId)
      .where('kind', '=', 'github.merge')
      .execute();
  }

  async releaseOutbox(outboxId: string, error: string, retryAt: Date): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const item = await tx
        .selectFrom('workflow_dispatch_outbox as outbox')
        .innerJoin('workflow_steps as step', 'step.id', 'outbox.step_id')
        .innerJoin('workflows as workflow', 'workflow.id', 'outbox.workflow_id')
        .select([
          'outbox.workflow_id',
          'outbox.step_id',
          'outbox.attempts',
          'step.max_attempts',
          'workflow.version',
        ])
        .where('outbox.id', '=', outboxId)
        .where('outbox.completed_at', 'is', null)
        .forUpdate('outbox')
        .executeTakeFirst();
      if (item === undefined) return;
      if (item.attempts >= item.max_attempts) {
        const now = new Date().toISOString();
        await tx
          .updateTable('workflow_dispatch_outbox')
          .set({ completed_at: now, claimed_until: null, last_error: error.slice(0, 2_000) })
          .where('id', '=', outboxId)
          .execute();
        await tx
          .updateTable('workflow_steps')
          .set({ state: 'permanently_failed', updated_at: now })
          .where('id', '=', item.step_id)
          .execute();
        await tx
          .updateTable('workflows')
          .set({
            state: 'failed',
            version: item.version + 1,
            blocker: { summary: error.slice(0, 2_000) },
            updated_at: now,
          })
          .where('id', '=', item.workflow_id)
          .execute();
        await this.appendEvent(
          tx,
          item.workflow_id,
          'dispatch.retry_exhausted',
          'system',
          'session-launcher',
          'dispatching',
          'permanently_failed',
          { stepId: item.step_id, attempts: item.attempts, error: error.slice(0, 2_000) },
        );
        return;
      }
      await tx
        .updateTable('workflow_dispatch_outbox')
        .set({
          claimed_until: null,
          available_at: retryAt.toISOString(),
          last_error: error.slice(0, 2_000),
        })
        .where('id', '=', outboxId)
        .execute();
    });
  }

  async deferOutboxWithoutAttempt(outboxId: string, reason: string, retryAt: Date): Promise<void> {
    await this.db
      .updateTable('workflow_dispatch_outbox')
      .set({
        claimed_until: null,
        available_at: retryAt.toISOString(),
        attempts: (eb) => eb('attempts', '-', 1),
        last_error: reason.slice(0, 2_000),
      })
      .where('id', '=', outboxId)
      .where('completed_at', 'is', null)
      .where('attempts', '>', 0)
      .execute();
  }

  async bindHandoffSession(handoffId: string, sessionId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const handoff = await tx
        .selectFrom('workflow_handoffs as handoff')
        .innerJoin('workflow_steps as step', 'step.id', 'handoff.step_id')
        .innerJoin('workflows as workflow', 'workflow.id', 'handoff.workflow_id')
        .select(['handoff.workflow_id', 'handoff.step_id', 'handoff.session_id'])
        .where('handoff.id', '=', handoffId)
        .where('workflow.state', '=', 'running')
        .where('step.state', '=', 'dispatching')
        .forUpdate('handoff')
        .executeTakeFirst();
      if (handoff === undefined)
        throw new WorkflowConflictError(`handoff ${handoffId} is no longer dispatchable`);
      if (handoff.session_id !== sessionId)
        throw new WorkflowConflictError('handoff session association does not match');
      await tx
        .updateTable('workflow_handoffs')
        .set({ dispatched_at: new Date().toISOString() })
        .where('id', '=', handoffId)
        .where('session_id', '=', sessionId)
        .execute();
      await tx
        .updateTable('workflow_steps')
        .set({
          state: 'running',
          lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', handoff.step_id)
        .execute();
      await tx
        .updateTable('workflow_dispatch_outbox')
        .set({ completed_at: new Date().toISOString(), claimed_until: null })
        .where('step_id', '=', handoff.step_id)
        .execute();
      await this.appendEvent(
        tx,
        handoff.workflow_id,
        'handoff.dispatched',
        'system',
        'session-launcher',
        'dispatching',
        'running',
        { handoffId, sessionId },
      );
    });
  }

  async retryBoundDispatch(handoffId: string, error: string, retryAt: Date): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('workflow_handoffs as handoff')
        .innerJoin('workflow_steps as step', 'step.id', 'handoff.step_id')
        .innerJoin('workflows as workflow', 'workflow.id', 'handoff.workflow_id')
        .select([
          'handoff.workflow_id',
          'handoff.step_id',
          'handoff.attempt',
          'step.max_attempts',
          'workflow.version',
        ])
        .where('handoff.id', '=', handoffId)
        .where('workflow.state', '=', 'running')
        .where('step.state', '=', 'running')
        .forUpdate('handoff')
        .executeTakeFirst();
      if (row === undefined) return;
      const previousOutbox = await tx
        .selectFrom('workflow_dispatch_outbox')
        .select('payload')
        .where('step_id', '=', row.step_id)
        .where('attempt', '=', row.attempt)
        .where('kind', '=', 'session.dispatch')
        .executeTakeFirst();
      const previousPayload = previousOutbox?.payload as Record<string, unknown> | undefined;
      const actorId =
        typeof previousPayload?.actorId === 'string' ? previousPayload.actorId : 'workflow-service';
      const now = new Date().toISOString();
      await tx
        .updateTable('workflow_handoffs')
        .set({ expires_at: now })
        .where('id', '=', handoffId)
        .execute();
      if (row.attempt >= row.max_attempts) {
        await tx
          .updateTable('workflow_steps')
          .set({ state: 'permanently_failed', lease_expires_at: null, updated_at: now })
          .where('id', '=', row.step_id)
          .execute();
        await tx
          .updateTable('workflows')
          .set({
            state: 'failed',
            version: row.version + 1,
            blocker: { summary: error.slice(0, 2_000) },
            updated_at: now,
          })
          .where('id', '=', row.workflow_id)
          .execute();
        return;
      }
      const attempt = row.attempt + 1;
      await tx
        .updateTable('workflow_steps')
        .set({ state: 'dispatching', attempt, lease_expires_at: null, updated_at: now })
        .where('id', '=', row.step_id)
        .execute();
      await tx
        .updateTable('workflows')
        .set({ version: row.version + 1, updated_at: now })
        .where('id', '=', row.workflow_id)
        .execute();
      await tx
        .insertInto('workflow_dispatch_outbox')
        .values({
          id: `out_${randomUUID()}`,
          workflow_id: row.workflow_id,
          step_id: row.step_id,
          attempt,
          kind: 'session.dispatch',
          payload: { workflowId: row.workflow_id, stepId: row.step_id, attempt, actorId },
          available_at: retryAt.toISOString(),
          claimed_until: null,
          completed_at: null,
          attempts: 0,
          last_error: error.slice(0, 2_000),
        })
        .execute();
    });
  }

  async latestHandoffSession(workflowId: string, kind: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('workflow_handoffs')
      .select('session_id')
      .where('workflow_id', '=', workflowId)
      .where('kind', '=', kind)
      .where('session_id', 'is not', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row?.session_id ?? undefined;
  }

  async renewHandoffSessionLease(sessionId: string, now = new Date()): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const handoff = await tx
        .selectFrom('workflow_handoffs as handoff')
        .innerJoin('workflow_steps as step', 'step.id', 'handoff.step_id')
        .select('handoff.id')
        .where('handoff.session_id', '=', sessionId)
        .where('step.state', '=', 'running')
        .forUpdate('handoff')
        .executeTakeFirst();
      if (handoff === undefined) return false;
      const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      await tx
        .updateTable('workflow_steps')
        .set({ lease_expires_at: expiresAt, updated_at: now.toISOString() })
        .where('id', '=', (eb) =>
          eb.selectFrom('workflow_handoffs').select('step_id').where('id', '=', handoff.id),
        )
        .execute();
      await tx
        .updateTable('workflow_handoffs')
        .set({ expires_at: expiresAt })
        .where('id', '=', handoff.id)
        .execute();
      return true;
    });
  }

  async recordHandoffSession(handoffId: string, sessionId: string): Promise<void> {
    const result = await this.db
      .updateTable('workflow_handoffs')
      .set({ session_id: sessionId })
      .where('id', '=', handoffId)
      .where('session_id', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) !== 1) {
      const existing = await this.db
        .selectFrom('workflow_handoffs')
        .select('session_id')
        .where('id', '=', handoffId)
        .executeTakeFirst();
      if (existing === undefined) throw new WorkflowNotFoundError(`handoff ${handoffId} not found`);
      if (existing.session_id !== sessionId)
        throw new WorkflowConflictError('handoff is already associated with another session');
    }
  }

  async submitResult(
    authentication: {
      capability: string;
      handoffId: string;
      projectId: string;
      sessionId: string;
      pullRequest: number;
      commit: string;
    },
    input: HandoffResultInput,
  ): Promise<WorkflowView> {
    return this.db.transaction().execute(async (tx) => {
      const query = tx
        .selectFrom('workflow_handoffs')
        .selectAll()
        .where('id', '=', authentication.handoffId)
        .where('target_project_id', '=', authentication.projectId)
        .where('session_id', '=', authentication.sessionId)
        .where('capability_hash', '=', capabilityHash(authentication.capability))
        .forUpdate();
      const handoff = await query.executeTakeFirst();
      if (
        handoff === undefined ||
        handoff.expires_at.getTime() <= Date.now() ||
        handoff.session_id === null ||
        handoff.dispatched_at === null
      )
        throw new WorkflowAuthorizationError('invalid or expired handoff capability');
      if (handoff !== undefined) {
        const replay = await tx
          .selectFrom('workflow_results')
          .selectAll()
          .where('handoff_id', '=', handoff.id)
          .executeTakeFirst();
        if (replay !== undefined) return this.getWorkflowFrom(tx, handoff.workflow_id);
      }
      const active = await tx
        .selectFrom('workflow_steps as step')
        .innerJoin('workflows as workflow', 'workflow.id', 'step.workflow_id')
        .select([
          'step.state',
          'step.attempt',
          'workflow.state as workflow_state',
          'workflow.version as workflow_version',
        ])
        .where('step.id', '=', handoff.step_id)
        .executeTakeFirst();
      if (
        active?.workflow_state !== 'running' ||
        active.state !== 'running' ||
        active.attempt !== handoff.attempt
      ) {
        throw new WorkflowAuthorizationError('handoff is no longer active');
      }
      const contract = handoff.payload as {
        kind?: string;
        constraints?: { allowedRepository?: string; allowedPathPrefixes?: string[] };
      };
      const allowedRepository = contract.constraints?.allowedRepository?.toLowerCase();
      const repository = input.outputs.repository;
      if (
        input.status === 'completed' &&
        (typeof repository !== 'string' || repository.toLowerCase() !== allowedRepository)
      ) {
        throw new WorkflowAuthorizationError(
          'result repository does not match the registered handoff repository',
        );
      }
      if (input.status === 'completed') {
        if (
          input.outputs.pullRequest !== authentication.pullRequest ||
          input.outputs.commit !== authentication.commit
        )
          throw new WorkflowAuthorizationError(
            'result pull request is not bound to the handoff session branch',
          );
        if (
          !Number.isInteger(input.outputs.pullRequest) ||
          typeof input.outputs.commit !== 'string' ||
          !/^[0-9a-f]{40}$/i.test(input.outputs.commit)
        ) {
          throw new WorkflowAuthorizationError(
            'completed handoff requires a pull request number and commit SHA',
          );
        }
        if (handoff.kind === 'gitops.image-update.v1') {
          const changedPaths = input.outputs.changedPaths;
          const allowed = contract.constraints?.allowedPathPrefixes ?? [];
          if (
            !Array.isArray(changedPaths) ||
            changedPaths.length === 0 ||
            !changedPaths.every(
              (path) =>
                typeof path === 'string' && allowed.some((prefix) => path.startsWith(prefix)),
            )
          ) {
            throw new WorkflowAuthorizationError(
              'GitOps result paths exceed the registered manifest scope',
            );
          }
        }
      }
      const normalizedOutputs =
        typeof repository === 'string' && repository.includes('/')
          ? {
              ...input.outputs,
              owner: repository.split('/', 2)[0]!.toLowerCase(),
              repo: repository.split('/', 2)[1]!.toLowerCase(),
              headSha: input.outputs.commit,
              ...(handoff.kind === 'gitops.image-update.v1'
                ? { allowedPathPrefixes: contract.constraints?.allowedPathPrefixes ?? [] }
                : {}),
            }
          : input.outputs;
      await tx
        .insertInto('workflow_results')
        .values({
          handoff_id: handoff.id,
          attempt: handoff.attempt,
          status: input.status,
          summary: input.summary,
          outputs: normalizedOutputs,
          evidence: input.evidence,
          blocker: input.blocker ?? null,
        })
        .execute();
      const nextState: WorkflowStepState =
        input.status === 'completed'
          ? 'waiting_for_gate'
          : input.status === 'failed'
            ? 'retryable_failed'
            : input.status === 'cancelled'
              ? 'cancelled'
              : 'retryable_failed';
      await tx
        .updateTable('workflow_steps')
        .set({
          state: nextState,
          lease_expires_at: null,
          next_reconcile_at: input.status === 'completed' ? new Date().toISOString() : null,
          expected_evidence: normalizedOutputs,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', handoff.step_id)
        .execute();
      await tx
        .updateTable('workflow_handoffs')
        .set({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() })
        .where('id', '=', handoff.id)
        .execute();
      if (input.status === 'blocked')
        await tx
          .updateTable('workflows')
          .set({
            state: 'blocked',
            blocker: input.blocker ?? { summary: input.summary },
            version: active.workflow_version + 1,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', handoff.workflow_id)
          .execute();
      if (input.status === 'cancelled') {
        await tx
          .updateTable('workflows')
          .set({
            state: 'cancelled',
            version: active.workflow_version + 1,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', handoff.workflow_id)
          .execute();
        await tx
          .updateTable('workflow_steps')
          .set({
            state: 'cancelled',
            lease_expires_at: null,
            next_reconcile_at: null,
            updated_at: new Date().toISOString(),
          })
          .where('workflow_id', '=', handoff.workflow_id)
          .where('state', 'not in', ['completed', 'cancelled'])
          .execute();
        await tx
          .updateTable('workflow_dispatch_outbox')
          .set({ completed_at: new Date().toISOString(), claimed_until: null })
          .where('workflow_id', '=', handoff.workflow_id)
          .where('completed_at', 'is', null)
          .execute();
      }
      if (input.status === 'completed' || input.status === 'failed')
        await tx
          .updateTable('workflows')
          .set({ version: active.workflow_version + 1, updated_at: new Date().toISOString() })
          .where('id', '=', handoff.workflow_id)
          .execute();
      await this.appendEvent(
        tx,
        handoff.workflow_id,
        'handoff.result_submitted',
        'session',
        handoff.session_id ?? handoff.id,
        'running',
        nextState,
        { handoffId: handoff.id, status: input.status },
      );
      return this.getWorkflowFrom(tx, handoff.workflow_id);
    });
  }

  async ingestProviderEvent(
    provider: string,
    deliveryId: string,
    eventType: string,
    payload: unknown,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const result = await tx
        .insertInto('workflow_provider_inbox')
        .values({
          provider,
          delivery_id: deliveryId,
          event_type: eventType,
          payload,
          processed_at: null,
          error: null,
        })
        .onConflict((oc) => oc.columns(['provider', 'delivery_id']).doNothing())
        .executeTakeFirst();
      const inserted = Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
      if (inserted) {
        const gates =
          provider === 'github'
            ? ['pull_request.ci_passed', 'pull_request.merged', 'oci.provenance_verified']
            : provider === 'argocd'
              ? ['argocd.synced_healthy', 'application.health']
              : [];
        if (gates.length > 0) {
          await tx
            .updateTable('workflow_steps')
            .set({ next_reconcile_at: new Date().toISOString() })
            .where('state', '=', 'waiting_for_gate')
            .where('completion_gate', 'in', gates)
            .execute();
        }
      }
      return inserted;
    });
  }

  async markProviderEventsReconciled(startedAt: Date, completedAt = new Date()): Promise<void> {
    await this.db
      .updateTable('workflow_provider_inbox')
      .set({ processed_at: completedAt.toISOString(), error: null })
      .where('processed_at', 'is', null)
      .where('received_at', '<=', startedAt)
      .execute();
  }

  async recordImageCandidate(
    workflowId: string,
    digest: string,
    actorId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<WorkflowView> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new WorkflowAuthorizationError('image digest must be an immutable sha256 digest');
    }
    return this.db.transaction().execute(async (tx) => {
      const replay = await tx
        .selectFrom('workflow_artifacts')
        .select(['digest', 'metadata'])
        .where('workflow_id', '=', workflowId)
        .where('type', '=', 'oci.image.v1')
        .execute();
      const replayed = replay.find(
        ({ metadata }) =>
          typeof metadata === 'object' &&
          metadata !== null &&
          'idempotencyKey' in metadata &&
          metadata.idempotencyKey === idempotencyKey,
      );
      if (replayed !== undefined) {
        const metadata = replayed.metadata as Record<string, unknown>;
        if (replayed.digest !== digest || metadata.expectedVersion !== expectedVersion) {
          throw new WorkflowConflictError('idempotency key was already used for another request');
        }
        return this.getWorkflowFrom(tx, workflowId);
      }
      const row = await tx
        .selectFrom('workflows as workflow')
        .innerJoin('workflow_services as service', 'service.id', 'workflow.service_id')
        .innerJoin('workflow_steps as step', 'step.workflow_id', 'workflow.id')
        .select([
          'workflow.version as version',
          'step.id as step_id',
          'step.state as step_state',
          'step.expected_evidence as expected_evidence',
          'service.source_repository as source_repository',
          'service.image_repository as image_repository',
        ])
        .where('workflow.id', '=', workflowId)
        .where('step.kind', '=', 'image.publish.v1')
        .forUpdate('workflow')
        .executeTakeFirst();
      if (row === undefined) throw new WorkflowNotFoundError(`workflow ${workflowId} not found`);
      if (row.version !== expectedVersion)
        throw new WorkflowConflictError('workflow version changed');
      if (row.step_state !== 'waiting_for_gate') {
        throw new WorkflowConflictError('image publication gate is not ready');
      }
      const previous = row.expected_evidence as Record<string, unknown>;
      const sourceCommit = previous.headSha;
      if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
        throw new WorkflowConflictError('verified source commit evidence is missing');
      }
      const evidence = {
        ...previous,
        imageRepository: row.image_repository,
        digest,
        sourceRepository: row.source_repository,
        sourceCommit,
      };
      await tx
        .updateTable('workflow_steps')
        .set({ expected_evidence: evidence, next_reconcile_at: new Date().toISOString() })
        .where('id', '=', row.step_id)
        .execute();
      await tx
        .updateTable('workflows')
        .set({ version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .where('id', '=', workflowId)
        .where('version', '=', expectedVersion)
        .execute();
      await tx
        .insertInto('workflow_artifacts')
        .values({
          id: `artifact_${randomUUID()}`,
          workflow_id: workflowId,
          producer_step_id: row.step_id,
          type: 'oci.image.v1',
          uri: row.image_repository,
          digest,
          metadata: {
            sourceRepository: row.source_repository,
            sourceCommit,
            idempotencyKey,
            expectedVersion,
          },
          verified_at: null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'image.candidate_recorded',
        'user',
        actorId,
        'waiting_for_gate',
        'waiting_for_gate',
        { digest, imageRepository: row.image_repository },
      );
      return this.getWorkflowFrom(tx, workflowId);
    });
  }

  async listDueGates(now = new Date(), limit = 20): Promise<WorkflowGateCandidate[]> {
    const rows = await this.db
      .selectFrom('workflow_steps as step')
      .innerJoin('workflows as workflow', 'workflow.id', 'step.workflow_id')
      .select([
        'step.workflow_id as workflow_id',
        'workflow.version as workflow_version',
        'step.id as step_id',
        'step.kind as step_kind',
        'step.completion_gate as completion_gate',
        'step.expected_evidence as expected_evidence',
        'step.attempt as attempt',
      ])
      .where('workflow.state', 'in', ['running', 'awaiting_decision'])
      .where('step.state', '=', 'waiting_for_gate')
      .where((eb) =>
        eb.or([eb('step.next_reconcile_at', 'is', null), eb('step.next_reconcile_at', '<=', now)]),
      )
      .orderBy('step.next_reconcile_at', 'asc')
      .limit(Math.min(100, Math.max(1, limit)))
      .execute();
    return rows.map((row) => ({
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      stepId: row.step_id,
      stepKind: row.step_kind,
      completionGate: row.completion_gate,
      expectedEvidence: row.expected_evidence,
      attempt: row.attempt,
    }));
  }

  async getGateCandidate(
    workflowId: string,
    stepId: string,
    version: number,
  ): Promise<WorkflowGateCandidate | undefined> {
    const row = await this.db
      .selectFrom('workflow_steps as step')
      .innerJoin('workflows as workflow', 'workflow.id', 'step.workflow_id')
      .select([
        'step.workflow_id as workflow_id',
        'workflow.version as workflow_version',
        'step.id as step_id',
        'step.kind as step_kind',
        'step.completion_gate as completion_gate',
        'step.expected_evidence as expected_evidence',
        'step.attempt as attempt',
      ])
      .where('workflow.id', '=', workflowId)
      .where('workflow.version', '=', version)
      .where('step.id', '=', stepId)
      .where('step.state', '=', 'waiting_for_gate')
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          workflowId: row.workflow_id,
          workflowVersion: row.workflow_version,
          stepId: row.step_id,
          stepKind: row.step_kind,
          completionGate: row.completion_gate,
          expectedEvidence: row.expected_evidence,
          attempt: row.attempt,
        };
  }

  async recordPolicyDenial(
    workflowId: string,
    transition: string,
    actor: { id: string; authorizationHash: string },
    reason: string,
  ): Promise<void> {
    const exists = await this.db
      .selectFrom('workflows')
      .select('id')
      .where('id', '=', workflowId)
      .executeTakeFirst();
    if (exists === undefined) return;
    await this.db
      .insertInto('workflow_policy_decisions')
      .values({
        id: `pol_${randomUUID()}`,
        workflow_id: workflowId,
        transition,
        actor_id: actor.id,
        authorization_hash: actor.authorizationHash,
        decision: 'denied',
        reason: reason.slice(0, 2_000),
      })
      .execute();
  }

  async completeGate(
    candidate: WorkflowGateCandidate,
    evidence: unknown,
    decisionActor?: { id: string; authorizationHash: string },
  ): Promise<WorkflowView> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['version', 'state'])
        .where('id', '=', candidate.workflowId)
        .forUpdate()
        .executeTakeFirst();
      const step = await tx
        .selectFrom('workflow_steps')
        .select(['state', 'ordinal'])
        .where('id', '=', candidate.stepId)
        .where('workflow_id', '=', candidate.workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow === undefined || step === undefined) {
        throw new WorkflowNotFoundError('workflow or step not found');
      }
      if (
        workflow.version !== candidate.workflowVersion ||
        !(
          workflow.state === 'running' ||
          (workflow.state === 'awaiting_decision' && candidate.completionGate === 'user.decision')
        ) ||
        step.state !== 'waiting_for_gate'
      ) {
        throw new WorkflowConflictError('gate candidate is stale');
      }
      const policyDecisionId = decisionActor === undefined ? null : `pol_${randomUUID()}`;
      if (decisionActor !== undefined && policyDecisionId !== null) {
        await tx
          .insertInto('workflow_policy_decisions')
          .values({
            id: policyDecisionId,
            workflow_id: candidate.workflowId,
            transition: candidate.completionGate,
            actor_id: decisionActor.id,
            authorization_hash: decisionActor.authorizationHash,
            decision: 'allowed',
            reason: 'explicit one-transition decision',
          })
          .execute();
      }
      if (candidate.completionGate === 'user.decision') {
        const current = evidence as Record<string, unknown>;
        const pullRequest = current.pullRequest;
        const headSha = current.headSha;
        if (
          !Number.isInteger(pullRequest) ||
          typeof headSha !== 'string' ||
          !/^[0-9a-f]{40}$/i.test(headSha)
        )
          throw new WorkflowConflictError('merge decision lacks verified pull request evidence');
        const session = await tx
          .selectFrom('workflow_handoffs')
          .select('session_id')
          .where('workflow_id', '=', candidate.workflowId)
          .where('kind', '=', 'gitops.image-update.v1')
          .where('session_id', 'is not', null)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (session?.session_id === null || session === undefined)
          throw new WorkflowConflictError('merge decision lacks a GitOps session');
        await tx
          .updateTable('workflow_steps')
          .set({
            completion_gate: 'pull_request.merged',
            expected_evidence: evidence,
            next_reconcile_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', candidate.stepId)
          .execute();
        await tx
          .insertInto('workflow_dispatch_outbox')
          .values({
            id: `out_${randomUUID()}`,
            workflow_id: candidate.workflowId,
            step_id: candidate.stepId,
            attempt: candidate.attempt,
            kind: 'github.merge',
            payload: {
              pullRequest,
              headSha,
              sessionId: session.session_id,
              actorId: decisionActor?.id ?? 'unknown',
              policyDecisionId,
            },
            available_at: new Date().toISOString(),
            claimed_until: null,
            completed_at: null,
            attempts: 0,
            last_error: null,
          })
          .execute();
        await tx
          .updateTable('workflows')
          .set({
            state: 'running',
            version: workflow.version + 1,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', candidate.workflowId)
          .execute();
        await this.appendEvent(
          tx,
          candidate.workflowId,
          'decision.approved',
          'user',
          decisionActor?.id ?? 'unknown',
          'awaiting_decision',
          'waiting_for_gate',
          { stepId: candidate.stepId, awaiting: 'pull_request.merged' },
          policyDecisionId,
        );
        return this.getWorkflowFrom(tx, candidate.workflowId);
      }
      await tx
        .updateTable('workflow_steps')
        .set({
          state: 'completed',
          expected_evidence: evidence,
          next_reconcile_at: null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', candidate.stepId)
        .execute();
      if (candidate.completionGate === 'oci.provenance_verified') {
        const digest = (evidence as Record<string, unknown>).digest;
        if (typeof digest === 'string') {
          await tx
            .updateTable('workflow_artifacts')
            .set({ verified_at: new Date().toISOString(), metadata: evidence })
            .where('workflow_id', '=', candidate.workflowId)
            .where('digest', '=', digest)
            .execute();
        }
      }
      const next = await tx
        .selectFrom('workflow_steps')
        .select(['id', 'kind', 'completion_gate'])
        .where('workflow_id', '=', candidate.workflowId)
        .where('ordinal', '=', step.ordinal + 1)
        .executeTakeFirst();
      const nextVersion = workflow.version + 1;
      if (next === undefined) {
        await tx
          .updateTable('workflows')
          .set({ state: 'succeeded', version: nextVersion, updated_at: new Date().toISOString() })
          .where('id', '=', candidate.workflowId)
          .execute();
      } else {
        const providerOnly = !['source.change.v1', 'gitops.image-update.v1'].includes(next.kind);
        let nextEvidence = evidence;
        if (next.kind === 'argocd.reconcile.v1') {
          const registered = await tx
            .selectFrom('workflows as workflow')
            .innerJoin('workflow_services as service', 'service.id', 'workflow.service_id')
            .select(['workflow.environment as environment', 'service.deployments as deployments'])
            .where('workflow.id', '=', candidate.workflowId)
            .executeTakeFirstOrThrow();
          const deployment = (registered.deployments as Record<string, WorkflowServiceDeployment>)[
            registered.environment
          ];
          if (deployment === undefined)
            throw new WorkflowAuthorizationError('registered deployment no longer exists');
          const current = evidence as Record<string, unknown>;
          nextEvidence = {
            ...current,
            application: deployment.argoApplication,
            desiredRevision: current.mergeCommitSha,
          };
        }
        await tx
          .updateTable('workflow_steps')
          .set({
            state: providerOnly ? 'waiting_for_gate' : 'ready',
            next_reconcile_at: providerOnly ? new Date().toISOString() : null,
            expected_evidence: nextEvidence,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', next.id)
          .execute();
        const nextWorkflowState =
          next.completion_gate === 'user.decision' ? 'awaiting_decision' : 'running';
        await tx
          .updateTable('workflows')
          .set({
            state: nextWorkflowState,
            version: nextVersion,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', candidate.workflowId)
          .execute();
      }
      await this.appendEvent(
        tx,
        candidate.workflowId,
        'gate.satisfied',
        'provider',
        candidate.completionGate,
        'waiting_for_gate',
        'completed',
        { stepId: candidate.stepId, evidence },
        policyDecisionId,
      );
      return this.getWorkflowFrom(tx, candidate.workflowId);
    });
  }

  async deferGate(candidate: WorkflowGateCandidate, reason: string, retryAt: Date): Promise<void> {
    const evidence =
      typeof candidate.expectedEvidence === 'object' && candidate.expectedEvidence !== null
        ? (candidate.expectedEvidence as Record<string, unknown>)
        : {};
    await this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select('version')
        .where('id', '=', candidate.workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow?.version !== candidate.workflowVersion) return;
      await tx
        .updateTable('workflow_steps')
        .set({
          next_reconcile_at: retryAt.toISOString(),
          expected_evidence: { ...evidence, reconciliation: { status: 'pending', reason } },
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', candidate.stepId)
        .where('workflow_id', '=', candidate.workflowId)
        .where('state', '=', 'waiting_for_gate')
        .execute();
    });
  }

  async blockGate(candidate: WorkflowGateCandidate, reason: string): Promise<void> {
    const evidence =
      typeof candidate.expectedEvidence === 'object' && candidate.expectedEvidence !== null
        ? (candidate.expectedEvidence as Record<string, unknown>)
        : {};
    await this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['version', 'state'])
        .where('id', '=', candidate.workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow?.version !== candidate.workflowVersion || workflow.state !== 'running') return;
      const updated = await tx
        .updateTable('workflow_steps')
        .set({
          state: 'permanently_failed',
          next_reconcile_at: null,
          expected_evidence: { ...evidence, reconciliation: { status: 'blocked', reason } },
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', candidate.stepId)
        .where('workflow_id', '=', candidate.workflowId)
        .where('state', '=', 'waiting_for_gate')
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return;
      await tx
        .updateTable('workflows')
        .set({
          state: 'blocked',
          version: workflow.version + 1,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', candidate.workflowId)
        .execute();
      await this.appendEvent(
        tx,
        candidate.workflowId,
        'gate.blocked',
        'provider',
        candidate.completionGate,
        'waiting_for_gate',
        'permanently_failed',
        { stepId: candidate.stepId, reason },
      );
    });
  }

  async cancelWorkflow(workflowId: string, actorId: string): Promise<WorkflowView> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['state', 'version'])
        .where('id', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (workflow === undefined)
        throw new WorkflowNotFoundError(`workflow ${workflowId} not found`);
      if (['succeeded', 'failed', 'cancelled', 'rolled_back'].includes(workflow.state))
        return this.getWorkflowFrom(tx, workflowId);
      await tx
        .updateTable('workflows')
        .set({
          state: 'cancelled',
          version: workflow.version + 1,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', workflowId)
        .execute();
      await tx
        .updateTable('workflow_steps')
        .set({
          state: 'cancelled',
          lease_expires_at: null,
          next_reconcile_at: null,
          updated_at: new Date().toISOString(),
        })
        .where('workflow_id', '=', workflowId)
        .where('state', 'not in', ['completed', 'cancelled'])
        .execute();
      await tx
        .updateTable('workflow_dispatch_outbox')
        .set({ completed_at: new Date().toISOString(), claimed_until: null })
        .where('workflow_id', '=', workflowId)
        .where('completed_at', 'is', null)
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'workflow.cancelled',
        'user',
        actorId,
        workflow.state,
        'cancelled',
        {},
      );
      return this.getWorkflowFrom(tx, workflowId);
    });
  }

  async resumeBlockedWorkflow(
    workflowId: string,
    expectedVersion: number,
    actor: { id: string; authorizationHash: string },
  ): Promise<WorkflowView> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await tx
        .selectFrom('workflows')
        .select(['state', 'version'])
        .where('id', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (
        workflow === undefined ||
        workflow.state !== 'blocked' ||
        workflow.version !== expectedVersion
      )
        throw new WorkflowConflictError('workflow is not resumable');
      const decisionId = `pol_${randomUUID()}`;
      await tx
        .insertInto('workflow_policy_decisions')
        .values({
          id: decisionId,
          workflow_id: workflowId,
          transition: 'workflow:resume',
          actor_id: actor.id,
          authorization_hash: actor.authorizationHash,
          decision: 'allowed',
          reason: 'manual resume after structured blocker',
        })
        .execute();
      await tx
        .updateTable('workflows')
        .set({
          state: 'running',
          version: expectedVersion + 1,
          blocker: null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', workflowId)
        .execute();
      await tx
        .updateTable('workflow_steps')
        .set({
          state: 'waiting_for_gate',
          next_reconcile_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('workflow_id', '=', workflowId)
        .where('state', '=', 'permanently_failed')
        .execute();
      await this.appendEvent(
        tx,
        workflowId,
        'workflow.resumed',
        'user',
        actor.id,
        'blocked',
        'running',
        {},
        decisionId,
      );
      return this.getWorkflowFrom(tx, workflowId);
    });
  }

  async listActiveWorkflowSessionIds(workflowId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('workflow_handoffs as handoff')
      .innerJoin('workflow_steps as step', 'step.id', 'handoff.step_id')
      .select('handoff.session_id')
      .where('handoff.workflow_id', '=', workflowId)
      .where('handoff.session_id', 'is not', null)
      .where('step.state', 'in', ['dispatching', 'running'])
      .execute();
    return rows.flatMap(({ session_id: sessionId }) => (sessionId === null ? [] : [sessionId]));
  }

  async listActiveWorkflowSessionIdsForRenewal(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('workflow_handoffs as handoff')
      .innerJoin('workflow_steps as step', 'step.id', 'handoff.step_id')
      .innerJoin('workflows as workflow', 'workflow.id', 'handoff.workflow_id')
      .select('handoff.session_id')
      .where('workflow.state', '=', 'running')
      .where('handoff.session_id', 'is not', null)
      .where('step.state', '=', 'running')
      .execute();
    return rows.flatMap(({ session_id: sessionId }) => (sessionId === null ? [] : [sessionId]));
  }

  async reconcileSessionSteps(now = new Date()): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      const candidates = await tx
        .selectFrom('workflow_steps as step')
        .innerJoin('workflows as workflow', 'workflow.id', 'step.workflow_id')
        .select([
          'step.id',
          'step.workflow_id',
          'step.state',
          'step.attempt',
          'step.max_attempts',
          'workflow.version as workflow_version',
        ])
        .where('workflow.state', '=', 'running')
        .where((eb) =>
          eb.or([
            eb('step.state', '=', 'retryable_failed'),
            eb.and([eb('step.state', '=', 'running'), eb('step.lease_expires_at', '<=', now)]),
          ]),
        )
        .forUpdate('step')
        .execute();
      for (const step of candidates) {
        const recoverableHandoff =
          step.state === 'running'
            ? await tx
                .selectFrom('workflow_handoffs')
                .select('id')
                .where('step_id', '=', step.id)
                .where('attempt', '=', step.attempt)
                .where('session_id', 'is not', null)
                .executeTakeFirst()
            : undefined;
        const redispatchSameAttempt = recoverableHandoff !== undefined;
        const exhausted = !redispatchSameAttempt && step.attempt >= step.max_attempts;
        const nextState: WorkflowStepState = exhausted ? 'permanently_failed' : 'dispatching';
        const nextAttempt = exhausted || redispatchSameAttempt ? step.attempt : step.attempt + 1;
        await tx
          .updateTable('workflow_steps')
          .set({
            state: nextState,
            attempt: nextAttempt,
            lease_expires_at: null,
            updated_at: now.toISOString(),
          })
          .where('id', '=', step.id)
          .execute();
        await tx
          .updateTable('workflow_dispatch_outbox')
          .set({ completed_at: now.toISOString(), claimed_until: null })
          .where('step_id', '=', step.id)
          .where('completed_at', 'is', null)
          .execute();
        if (exhausted) {
          await tx
            .updateTable('workflows')
            .set({
              state: 'failed',
              version: step.workflow_version + 1,
              blocker: { summary: `step ${step.id} exhausted ${step.max_attempts} attempts` },
              updated_at: now.toISOString(),
            })
            .where('id', '=', step.workflow_id)
            .execute();
        } else {
          if (redispatchSameAttempt)
            await tx
              .updateTable('workflow_handoffs')
              .set({ dispatched_at: null, expires_at: now.toISOString() })
              .where('step_id', '=', step.id)
              .where('attempt', '=', step.attempt)
              .execute();
          const previous = await tx
            .selectFrom('workflow_dispatch_outbox')
            .select('payload')
            .where('step_id', '=', step.id)
            .orderBy('attempt', 'desc')
            .executeTakeFirst();
          const payload = previous?.payload as Record<string, unknown> | undefined;
          const actorId =
            typeof payload?.actorId === 'string' ? payload.actorId : 'workflow-service';
          await tx
            .insertInto('workflow_dispatch_outbox')
            .values({
              id: `out_${randomUUID()}`,
              workflow_id: step.workflow_id,
              step_id: step.id,
              attempt: nextAttempt,
              kind: 'session.dispatch',
              payload: {
                workflowId: step.workflow_id,
                stepId: step.id,
                attempt: nextAttempt,
                actorId,
              },
              available_at: now.toISOString(),
              claimed_until: null,
              completed_at: null,
              attempts: 0,
              last_error: null,
            })
            .execute();
          await tx
            .updateTable('workflows')
            .set({ version: step.workflow_version + 1, updated_at: now.toISOString() })
            .where('id', '=', step.workflow_id)
            .execute();
        }
        await this.appendEvent(
          tx,
          step.workflow_id,
          exhausted
            ? 'step.retry_exhausted'
            : redispatchSameAttempt
              ? 'step.dispatch_recovered'
              : 'step.retry_ready',
          'system',
          'workflow-reconciler',
          step.state,
          nextState,
          { stepId: step.id, attempt: step.attempt, maxAttempts: step.max_attempts },
        );
      }
      return candidates.length;
    });
  }

  async getWorkflow(id: string): Promise<WorkflowView> {
    return this.getWorkflowFrom(this.db, id);
  }

  async listWorkflows(limit = 50): Promise<WorkflowView[]> {
    const rows = await this.db
      .selectFrom('workflows')
      .select('id')
      .orderBy('created_at', 'desc')
      .limit(Math.min(100, Math.max(1, limit)))
      .execute();
    return Promise.all(rows.map((row) => this.getWorkflow(row.id)));
  }

  private async getWorkflowFrom(db: WorkflowDb, id: string): Promise<WorkflowView> {
    const workflow = await db
      .selectFrom('workflows')
      .select(['id', 'version', 'state', 'objective', 'environment', 'service_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (workflow === undefined) throw new WorkflowNotFoundError(`workflow ${id} not found`);
    const steps = await db
      .selectFrom('workflow_steps')
      .select([
        'id',
        'ordinal',
        'kind',
        'state',
        'attempt',
        'max_attempts',
        'target_project_id',
        'completion_gate',
      ])
      .where('workflow_id', '=', id)
      .orderBy('ordinal')
      .execute();
    return {
      id: workflow.id,
      version: workflow.version,
      state: workflow.state as WorkflowState,
      objective: workflow.objective,
      environment: workflow.environment,
      serviceId: workflow.service_id,
      steps: steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        kind: step.kind,
        state: step.state as WorkflowStepState,
        attempt: step.attempt,
        maxAttempts: step.max_attempts,
        targetProjectId: step.target_project_id,
        completionGate: step.completion_gate,
      })),
    };
  }

  private async appendEvent(
    db: WorkflowDb,
    workflowId: string,
    kind: string,
    actorType: string,
    actorId: string,
    previousState: string | null,
    newState: string | null,
    payload: unknown,
    policyDecisionId: string | null = null,
  ): Promise<void> {
    await db
      .insertInto('workflow_events')
      .values({
        workflow_id: workflowId,
        event_id: `wev_${randomUUID()}`,
        kind,
        actor_type: actorType,
        actor_id: actorId,
        previous_state: previousState,
        new_state: newState,
        policy_decision_id: policyDecisionId,
        payload,
      })
      .execute();
  }
}
