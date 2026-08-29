import { describe, expect, it, vi } from 'vitest';
import { WorkflowConflictError, type CreateWorkflowInput, type WorkflowView } from '@verity/store';

import { createControlPlaneDeliveryTool } from './workflow-control-tool.js';

const view = (state: WorkflowView['state'], version: number): WorkflowView => ({
  id: 'wf_1',
  version,
  state,
  objective: 'Ship OCR update',
  environment: 'staging',
  serviceId: 'deep-ocr-api',
  steps: [],
});

describe('control-plane delivery tool', () => {
  it('registers a first-use relationship from exact existing projects before starting', async () => {
    const createWorkflow = vi.fn(async () => view('running', 2));
    const createAuthorizedWorkflowWithService = vi.fn(async () => view('running', 2));
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: {
        createAuthorizedWorkflowWithService,
        createWorkflow,
        authorizeWorkflow: vi.fn(),
        getWorkflow: vi.fn(),
      },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
      listProjects: vi.fn(
        async () =>
          [
            {
              id: 'source-id',
              owner: 'Heey-Global',
              repo: 'Verity',
              state: 'active',
              hiddenAt: null,
            },
            { id: 'gitops-id', owner: 'Heey-Global', repo: 'k8s', state: 'active', hiddenAt: null },
          ] as never,
      ),
    });

    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: {
          environment: 'production',
          objective: 'Ship the website',
          service: {
            name: 'verity-website',
            sourceProject: 'verity',
            deploymentProject: 'k8s',
            imageRepository: 'ghcr.io/heey-global/verity',
            manifestPath: 'apps/verity',
            argoApplication: 'verity',
          },
        },
      }),
    ).resolves.toMatchObject({ state: 'running' });
    expect(createAuthorizedWorkflowWithService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'verity-website',
        sourceProjectId: 'source-id',
        sourceRepository: 'Heey-Global/Verity',
        deployments: { production: expect.objectContaining({ projectId: 'gitops-id' }) },
      }),
      expect.objectContaining({
        serviceId: 'verity-website',
        environment: 'production',
      }),
      expect.objectContaining({ id: 'control-plane-session:session-1' }),
    );
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it('rejects first-use relationships containing an inactive project', async () => {
    const createAuthorizedWorkflowWithService = vi.fn();
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: {
        createAuthorizedWorkflowWithService,
        createWorkflow: vi.fn(),
        authorizeWorkflow: vi.fn(),
        getWorkflow: vi.fn(),
      },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
      listProjects: vi.fn(
        async () =>
          [
            { id: 'source', owner: 'example', repo: 'app', state: 'failed', hiddenAt: null },
            { id: 'gitops', owner: 'example', repo: 'cluster', state: 'active', hiddenAt: null },
          ] as never,
      ),
    });

    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: {
          environment: 'production',
          objective: 'Ship it',
          service: {
            name: 'website',
            sourceProject: 'app',
            deploymentProject: 'cluster',
            imageRepository: 'ghcr.io/example/app',
            manifestPath: 'apps/web',
            argoApplication: 'web',
          },
        },
      }),
    ).rejects.toThrow('project app is not active and ready for delivery');
    expect(createAuthorizedWorkflowWithService).not.toHaveBeenCalled();
  });

  it('rejects an active local project', async () => {
    const createAuthorizedWorkflowWithService = vi.fn();
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: {
        createAuthorizedWorkflowWithService,
        createWorkflow: vi.fn(),
        authorizeWorkflow: vi.fn(),
        getWorkflow: vi.fn(),
      },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
      listProjects: vi.fn(
        async () =>
          [
            {
              id: 'source',
              owner: '__local__',
              repo: 'scratch',
              kind: 'local',
              state: 'active',
              hiddenAt: null,
            },
            {
              id: 'gitops',
              owner: 'example',
              repo: 'cluster',
              kind: 'github',
              state: 'active',
              hiddenAt: null,
            },
          ] as never,
      ),
    });
    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: {
          environment: 'production',
          objective: 'Ship it',
          service: {
            name: 'website',
            sourceProject: 'scratch',
            deploymentProject: 'cluster',
            imageRepository: 'ghcr.io/example/app',
            manifestPath: 'apps/web',
            argoApplication: 'web',
          },
        },
      }),
    ).rejects.toThrow('project scratch is not active and ready for delivery');
    expect(createAuthorizedWorkflowWithService).not.toHaveBeenCalled();
  });

  it('creates and authorizes a delivery bound to its originating Control session', async () => {
    const createWorkflow = vi.fn(async (_input: CreateWorkflowInput) => {
      void _input;
      return view('awaiting_authorization', 1);
    });
    const authorizeWorkflow = vi.fn(async () => view('running', 2));
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: { createWorkflow, authorizeWorkflow, getWorkflow: vi.fn() },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
    });

    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: {
          serviceId: 'deep-ocr-api',
          environment: 'staging',
          objective: 'Ship OCR update',
        },
      }),
    ).resolves.toEqual({
      workflowId: 'wf_1',
      state: 'running',
      serviceId: 'deep-ocr-api',
      environment: 'staging',
    });
    expect(createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        controlProjectId: 'verity-control',
        rootSessionId: 'session-1',
        actorId: 'control-plane-session:session-1',
      }),
    );
    expect(authorizeWorkflow).toHaveBeenCalledWith(
      'wf_1',
      1,
      expect.objectContaining({ id: 'control-plane-session:session-1' }),
    );
  });

  it('is idempotent for a retried invocation but allows a later identical delivery', async () => {
    const createWorkflow = vi.fn(async (_input: CreateWorkflowInput) => {
      void _input;
      return view('running', 2);
    });
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: { createWorkflow, authorizeWorkflow: vi.fn(), getWorkflow: vi.fn() },
      getSession: vi.fn(async () => ({ projectId: null })),
    });
    const request = {
      serviceId: 'deep-ocr-api',
      environment: 'staging',
      objective: 'Ship OCR update',
    };

    await tool({
      projectId: 'verity-control',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      request,
    });
    await tool({
      projectId: 'verity-control',
      sessionId: 'session-1',
      turnId: 'turn-2',
      callId: 'call-2',
      request,
    });
    await tool({
      projectId: 'verity-control',
      sessionId: 'session-1',
      turnId: 'turn-2',
      callId: 'call-2',
      request,
    });

    const first = createWorkflow.mock.calls[0]?.[0].idempotencyKey;
    const second = createWorkflow.mock.calls[1]?.[0].idempotencyKey;
    const retry = createWorkflow.mock.calls[2]?.[0].idempotencyKey;
    expect(first).not.toBe(second);
    expect(second).toBe(retry);
  });

  it('accepts a concurrent authorization replay once the delivery is running', async () => {
    const createWorkflow = vi.fn(async () => view('awaiting_authorization', 1));
    const authorizeWorkflow = vi.fn(async () => {
      throw new WorkflowConflictError('workflow version or state changed');
    });
    const getWorkflow = vi.fn(async () => view('running', 2));
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: { createWorkflow, authorizeWorkflow, getWorkflow },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
    });

    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: { serviceId: 'api', environment: 'staging', objective: 'Ship it' },
      }),
    ).resolves.toMatchObject({ workflowId: 'wf_1', state: 'running' });
    expect(getWorkflow).toHaveBeenCalledWith('wf_1');
  });

  it('returns an idempotent replay after the delivery has progressed', async () => {
    const createWorkflow = vi.fn(async () => view('awaiting_authorization', 1));
    const authorizeWorkflow = vi.fn(async () => {
      throw new WorkflowConflictError('workflow version or state changed');
    });
    const getWorkflow = vi.fn(async () => view('succeeded', 8));
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: { createWorkflow, authorizeWorkflow, getWorkflow },
      getSession: vi.fn(async () => ({ projectId: 'verity-control' })),
    });

    await expect(
      tool({
        projectId: 'verity-control',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: { serviceId: 'api', environment: 'staging', objective: 'Ship it' },
      }),
    ).resolves.toMatchObject({ workflowId: 'wf_1', state: 'succeeded' });
  });

  it('rejects calls attributed to a project session', async () => {
    const createWorkflow = vi.fn();
    const tool = createControlPlaneDeliveryTool({
      controlProjectId: 'verity-control',
      workflowStore: {
        createWorkflow,
        authorizeWorkflow: vi.fn(),
        getWorkflow: vi.fn(),
      },
      getSession: vi.fn(async () => ({ projectId: 'source-project' })),
    });

    await expect(
      tool({
        projectId: 'source-project',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        request: { serviceId: 'api', environment: 'staging', objective: 'Ship it' },
      }),
    ).rejects.toThrow('restricted to Verity Control sessions');
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});
