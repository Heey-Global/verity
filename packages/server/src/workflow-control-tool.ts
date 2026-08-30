import { createHash } from 'node:crypto';

import { createDeliveryRequestSchema } from '@verity/events';
import {
  WorkflowConflictError,
  type ProjectRecord,
  type WorkflowServiceInput,
  type WorkflowStore,
  type WorkflowView,
} from '@verity/store';

import { resolveProjectReference } from './project-reference.js';

interface DeliveryWorkflowStore {
  createAuthorizedWorkflowWithService?(
    service: WorkflowServiceInput,
    input: Parameters<WorkflowStore['createWorkflow']>[0],
    actor: { id: string; authorizationHash: string },
  ): Promise<WorkflowView>;
  createWorkflow(input: Parameters<WorkflowStore['createWorkflow']>[0]): Promise<WorkflowView>;
  authorizeWorkflow(
    workflowId: string,
    expectedVersion: number,
    actor: { id: string; authorizationHash: string },
  ): Promise<WorkflowView>;
  getWorkflow(workflowId: string): Promise<WorkflowView>;
}

export interface ControlPlaneDeliveryCall {
  projectId: string;
  sessionId: string;
  turnId: string;
  /** Stable gateway invocation identity (request id + tool + authenticated request MAC). */
  invocationId: string;
  request: unknown;
}

export function createControlPlaneDeliveryTool(options: {
  controlProjectId: string;
  workflowStore: DeliveryWorkflowStore;
  getSession: (sessionId: string) => Promise<{ projectId: string | null } | undefined>;
  listProjects?: () => Promise<ProjectRecord[]>;
}): (input: ControlPlaneDeliveryCall) => Promise<Record<string, unknown>> {
  return async (input) => {
    if (input.projectId !== options.controlProjectId) {
      throw new Error('delivery creation is restricted to Verity Control sessions');
    }
    const session = await options.getSession(input.sessionId);
    if (session === undefined)
      throw new Error('originating Verity Control session no longer exists');
    if (session.projectId !== null && session.projectId !== options.controlProjectId) {
      throw new Error('originating session is not a Verity Control session');
    }
    const request = createDeliveryRequestSchema.parse(input.request);
    let serviceId: string;
    let proposedService: WorkflowServiceInput | undefined;
    if ('serviceId' in request) {
      serviceId = request.serviceId;
    } else {
      if (
        options.listProjects === undefined ||
        options.workflowStore.createAuthorizedWorkflowWithService === undefined
      )
        throw new Error('first-use service registration is unavailable');
      const projects = await options.listProjects();
      const resolveProject = (reference: string): ProjectRecord => {
        const project = resolveProjectReference(
          projects,
          reference,
          (message) => new Error(message),
        );
        if (
          project.state !== 'active' ||
          (project.kind !== undefined && project.kind !== 'github') ||
          project.hiddenAt !== null ||
          project.archived === true ||
          project.overviewVisible === false
        )
          throw new Error(`project ${reference} is not active and ready for delivery`);
        return project;
      };
      const source = resolveProject(request.service.sourceProject);
      const deployment = resolveProject(request.service.deploymentProject);
      if (source.id === deployment.id)
        throw new Error('source and deployment projects must be different');
      serviceId = request.service.name;
      proposedService = {
        id: serviceId,
        sourceProjectId: source.id,
        sourceRepository: `${source.owner}/${source.repo}`,
        imageRepository: request.service.imageRepository,
        deployments: {
          [request.environment]: {
            projectId: deployment.id,
            repository: `${deployment.owner}/${deployment.repo}`,
            manifestPath: request.service.manifestPath,
            argoApplication: request.service.argoApplication,
          },
        },
      };
    }
    const actorId = `control-plane-session:${input.sessionId}`;
    const invocationHash = createHash('sha256')
      .update(input.sessionId)
      .update('\0')
      .update(input.turnId)
      .update('\0')
      .update(input.invocationId)
      .digest('hex');
    const workflowInput = {
      idempotencyKey: `control-plane:${invocationHash}`,
      controlProjectId: options.controlProjectId,
      rootSessionId: input.sessionId,
      actorId,
      objective: request.objective,
      environment: request.environment,
      serviceId,
    };
    const created =
      proposedService === undefined
        ? await options.workflowStore.createWorkflow(workflowInput)
        : await options.workflowStore.createAuthorizedWorkflowWithService!(
            proposedService,
            workflowInput,
            { id: actorId, authorizationHash: invocationHash },
          );
    let workflow = created;
    if (created.state === 'awaiting_authorization') {
      try {
        workflow = await options.workflowStore.authorizeWorkflow(created.id, created.version, {
          id: actorId,
          authorizationHash: invocationHash,
        });
      } catch (error) {
        if (!(error instanceof WorkflowConflictError)) throw error;
        workflow = await options.workflowStore.getWorkflow(created.id);
        if (workflow.state === 'awaiting_authorization') throw error;
      }
    }
    return {
      workflowId: workflow.id,
      state: workflow.state,
      serviceId: workflow.serviceId,
      environment: workflow.environment,
    };
  };
}
