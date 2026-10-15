import type { EventStore } from '@verity/store';
import { hasGoogleDriveScopes } from './google-oauth-scopes.js';

export async function resolveGoogleDriveAuthority(
  store: Pick<EventStore, 'googleAccounts'>,
  projectId: string,
  request: { action: string; accountId?: string | undefined; folderLinkId?: string | undefined },
) {
  const links = await store.googleAccounts.folders(projectId);
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
  const accounts = (await store.googleAccounts.list()).filter((account) =>
    hasGoogleDriveScopes(account.scopes),
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
