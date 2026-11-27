import type { FileAction } from '../FileActionMenu';

/**
 * The actions every explorer offers, under one label and glyph each, so a row
 * menu in Code, Google Drive, Shared or project knowledge reads the same.
 * A trailing ellipsis marks the actions that ask for more before they act.
 */
export const FILE_ACTION = {
  open: { key: 'open', label: 'Open', icon: 'file' },
  select: { key: 'select', label: 'Select', icon: 'check-circle' },
  copy: { key: 'copy', label: 'Copy contents', icon: 'copy' },
  export: { key: 'export', label: 'Print or share as PDF', icon: 'printer' },
  openWith: { key: 'open-with', label: 'Open with another app', icon: 'share' },
  edit: { key: 'edit', label: 'Edit text', icon: 'edit' },
  rename: { key: 'rename', label: 'Rename…', icon: 'edit-2' },
  move: { key: 'move', label: 'Move…', icon: 'folder' },
  delete: { key: 'delete', label: 'Delete…', icon: 'trash-2', destructive: true },
  trash: { key: 'trash', label: 'Move to trash', icon: 'trash-2', destructive: true },
} as const satisfies Record<string, Omit<FileAction, 'onPress'>>;

export type FileActionKey = keyof typeof FILE_ACTION;

/** The menu for `handlers`, in the fixed order of {@link FILE_ACTION}: the
 *  absent ones are not offered, so every place lists its actions alike. */
export function fileActions(
  handlers: Partial<Record<FileActionKey, (() => void) | undefined>>,
): FileAction[] {
  return (Object.keys(FILE_ACTION) as FileActionKey[]).flatMap((key) => {
    const onPress = handlers[key];
    return onPress ? [{ ...FILE_ACTION[key], onPress }] : [];
  });
}

/** "Add files" behind the +, in one order everywhere; Sources leaves out
 *  `create` (it holds originals, not pages), Drive offers its own documents. */
export function addFileActions(handlers: {
  create?: (() => void) | undefined;
  folder?: (() => void) | undefined;
  upload?: (() => void) | undefined;
}): FileAction[] {
  return [
    ...(handlers.create
      ? [
          {
            key: 'create',
            label: 'New Markdown file…',
            icon: 'file-plus' as const,
            onPress: handlers.create,
          },
        ]
      : []),
    ...(handlers.folder
      ? [
          {
            key: 'folder',
            label: 'New folder…',
            icon: 'folder-plus' as const,
            onPress: handlers.folder,
          },
        ]
      : []),
    ...(handlers.upload
      ? [
          {
            key: 'upload',
            label: 'Upload files…',
            icon: 'upload' as const,
            onPress: handlers.upload,
          },
        ]
      : []),
  ];
}

/** What a name has to be before any request, wherever a file is named. */
export function fileNameProblem(name: string, siblings: readonly string[] = []): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed !== name) return 'Remove the spaces at the start or end.';
  if (/[\\/\0]/.test(name)) return 'Use a name without slashes.';
  if (name === '.' || name === '..' || name === '.text') return 'This name is reserved.';
  // The app addresses its own virtual sections with a leading colon.
  if (name.startsWith(':')) return 'Use a name that does not start with “:”.';
  if (siblings.includes(name)) return 'An entry with this name already exists here.';
  return null;
}
