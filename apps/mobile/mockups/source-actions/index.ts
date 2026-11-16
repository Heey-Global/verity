import type { MockupSpec } from '../types';
import FilePaneMockup from './file-pane';
import FileSwipeMockup from './file-swipe';
import FolderSwipeMockup from './folder-swipe';
import RenameDialogMockup from './rename-dialog';

/**
 * Swipe actions on Sources entries in the session row's style, renaming
 * sources and their folders, and the open file's header in the wide layout.
 * Sample content only; nothing here talks to a server.
 */
export const sourceActionsSpec: MockupSpec = {
  id: 'source-actions',
  title: 'Source actions',
  screens: {
    'file-swipe': { title: 'meetings', Component: FileSwipeMockup },
    'folder-swipe': { title: 'Sources', Component: FolderSwipeMockup },
    'rename-dialog': { title: 'meetings', Component: RenameDialogMockup },
    'file-pane': { title: 'meetings', Component: FilePaneMockup },
  },
};
