import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { WorkflowAuthorizationError, WorkflowConflictError, WorkflowStore } from './workflows.js';

describe('WorkflowStore', () => {
  let ctx: TestDb;
  let workflows: WorkflowStore;

  beforeEach(async () => {
    ctx = await createTestDb();
    workflows = new WorkflowStore(ctx.db);
    await ctx.store.upsertProject({
      id: 'control',
      owner: '__local__',
      repo: 'control',
      containerName: 'verity-control',
      kind: 'control_plane',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'source',
      owner: 'example',
      repo: 'app',
      containerName: 'verity-example--app',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'gitops',
      owner: 'example',
      repo: 'cluster',
      containerName: 'verity-example--cluster',
      state: 'active',
    });
    await workflows.registerService({
      id: 'api',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        staging: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api/staging',
          argoApplication: 'api-staging',
        },
      },
    });
  });

  afterEach(async () => ctx.close());

  it('allows exact first-use service replays but rejects relationship changes', async () => {
    const input = {
      id: 'website',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/website',
      deployments: {
        production: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/website',
          argoApplication: 'website',
        },
      },
    };
    await workflows.ensureService(input);
    await expect(workflows.ensureService(input)).resolves.toBeUndefined();
    await expect(
      workflows.ensureService({ ...input, imageRepository: 'ghcr.io/example/other' }),
    ).rejects.toBeInstanceOf(WorkflowConflictError);
  });

  it('adds a new environment without changing an existing service relationship', async () => {
    const production = {
      id: 'api',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        production: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api/production',
          argoApplication: 'api-production',
        },
      },
    };
    await workflows.ensureService(production);
    const stored = await ctx.db
      .selectFrom('workflow_services')
      .select('deployments')
      .where('id', '=', 'api')
      .executeTakeFirstOrThrow();
    expect(Object.keys(stored.deployments as object).sort()).toEqual(['production', 'staging']);
    await expect(
      workflows.createWorkflow({
        idempotencyKey: 'production-create',
        controlProjectId: 'control',
        actorId: 'device-1',
        objective: 'promote it',
        environment: 'production',
        serviceId: 'api',
      }),
    ).resolves.toMatchObject({ environment: 'production' });
  });

  it('rolls back first-use registration when workflow creation fails', async () => {
    const service = {
      id: 'atomic-service',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        staging: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api',
          argoApplication: 'api',
        },
      },
    };
    await expect(
      workflows.createAuthorizedWorkflowWithService(
        service,
        {
          idempotencyKey: 'atomic-failure',
          controlProjectId: 'missing-control',
          actorId: 'device-1',
          objective: 'ship it',
          environment: 'staging',
          serviceId: service.id,
        },
        { id: 'device-1', authorizationHash: 'approved' },
      ),
    ).rejects.toThrow();
    expect(
      await ctx.db
        .selectFrom('workflow_services')
        .select('id')
        .where('id', '=', service.id)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('replays an already authorized atomic first-use delivery', async () => {
    const service = {
      id: 'replay-service',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        staging: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api',
          argoApplication: 'api',
        },
      },
    };
    const input = {
      idempotencyKey: 'atomic-replay',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: service.id,
    };
    const actor = { id: 'device-1', authorizationHash: 'approved' };
    const first = await workflows.createAuthorizedWorkflowWithService(service, input, actor);
    const replay = await workflows.createAuthorizedWorkflowWithService(service, input, actor);
    expect(first.state).toBe('running');
    expect(replay).toEqual(first);
  });

  it('replays a first-use command after a later registry update', async () => {
    const service = {
      id: 'updated-replay-service',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        staging: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api',
          argoApplication: 'api',
        },
      },
    };
    const input = {
      idempotencyKey: 'updated-atomic-replay',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: service.id,
    };
    const first = await workflows.createAuthorizedWorkflowWithService(service, input, {
      id: 'device-1',
      authorizationHash: 'approved',
    });
    await ctx.db
      .updateTable('workflows')
      .set({ state: 'succeeded' })
      .where('id', '=', first.id)
      .execute();
    await workflows.registerService({ ...service, imageRepository: 'ghcr.io/example/app-v2' });
    const replay = await workflows.createAuthorizedWorkflowWithService(service, input, {
      id: 'device-1',
      authorizationHash: 'approved',
    });
    expect(replay).toMatchObject({ id: first.id, state: 'succeeded' });
  });

  it('rejects a first-use replay with altered service coordinates', async () => {
    const service = {
      id: 'bound-replay-service',
      sourceProjectId: 'source',
      sourceRepository: 'example/app',
      imageRepository: 'ghcr.io/example/app',
      deployments: {
        staging: {
          projectId: 'gitops',
          repository: 'example/cluster',
          manifestPath: 'apps/api',
          argoApplication: 'api',
        },
      },
    };
    const input = {
      idempotencyKey: 'bound-atomic-replay',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: service.id,
    };
    const actor = { id: 'device-1', authorizationHash: 'approved' };
    await workflows.createAuthorizedWorkflowWithService(service, input, actor);
    await expect(
      workflows.createAuthorizedWorkflowWithService(
        {
          ...service,
          imageRepository: 'ghcr.io/example/other',
        },
        input,
        actor,
      ),
    ).rejects.toBeInstanceOf(WorkflowConflictError);
  });

  it('creates the fixed serial template idempotently', async () => {
    const request = {
      idempotencyKey: 'create-1',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    };
    const first = await workflows.createWorkflow(request);
    const replay = await workflows.createWorkflow(request);
    expect(replay).toEqual(first);
    expect(first.state).toBe('awaiting_authorization');
    expect(first.steps).toHaveLength(8);
    expect(first.steps[0]).toMatchObject({ kind: 'source.change.v1', targetProjectId: 'source' });
    expect(first.steps[3]).toMatchObject({
      kind: 'gitops.image-update.v1',
      targetProjectId: 'gitops',
    });
  });

  it('rejects an idempotency key reused for another request', async () => {
    const request = {
      idempotencyKey: 'create-1',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    };
    await workflows.createWorkflow(request);
    await expect(
      workflows.createWorkflow({ ...request, objective: 'different' }),
    ).rejects.toBeInstanceOf(WorkflowConflictError);
  });

  it('scopes workflow creation idempotency to the requesting actor', async () => {
    const request = {
      idempotencyKey: 'shared-client-key',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    };
    const first = await workflows.createWorkflow(request);
    const second = await workflows.createWorkflow({ ...request, actorId: 'device-2' });

    expect(second.id).not.toBe(first.id);
  });

  it('fails closed for an unregistered environment', async () => {
    await expect(
      workflows.createWorkflow({
        idempotencyKey: 'create-prod',
        controlProjectId: 'control',
        actorId: 'device-1',
        objective: 'ship it',
        environment: 'production',
        serviceId: 'api',
      }),
    ).rejects.toBeInstanceOf(WorkflowAuthorizationError);
  });

  it('co-commits authorization, first-step readiness, and dispatch outbox', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-2',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    expect(authorized.state).toBe('running');
    expect(authorized.steps[0]?.state).toBe('dispatching');
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const outbox = await ctx.db
      .selectFrom('workflow_dispatch_outbox')
      .selectAll()
      .where('workflow_id', '=', authorized.id)
      .executeTakeFirstOrThrow();
    expect(outbox.attempt).toBe(1);
    expect((await workflows.getWorkflow(authorized.id)).steps[0]?.state).toBe('dispatching');
  });

  it('deduplicates provider deliveries and cancellation is idempotent', async () => {
    expect(await workflows.ingestProviderEvent('github', 'delivery-1', 'pull_request', {})).toBe(
      true,
    );
    expect(await workflows.ingestProviderEvent('github', 'delivery-1', 'pull_request', {})).toBe(
      false,
    );
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-3',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const cancelled = await workflows.cancelWorkflow(created.id, 'device-1');
    expect(cancelled.state).toBe('cancelled');
    expect((await workflows.cancelWorkflow(created.id, 'device-1')).state).toBe('cancelled');
  });

  it('prevents a cancelled workflow from claiming queued dispatch work', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-cancel-outbox',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    await workflows.cancelWorkflow(authorized.id, 'device-1');
    await expect(workflows.claimDueOutbox()).resolves.toBeUndefined();
  });

  it('retries failed or expired session steps once and then fails closed', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-bounded-retry',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    const step = authorized.steps[0]!;
    await workflows.queueDispatch(authorized.id, step.id, authorized.version);
    await ctx.db
      .updateTable('workflow_steps')
      .set({ state: 'retryable_failed' })
      .where('id', '=', step.id)
      .execute();
    expect(await workflows.reconcileSessionSteps()).toBe(1);
    const retryReady = await workflows.getWorkflow(authorized.id);
    expect(retryReady.steps[0]?.state).toBe('dispatching');

    await workflows.queueDispatch(retryReady.id, step.id, retryReady.version);
    await ctx.db
      .updateTable('workflow_steps')
      .set({ state: 'running', lease_expires_at: new Date(Date.now() - 1).toISOString() })
      .where('id', '=', step.id)
      .execute();
    expect(await workflows.reconcileSessionSteps()).toBe(1);
    const exhausted = await workflows.getWorkflow(authorized.id);
    expect(exhausted.state).toBe('failed');
    expect(exhausted.steps[0]?.state).toBe('permanently_failed');
  });

  it('recovers an unbound handoff by rotating its capability without duplicating it', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-recovery',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const outbox = await workflows.claimDueOutbox();
    expect(outbox).toBeDefined();
    const first = await workflows.issueHandoff(outbox!.id);
    const recovered = await workflows.issueHandoff(outbox!.id);
    expect(recovered.handoffId).toBe(first.handoffId);
    expect(recovered.capability).not.toBe(first.capability);
    const count = await ctx.db
      .selectFrom('workflow_handoffs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1);
  });

  it('rejects results after the workflow was cancelled', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-stale-result',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const outbox = (await workflows.claimDueOutbox())!;
    const issued = await workflows.issueHandoff(outbox.id);
    await ctx.store.createSession({
      sessionId: 'cancelled-session',
      worktree: '/work/cancelled-session',
      model: 'claude-sonnet',
      projectId: 'source',
    });
    await workflows.recordHandoffSession(issued.handoffId, 'cancelled-session');
    await workflows.bindHandoffSession(issued.handoffId, 'cancelled-session');
    await workflows.cancelWorkflow(authorized.id, 'device-1');
    await expect(
      workflows.submitResult(
        {
          capability: issued.capability,
          handoffId: issued.handoffId,
          projectId: 'source',
          sessionId: 'cancelled-session',
          pullRequest: 0,
          commit: '',
        },
        {
          status: 'completed',
          summary: 'too late',
          outputs: { repository: 'example/app', commit: 'a'.repeat(40) },
          evidence: [],
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowAuthorizationError);
  });

  it('makes a cancelled handoff terminal for the workflow', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-session-cancel',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const issued = await workflows.issueHandoff((await workflows.claimDueOutbox())!.id);
    await ctx.store.createSession({
      sessionId: 'self-cancelled-session',
      worktree: '/work/self-cancelled-session',
      model: 'claude-sonnet',
      projectId: 'source',
    });
    await workflows.recordHandoffSession(issued.handoffId, 'self-cancelled-session');
    await workflows.bindHandoffSession(issued.handoffId, 'self-cancelled-session');
    const result = await workflows.submitResult(
      {
        capability: issued.capability,
        handoffId: issued.handoffId,
        projectId: 'source',
        sessionId: 'self-cancelled-session',
        pullRequest: 0,
        commit: '',
      },
      {
        status: 'cancelled',
        summary: 'session cancelled',
        outputs: {},
        evidence: [],
      },
    );
    expect(result.state).toBe('cancelled');
    expect(
      result.steps
        .filter(({ state }) => state !== 'completed')
        .every(({ state }) => state === 'cancelled'),
    ).toBe(true);
  });

  it('advances only after a structured result and its separate gate', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-result',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const outbox = await workflows.claimDueOutbox();
    const issued = await workflows.issueHandoff(outbox!.id);
    await ctx.store.createSession({
      sessionId: 'source-session',
      worktree: '/work/source-session',
      model: 'claude-sonnet',
      projectId: 'source',
    });
    await workflows.recordHandoffSession(issued.handoffId, 'source-session');
    await workflows.bindHandoffSession(issued.handoffId, 'source-session');
    await expect(
      workflows.submitResult(
        {
          capability: issued.capability,
          handoffId: issued.handoffId,
          projectId: 'gitops',
          sessionId: 'source-session',
          pullRequest: 12,
          commit: 'a'.repeat(40),
        },
        {
          status: 'completed',
          summary: 'cross-project forgery',
          outputs: {
            repository: 'example/app',
            pullRequest: 12,
            commit: 'a'.repeat(40),
          },
          evidence: [],
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowAuthorizationError);
    await expect(
      workflows.submitResult(
        {
          capability: issued.capability,
          handoffId: issued.handoffId,
          projectId: 'source',
          sessionId: 'different-source-session',
          pullRequest: 12,
          commit: 'a'.repeat(40),
        },
        {
          status: 'completed',
          summary: 'same-project session forgery',
          outputs: {
            repository: 'example/app',
            pullRequest: 12,
            commit: 'a'.repeat(40),
          },
          evidence: [],
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowAuthorizationError);
    const productionAuthentication = {
      capability: issued.capability,
      handoffId: issued.handoffId,
      projectId: 'source',
      sessionId: 'source-session',
      pullRequest: 12,
      commit: 'a'.repeat(40),
    };
    const submitted = await workflows.submitResult(productionAuthentication, {
      status: 'completed',
      summary: 'opened the source PR',
      outputs: {
        repository: 'example/app',
        pullRequest: 12,
        commit: 'a'.repeat(40),
      },
      evidence: [],
    });
    expect(submitted.steps[0]?.state).toBe('waiting_for_gate');
    await expect(
      workflows.submitResult(productionAuthentication, {
        status: 'completed',
        summary: 'replayed after a lost response',
        outputs: {
          repository: 'example/app',
          pullRequest: 12,
          commit: 'a'.repeat(40),
        },
        evidence: [],
      }),
    ).resolves.toMatchObject({ id: submitted.id, version: submitted.version });
    const gate = (await workflows.listDueGates())[0]!;
    const advanced = await workflows.completeGate(gate, {
      owner: 'example',
      repo: 'app',
      pullRequest: 12,
      headSha: 'a'.repeat(40),
    });
    expect(advanced.steps[0]?.state).toBe('completed');
    expect(advanced.steps[1]?.state).toBe('waiting_for_gate');

    const initialCiGate = (await workflows.listDueGates())[0]!;
    await workflows.blockGate(initialCiGate, 'pull request head changed');
    const blocked = await workflows.getWorkflow(initialCiGate.workflowId);
    expect(blocked).toMatchObject({
      state: 'blocked',
      steps: expect.arrayContaining([
        expect.objectContaining({ id: initialCiGate.stepId, state: 'permanently_failed' }),
      ]),
    });
    const resumed = await workflows.resumeBlockedWorkflow(blocked.id, blocked.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    expect(resumed).toMatchObject({
      state: 'running',
      steps: expect.arrayContaining([
        expect.objectContaining({ id: initialCiGate.stepId, state: 'waiting_for_gate' }),
      ]),
    });

    const ciGate = (await workflows.listDueGates())[0]!;
    await workflows.deferGate(ciGate, 'first attempt', new Date(Date.now() - 1));
    const retried = (await workflows.listDueGates())[0]!;
    expect(retried.expectedEvidence).toMatchObject({
      owner: 'example',
      repo: 'app',
      pullRequest: 12,
      headSha: 'a'.repeat(40),
      reconciliation: { status: 'pending', reason: 'first attempt' },
    });
    await workflows.deferGate(retried, 'second attempt', new Date(Date.now() + 60_000));
    const persisted = await ctx.db
      .selectFrom('workflow_steps')
      .select('expected_evidence')
      .where('id', '=', ciGate.stepId)
      .executeTakeFirstOrThrow();
    expect(persisted.expected_evidence).toMatchObject({
      owner: 'example',
      repo: 'app',
      pullRequest: 12,
      headSha: 'a'.repeat(40),
      reconciliation: { status: 'pending', reason: 'second attempt' },
    });
    await ctx.db
      .updateTable('workflows')
      .set({ version: retried.workflowVersion + 1 })
      .where('id', '=', retried.workflowId)
      .execute();
    await workflows.deferGate(retried, 'stale overwrite', new Date(Date.now() + 120_000));
    const afterStale = await ctx.db
      .selectFrom('workflow_steps')
      .select('expected_evidence')
      .where('id', '=', ciGate.stepId)
      .executeTakeFirstOrThrow();
    expect(afterStale.expected_evidence).toMatchObject({
      reconciliation: { status: 'pending', reason: 'second attempt' },
    });
  });

  it('reuses a recorded session when dispatch acceptance is retried', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-dispatch-retry',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const outbox = (await workflows.claimDueOutbox())!;
    const issued = await workflows.issueHandoff(outbox.id);
    await ctx.store.createSession({
      sessionId: 'session-created-before-turn',
      worktree: '/work/session-created-before-turn',
      model: 'claude-sonnet',
      projectId: 'source',
    });
    await workflows.recordHandoffSession(issued.handoffId, 'session-created-before-turn');
    await workflows.releaseOutbox(outbox.id, 'turn rejected', new Date(Date.now() - 1));

    const retriedOutbox = (await workflows.claimDueOutbox())!;
    const retried = await workflows.issueHandoff(retriedOutbox.id);
    expect(retried.handoffId).toBe(issued.handoffId);
    expect(retried.sessionId).toBe('session-created-before-turn');
    await workflows.releaseOutbox(retriedOutbox.id, 'turn rejected again', new Date());
    const exhausted = await workflows.getWorkflow(created.id);
    expect(exhausted.state).toBe('failed');
    expect(exhausted.steps[0]?.state).toBe('permanently_failed');
  });

  it('renews the lease only for the bound running handoff session', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-lease-renewal',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    const authorized = await workflows.authorizeWorkflow(created.id, created.version, {
      id: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await workflows.queueDispatch(authorized.id, authorized.steps[0]!.id, authorized.version);
    const issued = await workflows.issueHandoff((await workflows.claimDueOutbox())!.id);
    await ctx.store.createSession({
      sessionId: 'long-running-session',
      worktree: '/work/long-running-session',
      model: 'claude-sonnet',
      projectId: 'source',
    });
    await workflows.recordHandoffSession(issued.handoffId, 'long-running-session');
    await workflows.bindHandoffSession(issued.handoffId, 'long-running-session');
    const now = new Date('2030-01-01T00:00:00.000Z');
    await expect(workflows.renewHandoffSessionLease('long-running-session', now)).resolves.toBe(
      true,
    );
    await expect(workflows.renewHandoffSessionLease('other-session', now)).resolves.toBe(false);
    const step = await ctx.db
      .selectFrom('workflow_steps')
      .select('lease_expires_at')
      .where('id', '=', authorized.steps[0]!.id)
      .executeTakeFirstOrThrow();
    expect(step.lease_expires_at?.toISOString()).toBe('2030-01-01T00:05:00.000Z');
  });

  it('records merge approval durably before the merge worker acts', async () => {
    const created = await workflows.createWorkflow({
      idempotencyKey: 'create-merge-outbox',
      controlProjectId: 'control',
      actorId: 'device-1',
      objective: 'ship it',
      environment: 'staging',
      serviceId: 'api',
    });
    await ctx.store.createSession({
      sessionId: 'gitops-merge-session',
      worktree: '/work/gitops-merge-session',
      model: 'claude-sonnet',
      projectId: 'gitops',
    });
    const gitopsStep = created.steps[3]!;
    const mergeStep = created.steps[5]!;
    await ctx.db
      .insertInto('workflow_handoffs')
      .values({
        id: 'hof_merge_test',
        workflow_id: created.id,
        step_id: gitopsStep.id,
        attempt: 1,
        target_project_id: 'gitops',
        kind: 'gitops.image-update.v1',
        payload: {},
        capability_hash: 'unused',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        session_id: 'gitops-merge-session',
        previous_handoff_id: null,
        dispatched_at: new Date().toISOString(),
      })
      .execute();
    await ctx.db
      .updateTable('workflow_steps')
      .set({ state: 'completed', updated_at: new Date().toISOString() })
      .where('workflow_id', '=', created.id)
      .where('ordinal', '<', 5)
      .execute();
    await ctx.db
      .updateTable('workflow_steps')
      .set({
        state: 'waiting_for_gate',
        expected_evidence: {
          owner: 'example',
          repo: 'ops',
          pullRequest: 42,
          headSha: 'a'.repeat(40),
        },
        next_reconcile_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', mergeStep.id)
      .execute();
    await ctx.db
      .updateTable('workflows')
      .set({ state: 'awaiting_decision', updated_at: new Date().toISOString() })
      .where('id', '=', created.id)
      .execute();
    const gate = (await workflows.listDueGates()).find(({ stepId }) => stepId === mergeStep.id)!;
    const approved = await workflows.completeGate(
      gate,
      { ...(gate.expectedEvidence as object), approved: true },
      { id: 'device-1', authorizationHash: 'a'.repeat(64) },
    );
    expect(approved.steps[5]).toMatchObject({
      state: 'waiting_for_gate',
      completionGate: 'pull_request.merged',
    });
    await expect(workflows.claimDueMergeOutbox()).resolves.toMatchObject({
      workflowId: created.id,
      stepId: mergeStep.id,
      pullRequest: 42,
      sessionId: 'gitops-merge-session',
    });
  });
});
