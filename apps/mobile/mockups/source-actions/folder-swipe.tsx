import { Group, Row } from '../../components/ui';
import { LibraryLayout, LibraryPath, SwipedOpen } from './parts';

const ignore = () => undefined;

/** A folder in Sources swiped open: the same Rename and Delete lanes as a file. */
export default function FolderSwipeMockup() {
  return (
    <LibraryLayout
      list={
        <>
          <LibraryPath levels={['Sources']} />
          <Group>
            <Row leading={{ icon: 'folder' }} title="documents" navigates onPress={ignore} />
            <SwipedOpen
              actions={[
                { label: 'Rename', icon: 'edit-2' },
                { label: 'Delete', icon: 'trash-2', destructive: true },
              ]}
            >
              <Row leading={{ icon: 'folder' }} title="meetings" navigates onPress={ignore} />
            </SwipedOpen>
            <Row leading={{ icon: 'folder' }} title="screenshots" navigates onPress={ignore} />
            <Row
              leading={{ icon: 'file-text' }}
              title="pricing-interview-notes.md"
              navigates
              onPress={ignore}
            />
          </Group>
        </>
      }
    />
  );
}
