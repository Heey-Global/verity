import type { EventStore } from '@verity/store';
import { assertDriveFileInLinkedFolder } from './google-drive-project-routes.js';
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

export async function assertWorkspaceWritePermission(
  store: Pick<GoogleWorkspaceToolStore, 'getProjectSettings' | 'googleAccounts'>,
  projectId: string,
  file?: SessionWorkspaceFile,
) {
  if (store.googleAccounts && file && !file.folderLinkId) {
    const links = await store.googleAccounts.folders(projectId);
    if (links.some((link) => link.accountId === file.accountId))
      throw new Error('Select a linked project folder before editing the assigned file');
  }
  if (file?.folderLinkId && store.googleAccounts) {
    const link = (await store.googleAccounts.folders(projectId)).find(
      (candidate) => candidate.id === file.folderLinkId,
    );
    if (!link || link.accountId !== file.accountId || link.accessMode === 'read-only')
      throw new Error('The assigned file has no writable project folder access');
    return link;
  }
  const settings = await store.getProjectSettings?.(projectId);
  if (settings?.googleDriveFolderId && settings.googleDriveAccessMode === 'read-only')
    throw new Error('This project has read-only Google Drive access');
}

/** Executors additionally prove current file membership with the selected account token. */
export async function assertWorkspaceWriteAccess(
  store: Pick<GoogleWorkspaceToolStore, 'getProjectSettings' | 'googleAccounts'>,
  projectId: string,
  file: SessionWorkspaceFile,
  accessToken: string | undefined,
): Promise<void> {
  const link = await assertWorkspaceWritePermission(store, projectId, file);
  if (link && store.googleAccounts) {
    if (!accessToken) throw new Error('Google Drive is not connected');
    await assertDriveFileInLinkedFolder(accessToken, link.folderId, file.fileId);
    const current = (await store.googleAccounts.folders(projectId)).find(
      (candidate) => candidate.id === link.id,
    );
    const account = await store.googleAccounts.get(link.accountId);
    if (
      !current ||
      current.revision !== link.revision ||
      !account ||
      (file.credentialVersion != null && account.credentialVersion !== file.credentialVersion)
    )
      throw new Error('Google account or folder access changed before editing');
  }
}
