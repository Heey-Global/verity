import { LibraryExplorer, SHARED_WIKI, sharedTabs } from './parts';

/** Settings › Shared knowledge, Wiki tab at its top: tabs, then rows with "⋯". */
export default function SharedListMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
    />
  );
}
