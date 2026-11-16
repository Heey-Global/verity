import { FileNameDialog } from '../../components/files/FileNameDialog';
import { Group, Row } from '../../components/ui';
import { LibraryLayout, LibraryPath } from './parts';

const ignore = () => undefined;

/**
 * Rename, from the swipe or the context menu: the file dialog the session
 * files already use, with the name before the extension selected. Links in the
 * Wiki keep the old path, so the dialog says so.
 */
export default function RenameDialogMockup() {
  return (
    <>
      <LibraryLayout
        list={
          <>
            <LibraryPath levels={['Sources', 'meetings']} />
            <Group>
              <Row
                leading={{ icon: 'file-text' }}
                title="2026-10-06-live-meeting-2c5fda9c.md"
                navigates
                onPress={ignore}
              />
              <Row
                leading={{ icon: 'file-text' }}
                title="2026-10-07-live-meeting-b8b01bbc.md"
                navigates
                onPress={ignore}
              />
            </Group>
          </>
        }
      />
      <FileNameDialog
        title="Rename file"
        subtitle="Wiki pages that cite this source keep pointing to the old name."
        initialName="2026-10-06-live-meeting-2c5fda9c.md"
        confirmLabel="Rename"
        validate={() => null}
        onSubmit={async () => undefined}
        onCancel={ignore}
      />
    </>
  );
}
