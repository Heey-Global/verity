import { Group, Row, SectionHeader } from '../../components/ui';
import { LibraryLayout, LibraryPath, SwipedOpen } from './parts';

const ignore = () => undefined;

const FILES = [
  '2026-10-07-live-meeting-b8b01bbc.md',
  '2026-10-08-live-meeting-0427134a.md',
  '2026-10-08-live-meeting-0f2bea20.md',
];

/**
 * A file in Sources swiped open: Rename and Delete rest beside it in the same
 * lanes as a session row (below for comparison). A long swipe only opens the
 * actions; Delete still asks first.
 */
export default function FileSwipeMockup() {
  return (
    <LibraryLayout
      list={
        <>
          <LibraryPath levels={['Sources', 'meetings']} />
          <Group>
            <SwipedOpen
              actions={[
                { label: 'Rename', icon: 'edit-2' },
                { label: 'Delete', icon: 'trash-2', destructive: true },
              ]}
            >
              <Row
                leading={{ icon: 'file-text' }}
                title="2026-10-06-live-meeting-2c5fda9c.md"
                navigates
                onPress={ignore}
              />
            </SwipedOpen>
            {FILES.map((name) => (
              <Row
                key={name}
                leading={{ icon: 'file-text' }}
                title={name}
                navigates
                onPress={ignore}
              />
            ))}
          </Group>
          <SectionHeader title="Session row, for comparison" />
          <Group>
            <SwipedOpen
              actions={[
                { label: 'Edit', icon: 'edit-2' },
                { label: 'Delete', icon: 'trash-2', destructive: true },
              ]}
            >
              <Row
                leading={{ icon: 'message-circle' }}
                title="Fix login redirect"
                subtitle="verity · 2 h ago"
                onPress={ignore}
              />
            </SwipedOpen>
          </Group>
        </>
      }
    />
  );
}
