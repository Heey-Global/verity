import { ConfirmSheet } from '../../components/ui';
import { ignore, LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/**
 * Moving or renaming a Wiki page that other pages link to asks first, in the
 * same confirmation the explorer uses for Delete. Without links, or outside
 * a Wiki, the move just happens.
 */
export default function MoveConfirmMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      overlay={
        <ConfirmSheet
          visible
          title="Move “tone-of-voice.md”?"
          message="3 other pages link to it. Their links will point to verity-uplink/tone-of-voice.md."
          confirmLabel="Move"
          onConfirm={ignore}
          onCancel={ignore}
        />
      }
    />
  );
}
