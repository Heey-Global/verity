import { Text } from '../../components/ui';
import { DOCS_ADR, Line, MOBILE_HEADER, SERVER_AUTH, SessionWithLine, UserMessage } from './parts';

/**
 * Several collaborators: their tiles stack, frames say who is working and the
 * dot who answered. The text leads with what matters most.
 */
export default function SeveralCollaboratorsMockup() {
  return (
    <SessionWithLine line={<Line entries={[MOBILE_HEADER, SERVER_AUTH, DOCS_ADR]} />}>
      <UserMessage>How far along are the others with the header?</UserMessage>
      <Text variant="body">
        Mobile answered: the new header is in place, only the status ring is missing. Server is
        still working on the token refresh; the ADR was handed over and is done.
      </Text>
    </SessionWithLine>
  );
}
