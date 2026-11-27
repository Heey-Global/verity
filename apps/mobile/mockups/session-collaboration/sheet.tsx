import { CollaborationSheet } from '../../components/session/collaboration';
import { Text } from '../../components/ui';
import { DOCS_ADR, ignore, Line, MOBILE_HEADER, NOW, SERVER_AUTH, SessionWithLine } from './parts';

/** The list behind the row: direction, state and age per session; a row opens it. */
export default function CollaborationSheetMockup() {
  return (
    <SessionWithLine
      line={<Line entries={[MOBILE_HEADER, SERVER_AUTH, DOCS_ADR]} />}
      overlay={
        <CollaborationSheet
          visible
          now={NOW}
          entries={[MOBILE_HEADER, SERVER_AUTH, { ...DOCS_ADR, section: 'earlier' }]}
          onOpen={ignore}
          onClose={ignore}
        />
      }
    >
      <Text variant="body">Mobile answered.</Text>
    </SessionWithLine>
  );
}
