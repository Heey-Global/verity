import type { SessionDirectory, SessionFileContent, VerityClient } from '@verity/mobile';
import { router } from 'expo-router';

import type { IconName } from '../Icon';

/** Which library a knowledge screen browses: Shared, or one project's. */
export type KnowledgeScope = { kind: 'shared' } | { kind: 'project'; projectId: string };

export const SHARED: KnowledgeScope = { kind: 'shared' };

export function scopeTitle(scope: KnowledgeScope): string {
  return scope.kind === 'shared' ? 'Shared knowledge' : 'Project knowledge';
}

export const DECISIONS = 'insights/decisions';

/** The folders with a name, glyph and one line of their own, wherever they are
 *  listed, so Sources reads as originals rather than one more folder. */
const KNOWN_FOLDERS: Record<string, { title: string; icon: IconName; subtitle: string }> = {
  insights: { title: 'Wiki', icon: 'book-open', subtitle: 'Maintained knowledge and decisions' },
  [DECISIONS]: {
    title: 'Decisions',
    icon: 'check-circle',
    subtitle: 'Confirmed choices, with reason and origin',
  },
  sources: {
    title: 'Sources',
    icon: 'paperclip',
    subtitle: 'Documents, meeting transcripts and attachments',
  },
};

/** What a folder is called on screen: the areas by their names, the rest by theirs. */
export function folderTitle(scope: KnowledgeScope, folder: string): string {
  if (folder === '') return scopeTitle(scope);
  return KNOWN_FOLDERS[folder]?.title ?? folder.split('/').at(-1) ?? folder;
}

export function folderIcon(folder: string): IconName {
  return KNOWN_FOLDERS[folder]?.icon ?? 'folder';
}

/** Only a project's areas explain themselves: Shared holds no project decisions. */
export function folderSubtitle(scope: KnowledgeScope, folder: string): string | undefined {
  return scope.kind === 'project' ? KNOWN_FOLDERS[folder]?.subtitle : undefined;
}

export function parentFolder(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export function listKnowledge(
  client: VerityClient,
  scope: KnowledgeScope,
  folder: string,
): Promise<SessionDirectory> {
  return scope.kind === 'shared'
    ? client.listSharedKnowledgeFiles(folder)
    : client.listProjectKnowledgeFiles(scope.projectId, folder);
}

export function readKnowledge(
  client: VerityClient,
  scope: KnowledgeScope,
  file: string,
): Promise<SessionFileContent> {
  return scope.kind === 'shared'
    ? client.getSharedKnowledgeFile(file)
    : client.getProjectKnowledgeFile(scope.projectId, file);
}

export function writeKnowledge(
  client: VerityClient,
  scope: KnowledgeScope,
  file: string,
  content: string,
  version: string,
): Promise<SessionFileContent> {
  return scope.kind === 'shared'
    ? client.writeSharedKnowledgeFile(file, content, version)
    : client.writeProjectKnowledgeFile(scope.projectId, file, content, version);
}

export function knowledgeDownloadUrl(
  client: VerityClient,
  scope: KnowledgeScope,
  file: string,
): string {
  return scope.kind === 'shared'
    ? client.sharedKnowledgeFileDownloadUrl(file)
    : client.projectKnowledgeFileDownloadUrl(scope.projectId, file);
}

export function downloadKnowledge(
  client: VerityClient,
  scope: KnowledgeScope,
  file: string,
): Promise<Blob> {
  return scope.kind === 'shared'
    ? client.downloadSharedKnowledgeFile(file)
    : client.downloadProjectKnowledgeFile(scope.projectId, file);
}

/** The route that shows a folder or a file of `scope` as its own screen, so the
 *  header's back arrow and the swipe go up exactly one level. */
export function pushKnowledge(
  scope: KnowledgeScope,
  target: { folder: string } | { file: string },
) {
  if (scope.kind === 'shared') {
    router.push({ pathname: '/settings/shared-knowledge', params: target });
    return;
  }
  router.push({
    pathname: '/project/[id]/knowledge',
    params: { id: scope.projectId, ...target },
  });
}
