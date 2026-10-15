import type { DriveFile, ProjectDriveFolder } from '@verity/mobile';

export function driveOverview(folders: ProjectDriveFolder[], accountId?: string): DriveFile[] {
  const accounts = new Map(folders.map((folder) => [folder.accountId, folder.accountEmail]));
  if (accounts.size > 1 && !accountId)
    return [...accounts].map(([id, email]) => ({
      id: `account:${id}`,
      name: email,
      mimeType: 'application/vnd.google-apps.folder',
    }));
  return folders
    .filter((folder) => !accountId || folder.accountId === accountId)
    .map((folder) => ({
      id: `link:${folder.id}`,
      name: folder.name,
      mimeType: 'application/vnd.google-apps.folder',
    }));
}

export function singleDriveFolderPath(folders: ProjectDriveFolder[]) {
  const folder = folders.length === 1 ? folders[0] : undefined;
  return folder ? [{ id: `link:${folder.id}`, name: folder.name }] : [];
}
