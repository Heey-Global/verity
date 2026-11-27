import { LibraryExplorer, SelectionBar, SelectionHeader, SHARED_WIKI, sharedTabs } from './parts';

/** A long press (⌘/Shift-click, or "Select") selects; the bar acts on all of them. */
export default function SelectionMockup() {
  return (
    <LibraryExplorer
      title="Shared knowledge"
      tabs={sharedTabs('wiki')}
      root={{ label: 'Wiki', icon: 'book-open' }}
      entries={SHARED_WIKI}
      list={{ selecting: true, picked: ['holger-steckbrief.md', 'tone-of-voice.md'] }}
      selected={2}
      footer={<SelectionBar count={2} />}
    />
  );
}
