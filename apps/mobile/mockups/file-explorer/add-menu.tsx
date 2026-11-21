import { FileActionMenu } from '../../components/files/FileActionMenu';
import { ignore, LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/** The + opens the same "Add files" everywhere; Sources has no "New Markdown file…". */
export default function AddMenuMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      overlay={
        <FileActionMenu
          title="Add files"
          onDismiss={ignore}
          actions={[
            { key: 'create', label: 'New Markdown file…', icon: 'file-plus', onPress: ignore },
            { key: 'folder', label: 'New folder…', icon: 'folder-plus', onPress: ignore },
            { key: 'upload', label: 'Upload files…', icon: 'upload', onPress: ignore },
          ]}
        />
      }
    />
  );
}
