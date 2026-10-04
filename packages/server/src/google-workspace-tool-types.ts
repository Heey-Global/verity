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
  approvedByCard?: boolean;
}

type WorkspaceInvocationClaim =
  { status: 'claimed' } | { status: 'pending' } | { status: 'completed'; result: unknown };

export interface GoogleWorkspaceToolStore {
  getProjectSettings?(
    projectId: string,
  ): Promise<{ googleDriveAccessMode?: string; googleDriveFolderId?: string | null } | undefined>;
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

export async function assertWorkspaceWriteAccess(
  store: Pick<GoogleWorkspaceToolStore, 'getProjectSettings'>,
  projectId: string,
): Promise<void> {
  const settings = await store.getProjectSettings?.(projectId);
  if (settings?.googleDriveFolderId && settings.googleDriveAccessMode === 'read-only')
    throw new Error('This project has read-only Google Drive access');
}
