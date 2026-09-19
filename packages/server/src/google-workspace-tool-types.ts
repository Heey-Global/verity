export interface SessionWorkspaceFile {
  assignmentId: string;
  fileId: string;
  kind: 'docs' | 'sheets' | 'slides';
  revisionId: string | null;
  name?: string;
  webViewLink?: string;
}

export interface WorkspaceInvocationInput {
  projectId: string;
  sessionId: string;
  turnId: string;
  invocationId: string;
  request: unknown;
}

export type WorkspaceInvocationClaim =
  { status: 'claimed' } | { status: 'pending' } | { status: 'completed'; result: unknown };

export interface GoogleWorkspaceToolStore {
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  getSessionWorkspaceFile(sessionId: string): Promise<SessionWorkspaceFile | undefined>;
  updateSessionWorkspaceRevision(
    sessionId: string,
    assignmentId: string,
    revisionId: string,
  ): Promise<boolean>;
  claimGoogleWorkspaceInvocation(
    input: WorkspaceInvocationInput,
  ): Promise<WorkspaceInvocationClaim>;
  completeGoogleWorkspaceInvocation(invocationId: string, result: unknown): Promise<void>;
}
