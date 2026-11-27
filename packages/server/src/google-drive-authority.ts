import type { EventStore } from '@verity/store';
import { googleDriveIsMutation, googleDriveRequestSchema } from './google-drive-request.js';
import { hasGoogleDriveScopes } from './google-oauth-scopes.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';

export async function resolveGoogleDriveAuthority(
  store: Pick<EventStore, 'googleAccounts'>,
  projectId: string,
  request: { action: string; accountId?: string | undefined; folderLinkId?: string | undefined },
  /** The person the turn runs for. Only their own accounts and the folder links
   *  made with them count; "the only one" means the only one of theirs. */
  userId: string | undefined,
) {
  const links = (await store.googleAccounts.folders(projectId)).filter(
    (candidate) => userId !== undefined && candidate.accountOwnerUserId === userId,
  );
  let link = request.folderLinkId
    ? links.find((candidate) => candidate.id === request.folderLinkId)
    : links.length === 1
      ? links[0]
      : undefined;
  if (
    request.action === 'read_document_url' &&
    !request.folderLinkId &&
    request.accountId &&
    link?.accountId !== request.accountId
  )
    link = undefined;
  if (request.folderLinkId && !link)
    throw new Error('The selected Drive folder is not connected to this project');
  if (!link && request.action !== 'read_document_url')
    throw new Error('Choose folderLinkId from the project Drive folders');
  const accounts = (userId === undefined ? [] : await store.googleAccounts.list(userId)).filter(
    (account) => hasGoogleDriveScopes(account.scopes),
  );
  const id = link?.accountId ?? request.accountId;
  const account = id
    ? accounts.find((candidate) => candidate.id === id)
    : accounts.length === 1
      ? accounts[0]
      : undefined;
  if (!account || (request.accountId && request.accountId !== account.id))
    throw new Error('Choose an authorized Google account');
  return {
    accountId: account.id,
    accountEmail: account.email,
    credentialVersion: account.credentialVersion,
    bindingRevision: link?.revision ?? null,
    folderLinkId: link?.id ?? null,
    googleDriveFolderId: link?.folderId ?? null,
    googleDriveFolderName: link?.name ?? null,
    googleDriveAccessMode: link?.accessMode ?? ('read-only' as const),
  };
}

/**
 * The pre-card refusal for a Google Drive tool call: the session must still
 * belong to the project, folder operations need a valid folder link, and a
 * read-only link refuses mutations.
 */
export async function authorizeGoogleDriveCall(
  store: EventStore,
  input: { projectId: string; sessionId: string; request: unknown },
  initiator: () => Promise<string | undefined>,
): Promise<void> {
  const session = await store.getSession(input.sessionId);
  if (session?.projectId !== input.projectId)
    throw new ControlPlaneSessionAuthorityError('session project changed');
  const driveRequest = googleDriveRequestSchema.parse(input.request);
  if (driveRequest.action === 'capabilities' && !driveRequest.folderLinkId) return;
  const authority = await resolveGoogleDriveAuthority(
    store,
    input.projectId,
    driveRequest,
    await initiator(),
  );
  if (googleDriveIsMutation(driveRequest) && authority.googleDriveAccessMode === 'read-only')
    throw new ControlPlaneSessionAuthorityError(
      'This project folder has read-only Google Drive access',
    );
}
