import { FileActionMenu } from '../../components/files/FileActionMenu';
import { FILE_ACTIONS, ignore, LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/** "⋯", a long press on iPad or a right-click opens the row's one menu. */
export default function RowMenuMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      overlay={
        <FileActionMenu
          title="tone-of-voice.md"
          onDismiss={ignore}
          actions={[
            ...FILE_ACTIONS.map((action) => ({ ...action, onPress: ignore })),
            {
              key: 'delete',
              label: 'Delete…',
              icon: 'trash-2',
              destructive: true,
              onPress: ignore,
            },
          ]}
        />
      }
    />
  );
}
