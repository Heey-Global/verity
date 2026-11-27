import type { MockupSpec } from '../types';
import AddMenuMockup from './add-menu';
import MoveConfirmMockup from './move-confirm';
import MovePickerMockup from './move-picker';
import RowMenuMockup from './row-menu';
import SelectionMockup from './selection';
import SessionCodeMockup from './session-code';
import SessionDriveMockup from './session-drive';
import SharedListMockup from './shared-list';
import SwipeMockup from './swipe';

/**
 * One file explorer for a session's Code and Google Drive, project knowledge
 * and Shared knowledge: the same header, tabs, rows, menus and dialogs, with
 * "New folder…" and "Move…" for all of them. Sample content only.
 */
export const fileExplorerSpec: MockupSpec = {
  id: 'file-explorer',
  title: 'File explorer',
  screens: {
    'shared-list': { title: 'Shared knowledge', Component: SharedListMockup },
    'row-menu': { title: 'Shared knowledge', Component: RowMenuMockup },
    swipe: { title: 'Shared knowledge', Component: SwipeMockup },
    selection: { title: 'Shared knowledge', Component: SelectionMockup },
    'add-menu': { title: 'Shared knowledge', Component: AddMenuMockup },
    'move-picker': { title: 'Shared knowledge', Component: MovePickerMockup },
    'move-confirm': { title: 'Shared knowledge', Component: MoveConfirmMockup },
    'session-code': { title: 'Session', Component: SessionCodeMockup },
    'session-drive': { title: 'Session', Component: SessionDriveMockup },
  },
};
