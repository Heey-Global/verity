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

/**
 * A project Wiki's own views, addressed like folders so a phone's route stack
 * and the wide column move through them like any other level: `insights` is the
 * start page, `insights/decisions` the decision list, `insights/:files` the
 * folder as it lies on disk and `insights/:topic:<title>` one topic's pages.
 */
export const WIKI = 'insights';
export const WIKI_FILES = 'insights/:files';
const TOPIC = 'insights/:topic:';

export type WikiView =
  { kind: 'home' } | { kind: 'decisions' } | { kind: 'files' } | { kind: 'topic'; title: string };

/**
 * A topic's title as part of a folder. The router decodes its params itself, so
 * percent-encoding would be undone on the way; this spelling has no `%` and no
 * `/` (which would make the topic look like a folder inside another).
 */
export function topicFolder(title: string): string {
  return `${TOPIC}${title.replace(/[^A-Za-z0-9 _-]/gu, (char) => `~${char.codePointAt(0)!.toString(16)}.`)}`;
}

function topicTitle(encoded: string): string | null {
  if (!/^(?:[A-Za-z0-9 _-]|~[0-9a-f]{1,6}\.)*$/u.test(encoded)) return null;
  try {
    return encoded.replace(/~([0-9a-f]{1,6})\./gu, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
  } catch {
    return null;
  }
}

/** The Wiki view a project folder names, or null for an ordinary folder. */
export function wikiView(scope: KnowledgeScope, folder: string): WikiView | null {
  if (scope.kind !== 'project') return null;
  if (folder === WIKI) return { kind: 'home' };
  if (folder === DECISIONS) return { kind: 'decisions' };
  if (folder === WIKI_FILES) return { kind: 'files' };
  if (folder.startsWith(TOPIC)) {
    const title = topicTitle(folder.slice(TOPIC.length));
    return title === null ? null : { kind: 'topic', title };
  }
  return null;
}

/** The folder on disk behind a Wiki view: the Wiki's own for its start page,
 *  its files and a topic, which a server without a catalog lists instead. */
function wikiFolder(scope: KnowledgeScope, folder: string): string {
  const view = wikiView(scope, folder);
  return view && view.kind !== 'decisions' ? WIKI : folder;
}

/** What a folder is called on screen: the areas by their names, the rest by theirs. */
export function folderTitle(scope: KnowledgeScope, folder: string): string {
  if (folder === '') return scopeTitle(scope);
  const view = wikiView(scope, folder);
  if (view?.kind === 'files') return 'All files';
  if (view?.kind === 'topic') return view.title;
  const name = folder.split('/').at(-1) ?? folder;
  // Shared names only its top-level areas; Decisions is a project's own section.
  if (scope.kind === 'shared' && folder.includes('/')) return name;
  return KNOWN_FOLDERS[folder]?.title ?? name;
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
    : client.listProjectKnowledgeFiles(scope.projectId, wikiFolder(scope, folder));
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
  target: { folder: string } | { file: string } | { proposal: string },
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
