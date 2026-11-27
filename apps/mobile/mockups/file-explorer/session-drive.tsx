import { SessionExplorer, sessionTabs } from './parts';

/**
 * The Google Drive tab, no longer a list of its own: the same rows and "⋯".
 * A tap opens the file in Drive; the rest (Use in this chat, Add to Project
 * Knowledge, Rename…, Move…, Move to trash) is in the menu.
 */
export default function SessionDriveMockup() {
  return (
    <SessionExplorer
      tabs={sessionTabs('drive')}
      root={{ label: 'Project Drive', icon: 'hard-drive' }}
      segments={['Proposals']}
      entries={[
        { name: '2026', folder: true, meta: '12 items' },
        { name: 'Offer Acme', icon: 'file', meta: 'Google Docs · Nov 17' },
        { name: 'Pricing sheet', icon: 'file', meta: 'Google Sheets · Nov 9' },
      ]}
    />
  );
}
