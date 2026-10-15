import type { EventStore } from '@verity/store';
export interface SessionWorkspaceFile {
  accountId?: string | null;
  folderLinkId?: string | null;
  credentialVersion?: number | null;
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

export interface GoogleWorkspaceToolStore extends Partial<Pick<EventStore, 'googleAccounts'>> {
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
  store: Pick<GoogleWorkspaceToolStore, 'getProjectSettings' | 'googleAccounts'>,
  projectId: string,
  file?: SessionWorkspaceFile,
): Promise<void> {
  if (file?.folderLinkId && store.googleAccounts) {
    const link = (await store.googleAccounts.folders(projectId)).find(
      (candidate) => candidate.id === file.folderLinkId,
    );
    if (!link || link.accountId !== file.accountId || link.accessMode === 'read-only')
      throw new Error('The assigned file has no writable project folder access');
    return;
  }
  const settings = await store.getProjectSettings?.(projectId);
  if (settings?.googleDriveFolderId && settings.googleDriveAccessMode === 'read-only')
    throw new Error('This project has read-only Google Drive access');
}
