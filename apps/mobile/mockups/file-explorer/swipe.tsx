import { LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/** A short swipe holds two shortcuts open: More (the menu) and Delete (asks first). */
export default function SwipeMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      list={{ swiped: 'tone-of-voice.md' }}
    />
  );
}
