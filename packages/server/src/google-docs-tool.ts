import { assertWorkspaceWriteAccess } from './google-workspace-tool-types.js';
import type {
  GoogleWorkspaceToolStore,
  SessionWorkspaceFile,
  WorkspaceInvocationInput,
} from './google-workspace-tool-types.js';
import { getDocsDocument, getDocsDocumentMetadata, updateDocsDocument } from './google-docs.js';

const MAX_REQUESTS = 100;
const MAX_REQUEST_BYTES = 1_000_000;
type DocsRequest =
  | { action: 'inspect_document' }
  | { action: 'read_document' }
  | { action: 'edit'; requests?: Record<string, unknown>[]; revisionId?: string };

export interface GoogleDocsToolDeps {
  eventStore: GoogleWorkspaceToolStore;
  googleAccessToken: () => Promise<string | undefined>;
  docs?: {
    inspect(token: string, fileId: string): Promise<{ revisionId: string }>;
    read(token: string, fileId: string): Promise<{ revisionId: string }>;
    update(
      token: string,
      fileId: string,
      requests: readonly Record<string, unknown>[],
      requiredRevisionId: string,
    ): Promise<{ revisionId: string; result: unknown }>;
  };
}

function parseRequest(value: unknown): DocsRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { action?: unknown }).action !== 'string'
  ) {
    throw new Error('Google Docs request requires an action');
  }
  return value as DocsRequest;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateEdit(requests: unknown): asserts requests is Record<string, unknown>[] {
  if (!Array.isArray(requests) || requests.length === 0) throw new Error('edit requires requests');
  if (requests.length > MAX_REQUESTS) throw new Error('edit exceeds 100 requests');
  if (Buffer.byteLength(JSON.stringify(requests)) > MAX_REQUEST_BYTES) {
    throw new Error('edit payload exceeds 1 MB');
  }
  const candidates: unknown[] = requests;
  const validated: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (!isUnknownRecord(candidate) || Object.keys(candidate).length !== 1) {
      throw new Error('edit requires one Google request operation per entry');
    }
    const operation = candidate[Object.keys(candidate)[0]!];
    if (!isUnknownRecord(operation)) {
      throw new Error('edit requires Google request operation objects');
    }
    validated.push(candidate);
  }
}

export function createGoogleDocsTool(deps: GoogleDocsToolDeps): {
  invoke(input: WorkspaceInvocationInput): Promise<unknown>;
} {
  const docs = deps.docs ?? {
    inspect: getDocsDocumentMetadata,
    read: getDocsDocument,
    update: async (
      token: string,
      fileId: string,
      requests: readonly Record<string, unknown>[],
      revisionId: string,
    ) => {
      const result = await updateDocsDocument(token, fileId, requests, revisionId);
      return { revisionId: result.writeControl.requiredRevisionId, result };
    },
  };
  const assigned = async (
    sessionId: string,
    assignmentId?: string,
  ): Promise<SessionWorkspaceFile> => {
    const file = await deps.eventStore.getSessionWorkspaceFile(sessionId);
    if (
      file === undefined ||
      file.kind !== 'docs' ||
      (assignmentId !== undefined && file.assignmentId !== assignmentId)
    ) {
      throw new Error(
        assignmentId === undefined
          ? 'No Google Docs document is assigned to this session'
          : 'The assigned Google Docs document changed before the operation was sent',
      );
    }
    return file;
  };

  return {
    async invoke(input) {
      const session = await deps.eventStore.getSession(input.sessionId);
      if (session === undefined || session.projectId !== input.projectId) {
        throw new Error('Google Docs is restricted to the calling session');
      }
      const file = await assigned(input.sessionId);
      const token = await deps.googleAccessToken();
      if (token === undefined) throw new Error('Google Drive is not connected');
      const request = parseRequest(input.request);

      if (request.action === 'inspect_document' || request.action === 'read_document') {
        await assigned(input.sessionId, file.assignmentId);
        const document = await (request.action === 'inspect_document'
          ? docs.inspect(token, file.fileId)
          : docs.read(token, file.fileId));
        const persisted = await deps.eventStore.updateSessionWorkspaceRevision(
          input.sessionId,
          file.assignmentId,
          document.revisionId,
        );
        if (!persisted) {
          throw new Error('The assigned Google Docs document changed while it was being read');
        }
        return document;
      }
      if (request.action === 'edit')
        await assertWorkspaceWriteAccess(deps.eventStore, input.projectId);
      if (request.action !== 'edit') throw new Error('Unsupported Google Docs action');
      validateEdit(request.requests);
      if (request.revisionId === undefined) {
        throw new Error('This edit depends on previously read state and requires revisionId');
      }
      await assigned(input.sessionId, file.assignmentId);
      const claim = await deps.eventStore.claimGoogleWorkspaceInvocation(input);
      if (claim.status === 'completed') return claim.result;
      if (claim.status === 'pending') {
        throw new Error('This Google Docs edit may already have run; inspect the document first');
      }
      if (request.revisionId !== file.revisionId)
        throw new Error('The Google Docs revision is stale');
      await assigned(input.sessionId, file.assignmentId);
      await assertWorkspaceWriteAccess(deps.eventStore, input.projectId);
      const updated = await docs.update(token, file.fileId, request.requests, request.revisionId);
      await deps.eventStore.updateSessionWorkspaceRevision(
        input.sessionId,
        file.assignmentId,
        updated.revisionId,
      );
      const response = { result: updated.result, revisionId: updated.revisionId };
      await deps.eventStore.completeGoogleWorkspaceInvocation(input.invocationId, response);
      return response;
    },
  };
}
